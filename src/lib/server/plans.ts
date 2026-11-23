// The admin side of plans: listing, creating, renaming and setting limits,
// choosing the default, assigning a plan to an account, and the per-account
// usage the Usage & storage section shows. Enforcement is in quotas.ts.
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm';
import { recountStorageUsed } from './quotas.ts';
import { likePattern } from './sql-like.ts';
import type { Database } from './auth.ts';
import { entitlements, plans, users } from './db/schema.ts';
import { isUniqueViolation } from './db-errors.ts';
import type { ActionFailure } from './action-result.ts';
import { NO_LIMITS, parseLimit, QUOTA_KEYS, type Limits } from '../quota.ts';
import { slugify } from '../slug.ts';

export type PlanView = {
	id: string;
	key: string;
	name: string;
	isDefault: boolean;
	limits: Limits;
	// Accounts on the plan, counting those that fall back to it as default.
	accounts: number;
};

const PLAN_NAME_MAX = 80;

export async function listPlans(db: Database): Promise<PlanView[]> {
	const rows = await db
		.select({
			id: plans.id,
			key: plans.key,
			name: plans.name,
			isDefault: plans.isDefault,
			accounts: sql<number>`(select count(*)::int from ${users}
				where ${users.planId} = ${plans.id} or (${users.planId} is null and ${plans.isDefault}))`
		})
		.from(plans)
		.orderBy(asc(plans.sortOrder), asc(plans.createdAt));
	const limitRows =
		rows.length === 0
			? []
			: await db
					.select({ planId: entitlements.planId, key: entitlements.key, value: entitlements.value })
					.from(entitlements)
					.where(
						and(
							inArray(
								entitlements.planId,
								rows.map((row) => row.id)
							),
							inArray(entitlements.key, [...QUOTA_KEYS])
						)
					);
	return rows.map((row) => {
		const limits: Limits = { ...NO_LIMITS };
		for (const limit of limitRows) {
			if (limit.planId === row.id) limits[limit.key as keyof Limits] = parseLimit(limit.value);
		}
		return { ...row, limits };
	});
}

function cleanName(name: string): string | null {
	const trimmed = name.trim().slice(0, PLAN_NAME_MAX);
	return trimmed || null;
}

export async function createPlan(
	db: Database,
	name: string
): Promise<{ ok: true; id: string } | ActionFailure> {
	const clean = cleanName(name);
	if (!clean) return { ok: false, code: 'invalid', reason: 'Give the plan a name.' };
	const base = slugify(clean, 'plan');
	const [{ next }] = (
		await db.execute(sql`select coalesce(max(sort_order), 0) + 1 as next from plans`)
	).rows as { next: number }[];
	// The key is a fixed handle for the plan; renaming leaves it alone.
	for (const key of [base, `${base}-${randomUUID().slice(0, 8)}`]) {
		try {
			const [row] = await db
				.insert(plans)
				.values({ key, name: clean, sortOrder: next })
				.returning({ id: plans.id });
			return { ok: true, id: row.id };
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
		}
	}
	return { ok: false, code: 'conflict', reason: 'That plan could not be created. Try again.' };
}

/** Renames the plan and replaces its limits; a null limit removes the row,
 * which means no limit. */
export async function savePlan(
	db: Database,
	planId: string,
	input: { name: string; limits: Limits }
): Promise<{ ok: true } | ActionFailure> {
	const clean = cleanName(input.name);
	if (!clean) return { ok: false, code: 'invalid', reason: 'Give the plan a name.' };
	return db.transaction(async (tx) => {
		const [row] = await tx
			.update(plans)
			.set({ name: clean })
			.where(eq(plans.id, planId))
			.returning({ id: plans.id });
		if (!row) return { ok: false, code: 'not_found', reason: 'That plan does not exist.' };
		for (const key of QUOTA_KEYS) {
			const value = input.limits[key];
			if (value === null) {
				await tx
					.delete(entitlements)
					.where(and(eq(entitlements.planId, planId), eq(entitlements.key, key)));
			} else {
				await tx
					.insert(entitlements)
					.values({ planId, key, value })
					.onConflictDoUpdate({
						target: [entitlements.planId, entitlements.key],
						set: { value }
					});
			}
		}
		return { ok: true };
	});
}

/** Makes the plan the one accounts without a plan of their own are on. */
export async function setDefaultPlan(db: Database, planId: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		// Every plan row, so two changes of default at once take turns.
		const all = await tx.select({ id: plans.id }).from(plans).orderBy(asc(plans.id)).for('update');
		if (!all.some((row) => row.id === planId)) return false;
		// Clear first: the partial unique index allows one default at a time.
		await tx.update(plans).set({ isDefault: false }).where(eq(plans.isDefault, true));
		await tx.update(plans).set({ isDefault: true }).where(eq(plans.id, planId));
		return true;
	});
}

/** Puts the account on a plan, or with null back on the default plan. */
export async function setUserPlan(
	db: Database,
	userId: string,
	planId: string | null
): Promise<boolean> {
	if (planId !== null) {
		const [plan] = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, planId));
		if (!plan) return false;
	}
	const [row] = await db
		.update(users)
		.set({ planId })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return Boolean(row);
}

export type AccountUsage = {
	id: string;
	email: string;
	displayName: string;
	// The account's own plan; null means the default plan.
	planId: string | null;
	universes: number;
	stories: number;
	storageBytes: number;
};

export const USAGE_PAGE_SIZE = 50;

export type AccountUsagePage = {
	accounts: AccountUsage[];
	// Accounts matching the search, on every page.
	total: number;
	// Zero-based.
	page: number;
	hasMore: boolean;
};

/**
 * One page of accounts' use of what their plans limit, biggest image use
 * first. query narrows it to accounts whose email or display name contains
 * the text. The counts follow the same rules as liveCountsSql in quotas.ts
 * (live rows only), computed for the whole page in one grouped query.
 */
export async function listAccountUsage(
	db: Database,
	{ query = '', page = 0 }: { query?: string; page?: number } = {}
): Promise<AccountUsagePage> {
	const safePage = Math.max(0, Math.floor(Number.isFinite(page) ? page : 0));
	const text = query.trim();
	const pattern = likePattern(text);
	const match = text
		? or(ilike(users.email, pattern), ilike(users.displayName, pattern))
		: undefined;
	const [{ total }] = await db.select({ total: count() }).from(users).where(match);
	// One row past the page says whether a next page exists.
	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			planId: users.planId,
			storageBytes: users.storageUsedBytes
		})
		.from(users)
		.where(match)
		.orderBy(desc(users.storageUsedBytes), desc(users.createdAt), asc(users.id))
		.limit(USAGE_PAGE_SIZE + 1)
		.offset(safePage * USAGE_PAGE_SIZE);
	const pageRows = rows.slice(0, USAGE_PAGE_SIZE);
	const counts = new Map<string, { universes: number; stories: number }>();
	if (pageRows.length > 0) {
		const ids = sql.join(
			pageRows.map((row) => sql`${row.id}::uuid`),
			sql`, `
		);
		const result = await db.execute(sql`
			select owner_id, sum(u)::int as universes, sum(s)::int as stories from (
				select qu.owner_id, 1 as u, 0 as s from universes qu
				where qu.owner_id in (${ids}) and qu.deleted_at is null and not qu.standalone
				union all
				select qs.owner_id, 0, 1 from stories qs
				join universes qu on qu.id = qs.universe_id
				where qs.owner_id in (${ids}) and qs.deleted_at is null and qu.deleted_at is null
			) live
			group by owner_id
		`);
		for (const row of result.rows as { owner_id: string; universes: number; stories: number }[]) {
			counts.set(row.owner_id, { universes: row.universes, stories: row.stories });
		}
	}
	return {
		accounts: pageRows.map((row) => ({
			...row,
			universes: counts.get(row.id)?.universes ?? 0,
			stories: counts.get(row.id)?.stories ?? 0
		})),
		total,
		page: safePage,
		hasMore: rows.length > USAGE_PAGE_SIZE
	};
}

export const RECOUNT_BATCH = 200;

/**
 * Recounts the image storage of up to `limit` accounts, in id order after
 * `after` (from the start when null), each in its own short transaction (see
 * recountStorageUsed). next is the id to continue after, or null when every
 * account has been done.
 */
export async function recountStorageBatch(
	db: Database,
	after: string | null,
	limit = RECOUNT_BATCH
): Promise<{ recounted: number; next: string | null }> {
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(after ? gt(users.id, after) : undefined)
		.orderBy(asc(users.id))
		.limit(limit + 1);
	const batch = rows.slice(0, limit);
	for (const row of batch) await recountStorageUsed(db, row.id);
	return {
		recounted: batch.length,
		next: rows.length > limit ? batch[batch.length - 1].id : null
	};
}

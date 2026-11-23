// The admin side of plans: listing, creating, renaming and setting limits,
// choosing the default, assigning a plan to an account, and the per-account
// usage the Usage & storage section shows. Enforcement is in quotas.ts.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { liveCountsSql } from './quotas.ts';
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

/** Every account's use of what its plan limits, counted the way quotas.ts
 * counts it (live rows only). */
export async function listAccountUsage(db: Database): Promise<AccountUsage[]> {
	const counts = liveCountsSql(sql`${users.id}`);
	return db
		.select({
			id: users.id,
			email: users.email,
			displayName: users.displayName,
			planId: users.planId,
			universes: counts.universes,
			stories: counts.stories,
			storageBytes: users.storageUsedBytes
		})
		.from(users)
		.orderBy(desc(users.storageUsedBytes), desc(users.createdAt));
}

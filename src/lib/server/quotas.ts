// Enforcing a plan's limits (see #lib/quota.ts for which ones). An account's
// plan is its users.plan_id, or the default plan when that is null; a limit
// that is missing or null is no limit, so the seeded default plan changes
// nothing. Billing has no part here.
//
// Counts are of live rows: a universe or story in the trash does not count,
// and the standalone-stories universe is a container rather than a universe
// the writer made, so it never counts either. Restoring from the trash is
// checked like a create. Storage is the bytes of uploaded files
// (users.storage_used_bytes, kept by assets.ts); text is not counted.
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { NO_LIMITS, parseLimit, quotaMessage, QUOTA_KEYS, type Limits } from '../quota.ts';

/** Thrown inside a create's transaction so the whole create rolls back; the
 * route turns it into the message. */
export class QuotaExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QuotaExceededError';
	}
}

/** The limits of the account's plan. */
export async function accountLimits(db: Database, userId: string): Promise<Limits> {
	const result = await db.execute(sql`
		select e.key, e.value from entitlements e
		where e.plan_id = coalesce(
			(select plan_id from users where id = ${userId}),
			(select id from plans where is_default)
		)
	`);
	const limits: Limits = { ...NO_LIMITS };
	for (const row of result.rows as { key: string; value: unknown }[]) {
		if ((QUOTA_KEYS as readonly string[]).includes(row.key)) {
			limits[row.key as keyof Limits] = parseLimit(row.value);
		}
	}
	return limits;
}

/** What counts toward max_universes and max_stories for the owner given by an
 * SQL expression (a bound id, or a column of an outer query): live universes
 * the writer made, and live stories in live universes. */
export function liveCountsSql(owner: SQL) {
	return {
		universes: sql<number>`(select count(*)::int from universes qu
			where qu.owner_id = ${owner} and qu.deleted_at is null and not qu.standalone)`,
		stories: sql<number>`(select count(*)::int from stories qs
			join universes qu on qu.id = qs.universe_id
			where qs.owner_id = ${owner} and qs.deleted_at is null and qu.deleted_at is null)`
	};
}

export async function countLive(
	db: Database,
	userId: string
): Promise<{ universes: number; stories: number }> {
	const counts = liveCountsSql(sql`${userId}::uuid`);
	const result = await db.execute(
		sql`select ${counts.universes} as universes, ${counts.stories} as stories`
	);
	return result.rows[0] as { universes: number; stories: number };
}

/**
 * Throws QuotaExceededError when adding this many universes or stories would
 * pass the account's limits. Call it inside the create's transaction, before
 * the insert: it takes a per-account lock (only when a limit applies) that
 * holds until the transaction ends, so two creates at once cannot both pass on
 * the same count. Take it after any row lock the transaction needs (see
 * holdStoryQuota). Outside a transaction it is a plain check, for refusing
 * early before slow work.
 */
export async function holdCountQuota(
	tx: Database,
	userId: string,
	adding: { universes?: number; stories?: number },
	action: 'create' | 'restore' = 'create'
): Promise<void> {
	const addUniverses = adding.universes ?? 0;
	const addStories = adding.stories ?? 0;
	if (addUniverses === 0 && addStories === 0) return;
	const limits = await accountLimits(tx, userId);
	const universeLimit = addUniverses > 0 ? limits.max_universes : null;
	const storyLimit = addStories > 0 ? limits.max_stories : null;
	if (universeLimit === null && storyLimit === null) return;
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${userId}`}))`);
	const live = await countLive(tx, userId);
	if (universeLimit !== null && live.universes + addUniverses > universeLimit) {
		throw new QuotaExceededError(quotaMessage('max_universes', universeLimit, action));
	}
	if (storyLimit !== null && live.stories + addStories > storyLimit) {
		throw new QuotaExceededError(quotaMessage('max_stories', storyLimit, action));
	}
}

/**
 * holdCountQuota for one new story in the universe. Lock order is the row,
 * then the quota lock, then the slug lock (restoreUniverse locks the universe
 * row before the quota). The story insert's foreign-key check would take the
 * universe row after the quota lock, so this takes it first, in key share mode
 * so that creates do not wait on each other.
 */
export async function holdStoryQuota(
	tx: Database,
	userId: string,
	universeId: string
): Promise<void> {
	await tx.execute(sql`select id from universes where id = ${universeId} for key share`);
	await holdCountQuota(tx, userId, { stories: 1 });
}

/** The message of a QuotaExceededError, or undefined for anything else. */
export function quotaFailure(err: unknown): string | undefined {
	return err instanceof QuotaExceededError ? err.message : undefined;
}

// ============ Storage ============

/**
 * Locks account rows, lowest id first. Every path that changes storage use
 * locks the account before it touches asset rows (an upload, a delete, a
 * universe purge, the account purge), so two of them never deadlock.
 */
export async function lockStorageOwners(tx: Database, userIds: string[]): Promise<void> {
	for (const id of [...new Set(userIds)].sort()) {
		await tx.execute(sql`select id from users where id = ${id} for no key update`);
	}
}

/**
 * Adds bytes to the account's storage use, unless that would pass the limit.
 * The account row is locked first and the limit read under the lock, so
 * uploads at once take turns and each sees the plan as it is now. credit is
 * the size of an image the upload replaces. Run it in the same transaction as
 * the asset insert. A null limit on failure means the account is gone.
 */
export async function reserveStorage(
	tx: Database,
	userId: string,
	bytes: number,
	credit = 0
): Promise<{ ok: true } | { ok: false; limit: number | null }> {
	const locked = await tx.execute(
		sql`select storage_used_bytes::float8 as used from users where id = ${userId} for no key update`
	);
	const row = locked.rows[0] as { used: number } | undefined;
	if (!row) return { ok: false, limit: null };
	const limit = (await accountLimits(tx, userId)).storage_bytes;
	if (limit !== null && row.used - credit + bytes > limit) return { ok: false, limit };
	await tx.execute(
		sql`update users set storage_used_bytes = storage_used_bytes + ${bytes} where id = ${userId}`
	);
	return { ok: true };
}

/** Takes deleted assets' bytes off their owners' storage use. */
export async function releaseStorage(
	tx: Database,
	deleted: { ownerId: string; byteSize: number }[]
): Promise<void> {
	const byOwner = new Map<string, number>();
	for (const row of deleted) {
		byOwner.set(row.ownerId, (byOwner.get(row.ownerId) ?? 0) + row.byteSize);
	}
	for (const [ownerId, bytes] of [...byOwner].sort(([a], [b]) => (a < b ? -1 : 1))) {
		await tx.execute(sql`
			update users set storage_used_bytes = greatest(storage_used_bytes - ${bytes}, 0)
			where id = ${ownerId}
		`);
	}
}

/**
 * Rebuilds storage use from the asset rows, for one account or all of them.
 * The account row is locked before the sum is read, so an upload that commits
 * meanwhile is either in the sum or waits and adds itself after.
 */
export async function recountStorageUsed(db: Database, userId?: string): Promise<void> {
	const ids = userId
		? [userId]
		: ((await db.execute(sql`select id from users order by id`)).rows as { id: string }[]).map(
				(row) => row.id
			);
	for (const id of ids) {
		await db.transaction(async (tx) => {
			await lockStorageOwners(tx, [id]);
			await tx.execute(sql`
				update users set storage_used_bytes =
					coalesce((select sum(byte_size) from assets where owner_id = ${id}), 0)
				where id = ${id}
			`);
		});
	}
}

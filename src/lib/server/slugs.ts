import { and, eq, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { isUniqueViolation } from './db-errors.ts';
import { publications, slugHistory, stories, universes } from './db/schema.ts';
import { isUuid, slugify } from '../slug.ts';
import type { Tx } from './story-delete.ts';

// Suffix room: a deduped slug must still fit the column conventions.
const BASE_MAX = 55;

type Table = 'universes' | 'stories';

// Sent with the permanent redirect from an old public slug. A browser would
// otherwise cache the redirect for good, and a rename back to the old slug
// would then bounce the reader between the two addresses forever; no-cache
// makes it ask the server again each time.
export const OLD_SLUG_REDIRECT_HEADERS = { 'cache-control': 'no-cache' };

const historyKind = (table: Table) => (table === 'universes' ? 'universe' : 'story');
const historyTarget = (table: Table) =>
	table === 'universes' ? slugHistory.universeId : slugHistory.storyId;

/**
 * A slug for a new universe or story, unique within the owner's account:
 * the slugified name, with -2, -3, ... appended when taken. Only live rows
 * hold a slug; one in the trash has freed it. A slug that another story (or
 * universe) moved off by a rename stays reserved in slug_history, so an old
 * public link never opens a different work; selfId lets a rename take back
 * its own old slug. current, when given, is kept if still free: saveWithSlug
 * passes the row's slug when the new name slugs to the same base as the old,
 * so such a rename does not move to a lower suffix that has come free since.
 * The unique index is the real guard against live clashes; this just picks a
 * free name.
 */
export async function uniqueSlug(
	db: Database | Tx,
	table: Table,
	ownerId: string,
	name: string,
	fallback: string,
	selfId?: string,
	current?: string
): Promise<string> {
	const base = slugBase(name, fallback);
	const target = table === 'universes' ? universes : stories;
	const rows = await db
		.select({ slug: target.slug })
		.from(target)
		.where(
			and(
				eq(target.ownerId, ownerId),
				like(target.slug, `${base}%`),
				isNull(target.deletedAt),
				selfId ? ne(target.id, selfId) : undefined
			)
		);
	const reserved = await reservedSlugs(
		db,
		table,
		ownerId,
		like(slugHistory.slug, `${base}%`),
		selfId
	);
	const taken = new Set([...rows.map((row) => row.slug), ...reserved]);
	// Only a current slug under the base is in taken's range.
	if (current?.startsWith(base) && !taken.has(current) && !isUuid(current)) return current;
	// A uuid-shaped base would be looked up as an id and never resolve, so it
	// always takes a suffix.
	if (!taken.has(base) && !isUuid(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

function slugBase(name: string, fallback: string): string {
	return slugify(name, fallback).slice(0, BASE_MAX).replace(/-+$/, '') || fallback;
}

// The owner's reserved old slugs matching the condition, purged targets
// included, leaving out selfId's own.
async function reservedSlugs(
	db: Database | Tx,
	table: Table,
	ownerId: string,
	match: SQL,
	selfId?: string
): Promise<string[]> {
	const target = historyTarget(table);
	const rows = await db
		.select({ slug: slugHistory.slug })
		.from(slugHistory)
		.where(
			and(
				eq(slugHistory.ownerId, ownerId),
				eq(slugHistory.kind, historyKind(table)),
				match,
				selfId ? or(isNull(target), sql`${target} <> ${selfId}`) : undefined
			)
		);
	return rows.map((row) => row.slug);
}

// Serialises slug changes (renames and restores) within one account. Always
// taken after the row's own FOR UPDATE lock, inside the caller's transaction,
// and released at its end. Creates do not take it; the live unique index
// catches a clash with one.
async function lockSlugs(tx: Tx, ownerId: string) {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`slugs:${ownerId}`}))`);
}

// Whether a slug a row moves off is worth reserving. A story's is, once the
// story has been published: before that no public link can name it, and
// reserving it would only push suffixes onto later drafts. Purging the story
// keeps the reservation (its story_id goes null), so its old address stays
// out of reach of the account's other stories. A universe's always is: its stories' editions can be purged while the universe lives on,
// and that must not free an address readers may have shared.
async function reserveOnRename(tx: Tx, table: Table, id: string): Promise<boolean> {
	if (table === 'universes') return true;
	const [row] = await tx
		.select({ id: publications.id })
		.from(publications)
		.where(eq(publications.storyId, id))
		.limit(1);
	return Boolean(row);
}

// The row's own history entry for a slug it now holds again, removed.
async function forgetOwnSlug(tx: Tx, table: Table, ownerId: string, id: string, slug: string) {
	await tx
		.delete(slugHistory)
		.where(
			and(
				eq(slugHistory.ownerId, ownerId),
				eq(slugHistory.kind, historyKind(table)),
				eq(slugHistory.slug, slug),
				eq(historyTarget(table), id)
			)
		);
}

// The row, locked for the rest of the transaction.
async function lockedRow(tx: Tx, table: Table, id: string) {
	const [row] =
		table === 'universes'
			? await tx
					.select({ ownerId: universes.ownerId, name: universes.name, slug: universes.slug })
					.from(universes)
					.where(eq(universes.id, id))
					.for('update')
			: await tx
					.select({ ownerId: stories.ownerId, name: stories.title, slug: stories.slug })
					.from(stories)
					.where(eq(stories.id, id))
					.for('update');
	return row ?? null;
}

/**
 * Saves a universe or story with a name that may have changed, and its slug.
 * In one transaction: locks the row and compares the name with the one it has
 * now, so a save that read an older name cannot leave the slug behind. On a
 * rename it also takes the account's slug lock, picks a new slug, lets write
 * save the row, and records the move: a slug it takes back stops being its
 * history, and the slug it leaves is reserved for it (see reserveOnRename), so
 * an old public link redirects and no other work of the account can take it.
 * Retries once if a concurrent create takes the pick. Returns the slug, or
 * null when the row no longer exists.
 */
export async function saveWithSlug(
	db: Database,
	table: Table,
	id: string,
	name: string,
	write: (tx: Tx, slug: string) => Promise<void>
): Promise<string | null> {
	const fallback = table === 'universes' ? 'universe' : 'story';
	const attempt = () =>
		db.transaction(async (tx) => {
			const row = await lockedRow(tx, table, id);
			if (!row) return null;
			if (row.name === name) {
				await write(tx, row.slug);
				return row.slug;
			}
			await lockSlugs(tx, row.ownerId);
			const keep =
				slugBase(row.name, fallback) === slugBase(name, fallback) ? row.slug : undefined;
			const slug = await uniqueSlug(tx, table, row.ownerId, name, fallback, id, keep);
			await write(tx, slug);
			if (slug !== row.slug) {
				await forgetOwnSlug(tx, table, row.ownerId, id, slug);
				if (await reserveOnRename(tx, table, id)) {
					// Under the lock the old slug carries no other reservation (it was
					// this row's live slug until now), so a conflict is its own row.
					await tx
						.insert(slugHistory)
						.values({
							ownerId: row.ownerId,
							kind: historyKind(table),
							slug: row.slug,
							...(table === 'universes' ? { universeId: id } : { storyId: id })
						})
						.onConflictDoNothing();
				}
			}
			return slug;
		});
	try {
		return await attempt();
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		return await attempt();
	}
}

/**
 * Takes a universe or story out of the trash. A live row may have claimed its
 * slug meanwhile; it then comes back under a fresh one picked from its name,
 * the same as a rename. It does the same when its slug became another one's
 * reserved old slug while it sat in the trash (taken, then renamed away), so
 * that one's old links keep their target. Runs under the account's slug lock;
 * retries if a concurrent create takes the pick.
 *
 * Nothing is done here for the Assistant: what it wrote from the scenes as
 * they were without this story reads as out of date by its fingerprint.
 */
export async function untrash(db: Database, table: Table, id: string) {
	// Each attempt runs in a transaction of its own (a savepoint when the
	// caller passed one), so a taken slug does not abort the caller's
	// transaction.
	const fallback = table === 'universes' ? 'universe' : 'story';
	const attempt = (forceFresh: boolean) =>
		db.transaction(async (tx) => {
			const row = await lockedRow(tx, table, id);
			if (!row) return;
			await lockSlugs(tx, row.ownerId);
			const reserved = await reservedSlugs(
				tx,
				table,
				row.ownerId,
				eq(slugHistory.slug, row.slug),
				id
			);
			const slug =
				forceFresh || reserved.length > 0
					? await uniqueSlug(tx, table, row.ownerId, row.name, fallback, id)
					: row.slug;
			if (table === 'universes') {
				await tx.update(universes).set({ deletedAt: null, slug }).where(eq(universes.id, id));
			} else {
				await tx.update(stories).set({ deletedAt: null, slug }).where(eq(stories.id, id));
			}
			// Back under one of its own old slugs, that slug is current again.
			// The slug it leaves is not reserved: a trashed row's slug is
			// already free to take.
			await forgetOwnSlug(tx, table, row.ownerId, id, slug);
		});
	const attempts = [false, true, true];
	for (const [i, forceFresh] of attempts.entries()) {
		try {
			await attempt(forceFresh);
			return;
		} catch (err) {
			if (!isUniqueViolation(err) || i === attempts.length - 1) throw err;
		}
	}
}

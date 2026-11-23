import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { isUniqueViolation } from './db-errors.ts';
import { entityCategories, stories, universes } from './db/schema';
import { uniqueSlug, untrash } from './slugs';
import { holdCountQuota, holdStoryQuota } from './quotas.ts';

// Creates a story with a readable slug, shared by the library's new-story
// card and the universe plan board. Retries once when a concurrent create
// takes the picked slug between the pick and the insert. Throws
// QuotaExceededError when the account is at its story limit.
export async function createStoryInUniverse(
	db: Database,
	ownerId: string,
	universeId: string,
	title: string
) {
	const create = (slug: string) =>
		db.transaction(async (tx) => {
			await holdStoryQuota(tx, ownerId, universeId);
			const [story] = await tx
				.insert(stories)
				.values({ universeId, ownerId, title, slug })
				.returning();
			return story;
		});
	try {
		return await create(await uniqueSlug(db, 'stories', ownerId, title, 'story'));
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		return await create(await uniqueSlug(db, 'stories', ownerId, title, 'story'));
	}
}

// Every universe starts with a couple of categories; writers rename and
// extend from there.
async function addStarterCategories(db: Database, universeId: string, ownerId: string) {
	await db.insert(entityCategories).values([
		{ universeId, ownerId, name: 'Lore', sortOrder: 0 },
		{ universeId, ownerId, name: 'Faction', sortOrder: 1 }
	]);
}

// Creates a universe from the library, with the same slug retry as a story.
// Throws QuotaExceededError when the account is at its universe limit.
export async function createUniverse(db: Database, ownerId: string, name: string) {
	const create = (slug: string) =>
		db.transaction(async (tx) => {
			await holdCountQuota(tx, ownerId, { universes: 1 });
			const [row] = await tx.insert(universes).values({ ownerId, name, slug }).returning();
			await addStarterCategories(tx, row.id, ownerId);
			return row;
		});
	try {
		return await create(await uniqueSlug(db, 'universes', ownerId, name, 'universe'));
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		return await create(await uniqueSlug(db, 'universes', ownerId, name, 'universe'));
	}
}

// The home for stories that do not fit a universe: one per owner, created
// lazily the first time it is needed. A full universe like any other, so
// characters, mentions, export, and publishing all keep working; a partial
// unique index keeps concurrent first uses to a single row.
export const STANDALONE_UNIVERSE_NAME = 'Standalone stories';

export async function standaloneUniverse(db: Database, ownerId: string) {
	// Look up the standalone row regardless of liveness: the partial unique
	// index allows only one per owner whether live or trashed, so a trashed
	// row still blocks an insert. If the owner trashed it, revive it rather
	// than let the insert fail and drop their new story into a trashed
	// universe (invisible, then purged after the trash window).
	const [existing] = await db
		.select()
		.from(universes)
		.where(and(eq(universes.ownerId, ownerId), eq(universes.standalone, true)));
	if (existing) return reviveIfTrashed(db, existing);
	try {
		const [created] = await db
			.insert(universes)
			.values({
				ownerId,
				name: STANDALONE_UNIVERSE_NAME,
				slug: await uniqueSlug(db, 'universes', ownerId, STANDALONE_UNIVERSE_NAME, 'universe'),
				standalone: true
			})
			.returning();
		// The same starter categories every universe gets, so lore entries
		// (which need a category) work here too.
		await addStarterCategories(db, created.id, ownerId);
		return created;
	} catch (err) {
		// A concurrent request created it between the select and the insert.
		if (!isUniqueViolation(err)) throw err;
		const [winner] = await db
			.select()
			.from(universes)
			.where(and(eq(universes.ownerId, ownerId), eq(universes.standalone, true)));
		return reviveIfTrashed(db, winner);
	}
}

// Brings a trashed standalone universe back so a new story has a live home.
// Its live stories come back with it, so there must be room for them and the
// new story; otherwise this throws QuotaExceededError and nothing is revived.
async function reviveIfTrashed(db: Database, universe: typeof universes.$inferSelect) {
	if (!universe.deletedAt) return universe;
	await db.transaction(async (tx) => {
		// The row before the quota lock, as restoreUniverse takes them.
		await tx.execute(sql`select id from universes where id = ${universe.id} for update`);
		const [inside] = await tx
			.select({ n: count() })
			.from(stories)
			.where(and(eq(stories.universeId, universe.id), isNull(stories.deletedAt)));
		if (inside.n > 0) await holdCountQuota(tx, universe.ownerId, { stories: inside.n + 1 });
		await untrash(tx, 'universes', universe.id);
	});
	// Re-read: the restore may have given it a fresh slug.
	const [live] = await db.select().from(universes).where(eq(universes.id, universe.id));
	return live ?? { ...universe, deletedAt: null };
}

// Universe trash and the purge cascade. Deleting a universe is a soft
// delete: it leaves every live read at once but sits restorable for the
// window below, after which the worker purges it for good. The cascade is
// shared with the account purge. Runs in the worker too.
import { and, count, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from './auth.ts';
import {
	assets,
	assistantChatMessages,
	assistantChatSummaries,
	assistantChats,
	entityCategories,
	entityRelationships,
	exportArtifacts,
	notes,
	publications,
	relationTypes,
	revisions,
	stories,
	universes
} from './db/schema.ts';
import { scheduleObjectDeletions } from './assets.ts';
import { untrash } from './slugs.ts';
import { holdCountQuota, lockStorageOwners } from './quotas.ts';
import { ENTITY_TYPES, entityTable } from './entity-lookups.ts';
import { deleteStoryWithin, trashedFor, type Tx } from './story-delete.ts';
import { ownedUniverseRow } from './universe-scope.ts';

export const UNIVERSE_TRASH_DAYS = 30;

/** Moves a universe to the trash. Everything inside stops resolving at
 * once; published editions stay frozen until the purge. */
export async function trashUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<boolean> {
	const universe = await ownedUniverseRow(db, userId, universeId);
	if (!universe) return false;
	await db
		.update(universes)
		.set({ deletedAt: sql`now()` })
		.where(eq(universes.id, universe.id));
	return true;
}

/** Brings a trashed universe back whole; nothing inside was touched. Its
 * slug may have been reused meanwhile, in which case it gets a fresh one. */
export async function restoreUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<boolean> {
	return db.transaction(async (tx) => {
		// A second restore of the same universe waits here, then finds it live
		// and does nothing, rather than counting it against the limit.
		await tx.execute(
			sql`select id from universes where id = ${universeId} and owner_id = ${userId} for update`
		);
		const universe = await ownedUniverseRow(tx, userId, universeId, { deleted: true });
		if (!universe) return false;
		// Its live stories come back with it, so they count as well.
		const [inside] = await tx
			.select({ standalone: universes.standalone, stories: count(stories.id) })
			.from(universes)
			.leftJoin(stories, and(eq(stories.universeId, universes.id), isNull(stories.deletedAt)))
			.where(eq(universes.id, universe.id))
			.groupBy(universes.id);
		await holdCountQuota(
			tx,
			userId,
			{ universes: inside.standalone ? 0 : 1, stories: inside.stories },
			'restore'
		);
		await untrash(tx, 'universes', universe.id);
		return true;
	});
}

export type TrashedUniverse = {
	id: string;
	name: string;
	deletedAt: Date;
	daysLeft: number;
};

/** The dashboard's deleted-universes block, newest deletion first. */
export async function listTrashedUniverses(
	db: Database,
	userId: string
): Promise<TrashedUniverse[]> {
	const rows = await db
		.select({ id: universes.id, name: universes.name, deletedAt: universes.deletedAt })
		.from(universes)
		.where(and(eq(universes.ownerId, userId), isNotNull(universes.deletedAt)))
		.orderBy(sql`${universes.deletedAt} desc`);
	return rows.map((row) => {
		const deletedAt = row.deletedAt as Date;
		const elapsed = Date.now() - deletedAt.getTime();
		const daysLeft = Math.max(0, UNIVERSE_TRASH_DAYS - Math.floor(elapsed / 86_400_000));
		return { id: row.id, name: row.name, deletedAt, daysLeft };
	});
}

/** Deletes a trashed universe for good, right now. Owner-guarded. */
export async function destroyUniverse(
	db: Database,
	userId: string,
	universeId: string
): Promise<{ ok: boolean }> {
	const universe = await ownedUniverseRow(db, userId, universeId, { deleted: true });
	if (!universe) return { ok: false };
	return { ok: await purgeUniverse(db, universe.id) };
}

/**
 * Hard-deletes a universe in the trash and queues its stored files for the
 * deferred sweep (see scheduleObjectDeletions). Nothing happens, and false
 * comes back, when the universe is no longer in the trash (a restore got there
 * first) or, with dueAfterDays, has not been there that long: the scheduled
 * purge read its list before the lock.
 *
 * Its images are not deleted here: purgeUniverseWithin leaves them marked as
 * unused, and the unused image sweep frees each once it is due and nothing
 * shows it. Reading every column for uses while holding the account row would
 * stall that account's uploads and saves.
 */
export async function purgeUniverse(
	db: Database,
	universeId: string,
	options: { dueAfterDays?: number } = {}
): Promise<boolean> {
	return db.transaction(async (tx) => {
		// The account rows before the universe row: every storage path locks
		// the account first (see lockStorageOwners), and the purge changes the
		// images. The universe row is then read under its lock, so a restore
		// (which locks it for update) either finished before this or waits for
		// it. No key update leaves foreign-key checks on the universe free until
		// the row is deleted at the end, as before.
		await lockStorageOwners(tx, await universeImageOwners(tx, universeId));
		const [row] = await tx
			.select({
				deletedAt: universes.deletedAt,
				due: trashedFor(universes.deletedAt, options.dueAfterDays)
			})
			.from(universes)
			.where(eq(universes.id, universeId))
			.for('no key update');
		if (!row?.deletedAt || !row.due) return false;
		const fileKeys = await universeEditionFileKeys(tx, universeId);
		await purgeUniverseWithin(tx, universeId);
		await scheduleObjectDeletions(tx, fileKeys);
		return true;
	});
}

async function universeImageOwners(db: Database | Tx, universeId: string): Promise<string[]> {
	const rows = await db
		.selectDistinct({ ownerId: assets.ownerId })
		.from(assets)
		.where(eq(assets.universeId, universeId));
	return rows.map((row) => row.ownerId);
}

/** Universes whose trash window has elapsed and are due for the purge. */
export async function listUniversesDueForPurge(db: Database): Promise<string[]> {
	const rows = await db
		.select({ id: universes.id })
		.from(universes)
		.where(
			and(
				isNotNull(universes.deletedAt),
				lte(universes.deletedAt, sql`now() - make_interval(days => ${UNIVERSE_TRASH_DAYS})`)
			)
		);
	return rows.map((row) => row.id);
}

/** The bucket keys of the stored export files of the universe's editions,
 * whose rows cascade away with their publications in the purge. */
export async function universeEditionFileKeys(
	db: Database | Tx,
	universeId: string
): Promise<string[]> {
	const rows = await db
		.select({ storageKey: exportArtifacts.storageKey })
		.from(exportArtifacts)
		.innerJoin(publications, eq(exportArtifacts.publicationId, publications.id))
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(eq(stories.universeId, universeId));
	return rows.map((row) => row.storageKey);
}

/**
 * Hard-deletes a universe and everything in it, child-first, within the
 * caller's transaction. Shared by the trash purge and the account purge. Its
 * images are left in place, no longer tied to the universe and marked as
 * unused (an earlier mark is kept), for the unused image sweep to free.
 */
export async function purgeUniverseWithin(tx: Tx, universeId: string): Promise<void> {
	// The owners of the images the detach below changes, locked before any
	// other row (see lockStorageOwners).
	await lockStorageOwners(tx, await universeImageOwners(tx, universeId));

	// Stories first: each clears its scenes, chapters, markers, revisions,
	// memberships, notes, publications, reviews, and mentions.
	const storyRows = await tx
		.select({ id: stories.id })
		.from(stories)
		.where(eq(stories.universeId, universeId));
	for (const story of storyRows) await deleteStoryWithin(tx, story.id);

	// Universe-scoped Assistant transcripts (the universe-Plan threads); the
	// story-scoped ones went with their stories above.
	await tx.delete(assistantChatMessages).where(eq(assistantChatMessages.universeId, universeId));
	await tx.delete(assistantChatSummaries).where(eq(assistantChatSummaries.universeId, universeId));
	await tx.delete(assistantChats).where(eq(assistantChats.universeId, universeId));

	// Universe-scoped freeform notes (story notes went with their stories) and
	// their polymorphic revisions.
	const noteRows = await tx
		.select({ id: notes.id })
		.from(notes)
		.where(eq(notes.universeId, universeId));
	if (noteRows.length > 0) {
		const noteIds = noteRows.map((row) => row.id);
		await tx
			.delete(revisions)
			.where(and(eq(revisions.entityType, 'note'), inArray(revisions.entityId, noteIds)));
		await tx.delete(notes).where(eq(notes.universeId, universeId));
	}

	// Entity history is polymorphic (no FK), so it goes by the entity ids.
	const entityIds: string[] = [];
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		const rows = await tx
			.select({ id: table.id })
			.from(table)
			.where(eq(table.universeId, universeId));
		entityIds.push(...rows.map((row) => row.id));
	}
	if (entityIds.length > 0) {
		await tx.delete(revisions).where(inArray(revisions.entityId, entityIds));
	}

	// Relationships before their types, entities before their categories.
	await tx.delete(entityRelationships).where(eq(entityRelationships.universeId, universeId));
	await tx.delete(relationTypes).where(eq(relationTypes.universeId, universeId));
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		await tx.delete(table).where(eq(table.universeId, universeId));
	}
	await tx.delete(entityCategories).where(eq(entityCategories.universeId, universeId));
	await tx
		.update(assets)
		.set({ universeId: null, unreferencedSince: sql`coalesce(${assets.unreferencedSince}, now())` })
		.where(eq(assets.universeId, universeId));
	await tx.delete(universes).where(eq(universes.id, universeId));
}

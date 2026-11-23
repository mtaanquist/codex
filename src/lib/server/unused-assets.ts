import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { assets } from './db/schema.ts';
import { scheduleObjectDeletions } from './assets.ts';
import { lockStorageOwners, releaseStorage } from './quotas.ts';

// Freeing the storage of images nothing uses any more: the images a purged
// story leaves behind (purgeStory) and the daily sweep of every image no row
// points at (sweepUnusedAssets). Deleting an image a writer still uses is the
// one mistake this must never make, so "used" is read as widely as possible:
// an image is in use while its id appears anywhere in the database outside
// its own assets row. That is every uuid column (covers, avatars, badges,
// publication_assets) and the text of every text, json and array column
// (scene and draft bodies, saved drafts, staged drafts, frozen editions,
// history, notes, review suggestions, chat transcripts, settings). Columns are
// read from the catalog on each run rather than listed here, so a table added
// later is covered without anyone remembering to add it.
//
// Rows in the trash still exist, so an image a trashed story or scene uses is
// kept until that is purged. A deleted row's object is only queued
// (scheduleObjectDeletions) and removed after the backup retention window.

// An image newer than this is never freed: it may have just been pasted into
// the editor and not saved yet.
export const UNUSED_ASSET_GRACE_HOURS = 24;

// Ids checked per query, and asset rows locked per transaction.
const BATCH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type Column = { table: string; column: string; uuid: boolean };

// Every column that could hold an asset id. Numbers, booleans, dates and
// bytes cannot, so they are skipped; anything else is read as text.
async function referenceColumns(db: Database): Promise<Column[]> {
	const result = await db.execute(sql`
		select c.table_name as "table", c.column_name as "column", c.data_type = 'uuid' as uuid
		from information_schema.columns c
		join information_schema.tables t
			on t.table_schema = c.table_schema and t.table_name = c.table_name
		where c.table_schema = current_schema()
			and t.table_type = 'BASE TABLE'
			and c.table_name <> 'assets'
			and c.data_type in (
				'uuid', 'text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY',
				'USER-DEFINED'
			)
		order by c.table_name, c.column_name
	`);
	return result.rows as Column[];
}

/**
 * The ids among these that any row references (see the note at the top).
 * One statement, so every table is read from the same snapshot: a reference
 * moving from one table to another while this runs is seen in one of them.
 */
export async function findReferencedAssets(db: Database, ids: string[]): Promise<Set<string>> {
	const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
	if (wanted.length === 0) return new Set();
	if (!wanted.every((id) => UUID_RE.test(id))) throw new Error('asset ids must be uuids');
	const pattern = sql.raw(`'${UUID_PATTERN}'`);
	const parts: SQL[] = (await referenceColumns(db)).map(({ table, column, uuid }) => {
		const t = sql.identifier(table);
		const c = sql.identifier(column);
		return uuid
			? sql`select ${t}.${c}::text as id from ${t}
				where ${t}.${c} in (select id::uuid from wanted)`
			: sql`select lower(m[1]) as id from ${t}
				cross join lateral regexp_matches(${t}.${c}::text, ${pattern}, 'gi') as m
				where lower(m[1]) in (select id from wanted)`;
	});
	if (parts.length === 0) return new Set();
	const result = await db.execute(sql`
		with wanted as (select unnest(string_to_array(${wanted.join(',')}, ',')) as id)
		select distinct id from (${sql.join(parts, sql` union all `)}) refs
	`);
	return new Set((result.rows as { id: string }[]).map((row) => row.id));
}

const pastGrace = (graceHours: number) =>
	lte(assets.createdAt, sql`now() - make_interval(hours => ${graceHours})`);

/**
 * Deletes those of the given assets that nothing references, within the
 * caller's transaction, and gives their bytes back. The owners' account rows
 * are locked first and then the asset rows, the order every storage path
 * takes (see lockStorageOwners), and the references are checked again under
 * those locks: a check made before the transaction could be stale. A badge or
 * edition set meanwhile waits on the asset row lock (its foreign key) and is
 * seen by the check once it commits.
 */
export async function deleteUnreferencedAssets(
	tx: Database,
	candidates: { id: string; ownerId: string }[],
	graceHours = UNUSED_ASSET_GRACE_HOURS
): Promise<{ count: number; bytes: number }> {
	let count = 0;
	let bytes = 0;
	for (let start = 0; start < candidates.length; start += BATCH) {
		const chunk = candidates.slice(start, start + BATCH);
		await lockStorageOwners(
			tx,
			chunk.map((row) => row.ownerId)
		);
		const locked = await tx
			.select({ id: assets.id })
			.from(assets)
			.where(
				and(
					inArray(
						assets.id,
						chunk.map((row) => row.id)
					),
					pastGrace(graceHours)
				)
			)
			.orderBy(asc(assets.id))
			.for('update');
		if (locked.length === 0) continue;
		const referenced = await findReferencedAssets(
			tx,
			locked.map((row) => row.id)
		);
		const unused = locked.map((row) => row.id).filter((id) => !referenced.has(id));
		if (unused.length === 0) continue;
		const deleted = await tx.delete(assets).where(inArray(assets.id, unused)).returning({
			storageKey: assets.storageKey,
			ownerId: assets.ownerId,
			byteSize: assets.byteSize
		});
		await releaseStorage(tx, deleted);
		await scheduleObjectDeletions(
			tx,
			deleted.map((row) => row.storageKey)
		);
		count += deleted.length;
		bytes += deleted.reduce((sum, row) => sum + row.byteSize, 0);
	}
	return { count, bytes };
}

/**
 * The assets a story purge should try to free, read before the story's rows
 * go: the owner's images in the story's universe (covers and inline images
 * are uploaded there) that are past the grace period. Any that something else
 * still uses survive deleteUnreferencedAssets.
 */
export async function storyAssetCandidates(
	tx: Database,
	story: { ownerId: string; universeId: string },
	graceHours = UNUSED_ASSET_GRACE_HOURS
): Promise<{ id: string; ownerId: string }[]> {
	return tx
		.select({ id: assets.id, ownerId: assets.ownerId })
		.from(assets)
		.where(
			and(
				eq(assets.ownerId, story.ownerId),
				eq(assets.universeId, story.universeId),
				pastGrace(graceHours)
			)
		)
		.orderBy(asc(assets.id));
}

/**
 * Deletes every asset past the grace period that nothing references, a batch
 * at a time. Each batch is checked without locks first, so most batches end
 * there; only the unused ones are locked and checked again before deleting.
 */
export async function sweepUnusedAssets(
	db: Database,
	graceHours = UNUSED_ASSET_GRACE_HOURS
): Promise<{ count: number; bytes: number }> {
	let count = 0;
	let bytes = 0;
	let after = '00000000-0000-0000-0000-000000000000';
	for (;;) {
		const batch = await db
			.select({ id: assets.id, ownerId: assets.ownerId })
			.from(assets)
			.where(and(gt(assets.id, after), pastGrace(graceHours)))
			.orderBy(asc(assets.id))
			.limit(BATCH);
		if (batch.length === 0) break;
		after = batch[batch.length - 1].id;
		const referenced = await findReferencedAssets(
			db,
			batch.map((row) => row.id)
		);
		const unused = batch.filter((row) => !referenced.has(row.id));
		if (unused.length === 0) continue;
		const freed = await db.transaction((tx) => deleteUnreferencedAssets(tx, unused, graceHours));
		count += freed.count;
		bytes += freed.bytes;
	}
	return { count, bytes };
}

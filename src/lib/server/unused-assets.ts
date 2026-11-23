import { sql, type SQL } from 'drizzle-orm';
import type { Database } from './auth.ts';
import { scheduleObjectDeletions } from './assets.ts';
import { releaseStorage } from './quotas.ts';
import { logEvent } from './log.ts';

// Frees the storage of uploaded images nothing uses any more: the worker's
// sweepUnusedAssets, nightly and after a story is deleted for good. Deleting
// an image a writer still uses is the one mistake this must never make, so
// "used" is read as widely as possible: an image is in use while its id
// appears anywhere in the database outside its own assets row. That is every
// uuid column (covers, avatars, badges, publication_assets) and the text of
// every text, json and array column (scene and draft bodies, saved drafts,
// staged drafts, frozen editions, history, notes, review suggestions, chat
// transcripts, settings). Columns are read from the catalog on each run
// rather than listed here, so a table added later is covered without anyone
// remembering to add it. Rows in the trash still exist, so their images stay.
//
// An id typed into any row keeps the image, whoever wrote it: another
// writer's prose naming it keeps it counted against its owner. That is
// accepted (see docs/design/schema.md); narrowing the check would risk
// deleting an image someone still shows.

// Deleting is in two phases. A run that finds an image unused marks it
// (assets.unreferenced_since) and keeps it; a run that finds it in use again
// clears the mark. Only an image unused for UNREFERENCED_DAYS since its mark
// is deleted, so one taken out of a field with no history (a description, a
// bio) can still come back from an open tab's undo or a save that is retrying.
export const UNREFERENCED_DAYS = 30;
// An image newer than this is never freed, however long it has been unused:
// it may sit only in an editor that has not saved yet.
export const UNUSED_ASSET_GRACE_DAYS = 30;
// How much longer than usual a freed image's stored file is kept, so it can
// still be restored by hand from the logged row (assets.unused_deleted).
export const FREED_OBJECT_EXTRA_DAYS = 30;

// Images deleted per transaction, so each holds its locks briefly.
const CHUNK = 100;

const UUID_PATTERN = sql.raw(`'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'`);

type Column = { table: string; column: string; uuid: boolean };

// Every column that could hold an asset id, from pg_catalog rather than
// information_schema (which leaves out columns the role has no privilege
// on). Numbers, booleans, dates, network and bit types, bytes and search
// vectors cannot hold one; anything else is read as text.
export async function referenceColumns(db: Database): Promise<Column[]> {
	const result = await db.execute(sql`
		select c.relname as "table", a.attname as "column", t.typname = 'uuid' as uuid
		from pg_class c
		join pg_namespace n on n.oid = c.relnamespace
		join pg_attribute a on a.attrelid = c.oid
		join pg_type t on t.oid = a.atttypid
		where n.nspname = current_schema()
			and c.relkind in ('r', 'p')
			and not c.relispartition
			and c.relname <> 'assets'
			and a.attnum > 0
			and not a.attisdropped
			and t.typcategory not in ('N', 'B', 'D', 'T', 'G', 'I', 'V')
			and t.typname not in ('bytea', 'tsvector', 'tsquery')
		order by c.relname, a.attname
	`);
	const columns = result.rows as Column[];
	// A catalog read that comes back without the tables prose lives in would
	// make every image look unused; refuse to go on.
	for (const [table, column] of [
		['scenes', 'body_md'],
		['revisions', 'body_md'],
		['stories', 'cover_asset_id']
	]) {
		if (!columns.some((c) => c.table === table && c.column === column)) {
			throw new Error(`unused-asset check cannot see ${table}.${column}`);
		}
	}
	return columns;
}

// The ids (as lowercase text) among `wanted` that the given columns hold.
// wanted is a query yielding one text column named id.
function referencesIn(columns: Column[], wanted: SQL): SQL {
	const parts = columns.map(({ table, column, uuid }) => {
		const t = sql.identifier(table);
		const c = sql.identifier(column);
		return uuid
			? sql`select ${t}.${c}::text as id from ${t}
				where ${t}.${c} in (select w.id::uuid from (${wanted}) w)`
			: sql`select lower(m[1]) as id from ${t}
				cross join lateral regexp_matches(${t}.${c}::text, ${UUID_PATTERN}, 'gi') as m
				where lower(m[1]) in (select w.id from (${wanted}) w)`;
	});
	return sql.join(parts, sql` union all `);
}

const daysAgo = (days: number) => sql`now() - make_interval(days => ${days})`;
// Unused long enough and uploaded long enough ago to delete.
const dueSql = sql`coalesce(unreferenced_since <= ${daysAgo(UNREFERENCED_DAYS)}
	and created_at <= ${daysAgo(UNUSED_ASSET_GRACE_DAYS)}, false)`;
const ownedBy = (ownerId: string | undefined) => (ownerId ? sql`owner_id = ${ownerId}` : sql`true`);

export type UnusedAsset = { id: string; ownerId: string; marked: boolean; due: boolean };

/**
 * The full read, in one statement: every column is read once, from one
 * snapshot, so a reference moving between tables while it runs (a staged
 * draft accepted into a scene) is seen in one of them. Returns the images
 * nothing uses (of one account, or all), and the marked ones in use again.
 */
export async function scanAssetUse(
	db: Database,
	options: { ownerId?: string } = {}
): Promise<{ unused: UnusedAsset[]; backInUse: string[] }> {
	const columns = await referenceColumns(db);
	const result = await db.execute(sql`
		with scope as materialized (
			select id::text as id, owner_id::text as owner_id,
				unreferenced_since is not null as marked, ${dueSql} as due
			from assets where ${ownedBy(options.ownerId)}
		),
		refs as materialized (select distinct id from (${referencesIn(columns, sql`select id from scope`)}) r)
		select scope.id, scope.owner_id as "ownerId", scope.marked, scope.due,
			refs.id is not null as referenced
		from scope left join refs on refs.id = scope.id
		where refs.id is null or scope.marked
		order by scope.owner_id, scope.id
	`);
	const rows = result.rows as (UnusedAsset & { referenced: boolean })[];
	return {
		unused: rows
			.filter((row) => !row.referenced)
			.map(({ id, ownerId, marked, due }) => ({ id, ownerId, marked, due })),
		backInUse: rows.filter((row) => row.referenced).map((row) => row.id)
	};
}

/**
 * Marks the unused images not yet marked, and clears the marks of the ones in
 * use again. A mark skips a row another session holds (the next run marks
 * it). A clear never skips one: a mark left on an image in use would let it go
 * early once it is out of use again. Each clear is its own statement, so it
 * waits while holding nothing.
 */
async function recordAssetUse(
	db: Database,
	scan: { unused: UnusedAsset[]; backInUse: string[] }
): Promise<void> {
	const fresh = scan.unused.filter((row) => !row.marked).map((row) => row.id);
	if (fresh.length > 0) {
		await db.execute(sql`
			update assets set unreferenced_since = now()
			where id in (
				select id from assets
				where id::text = any(string_to_array(${fresh.join(',')}, ','))
					and unreferenced_since is null
				for update skip locked
			)
		`);
	}
	await clearMarks(db, scan.backInUse);
}

async function clearMarks(db: Database, ids: string[]): Promise<void> {
	for (const id of ids) {
		await db.execute(
			sql`update assets set unreferenced_since = null where id = ${id} and unreferenced_since is not null`
		);
	}
}

/**
 * Which of the given image ids some row still references, by the same wide
 * reading as scanAssetUse, so a reference saved after an earlier full read is
 * caught. It reads every row of every column: never run it while holding
 * locks others wait on.
 */
async function referencedAssetIds(
	db: Database,
	ids: string[],
	columns?: Column[]
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const wanted = sql`select unnest(string_to_array(${ids.join(',')}, ',')) as id`;
	const result = await db.execute(
		sql`select distinct id from (${referencesIn(columns ?? (await referenceColumns(db)), wanted)}) refs`
	);
	return new Set((result.rows as { id: string }[]).map((row) => row.id));
}

type Freed = {
	id: string;
	ownerId: string;
	storageKey: string;
	byteSize: number;
	contentType: string;
	kind: string;
	filename: string;
	universeId: string | null;
	createdAt: string;
};

/**
 * Deletes the given due images (from scanAssetUse) that are still unused, a
 * chunk per transaction, and gives their bytes back. Every column is read
 * again for the chunk first, outside any lock, so a reference saved after the
 * full read is caught. Only then does a short transaction lock the owners'
 * account rows and then the image rows (the order every storage path takes,
 * see lockStorageOwners), skipping any another session holds (those are left
 * for the next run), and delete the rows still marked for long enough. An
 * upload or profile save of the same account waits only for that short
 * transaction. The stored files are queued to go later
 * (scheduleObjectDeletions), never removed here.
 */
export async function deleteUnusedAssets(
	db: Database,
	candidates: { id: string; ownerId: string }[]
): Promise<Freed[]> {
	if (candidates.length === 0) return [];
	const columns = await referenceColumns(db);
	const freed: Freed[] = [];
	for (let start = 0; start < candidates.length; start += CHUNK) {
		const chunk = candidates.slice(start, start + CHUNK);
		const referenced = await referencedAssetIds(
			db,
			chunk.map((row) => row.id),
			columns
		);
		await clearMarks(db, [...referenced]);
		const unused = chunk.filter((row) => !referenced.has(row.id));
		if (unused.length === 0) continue;
		const ids = unused.map((row) => row.id).join(',');
		const owners = [...new Set(unused.map((row) => row.ownerId))].sort().join(',');
		const deleted = await db.transaction(async (tx) => {
			const locked = await tx.execute(sql`
				select id from users where id::text = any(string_to_array(${owners}, ','))
				order by id for no key update skip locked
			`);
			if (locked.rows.length === 0) return [];
			const lockedOwners = (locked.rows as { id: string }[]).map((row) => row.id).join(',');
			// Still there, still marked for long enough: a run that saw the
			// image in use since cleared its mark.
			const rows = await tx.execute(sql`
				select id::text as id from assets
				where id::text = any(string_to_array(${ids}, ','))
					and owner_id::text = any(string_to_array(${lockedOwners}, ','))
					and ${dueSql}
				order by id for update skip locked
			`);
			const held = (rows.rows as { id: string }[]).map((row) => row.id);
			if (held.length === 0) return [];
			const result = await tx.execute(sql`
				delete from assets where id::text = any(string_to_array(${held.join(',')}, ','))
				returning id::text as id, owner_id::text as "ownerId", storage_key as "storageKey",
					byte_size::float8 as "byteSize", content_type as "contentType", kind, filename,
					universe_id::text as "universeId", created_at::text as "createdAt"
			`);
			const gone = result.rows as Freed[];
			await freeAssetFiles(tx, gone);
			return gone;
		});
		freed.push(...deleted);
	}
	for (const row of freed) logFreed(row);
	return freed;
}

/** Gives deleted images' bytes back and queues their files to go, kept
 * FREED_OBJECT_EXTRA_DAYS longer than usual. Run in the deleting transaction. */
async function freeAssetFiles(
	tx: Database,
	gone: { ownerId: string; byteSize: number; storageKey: string }[]
): Promise<void> {
	await releaseStorage(tx, gone);
	await scheduleObjectDeletions(
		tx,
		gone.map((row) => row.storageKey),
		FREED_OBJECT_EXTRA_DAYS
	);
}

/** Enough to put a freed image's row back by hand while its file is kept. */
function logFreed(row: Freed): void {
	logEvent('info', 'assets.unused_deleted', row);
}

/** One run of the sweep, over every account or one: one full read, the
 * marks, then the deletes. */
export async function sweepUnusedAssets(
	db: Database,
	options: { ownerId?: string } = {}
): Promise<{ count: number; bytes: number }> {
	const scan = await scanAssetUse(db, options);
	await recordAssetUse(db, scan);
	const freed = await deleteUnusedAssets(
		db,
		scan.unused.filter((row) => row.due)
	);
	return { count: freed.length, bytes: freed.reduce((sum, row) => sum + row.byteSize, 0) };
}

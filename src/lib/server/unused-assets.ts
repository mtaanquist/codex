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

// An image newer than this is never freed. It may sit only in an editor that
// has not saved yet, a save still retrying, or the undo history of an open
// tab; autosaves a couple of minutes apart share one history entry, so an
// image added and taken out again in one sitting may be in no saved row.
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

const pastGrace = (graceDays: number) =>
	sql`created_at <= now() - make_interval(days => ${graceDays})`;

/**
 * The images past the grace period that no row references, in one statement:
 * every column is read once, from one snapshot, so a reference moving between
 * tables while it runs (a staged draft accepted into a scene) is seen in one
 * of them.
 */
export async function findUnusedAssets(
	db: Database,
	graceDays = UNUSED_ASSET_GRACE_DAYS
): Promise<{ id: string; ownerId: string }[]> {
	const columns = await referenceColumns(db);
	const result = await db.execute(sql`
		with old as (
			select id::text as id, owner_id::text as owner_id from assets where ${pastGrace(graceDays)}
		),
		refs as (${referencesIn(columns, sql`select id from old`)})
		select old.id, old.owner_id as "ownerId" from old
		where not exists (select 1 from refs where refs.id = old.id)
		order by old.owner_id, old.id
	`);
	return result.rows as { id: string; ownerId: string }[];
}

/**
 * Which of the given image ids some row still references, by the same wide
 * reading as findUnusedAssets. Meant for a handful of ids inside a deleting
 * transaction, so a reference saved after an earlier full read is caught.
 */
export async function referencedAssetIds(
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
 * Deletes the given images (from findUnusedAssets) that still look unused,
 * a chunk per transaction, and gives their bytes back. Each transaction locks
 * the owners' account rows and then the image rows (the order every storage
 * path takes, see lockStorageOwners), skipping any another session holds so a
 * sign-in or an upload is never kept waiting; those are left for the next run.
 * Every column is checked again under the locks, for the held ids only, and
 * the stored files are queued to go later (scheduleObjectDeletions), never
 * removed here.
 */
export async function deleteUnusedAssets(
	db: Database,
	candidates: { id: string; ownerId: string }[],
	graceDays = UNUSED_ASSET_GRACE_DAYS
): Promise<Freed[]> {
	if (candidates.length === 0) return [];
	const columns = await referenceColumns(db);
	const freed: Freed[] = [];
	for (let start = 0; start < candidates.length; start += CHUNK) {
		const chunk = candidates.slice(start, start + CHUNK);
		const ids = chunk.map((row) => row.id).join(',');
		const owners = [...new Set(chunk.map((row) => row.ownerId))].sort().join(',');
		const deleted = await db.transaction(async (tx) => {
			const locked = await tx.execute(sql`
				select id from users where id::text = any(string_to_array(${owners}, ','))
				order by id for no key update skip locked
			`);
			if (locked.rows.length === 0) return [];
			const lockedOwners = (locked.rows as { id: string }[]).map((row) => row.id).join(',');
			const rows = await tx.execute(sql`
				select id::text as id from assets
				where id::text = any(string_to_array(${ids}, ','))
					and owner_id::text = any(string_to_array(${lockedOwners}, ','))
					and ${pastGrace(graceDays)}
				order by id for update skip locked
			`);
			const held = (rows.rows as { id: string }[]).map((row) => row.id);
			if (held.length === 0) return [];
			const referenced = await referencedAssetIds(tx, held, columns);
			const unused = held.filter((id) => !referenced.has(id));
			if (unused.length === 0) return [];
			const result = await tx.execute(sql`
				delete from assets where id::text = any(string_to_array(${unused.join(',')}, ','))
				returning id::text as id, owner_id::text as "ownerId", storage_key as "storageKey",
					byte_size::float8 as "byteSize", content_type as "contentType", kind, filename,
					universe_id::text as "universeId", created_at::text as "createdAt"
			`);
			const gone = result.rows as Freed[];
			await releaseStorage(tx, gone);
			await scheduleObjectDeletions(
				tx,
				gone.map((row) => row.storageKey),
				FREED_OBJECT_EXTRA_DAYS
			);
			return gone;
		});
		freed.push(...deleted);
	}
	return freed;
}

/** One run of the sweep: one full read, then the deletes. */
export async function sweepUnusedAssets(
	db: Database,
	graceDays = UNUSED_ASSET_GRACE_DAYS
): Promise<{ count: number; bytes: number }> {
	const freed = await deleteUnusedAssets(db, await findUnusedAssets(db, graceDays), graceDays);
	// Enough to put a row back by hand while its file is still kept.
	for (const row of freed) logEvent('info', 'assets.unused_deleted', row);
	return { count: freed.length, bytes: freed.reduce((sum, row) => sum + row.byteSize, 0) };
}

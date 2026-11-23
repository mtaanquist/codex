import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/lib/server/db/schema';
import { assets, pendingObjectDeletions, stories, users } from '../../src/lib/server/db/schema';
import {
	deleteUnusedAssets,
	FREED_OBJECT_EXTRA_DAYS,
	referenceColumns,
	referencedAssetIdsQuery,
	scanAssetUse,
	sweepUnusedAssets,
	tablesWithoutMarkTrigger,
	UNREFERENCED_DAYS,
	UNUSED_ASSET_GRACE_DAYS
} from '../../src/lib/server/unused-assets';
import { cancelLongReads, CANCEL_ON_MIGRATE_APP_NAME } from '../../src/lib/server/db/migrate';
import { purgeStory } from '../../src/lib/server/story-delete';
import { trashStory } from '../../src/lib/server/story-lifecycle';
import { createStoryInUniverse, createUniverse } from '../../src/lib/server/story-create';
import { saveDraft } from '../../src/lib/server/story-drafts';
import { saveUniverseDetails } from '../../src/lib/server/universe-details';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 6 });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'free@example.com', displayName: 'F', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	universeId = (await createUniverse(db, ownerId, 'World')).id;
});

// Only a story in the trash is purged.
async function trashAndPurge(storyId: string) {
	await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
	await purgeStory(db, storyId);
}

afterAll(async () => {
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');
	await pool.end();
});

// An uploaded image row, counted against its owner's storage the way
// createAsset counts it. Old by default, so it is past the grace period.
// unusedFor marks it as found unused that many days ago (the first phase of
// the sweep); left out, the image is unmarked.
async function image(
	opts: {
		bytes?: number;
		daysOld?: number;
		universe?: string | null;
		unusedFor?: number;
		owner?: string;
	} = {}
) {
	const id = randomUUID();
	const bytes = opts.bytes ?? 100;
	await db.insert(assets).values({
		id,
		ownerId: opts.owner ?? ownerId,
		universeId: opts.universe === undefined ? universeId : opts.universe,
		kind: 'inline',
		filename: 'a.png',
		contentType: 'image/png',
		byteSize: bytes,
		storageKey: `codex-assets/${id}`,
		createdAt: new Date(Date.now() - (opts.daysOld ?? UNUSED_ASSET_GRACE_DAYS + 10) * 86_400_000),
		unreferencedSince:
			opts.unusedFor === undefined ? null : new Date(Date.now() - opts.unusedFor * 86_400_000)
	});
	await pool.query('update users set storage_used_bytes = storage_used_bytes + $1 where id = $2', [
		bytes,
		opts.owner ?? ownerId
	]);
	return id;
}

async function story(title = 'Tale', inUniverse = universeId) {
	const created = await createStoryInUniverse(db, ownerId, inUniverse, title);
	return created.id as string;
}

async function scene(storyId: string, body: string, opts: { trashed?: boolean } = {}) {
	const { rows } = await pool.query(
		`insert into scenes (story_id, global_position, body_md, deleted_at)
		 values ($1, (select count(*) from scenes where story_id = $1), $2, $3) returning id`,
		[storyId, body, opts.trashed ? new Date() : null]
	);
	return rows[0].id as string;
}

async function edition(storyId: string, content: unknown) {
	const { rows } = await pool.query(
		`insert into publications (story_id, owner_id, handle, title, content, is_current)
		 values ($1, $2, 'free', 'Tale', $3, false) returning id`,
		[storyId, ownerId, JSON.stringify(content)]
	);
	return rows[0].id as string;
}

const link = (id: string) => `Before ![map](/assets/${id}) after.`;

async function remaining(ids: string[]) {
	const rows = await db.select({ id: assets.id }).from(assets).where(inArray(assets.id, ids));
	return new Set(rows.map((row) => row.id));
}

async function used() {
	const [row] = await db
		.select({ used: users.storageUsedBytes })
		.from(users)
		.where(eq(users.id, ownerId));
	return row.used;
}

async function unusedIds() {
	return new Set((await scanAssetUse(db)).unused.map((row) => row.id));
}

async function marks(ids: string[]) {
	const rows = await db
		.select({ id: assets.id, since: assets.unreferencedSince })
		.from(assets)
		.where(inArray(assets.id, ids));
	return new Map(rows.map((row) => [row.id, row.since]));
}

// Long enough unused for the sweep to delete.
const LONG = UNREFERENCED_DAYS + 1;

// The images the sweep would delete now, after a full read.
async function dueNow() {
	return (await scanAssetUse(db)).unused.filter((row) => row.due);
}

describe('scanAssetUse', () => {
	it('keeps an image wherever a row holds its id, in any column or casing', async () => {
		const storyId = await story();
		const trashedStory = await story('Trashed');
		const sceneId = await scene(storyId, 'No images here.');
		const ids = {
			sceneBody: await image(),
			trashedScene: await image(),
			trashedStory: await image(),
			revisionOnly: await image(),
			note: await image(),
			cover: await image(),
			avatar: await image({ universe: null }),
			badge: await image(),
			savedDraft: await image(),
			editionContent: await image(),
			editionAsset: await image(),
			upper: await image(),
			unused: await image()
		};
		await scene(storyId, link(ids.sceneBody));
		await scene(storyId, link(ids.trashedScene), { trashed: true });
		await scene(trashedStory, link(ids.trashedStory));
		expect(await trashStory(db, ownerId, trashedStory)).toBe(true);
		await pool.query(
			`insert into revisions (entity_type, entity_id, body_md) values ('scene', $1, $2)`,
			[sceneId, link(ids.revisionOnly)]
		);
		await pool.query(`insert into notes (owner_id, story_id, body_md) values ($1, $2, $3)`, [
			ownerId,
			storyId,
			link(ids.note)
		]);
		await pool.query('update stories set cover_asset_id = $1 where id = $2', [ids.cover, storyId]);
		await pool.query('update users set avatar_asset_id = $1 where id = $2', [ids.avatar, ownerId]);
		await pool.query(
			`insert into characters (universe_id, owner_id, name, badge_asset_id) values ($1, $2, 'Aldric', $3)`,
			[universeId, ownerId, ids.badge]
		);
		await pool.query(
			`insert into story_drafts (story_id, owner_id, label, content) values ($1, $2, 'Kept', $3)`,
			[storyId, ownerId, JSON.stringify({ scenes: [{ bodyMd: link(ids.savedDraft) }] })]
		);
		await edition(storyId, { unfiled: [{ bodyMd: link(ids.editionContent) }] });
		const pub = await edition(storyId, { unfiled: [] });
		await pool.query('insert into publication_assets (publication_id, asset_id) values ($1, $2)', [
			pub,
			ids.editionAsset
		]);
		await pool.query('update scenes set summary_md = $1 where id = $2', [
			`see /assets/${ids.upper.toUpperCase()}`,
			sceneId
		]);

		expect(await unusedIds()).toEqual(new Set([ids.unused]));
	});

	it('finds new images unused too, but never has them due', async () => {
		const fresh = await image({ daysOld: 1, unusedFor: LONG });
		const scan = await scanAssetUse(db);
		expect(scan.unused).toEqual([{ id: fresh, ownerId, marked: true, due: false }]);
	});
});

describe('sweepUnusedAssets', () => {
	it('marks an image it first finds unused and keeps it', async () => {
		const storyId = await story();
		// Uploaded long ago, taken out of a story description just now.
		const removed = await image({ bytes: 300, daysOld: 200 });
		const kept = await image({ bytes: 50 });
		await scene(storyId, link(kept));

		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await remaining([removed, kept])).toEqual(new Set([removed, kept]));
		expect(await used()).toBe(350);
		const marked = await marks([removed, kept]);
		expect(marked.get(removed)).toBeInstanceOf(Date);
		expect(marked.get(kept)).toBeNull();

		// A second run soon after keeps it too, and keeps the first date.
		const first = marked.get(removed);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect((await marks([removed])).get(removed)).toEqual(first);
	});

	it('deletes an image only once it has been unused for the whole period', async () => {
		const almost = await image({ unusedFor: UNREFERENCED_DAYS - 1 });
		const long = await image({ bytes: 300, unusedFor: LONG });
		expect(await sweepUnusedAssets(db)).toEqual({ count: 1, bytes: 300 });
		expect(await remaining([almost, long])).toEqual(new Set([almost]));
	});

	it('keeps an image unused for long that is newer than the grace period', async () => {
		const fresh = await image({ daysOld: UNUSED_ASSET_GRACE_DAYS - 1, unusedFor: LONG });
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await remaining([fresh])).toEqual(new Set([fresh]));
	});

	it('clears the mark of an image in use again, so the period starts over', async () => {
		const storyId = await story();
		const back = await image({ unusedFor: LONG });
		const sceneId = await scene(storyId, link(back));
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect((await marks([back])).get(back)).toBeNull();

		// Taken out again: marked afresh, not deleted.
		await pool.query(`update scenes set body_md = 'Cut.' where id = $1`, [sceneId]);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await remaining([back])).toEqual(new Set([back]));
		const since = (await marks([back])).get(back)!;
		expect(Date.now() - since.getTime()).toBeLessThan(60_000);
	});

	it('deletes long unused images, gives the bytes back, and keeps the file a while', async () => {
		const storyId = await story();
		const orphan = await image({ bytes: 300, unusedFor: LONG });
		const kept = await image({ bytes: 50 });
		await scene(storyId, link(kept));
		expect(await used()).toBe(350);

		expect(await sweepUnusedAssets(db)).toEqual({ count: 1, bytes: 300 });
		expect(await remaining([orphan, kept])).toEqual(new Set([kept]));
		expect(await used()).toBe(50);
		const queued = await db.select().from(pendingObjectDeletions);
		expect(queued.map((row) => row.storageKey)).toEqual([`codex-assets/${orphan}`]);
		// Queued as if deleted later, so it outlasts the usual wait by that much.
		const ahead = (queued[0].deletedAt.getTime() - Date.now()) / 86_400_000;
		expect(ahead).toBeGreaterThan(FREED_OBJECT_EXTRA_DAYS - 1);
	});

	it('works through more images than one transaction takes', async () => {
		for (let i = 0; i < 130; i += 1) await image({ bytes: 1, unusedFor: LONG });
		const storyId = await story();
		const kept = await image({ bytes: 7, unusedFor: LONG });
		await scene(storyId, link(kept));
		expect(await sweepUnusedAssets(db)).toEqual({ count: 130, bytes: 130 });
		expect(await used()).toBe(7);
	});

	it('keeps an image a writer links after the full read, before the delete', async () => {
		const storyId = await story();
		const target = await image({ bytes: 40, unusedFor: LONG });
		const candidates = await dueNow();
		expect(candidates.map((row) => row.id)).toEqual([target]);
		await scene(storyId, link(target));
		expect(await deleteUnusedAssets(db, candidates)).toEqual([]);
		expect(await remaining([target])).toEqual(new Set([target]));
		expect(await used()).toBe(40);
	});

	it('keeps an image set as a cover after the full read', async () => {
		const storyId = await story();
		const target = await image({ unusedFor: LONG });
		const candidates = await dueNow();
		await pool.query('update stories set cover_asset_id = $1 where id = $2', [target, storyId]);
		expect(await deleteUnusedAssets(db, candidates)).toEqual([]);
		expect(await remaining([target])).toEqual(new Set([target]));
	});

	it('keeps an image whose mark another run cleared after the full read', async () => {
		const target = await image({ unusedFor: LONG });
		const candidates = await dueNow();
		await db.update(assets).set({ unreferencedSince: null }).where(eq(assets.id, target));
		expect(await deleteUnusedAssets(db, candidates)).toEqual([]);
		expect(await remaining([target])).toEqual(new Set([target]));
	});

	// Columns the old hand-kept recheck list left out.
	it('keeps an image linked after the full read from any text column', async () => {
		const storyId = await story();
		const inSummary = await image({ unusedFor: LONG });
		const inCommissions = await image({ unusedFor: LONG });
		const candidates = await dueNow();
		await pool.query(
			`insert into chapters (story_id, position, title, summary_md) values ($1, 1, 'One', $2)`,
			[storyId, link(inSummary)]
		);
		await pool.query('update users set commissions_md = $1 where id = $2', [
			link(inCommissions),
			ownerId
		]);
		expect(await deleteUnusedAssets(db, candidates)).toEqual([]);
		expect(await remaining([inSummary, inCommissions])).toEqual(
			new Set([inSummary, inCommissions])
		);
	});

	it('skips an account another session holds and frees its images next time', async () => {
		const target = await image({ bytes: 40, unusedFor: LONG });
		const holder = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('select id from users where id = $1 for no key update', [ownerId]);
			expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
			await holder.query('commit');
		} finally {
			holder.release();
		}
		expect(await remaining([target])).toEqual(new Set([target]));
		expect(await sweepUnusedAssets(db)).toEqual({ count: 1, bytes: 40 });
	});

	it('does not hold the account while it reads every column', async () => {
		const target = await image({ unusedFor: LONG });
		const candidates = await dueNow();
		const holder = await pool.connect();
		try {
			// A table lock that the reference read must wait for: while it waits,
			// the account row must still be free to lock.
			await holder.query('begin');
			await holder.query('lock table notes in access exclusive mode');
			const running = deleteUnusedAssets(db, candidates);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const probe = await pool.connect();
			try {
				await probe.query('begin');
				await probe.query('set local lock_timeout = 1000');
				await probe.query('select id from users where id = $1 for no key update', [ownerId]);
				await probe.query('rollback');
			} finally {
				probe.release();
			}
			await holder.query('commit');
			expect((await running).map((row) => row.id)).toEqual([target]);
		} finally {
			holder.release();
		}
	});
});

// The sweep sees only what is stored when it runs; a write in between that
// puts an image back is caught by the trigger on every table instead.
describe('a write that stores an image id', () => {
	it('starts the period over for an image used only between two runs', async () => {
		// Taken out of the description 29 days ago, pasted back and saved, then
		// taken out again the same day.
		const back = await image({ unusedFor: UNREFERENCED_DAYS - 1 });
		const universe = { id: universeId };
		const details = { name: 'World', establishedSetting: false };
		await saveUniverseDetails(db, ownerId, universe, { ...details, descriptionMd: link(back) });
		expect((await marks([back])).get(back)).toBeNull();
		await saveUniverseDetails(db, ownerId, universe, { ...details, descriptionMd: 'Cut.' });

		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await remaining([back])).toEqual(new Set([back]));
		const since = (await marks([back])).get(back)!;
		expect(Date.now() - since.getTime()).toBeLessThan(60_000);
	});

	it('clears the mark from an insert or update in any column, in any casing', async () => {
		const storyId = await story();
		const ids = {
			note: await image({ unusedFor: 5 }),
			cover: await image({ unusedFor: 5 }),
			bio: await image({ unusedFor: 5 }),
			draft: await image({ unusedFor: 5 }),
			upper: await image({ unusedFor: 5 }),
			untouched: await image({ unusedFor: 5 })
		};
		await pool.query(`insert into notes (owner_id, story_id, body_md) values ($1, $2, $3)`, [
			ownerId,
			storyId,
			link(ids.note)
		]);
		await pool.query('update stories set cover_asset_id = $1 where id = $2', [ids.cover, storyId]);
		await pool.query('update users set bio_md = $1 where id = $2', [link(ids.bio), ownerId]);
		await pool.query(
			`insert into story_drafts (story_id, owner_id, label, content) values ($1, $2, 'Kept', $3)`,
			[storyId, ownerId, JSON.stringify({ scenes: [{ bodyMd: link(ids.draft) }] })]
		);
		await scene(storyId, link(ids.upper.toUpperCase()));

		const after = await marks(Object.values(ids));
		for (const [name, id] of Object.entries(ids)) {
			expect([name, after.get(id) === null]).toEqual([name, name !== 'untouched']);
		}
	});

	it('is on every table the sweep reads', async () => {
		expect(await tablesWithoutMarkTrigger(db)).toEqual([]);
		const tables = new Set((await referenceColumns(db)).map((column) => column.table));
		const { rows } = await pool.query(
			`select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
			 where t.tgname = 'clear_asset_marks'`
		);
		const guarded = new Set(rows.map((row: { relname: string }) => row.relname));
		expect([...tables].filter((table) => !guarded.has(table))).toEqual([]);
	});

	it('deletes nothing while a table is missing it', async () => {
		const long = await image({ unusedFor: LONG });
		await pool.query('alter table notes disable trigger clear_asset_marks');
		try {
			await expect(sweepUnusedAssets(db)).rejects.toThrow('notes');
		} finally {
			await pool.query('alter table notes enable trigger clear_asset_marks');
		}
		expect(await remaining([long])).toEqual(new Set([long]));
	});
});

describe('the read before the delete', () => {
	// Bound once per column, a large backlog sent the list hundreds of times
	// over and the sweep failed every night without freeing anything.
	it('binds the id list once however many columns it reads', async () => {
		const ids = Array.from({ length: 20_000 }, () => randomUUID());
		const columns = await referenceColumns(db);
		expect(columns.length).toBeGreaterThan(50);
		const { params } = new PgDialect().sqlToQuery(referencedAssetIdsQuery(columns, ids));
		expect(params).toEqual([ids.join(',')]);
	});

	it('finds the referenced ids among many', async () => {
		const storyId = await story();
		const kept = await image();
		await scene(storyId, link(kept.toUpperCase()));
		const ids = [...Array.from({ length: 20_000 }, () => randomUUID()), kept];
		const result = await db.execute(referencedAssetIdsQuery(await referenceColumns(db), ids));
		expect(result.rows).toEqual([{ id: kept }]);
	});
});

describe('after a story is deleted for good', () => {
	it('the sweep frees the images only that story used and keeps the rest', async () => {
		const doomed = await story('Doomed');
		const other = await story('Other');
		const ids = {
			cover: await image({ bytes: 10 }),
			inline: await image({ bytes: 20 }),
			inEdition: await image({ bytes: 30 }),
			shared: await image({ bytes: 1000 }),
			inOtherDraft: await image({ bytes: 2000 }),
			avatar: await image({ bytes: 4000, universe: null }),
			fresh: await image({ bytes: 8000, daysOld: 1 })
		};
		await pool.query('update stories set cover_asset_id = $1 where id = $2', [ids.cover, doomed]);
		await scene(doomed, `${link(ids.inline)} ${link(ids.shared)} ${link(ids.fresh)}`);
		await scene(doomed, link(ids.inOtherDraft));
		await edition(doomed, { unfiled: [{ bodyMd: link(ids.inEdition) }] });
		await pool.query('update users set avatar_asset_id = $1 where id = $2', [ids.avatar, ownerId]);
		await scene(other, link(ids.shared));
		// A saved draft of the other story still shows this image, though the
		// other story's working text no longer does.
		const otherScene = await scene(other, link(ids.inOtherDraft));
		const saved = await saveDraft(db, ownerId, other, { label: 'Before cuts', note: '' });
		expect(saved.ok).toBe(true);
		await pool.query(`update scenes set body_md = 'Cut.' where id = $1`, [otherScene]);
		const before = await used();

		await trashAndPurge(doomed);
		// The first run only marks what the purge left unused.
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		await pool.query(
			`update assets set unreferenced_since = unreferenced_since - make_interval(days => $1)
			 where unreferenced_since is not null`,
			[LONG]
		);
		expect(await sweepUnusedAssets(db)).toEqual({ count: 3, bytes: 60 });

		expect(await remaining(Object.values(ids))).toEqual(
			new Set([ids.shared, ids.inOtherDraft, ids.avatar, ids.fresh])
		);
		expect(await used()).toBe(before - 60);
	});

	it('keeps an image another universe uses, though it was uploaded here', async () => {
		const doomed = await story('Doomed');
		const elsewhere = (await createUniverse(db, ownerId, 'Elsewhere')).id;
		const far = await story('Far', elsewhere);
		const id = await image();
		await scene(doomed, link(id));
		await scene(far, link(id));
		await trashAndPurge(doomed);
		await sweepUnusedAssets(db);
		expect(await remaining([id])).toEqual(new Set([id]));
		expect((await marks([id])).get(id)).toBeNull();
	});
});

// The worker's pool cancels a statement after a few minutes, but reading every
// column of a large database can take longer. A lock another session holds on
// A chunk whose DELETE fails after earlier chunks committed. The trigger
// stands in for what can break a chunk at that point: a badge or publish
// pointing at the image by foreign key, saved after the last reference read
// (23503), or anything else (P0001).
describe('a chunk that fails partway through', () => {
	let lines: Record<string, unknown>[];

	beforeEach(() => {
		lines = [];
		const record = (line: unknown) => {
			lines.push(JSON.parse(String(line)));
		};
		vi.spyOn(console, 'log').mockImplementation(record);
		vi.spyOn(console, 'error').mockImplementation(record);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await pool.query('drop trigger if exists test_refuse_delete on assets');
		await pool.query('drop function if exists test_refuse_delete()');
	});

	async function refuseDelete(id: string, errcode: string) {
		await pool.query(`
			create function test_refuse_delete() returns trigger language plpgsql as $$
			begin
				if old.id = '${id}' then
					raise exception 'refused' using errcode = '${errcode}';
				end if;
				return old;
			end $$`);
		await pool.query(`create trigger test_refuse_delete before delete on assets
			for each row execute function test_refuse_delete()`);
	}

	// 101 images, so the last (by id, the order the sweep works in) is alone
	// in a second chunk.
	async function twoChunks() {
		const ids: string[] = [];
		for (let i = 0; i < 101; i += 1) ids.push(await image({ bytes: 1, unusedFor: LONG }));
		ids.sort();
		return { first: ids.slice(0, 100), last: ids[100] };
	}

	const loggedFreed = () =>
		new Set(lines.filter((l) => l.event === 'assets.unused_deleted').map((l) => l.id));

	it('logs what restoring the row needs, but not the original filename', async () => {
		const freed = await image({ bytes: 3, unusedFor: LONG });
		await sweepUnusedAssets(db);
		const logged = lines.filter((l) => l.event === 'assets.unused_deleted');
		expect(logged).toEqual([
			expect.objectContaining({
				id: freed,
				ownerId,
				storageKey: `codex-assets/${freed}`,
				byteSize: 3,
				contentType: 'image/png',
				kind: 'inline',
				universeId
			})
		]);
		expect(logged[0]).not.toHaveProperty('filename');
	});

	it('has logged the deletions earlier chunks committed', async () => {
		const { first, last } = await twoChunks();
		await refuseDelete(last, 'P0001');
		await expect(sweepUnusedAssets(db)).rejects.toThrow();
		expect(await remaining([...first, last])).toEqual(new Set([last]));
		expect(loggedFreed()).toEqual(new Set(first));
	});

	it('skips a chunk a foreign key refuses and carries on with the rest', async () => {
		const { first, last } = await twoChunks();
		// The refused image sits in the first chunk; the second chunk still goes.
		await refuseDelete(first[0], '23503');
		expect(await sweepUnusedAssets(db)).toEqual({ count: 1, bytes: 1 });
		expect(await remaining([...first, last])).toEqual(new Set(first));
		expect(loggedFreed()).toEqual(new Set([last]));
		expect(lines.some((l) => l.event === 'assets.unused_delete_skipped')).toBe(true);
		// Their marks are cleared, so they are found unused again from the start.
		const left = await marks(first);
		expect([...left.values()].every((since) => since === null)).toBe(true);
		expect(await used()).toBe(100);
	});
});

// a scanned table stands in for a slow read here: the wait counts toward
// statement_timeout like work does.
describe('reads on a pool with a short statement limit', () => {
	let shortPool: pg.Pool;
	let shortDb: Database;

	beforeAll(() => {
		shortPool = new pg.Pool({ connectionString: TEST_DATABASE_URL, statement_timeout: 100 });
		shortDb = drizzle(shortPool, { schema });
	});

	afterAll(async () => {
		await shortPool.end();
	});

	// Runs read while another session holds an exclusive lock on notes for
	// holdMs, and returns what it gave.
	async function underLock<T>(read: () => Promise<T>, holdMs = 600): Promise<T> {
		const holder = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('lock table notes in access exclusive mode');
			const running = read();
			// Seen as handled while the lock is held; the await below still throws.
			running.catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, holdMs));
			await holder.query('commit');
			return await running;
		} finally {
			holder.release();
		}
	}

	it('would cancel a plain read of a held table', async () => {
		await expect(underLock(() => shortPool.query('select count(*) from notes'))).rejects.toThrow(
			/statement timeout/
		);
	});

	it('lets the full read run past it', async () => {
		const orphan = await image();
		const scan = await underLock(() => scanAssetUse(shortDb));
		expect(scan.unused.map((row) => row.id)).toEqual([orphan]);
	});

	it('lets the read before the delete run past it', async () => {
		const orphan = await image({ bytes: 9, unusedFor: LONG });
		const candidates = await dueNow();
		const freed = await underLock(() => deleteUnusedAssets(shortDb, candidates));
		expect(freed.map((row) => row.id)).toEqual([orphan]);
	});
});

// A migration's ALTER TABLE would wait behind a read that runs for hours, and
// everything after it behind the ALTER, so the migrator cancels the sweep's
// reads. They name themselves for that only while they run.
describe('a migration starting during the full read', () => {
	async function sweepReads() {
		const { rows } = await pool.query(
			'select count(*)::int as n from pg_stat_activity where application_name = $1',
			[CANCEL_ON_MIGRATE_APP_NAME]
		);
		return rows[0].n as number;
	}

	it('cancels it, and the sweep fails without changing anything', async () => {
		const orphan = await image();
		const holder = await pool.connect();
		const migrator = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('lock table notes in access exclusive mode');
			const running = sweepUnusedAssets(db);
			running.catch(() => {});
			for (let i = 0; i < 50 && (await sweepReads()) === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(await cancelLongReads(migrator)).toBe(1);
			await expect(running).rejects.toThrow();
			await holder.query('commit');
		} finally {
			holder.release();
			migrator.release();
		}
		expect((await marks([orphan])).get(orphan)).toBeNull();
	});

	// pg_cancel_backend raises an error for a backend the role may not signal
	// (here a superuser's), which must not stop the migrations from starting.
	it('passes over a read the migrator may not cancel', async () => {
		const named = await pool.connect();
		const migrator = await pool.connect();
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await named.query(`set application_name = '${CANCEL_ON_MIGRATE_APP_NAME}'`);
			await pool.query(`do $$ begin
				if not exists (select 1 from pg_roles where rolname = 'codex_test_signal') then
					create role codex_test_signal;
				end if;
				if not exists (select 1 from pg_roles where rolname = 'codex_test_plain') then
					create role codex_test_plain;
				end if;
			end $$`);
			await pool.query('grant pg_signal_backend to codex_test_signal');
			await migrator.query('set role codex_test_plain');
			expect(await cancelLongReads(migrator)).toBe(0);
			await migrator.query('set role codex_test_signal');
			expect(await cancelLongReads(migrator)).toBe(0);
			expect(warned).toHaveBeenCalled();
			await migrator.query('reset role');
			expect(await cancelLongReads(migrator)).toBe(1);
		} finally {
			warned.mockRestore();
			await migrator.query('reset role');
			await named.query('reset application_name');
			named.release();
			migrator.release();
		}
	});

	it('leaves the connection unnamed once the read is done', async () => {
		await image();
		await scanAssetUse(db);
		expect(await sweepReads()).toBe(0);
	});
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/lib/server/db/schema';
import { assets, pendingObjectDeletions, users } from '../../src/lib/server/db/schema';
import {
	findReferencedAssets,
	sweepUnusedAssets,
	UNUSED_ASSET_GRACE_HOURS
} from '../../src/lib/server/unused-assets';
import { purgeStory } from '../../src/lib/server/story-delete';
import { createStoryInUniverse, createUniverse } from '../../src/lib/server/story-create';
import { saveDraft } from '../../src/lib/server/story-drafts';
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

afterAll(async () => {
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');
	await pool.end();
});

// An uploaded image row, counted against its owner's storage the way
// createAsset counts it. Old by default, so it is past the grace period.
async function image(
	opts: { bytes?: number; hoursOld?: number; universe?: string | null; owner?: string } = {}
) {
	const id = randomUUID();
	const owner = opts.owner ?? ownerId;
	const bytes = opts.bytes ?? 100;
	await db.insert(assets).values({
		id,
		ownerId: owner,
		universeId: opts.universe === undefined ? universeId : opts.universe,
		kind: 'inline',
		filename: 'a.png',
		contentType: 'image/png',
		byteSize: bytes,
		storageKey: `codex-assets/${id}`,
		createdAt: new Date(Date.now() - (opts.hoursOld ?? 48) * 3_600_000)
	});
	await pool.query('update users set storage_used_bytes = storage_used_bytes + $1 where id = $2', [
		bytes,
		owner
	]);
	return id;
}

async function story(title = 'Tale') {
	const created = await createStoryInUniverse(db, ownerId, universeId, title);
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

async function queuedKeys() {
	const rows = await db.select().from(pendingObjectDeletions);
	return new Set(rows.map((row) => row.storageKey));
}

describe('findReferencedAssets', () => {
	it('finds an id wherever a row holds it, in any column or casing', async () => {
		const storyId = await story();
		const sceneId = await scene(storyId, 'No images here.');
		const ids = {
			sceneBody: await image(),
			trashedScene: await image(),
			revision: await image(),
			note: await image(),
			cover: await image(),
			avatar: await image({ universe: null }),
			badge: await image(),
			jsonb: await image(),
			upper: await image(),
			unused: await image()
		};
		await scene(storyId, link(ids.sceneBody));
		await scene(storyId, link(ids.trashedScene), { trashed: true });
		await pool.query(
			`insert into revisions (entity_type, entity_id, body_md) values ('scene', $1, $2)`,
			[sceneId, link(ids.revision)]
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
			[storyId, ownerId, JSON.stringify({ coverAssetId: ids.jsonb })]
		);
		await pool.query('update scenes set summary_md = $1 where id = $2', [
			`see /assets/${ids.upper.toUpperCase()}`,
			sceneId
		]);

		const found = await findReferencedAssets(db, Object.values(ids));
		const { unused, ...inUse } = ids;
		expect(found).toEqual(new Set(Object.values(inUse)));
		expect(found.has(unused)).toBe(false);
	});

	it('does not count an asset as referencing itself', async () => {
		const id = await image();
		expect(await findReferencedAssets(db, [id])).toEqual(new Set());
	});
});

describe('sweepUnusedAssets', () => {
	it('deletes old unreferenced images, gives the bytes back, and queues the objects', async () => {
		const storyId = await story();
		const orphan = await image({ bytes: 300 });
		const kept = await image({ bytes: 50 });
		await scene(storyId, link(kept));
		expect(await used()).toBe(350);

		expect(await sweepUnusedAssets(db)).toEqual({ count: 1, bytes: 300 });
		expect(await remaining([orphan, kept])).toEqual(new Set([kept]));
		expect(await used()).toBe(50);
		expect(await queuedKeys()).toEqual(new Set([`codex-assets/${orphan}`]));
	});

	it('keeps an image newer than the grace period, even unreferenced', async () => {
		const fresh = await image({ hoursOld: UNUSED_ASSET_GRACE_HOURS - 1 });
		expect(await sweepUnusedAssets(db)).toEqual({ count: 0, bytes: 0 });
		expect(await remaining([fresh])).toEqual(new Set([fresh]));
	});

	it('works through more images than one batch', async () => {
		for (let i = 0; i < 520; i += 1) await image({ bytes: 1 });
		const storyId = await story();
		const kept = await image({ bytes: 7 });
		await scene(storyId, link(kept));
		expect(await sweepUnusedAssets(db)).toEqual({ count: 520, bytes: 520 });
		expect(await used()).toBe(7);
	});

	it('keeps an image that gains a reference while the sweep waits to delete it', async () => {
		const storyId = await story();
		const target = await image({ bytes: 40 });
		// Hold the account row, so the sweep passes its first check (the image
		// is unused then) and stops at the lock before deleting.
		const holder = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('select id from users where id = $1 for update', [ownerId]);
			const sweep = sweepUnusedAssets(db);
			await waitForLockWait(holder);
			// The writer saves a scene with the image while the sweep waits.
			await scene(storyId, link(target));
			await holder.query('commit');
			expect(await sweep).toEqual({ count: 0, bytes: 0 });
		} finally {
			holder.release();
		}
		expect(await remaining([target])).toEqual(new Set([target]));
		expect(await used()).toBe(40);
	});
});

describe('purgeStory frees storage', () => {
	it('frees the images only the purged story used and keeps the rest', async () => {
		const doomed = await story('Doomed');
		const other = await story('Other');
		const ids = {
			cover: await image({ bytes: 10 }),
			inline: await image({ bytes: 20 }),
			inEdition: await image({ bytes: 30 }),
			shared: await image({ bytes: 1000 }),
			inOtherDraft: await image({ bytes: 2000 }),
			avatar: await image({ bytes: 4000, universe: null }),
			fresh: await image({ bytes: 8000, hoursOld: 1 })
		};
		await pool.query('update stories set cover_asset_id = $1 where id = $2', [ids.cover, doomed]);
		await scene(doomed, `${link(ids.inline)} ${link(ids.shared)} ${link(ids.fresh)}`);
		await scene(doomed, link(ids.inOtherDraft));
		await pool.query(
			`insert into publications (story_id, owner_id, handle, title, content)
			 values ($1, $2, 'free', 'Doomed', $3)`,
			[doomed, ownerId, JSON.stringify({ scenes: [{ bodyMd: link(ids.inEdition) }] })]
		);
		await pool.query('update users set avatar_asset_id = $1 where id = $2', [ids.avatar, ownerId]);
		await scene(other, link(ids.shared));
		// A saved draft of the other story still shows this image, though the
		// other story's working text no longer does.
		const otherScene = await scene(other, link(ids.inOtherDraft));
		const saved = await saveDraft(db, ownerId, other, { label: 'Before cuts', note: '' });
		expect(saved.ok).toBe(true);
		await pool.query(`update scenes set body_md = 'Cut.' where id = $1`, [otherScene]);
		const before = await used();

		await purgeStory(db, doomed);

		expect(await remaining(Object.values(ids))).toEqual(
			new Set([ids.shared, ids.inOtherDraft, ids.avatar, ids.fresh])
		);
		expect(await used()).toBe(before - 60);
		const queued = await queuedKeys();
		for (const id of [ids.cover, ids.inline, ids.inEdition]) {
			expect(queued.has(`codex-assets/${id}`)).toBe(true);
		}
	});

	it('keeps an image another universe uses, though it was uploaded here', async () => {
		const doomed = await story('Doomed');
		const elsewhere = (await createUniverse(db, ownerId, 'Elsewhere')).id;
		const far = await createStoryInUniverse(db, ownerId, elsewhere, 'Far');
		const id = await image();
		await scene(doomed, link(id));
		await scene(far.id, link(id));
		await purgeStory(db, doomed);
		expect(await remaining([id])).toEqual(new Set([id]));
	});
});

// Waits until some other session is blocked on a lock the holder has.
async function waitForLockWait(holder: pg.PoolClient) {
	const { rows } = await holder.query('select pg_backend_pid() as pid');
	const pid = rows[0].pid;
	for (let i = 0; i < 200; i += 1) {
		const waiting = await pool.query(
			`select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`,
			[pid]
		);
		if (waiting.rowCount) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error('the sweep never waited on the lock');
}

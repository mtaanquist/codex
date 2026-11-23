import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/lib/server/db/schema';
import { assets, pendingObjectDeletions, stories, users } from '../../src/lib/server/db/schema';
import {
	deleteUnusedAssets,
	FREED_OBJECT_EXTRA_DAYS,
	findUnusedAssets,
	sweepUnusedAssets,
	UNUSED_ASSET_GRACE_DAYS
} from '../../src/lib/server/unused-assets';
import { purgeStory } from '../../src/lib/server/story-delete';
import { trashStory } from '../../src/lib/server/story-lifecycle';
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
async function image(opts: { bytes?: number; daysOld?: number; universe?: string | null } = {}) {
	const id = randomUUID();
	const bytes = opts.bytes ?? 100;
	await db.insert(assets).values({
		id,
		ownerId,
		universeId: opts.universe === undefined ? universeId : opts.universe,
		kind: 'inline',
		filename: 'a.png',
		contentType: 'image/png',
		byteSize: bytes,
		storageKey: `codex-assets/${id}`,
		createdAt: new Date(Date.now() - (opts.daysOld ?? UNUSED_ASSET_GRACE_DAYS + 10) * 86_400_000)
	});
	await pool.query('update users set storage_used_bytes = storage_used_bytes + $1 where id = $2', [
		bytes,
		ownerId
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
	return new Set((await findUnusedAssets(db)).map((row) => row.id));
}

describe('findUnusedAssets', () => {
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

	it('leaves out images newer than the grace period', async () => {
		await image({ daysOld: UNUSED_ASSET_GRACE_DAYS - 1 });
		expect(await unusedIds()).toEqual(new Set());
	});
});

describe('sweepUnusedAssets', () => {
	it('deletes old unreferenced images, gives the bytes back, and keeps the file a while', async () => {
		const storyId = await story();
		const orphan = await image({ bytes: 300 });
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
		for (let i = 0; i < 130; i += 1) await image({ bytes: 1 });
		const storyId = await story();
		const kept = await image({ bytes: 7 });
		await scene(storyId, link(kept));
		expect(await sweepUnusedAssets(db)).toEqual({ count: 130, bytes: 130 });
		expect(await used()).toBe(7);
	});

	it('keeps an image a writer links after the full read, before the delete', async () => {
		const storyId = await story();
		const target = await image({ bytes: 40 });
		const candidates = await findUnusedAssets(db);
		expect(candidates.map((row) => row.id)).toEqual([target]);
		await scene(storyId, link(target));
		expect(await deleteUnusedAssets(db, candidates)).toEqual([]);
		expect(await remaining([target])).toEqual(new Set([target]));
		expect(await used()).toBe(40);
	});

	it('keeps an image set as a cover after the full read', async () => {
		const storyId = await story();
		const target = await image();
		const candidates = await findUnusedAssets(db);
		await pool.query('update stories set cover_asset_id = $1 where id = $2', [target, storyId]);
		expect(await deleteUnusedAssets(db, candidates)).toEqual([]);
		expect(await remaining([target])).toEqual(new Set([target]));
	});

	// Columns the old hand-kept recheck list left out.
	it('keeps an image linked after the full read from any text column', async () => {
		const storyId = await story();
		const inSummary = await image();
		const inCommissions = await image();
		const candidates = await findUnusedAssets(db);
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
		const target = await image({ bytes: 40 });
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
	});
});

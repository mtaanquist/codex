import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import * as schema from '../../src/lib/server/db/schema';
import {
	markerRemaps,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { remapPendingMarkers, updateMarkerAnchors } from '../../src/lib/server/markers';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { sceneParagraphs } from '../prose';

// A save compares the old and new text under SAVE_DIFF_BUDGET while it holds
// the scene's row. A marker beside a rewrite too large for that is detached
// by the save and placed again by the worker's remap-markers sweep, run here
// through a real pg-boss queue.
const QUEUE = 'remap-markers-test';
let pool: pg.Pool;
let db: Database;
let boss: PgBoss;
let ownerId: string;
let storyId: string;

const A = 'The kettle was cold when she came down to the kitchen.';
const C = 'They set out before the bell rang for the morning office.';
const MARKED = 'She lit the candle and waited by the door for the cart to come.';
// About 3,500 characters rewritten before the marked sentence, which has a
// typo of its own: past the save's edit distance of 2,500, well inside the
// worker's.
const OLD = sceneParagraphs(91, 3500).join(' ').slice(0, 3500);
const NEW = sceneParagraphs(92, 3500).join(' ').slice(0, 3500);
const BEFORE = [A, OLD, MARKED, C].join('\n\n');
const AFTER = [A, NEW, MARKED.replace('waited', 'wiated'), C].join('\n\n');

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
	await boss.createQueue(QUEUE);
	await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, async () => {
		await remapPendingMarkers(db);
	});
});

beforeEach(async () => {
	await boss.deleteAllJobs(QUEUE);
	await pool.query(
		'truncate table marker_remaps, scene_markers, revisions, scenes, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'remap@example.com', displayName: 'R', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
});

afterAll(async () => {
	await boss.offWork(QUEUE);
	await boss.deleteQueue(QUEUE);
	await boss.stop({ graceful: false });
	await pool.end();
});

async function sceneWith(body: string, phrase: string, position = 1) {
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: position, bodyMd: body })
		.returning();
	const start = body.indexOf(phrase);
	const [marker] = await db
		.insert(sceneMarkers)
		.values({ sceneId: scene.id, ownerId, anchorStart: start, anchorEnd: start + phrase.length })
		.returning();
	return { sceneId: scene.id, markerId: marker.id };
}

const save = (id: string, bodyMd: string) =>
	saveSceneBody(db, id, { title: null, bodyMd, anchors: null, baseHashes: null, overwrite: false });

async function anchorOf(id: string) {
	const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, id));
	return row.anchorStart === null ? null : { start: row.anchorStart, end: row.anchorEnd! };
}

const pending = async () => (await db.select().from(markerRemaps)).length;
const bodyOf = async (id: string) =>
	(await db.select({ bodyMd: scenes.bodyMd }).from(scenes).where(eq(scenes.id, id)))[0].bodyMd;

// Sends one sweep job and waits for the worker to finish it.
async function sweep() {
	const jobId = await boss.send(QUEUE, {});
	for (let n = 0; n < 200; n++) {
		const job = await boss.getJobById(QUEUE, jobId!);
		if (job?.state === 'completed') return;
		if (job?.state === 'failed') throw new Error('sweep failed');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('sweep did not finish');
}

describe('remapPendingMarkers', () => {
	it('places a marker the save detached past its budget, without touching the text', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		expect(await save(sceneId, AFTER)).toMatchObject({ ok: true });
		expect(await anchorOf(markerId)).toBeNull();
		expect(await pending()).toBe(1);

		await sweep();
		const at = await anchorOf(markerId);
		expect(at && AFTER.slice(at.start, at.end)).toBe('lit the candle');
		expect(await pending()).toBe(0);
		expect(await bodyOf(sceneId)).toBe(AFTER);
		// A second sweep has nothing left to do.
		await sweep();
		expect(await anchorOf(markerId)).toEqual(at);
	});

	it('maps onto the text as it stands when the writer saved again before the sweep', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		await save(sceneId, AFTER);
		const later = `A new first line.\n\n${AFTER}`;
		await save(sceneId, later);
		await sweep();
		const at = await anchorOf(markerId);
		expect(at && later.slice(at.start, at.end)).toBe('lit the candle');
	});

	it('does not write a mapping when the text changed while it was being made', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		await save(sceneId, AFTER);
		const later = `A new first line.\n\n${AFTER}`;
		// Holds the scene's row so the sweep maps the saved text, then waits for
		// the lock while the text changes under it.
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query('select id from scenes where id = $1 for update', [sceneId]);
			const running = remapPendingMarkers(db);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await client.query('update scenes set body_md = $1 where id = $2', [later, sceneId]);
			await client.query('commit');
			expect(await running).toBe(0);
		} finally {
			client.release();
		}
		expect(await anchorOf(markerId)).toBeNull();
		expect(await pending()).toBe(1);
		// The next sweep maps onto the new text.
		await sweep();
		const at = await anchorOf(markerId);
		expect(at && later.slice(at.start, at.end)).toBe('lit the candle');
	});

	it('leaves a marker the writer anchored again, and forgets it', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		await save(sceneId, AFTER);
		const start = AFTER.indexOf('the door');
		await updateMarkerAnchors(
			db,
			sceneId,
			[{ id: markerId, anchorStart: start, anchorEnd: start + 8 }],
			AFTER.length
		);
		await sweep();
		expect(await anchorOf(markerId)).toEqual({ start, end: start + 8 });
		expect(await pending()).toBe(0);
	});

	// #1415: a Write editor that loaded the marker while it was detached sends
	// no anchors for it, so its next save must still carry the marker the
	// sweep placed along with the text.
	it('keeps a marker the sweep placed on its words through a Write save that did not mention it', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		await save(sceneId, AFTER);
		await sweep();
		const later = `A new first line.\n\n${AFTER}`;
		expect(
			await saveSceneBody(db, sceneId, {
				title: null,
				bodyMd: later,
				anchors: [],
				baseHashes: null,
				overwrite: false
			})
		).toMatchObject({ ok: true });
		const at = await anchorOf(markerId);
		expect(at && later.slice(at.start, at.end)).toBe('lit the candle');
	});

	it('detaches a marker a Write save did not mention when its words are deleted', async () => {
		const body = [A, MARKED, C].join('\n\n');
		const { sceneId, markerId } = await sceneWith(body, 'lit the candle');
		await saveSceneBody(db, sceneId, {
			title: null,
			bodyMd: [A, C].join('\n\n'),
			anchors: [],
			baseHashes: null,
			overwrite: false
		});
		expect(await anchorOf(markerId)).toBeNull();
	});

	it('leaves the anchors a Write save sends as they are', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		const start = BEFORE.indexOf('the door');
		await saveSceneBody(db, sceneId, {
			title: null,
			bodyMd: `${BEFORE}\n\nMore.`,
			anchors: [{ id: markerId, anchorStart: start, anchorEnd: start + 8 }],
			baseHashes: null,
			overwrite: false
		});
		expect(await anchorOf(markerId)).toEqual({ start, end: start + 8 });
	});

	it('leaves a marker that moved to another scene alone', async () => {
		const { sceneId, markerId } = await sceneWith(BEFORE, 'lit the candle');
		await save(sceneId, AFTER);
		const [other] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 2, bodyMd: AFTER })
			.returning();
		await db.update(sceneMarkers).set({ sceneId: other.id }).where(eq(sceneMarkers.id, markerId));
		await sweep();
		expect(await anchorOf(markerId)).toBeNull();
		expect(await pending()).toBe(0);
	});
});

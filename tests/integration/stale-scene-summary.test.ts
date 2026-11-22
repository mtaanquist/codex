// A scene summary the Assistant wrote before the scene last changed is sent to
// the model with a note that it is out of date, by every reader: the context
// outline, the focus scene, its neighbours, the recap, an attached outline,
// and the list_scenes and get_scene tools the Assistant and MCP clients share.
// The writer's own summary is never labelled.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { chapters, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { OUT_OF_DATE_SCENE_SUMMARY_NOTE } from '../../src/lib/server/summary-currency';

const { assembleContext, assembleRecapContext } =
	await import('../../src/lib/server/llm/context/assemble');
const { resolveAttachments } = await import('../../src/lib/server/llm/attachments');
const { dispatchToolCall } = await import('../../src/lib/server/llm/tools/dispatch');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;
let storyId: string;
let staleId: string;
let currentId: string;
let mineId: string;

const STALE = 'The duel ends with Bram dead.';
const CURRENT = 'Alice buries the sword.';
const MINE = 'Bram walks away.';
const labelled = `${OUT_OF_DATE_SCENE_SUMMARY_NOTE} ${STALE}`;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table scenes, chapters, stories, universes, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'Descent' })
		.returning({ id: chapters.id });
	const insert = async (globalPosition: number, title: string, summaryMd: string) => {
		const [row] = await db
			.insert(scenes)
			.values({
				storyId,
				chapterId: chapter.id,
				globalPosition,
				title,
				bodyMd: `Body of ${title}.`,
				summaryMd,
				status: 'draft'
			})
			.returning({ id: scenes.id });
		return row.id;
	};
	staleId = await insert(1, 'The Duel', STALE);
	currentId = await insert(2, 'The Grave', CURRENT);
	mineId = await insert(3, 'The Road', MINE);
	// Assistant summaries, stamped as the summary job does; the writer then
	// rewrote The Duel, so its summary tells an older scene.
	await pool.query(
		`update scenes set summary_generated_at = updated_at - interval '1 minute' where id = $1`,
		[staleId]
	);
	await pool.query(`update scenes set summary_generated_at = updated_at where id = $1`, [
		currentId
	]);
});

afterAll(async () => {
	await pool.end();
});

// Each reader sends the out-of-date summary labelled, and the others as they are.
function expectLabelled(text: string) {
	expect(text).toContain(labelled);
	expect(text).not.toContain(`${OUT_OF_DATE_SCENE_SUMMARY_NOTE} ${CURRENT}`);
	expect(text).not.toContain(`${OUT_OF_DATE_SCENE_SUMMARY_NOTE} ${MINE}`);
	expect(text).toContain(CURRENT);
	expect(text).toContain(MINE);
}

describe('an out-of-date scene summary', () => {
	it('is labelled in the story outline', async () => {
		const context = await assembleContext(db, { userId, storyId });
		expectLabelled(context!.text);
	});

	it('is labelled on the focus scene and as a neighbour', async () => {
		const onIt = await assembleContext(db, {
			userId,
			storyId,
			sceneId: staleId,
			includeTiers: ['frame', 'scene-local']
		});
		expect(onIt!.text).toContain(`Summary: ${labelled}`);
		const next = await assembleContext(db, {
			userId,
			storyId,
			sceneId: currentId,
			includeTiers: ['frame', 'scene-local']
		});
		expect(next!.text).toContain(`(scene id: ${staleId}): ${labelled}`);
	});

	it('is labelled in the recap', async () => {
		expectLabelled((await assembleRecapContext(db, { userId, storyId }))!);
	});

	it('is labelled in an attached story outline', async () => {
		const [outline] = await resolveAttachments(
			db,
			userId,
			[{ kind: 'story', id: storyId, label: 'The Tide Below', depth: 'outline' }],
			10_000
		);
		expectLabelled(outline.text);
	});

	it('is labelled by list_scenes and get_scene', async () => {
		const ctx = { db, userId, universeId };
		const list = await dispatchToolCall(ctx, { id: 'a', name: 'list_scenes', arguments: '{}' });
		const scenesListed = JSON.parse(list.result).stories[0].chapters[0].scenes;
		expect(scenesListed.map((s: { summary: string }) => s.summary)).toEqual([
			labelled,
			CURRENT,
			MINE
		]);
		const read = async (sceneId: string) =>
			JSON.parse(
				(
					await dispatchToolCall(ctx, {
						id: 'b',
						name: 'get_scene',
						arguments: JSON.stringify({ sceneId })
					})
				).result
			).summary;
		expect(await read(staleId)).toBe(labelled);
		expect(await read(currentId)).toBe(CURRENT);
		expect(await read(mineId)).toBe(MINE);
	});

	it('loses the label once the summary is current again', async () => {
		await pool.query(`update scenes set summary_generated_at = updated_at where id = $1`, [
			staleId
		]);
		const context = await assembleContext(db, { userId, storyId });
		expect(context!.text).not.toContain(OUT_OF_DATE_SCENE_SUMMARY_NOTE);
		expect(context!.text).toContain(STALE);
		const [row] = await db
			.select({ summaryMd: scenes.summaryMd })
			.from(scenes)
			.where(eq(scenes.id, staleId));
		// Labelling is only how it is sent; the stored summary is untouched.
		expect(row.summaryMd).toBe(STALE);
	});
});

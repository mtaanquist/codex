import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { JobWithMetadata } from 'pg-boss';
import * as schema from '../../src/lib/server/db/schema';
import {
	assistantUsage,
	embeddingIndexes,
	sceneChunks,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { EmbeddingsProvider } from '../../src/lib/server/llm/embeddings';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'embeddings-index-test-secret';

const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { saveEmbeddingsConfig } = await import('../../src/lib/server/llm/embeddings/config');
const {
	indexScenes,
	enableEmbeddingIndex,
	completeEmbeddingIndex,
	removeEmbeddingIndex,
	nearestChunks,
	storyIndexOwner,
	storiesBehindIndex,
	estimateEmbeddingIndex,
	embeddingIndexStatus
} = await import('../../src/lib/server/llm/embeddings/scene-index');
const { trashScene, restoreScene, destroyScene } =
	await import('../../src/lib/server/scene-lifecycle');
const { purgeStory } = await import('../../src/lib/server/story-delete');
const { purgeUniverse } = await import('../../src/lib/server/universe-lifecycle');
const { purgeAccount } = await import('../../src/lib/server/account-deletion');
const { createHandlers } = await import('../../src/worker/handlers');
type WorkerDeps = import('../../src/worker/handlers').WorkerDeps;

// The search index (scene_chunks), against the test database and a fake
// embeddings provider. A passage's vector counts a few words, so a query for
// "sea" lands nearest the passages about the sea.

const WORDS = ['sea', 'fire', 'love'];
function vectorOf(text: string): number[] {
	const lower = text.toLowerCase();
	return [...WORDS.map((w) => lower.split(w).length - 1), 1];
}

let pool: pg.Pool;
let db: Database;
let inputs: string[][] = [];
let failWith: Error | null = null;
const provider: EmbeddingsProvider = {
	async embed(request) {
		if (failWith) throw failWith;
		inputs.push(request.input);
		return {
			vectors: request.input.map(vectorOf),
			usage: { promptTokens: request.input.length * 10, completionTokens: 0 }
		};
	}
};
const deps = { provider, sleep: async () => {} };

let userId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

async function makeUser(email: string) {
	const [user] = await db
		.insert(users)
		.values({ email, displayName: email.split('@')[0], passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	await saveAccountLlmConfig(db, user.id, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		provider: 'anthropic',
		endpoint: '',
		apiKey: 'sk-ant',
		models: {}
	});
	await saveEmbeddingsConfig(db, user.id, {
		enabled: true,
		provider: 'custom',
		endpoint: 'http://embeddings.test/v1',
		apiKey: '',
		model: 'fake-embed',
		pricePerToken: 0.000001
	});
	return user.id;
}

async function makeStory(ownerId: string, inUniverse: string, title = 'Tides') {
	const [story] = await db
		.insert(stories)
		.values({ universeId: inUniverse, ownerId, title })
		.returning({ id: stories.id });
	return story.id;
}

async function makeScene(inStory: string, bodyMd: string, position = 0) {
	const [scene] = await db
		.insert(scenes)
		.values({ storyId: inStory, globalPosition: position, bodyMd, title: `Scene ${position}` })
		.returning({ id: scenes.id });
	return scene.id;
}

async function chunksOf(sceneId: string) {
	return await db
		.select()
		.from(sceneChunks)
		.where(eq(sceneChunks.sceneId, sceneId))
		.orderBy(sceneChunks.chunkIndex);
}

async function allChunks() {
	return await db.select().from(sceneChunks);
}

const run = (scope: { storyId: string } | { universeId: string } = { universeId }) =>
	indexScenes(db, { userId, scope, deps });

beforeEach(async () => {
	await pool.query(
		'truncate table scene_chunks, embedding_indexes, assistant_usage, assistant_job_spend, scenes, stories, universes, app_settings, users cascade'
	);
	inputs = [];
	failWith = null;
	userId = await makeUser('w@example.com');
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'Saltmarsh' })
		.returning({ id: universes.id });
	universeId = universe.id;
	storyId = await makeStory(userId, universeId);
});

describe('indexing a universe', () => {
	it('embeds every passage, records the model and size, and logs usage', async () => {
		const a = await makeScene(storyId, 'The sea was grey.\n\nThe fire was out.', 0);
		const b = await makeScene(storyId, 'Love, of a kind.', 1);
		await makeScene(storyId, '   \n', 2);
		await enableEmbeddingIndex(db, userId, universeId);

		const result = await run();
		expect(result).toMatchObject({ complete: true, scenes: 2, embedded: 2, reused: 0 });
		const [chunkA] = await chunksOf(a);
		expect(chunkA).toMatchObject({
			chunkIndex: 0,
			content: 'The sea was grey.\n\nThe fire was out.',
			model: 'fake-embed',
			dimensions: 4,
			embedding: [1, 1, 0, 1]
		});
		expect((await chunksOf(b))[0].embedding).toEqual([0, 0, 1, 1]);
		// One request for both scenes of the story.
		expect(inputs).toHaveLength(1);
		const usage = await db.select().from(assistantUsage);
		expect(usage).toEqual([expect.objectContaining({ role: 'embeddings', storyId })]);

		// Nothing changed, so nothing is sent again.
		inputs = [];
		expect(await run()).toMatchObject({ complete: true, scenes: 0, embedded: 0 });
		expect(inputs).toEqual([]);
	});

	it('leaves scene text alone', async () => {
		const body = 'The sea was grey.\r\n\r\nNothing else.';
		const id = await makeScene(storyId, body);
		const [before] = await db.select().from(scenes).where(eq(scenes.id, id));
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		const [after] = await db.select().from(scenes).where(eq(scenes.id, id));
		expect(after).toEqual(before);
	});

	it('embeds again only the passages an edit changed', async () => {
		const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} about the sea. `.repeat(12));
		const id = await makeScene(storyId, long.join('\n\n'));
		const other = await makeScene(storyId, 'Untouched fire.', 1);
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		const before = await chunksOf(id);
		expect(before.length).toBeGreaterThan(1);

		inputs = [];
		await db
			.update(scenes)
			.set({ bodyMd: [...long, 'A new ending with love.'].join('\n\n') })
			.where(eq(scenes.id, id));
		const result = await run();
		expect(result.scenes).toBe(1);
		expect(inputs.flat()).toHaveLength(1);
		expect(inputs[0][0]).toContain('A new ending with love.');
		const after = await chunksOf(id);
		expect(after.slice(0, -1).map((c) => c.contentHash)).toEqual(
			before.slice(0, -1).map((c) => c.contentHash)
		);
		expect((await chunksOf(other))[0].sceneUpdatedAt).toBeTruthy();
	});

	it('embeds everything again after a model change', async () => {
		const id = await makeScene(storyId, 'The sea.');
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		await saveEmbeddingsConfig(db, userId, {
			enabled: true,
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'fake-embed-2'
		});
		inputs = [];
		expect(await run()).toMatchObject({ scenes: 1, embedded: 1, reused: 0 });
		expect(inputs).toEqual([['The sea.']]);
		expect((await chunksOf(id)).map((c) => c.model)).toEqual(['fake-embed-2']);
	});

	it('drops a trashed scene and an emptied one, and indexes a restored one', async () => {
		const trashed = await makeScene(storyId, 'The sea.');
		const emptied = await makeScene(storyId, 'Fire.', 1);
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		expect(await allChunks()).toHaveLength(2);

		await trashScene(db, userId, trashed);
		await db.update(scenes).set({ bodyMd: '' }).where(eq(scenes.id, emptied));
		inputs = [];
		expect(await run()).toMatchObject({ removed: 2, embedded: 0 });
		expect(await allChunks()).toEqual([]);

		await restoreScene(db, userId, trashed);
		expect(await run()).toMatchObject({ scenes: 1, embedded: 1 });
		expect(inputs).toEqual([['The sea.']]);
	});

	it('skips a story muted for the Assistant', async () => {
		await makeScene(storyId, 'The sea.');
		const muted = await makeStory(userId, universeId, 'Quiet');
		await makeScene(muted, 'Hidden fire.');
		await saveStoryLlmOverride(db, muted, { enabled: false });
		await enableEmbeddingIndex(db, userId, universeId);
		expect(await run()).toMatchObject({ complete: true, scenes: 1 });
		expect(inputs.flat()).toEqual(['The sea.']);
	});

	it('indexes only the writer own stories, and nothing where the index is off', async () => {
		const other = await makeUser('o@example.com');
		await makeStory(other, universeId, 'Theirs').then((id) => makeScene(id, 'Their sea.'));
		await makeScene(storyId, 'My sea.');
		expect(await run()).toMatchObject({ complete: true, scenes: 0 });
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		expect(inputs.flat()).toEqual(['My sea.']);
	});

	it('stops at the spend cap and keeps what it finished', async () => {
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			provider: 'anthropic',
			endpoint: '',
			apiKey: '',
			models: {},
			spendCapUsd: 0.000001
		});
		await makeScene(storyId, 'The sea. '.repeat(200));
		await enableEmbeddingIndex(db, userId, universeId);
		const result = await indexScenes(db, { userId, scope: { universeId }, jobId: 'j1', deps });
		expect(result).toMatchObject({ complete: false, capped: true, scenes: 0 });
		expect(inputs).toEqual([]);
	});

	it('sends nothing while the Assistant is off', async () => {
		await makeScene(storyId, 'The sea.');
		await enableEmbeddingIndex(db, userId, universeId);
		await saveAccountLlmConfig(db, userId, {
			enabled: false,
			assistantName: '',
			persona: 'balanced',
			provider: 'anthropic',
			endpoint: '',
			apiKey: '',
			models: {}
		});
		expect(await run()).toMatchObject({ disabled: true, complete: false });
		expect(inputs).toEqual([]);
	});

	it('reports a failing endpoint without throwing', async () => {
		await makeScene(storyId, 'The sea.');
		await enableEmbeddingIndex(db, userId, universeId);
		failWith = new Error('Endpoint returned 400: bad model');
		expect(await run()).toMatchObject({ complete: false, error: expect.stringContaining('400') });
	});
});

describe('nearestChunks', () => {
	it('finds the closest passages in the writer own indexed stories only', async () => {
		const sea = await makeScene(storyId, 'Sea sea sea.');
		await makeScene(storyId, 'Fire and fire.', 1);
		const second = await makeStory(userId, universeId, 'Embers');
		await makeScene(second, 'Love and the sea.');
		// Another writer's story in the same universe, indexed by them.
		const other = await makeUser('o@example.com');
		const theirs = await makeStory(other, universeId, 'Theirs');
		await makeScene(theirs, 'Sea sea sea sea.');
		await enableEmbeddingIndex(db, userId, universeId);
		await enableEmbeddingIndex(db, other, universeId);
		await run();
		await indexScenes(db, { userId: other, scope: { universeId }, deps });

		const query = { model: 'fake-embed', vector: vectorOf('sea') };
		const found = await nearestChunks(db, userId, { universeId }, query, 2);
		expect(found.map((f) => f.content)).toEqual(['Sea sea sea.', 'Love and the sea.']);
		expect(found[0]).toMatchObject({
			sceneId: sea,
			storyId,
			universeId,
			chunkIndex: 0,
			storyTitle: 'Tides',
			sceneTitle: 'Scene 0'
		});
		expect(found[0].distance).toBeLessThan(found[1].distance);

		const inStory = await nearestChunks(db, userId, { storyId: second }, query, 5);
		expect(inStory.map((f) => f.content)).toEqual(['Love and the sea.']);
		// Another model, or another size, compares with nothing.
		expect(await nearestChunks(db, userId, { universeId }, { ...query, model: 'x' })).toEqual([]);
		expect(
			await nearestChunks(db, userId, { universeId }, { model: 'fake-embed', vector: [1, 0] })
		).toEqual([]);
	});

	it('leaves out trashed scenes, muted stories, and a universe whose index is off', async () => {
		const sea = await makeScene(storyId, 'Sea.');
		const muted = await makeStory(userId, universeId, 'Quiet');
		await makeScene(muted, 'Sea again.');
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		await saveStoryLlmOverride(db, muted, { enabled: false });
		const query = { model: 'fake-embed', vector: vectorOf('sea') };
		expect((await nearestChunks(db, userId, { universeId }, query)).map((f) => f.sceneId)).toEqual([
			sea
		]);
		await trashScene(db, userId, sea);
		expect(await nearestChunks(db, userId, { universeId }, query)).toEqual([]);
		await restoreScene(db, userId, sea);
		await removeEmbeddingIndex(db, userId, universeId);
		expect(await nearestChunks(db, userId, { universeId }, query)).toEqual([]);
		expect(await allChunks()).toEqual([]);
	});
});

describe('keeping the index current', () => {
	it('keeps a story current only once its universe has a finished index on the current model', async () => {
		const id = await makeScene(storyId, 'The sea.');
		expect(await storyIndexOwner(db, storyId)).toBeNull();
		await enableEmbeddingIndex(db, userId, universeId);
		expect(await storyIndexOwner(db, storyId)).toBeNull();
		await run();
		await completeEmbeddingIndex(db, userId, universeId, 'fake-embed');
		expect(await storyIndexOwner(db, storyId)).toBe(userId);
		expect(await storiesBehindIndex(db)).toEqual([]);

		await db.update(scenes).set({ bodyMd: 'The fire.' }).where(eq(scenes.id, id));
		expect(await storiesBehindIndex(db)).toEqual([{ userId, storyId }]);
		await run({ storyId });
		expect(await storiesBehindIndex(db)).toEqual([]);

		// A trashed scene with passages is behind too, until they are dropped.
		await trashScene(db, userId, id);
		expect(await storiesBehindIndex(db)).toEqual([{ userId, storyId }]);
		await run({ storyId });
		expect(await storiesBehindIndex(db)).toEqual([]);

		// Another model needs a full index the writer starts.
		await saveEmbeddingsConfig(db, userId, {
			enabled: true,
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'fake-embed-2'
		});
		expect(await storyIndexOwner(db, storyId)).toBeNull();
		expect(await storiesBehindIndex(db)).toEqual([]);
	});

	it('estimates the first full index and reports where each universe stands', async () => {
		await makeScene(storyId, 'x'.repeat(4000));
		await makeScene(storyId, 'y'.repeat(400), 1);
		await makeScene(storyId, '', 2);
		const estimate = await estimateEmbeddingIndex(db, userId, universeId);
		expect(estimate).toEqual({
			model: 'fake-embed',
			scenes: 2,
			estTokens: 1100,
			estCostUsd: expect.closeTo(0.0011, 8),
			confirm: false
		});
		expect(await embeddingIndexStatus(db, userId)).toEqual([
			{ universeId, name: 'Saltmarsh', state: 'off', scenes: 2, indexed: 0 }
		]);

		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		expect((await embeddingIndexStatus(db, userId))[0]).toMatchObject({
			state: 'partial',
			indexed: 2
		});
		await completeEmbeddingIndex(db, userId, universeId, 'fake-embed');
		expect((await embeddingIndexStatus(db, userId))[0].state).toBe('current');
		expect((await estimateEmbeddingIndex(db, userId, universeId)).scenes).toBe(0);
		await saveEmbeddingsConfig(db, userId, {
			enabled: true,
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'fake-embed-2'
		});
		expect((await embeddingIndexStatus(db, userId))[0]).toMatchObject({
			state: 'model-changed',
			indexed: 0
		});
	});
});

describe('deleting', () => {
	async function indexed() {
		const id = await makeScene(storyId, 'The sea.');
		await enableEmbeddingIndex(db, userId, universeId);
		await run();
		expect(await allChunks()).toHaveLength(1);
		return id;
	}

	it('goes with a scene deleted for good', async () => {
		const id = await indexed();
		await trashScene(db, userId, id);
		await destroyScene(db, userId, id);
		expect(await allChunks()).toEqual([]);
	});

	it('goes with a purged story', async () => {
		await indexed();
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect(await purgeStory(db, storyId)).toBe(true);
		expect(await allChunks()).toEqual([]);
	});

	it('goes with a purged universe, index setting included', async () => {
		await indexed();
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, universeId));
		expect(await purgeUniverse(db, universeId)).toBe(true);
		expect(await allChunks()).toEqual([]);
		expect(await db.select().from(embeddingIndexes)).toEqual([]);
	});

	it('goes with a deleted account', async () => {
		await indexed();
		await purgeAccount(db, userId, null, { requireSchedule: false });
		expect(await allChunks()).toEqual([]);
		expect(await db.select().from(embeddingIndexes)).toEqual([]);
	});
});

describe('the worker job', () => {
	function harness() {
		const sent: { queue: string; data: unknown }[] = [];
		const completed: { id: string; data: unknown }[] = [];
		const boss = {
			async complete(_queue: string, id: string, data: unknown) {
				completed.push({ id, data });
				return null;
			},
			async send(queue: string, data: unknown) {
				sent.push({ queue, data });
				return null;
			},
			async getJobById() {
				return null;
			}
		} as unknown as WorkerDeps['boss'];
		const handlers = createHandlers({
			db,
			boss,
			origin: 'https://codex.test',
			services: { indexScenes: (d, opts) => indexScenes(d, { ...opts, deps }) }
		});
		return { handlers, sent, completed };
	}

	function job<T>(data: T): JobWithMetadata<T> {
		return {
			id: randomUUID(),
			name: 'embeddings-index',
			data,
			signal: new AbortController().signal,
			startedOn: new Date(),
			retryCount: 0,
			retryLimit: 2
		} as JobWithMetadata<T>;
	}

	it('records a finished universe index, so upkeep starts, and settles a stopped one as failed', async () => {
		const id = await makeScene(storyId, 'The sea.');
		const { handlers, completed, sent } = harness();
		// Not turned on: nothing runs.
		await handlers.embeddingsIndex([job({ userId, universeId })]);
		expect(inputs).toEqual([]);

		await enableEmbeddingIndex(db, userId, universeId);
		await handlers.embeddingsIndex([job({ userId, universeId })]);
		expect(await storyIndexOwner(db, storyId)).toBe(userId);
		expect(completed).toEqual([]);

		await db.update(scenes).set({ bodyMd: 'The fire.' }).where(eq(scenes.id, id));
		await handlers.reconcileEmbeddings();
		expect(sent).toEqual([{ queue: 'embeddings-index', data: { userId, storyId } }]);
		await handlers.embeddingsIndex([job({ userId, storyId })]);
		expect((await chunksOf(id))[0].content).toBe('The fire.');

		failWith = new Error('Endpoint returned 400: bad model');
		await db.update(scenes).set({ bodyMd: 'The love.' }).where(eq(scenes.id, id));
		const failing = job({ userId, universeId });
		await handlers.embeddingsIndex([failing]);
		expect(completed).toEqual([{ id: failing.id, data: { failed: true } }]);
	});

	it('runs no upkeep for a story whose universe index has not finished', async () => {
		await makeScene(storyId, 'The sea.');
		await enableEmbeddingIndex(db, userId, universeId);
		const { handlers } = harness();
		await handlers.embeddingsIndex([job({ userId, storyId })]);
		expect(inputs).toEqual([]);
	});
});

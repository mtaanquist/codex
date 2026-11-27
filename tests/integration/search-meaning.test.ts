import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import { assistantUsage, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// Search by meaning (#1787), through its endpoint against the test database.
// Only the embeddings provider is stubbed: a text's vector counts a few
// words, so a query about the sea ranks the passages about the sea first.

process.env.APP_SECRET = process.env.APP_SECRET || 'search-meaning-test-secret';

const WORDS = ['sea', 'fire', 'love'];
function vectorOf(text: string): number[] {
	const lower = text.toLowerCase();
	return [...WORDS.map((w) => lower.split(w).length - 1), 1];
}

const stub = vi.hoisted(() => ({ inputs: [] as string[][], failWith: null as Error | null }));

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('../../src/lib/server/llm/embeddings/openai.ts', () => ({
	openaiEmbeddings: {
		async embed(request: { input: string[] }) {
			if (stub.failWith) throw stub.failWith;
			stub.inputs.push(request.input);
			return {
				vectors: request.input.map(vectorOf),
				usage: { promptTokens: request.input.length * 10, completionTokens: 0 }
			};
		}
	}
}));

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { saveEmbeddingsConfig } = await import('../../src/lib/server/llm/embeddings/config');
const { SpendCapError } = await import('../../src/lib/server/llm/spend');
const { EmbeddingsDisabledError } = await import('../../src/lib/server/llm/embeddings');
const { indexScenes, enableEmbeddingIndex, completeEmbeddingIndex } =
	await import('../../src/lib/server/llm/embeddings/scene-index');
const route = await import('../../src/routes/api/search/meaning/+server');

let userId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

async function makeUser(email: string, model = 'fake-embed') {
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
	await useModel(user.id, model);
	return user.id;
}

async function useModel(id: string, model: string, enabled = true) {
	await saveEmbeddingsConfig(db, id, {
		enabled,
		provider: 'custom',
		endpoint: 'http://embeddings.test/v1',
		apiKey: '',
		model,
		pricePerToken: 0.000001
	});
}

async function makeUniverse(ownerId: string, name: string) {
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name })
		.returning({ id: universes.id });
	return universe.id;
}

async function makeStory(ownerId: string, inUniverse: string, title: string) {
	const [story] = await db
		.insert(stories)
		.values({ universeId: inUniverse, ownerId, title })
		.returning({ id: stories.id, slug: stories.slug });
	return story;
}

async function makeScene(inStory: string, title: string, bodyMd: string, position = 0) {
	const [scene] = await db
		.insert(scenes)
		.values({ storyId: inStory, globalPosition: position, bodyMd, title })
		.returning({ id: scenes.id });
	return scene.id;
}

// A finished index of the writer's stories in the universe, as the account
// page's indexing job leaves it.
async function indexUniverse(owner: string, universe: string, model = 'fake-embed') {
	await enableEmbeddingIndex(db, owner, universe);
	await indexScenes(db, { userId: owner, scope: { universeId: universe } });
	await completeEmbeddingIndex(db, owner, universe, model);
}

function status(params: Record<string, string>, as = userId) {
	return route.GET({
		url: new URL(`http://localhost/api/search/meaning?${new URLSearchParams(params)}`),
		locals: { user: { id: as } }
	} as unknown as Parameters<typeof route.GET>[0]) as Promise<Response>;
}

function search(body: object, as = userId) {
	const request = new Request('http://localhost/api/search/meaning', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return route.POST({
		request,
		locals: { user: { id: as } }
	} as unknown as Parameters<typeof route.POST>[0]) as Promise<Response>;
}

async function refused(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
	try {
		await promise;
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
	throw new Error('expected a refusal');
}

beforeEach(async () => {
	await pool.query(
		'truncate table scene_chunks, embedding_indexes, assistant_usage, assistant_job_spend, scenes, stories, universes, app_settings, users cascade'
	);
	resetRateLimits();
	stub.inputs = [];
	stub.failWith = null;
	userId = await makeUser('w@example.com');
	universeId = await makeUniverse(userId, 'Saltmarsh');
	storyId = (await makeStory(userId, universeId, 'Tides')).id;
});

describe('whether a universe can be searched by meaning', () => {
	it('only once it has a finished index on the current model', async () => {
		await makeScene(storyId, 'Harbour', 'The sea.');
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		const ready = async () => (await (await status({ story: story.slug })).json()).universeId;

		expect(await ready()).toBeNull();
		await enableEmbeddingIndex(db, userId, universeId);
		expect(await ready()).toBeNull();
		await indexScenes(db, { userId, scope: { universeId } });
		expect(await ready()).toBeNull();
		await completeEmbeddingIndex(db, userId, universeId, 'fake-embed');
		expect(await ready()).toBe(universeId);
		expect(await (await status({ universe: universeId })).json()).toEqual({ universeId });

		// Another model needs a full index again; embeddings off hide it too.
		await useModel(userId, 'other-embed');
		expect(await ready()).toBeNull();
		await useModel(userId, 'fake-embed', false);
		expect(await ready()).toBeNull();
		// Opening the palette sends nothing to the model.
		expect(stub.inputs.flat()).not.toContain('sea');
	});

	it("is a 404 for another writer's story or universe", async () => {
		const other = await makeUser('o@example.com');
		const theirUniverse = await makeUniverse(other, 'Elsewhere');
		const theirs = await makeStory(other, theirUniverse, 'Theirs');
		await indexUniverse(other, theirUniverse);
		expect((await refused(status({ story: theirs.id }))).status).toBe(404);
		expect((await refused(status({ universe: theirUniverse }))).status).toBe(404);
		expect((await refused(search({ universeId: theirUniverse, query: 'sea' }))).status).toBe(404);
	});
});

describe('searching by meaning', () => {
	it('ranks scenes by their nearest passage, one result per scene', async () => {
		const harbour = await makeScene(storyId, 'Harbour', 'The sea, the sea, the sea.\n\nThen fire.');
		const forge = await makeScene(storyId, 'Forge', 'Fire and fire and fire.', 1);
		const embers = await makeStory(userId, universeId, 'Embers');
		const letters = await makeScene(embers.id, 'Letters', 'Love, and the sea.', 0);
		// Not the writer's: another universe, and another writer's story here.
		const elsewhere = await makeUniverse(userId, 'Elsewhere');
		const far = await makeStory(userId, elsewhere, 'Far');
		await makeScene(far.id, 'Far shore', 'Sea sea sea sea.');
		const other = await makeUser('o@example.com');
		const theirs = await makeStory(other, universeId, 'Theirs');
		await makeScene(theirs.id, 'Their sea', 'Sea sea sea sea sea.');
		await indexUniverse(userId, universeId);
		await indexUniverse(userId, elsewhere);
		await indexUniverse(other, universeId);
		await db.delete(assistantUsage);
		stub.inputs = [];

		const response = await search({ universeId, query: '  the sea  ' });
		const { results } = await response.json();
		expect(results.map((r: { sceneId: string }) => r.sceneId)).toEqual([harbour, letters, forge]);
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(results[0]).toEqual({
			sceneId: harbour,
			sceneTitle: 'Harbour',
			storyTitle: 'Tides',
			passage: 'The sea, the sea, the sea. Then fire.',
			href: `/stories/${story.slug}?scene=${harbour}`
		});
		expect(results[1]).toMatchObject({ storyTitle: 'Embers', sceneTitle: 'Letters' });
		// One request for the query, counted as usage with no story.
		expect(stub.inputs).toEqual([['the sea']]);
		expect(await db.select().from(assistantUsage)).toEqual([
			expect.objectContaining({ userId, role: 'embeddings', storyId: null })
		]);
	});

	it('leaves out stories muted for the Assistant', async () => {
		const sea = await makeScene(storyId, 'Harbour', 'The sea.');
		const quiet = await makeStory(userId, universeId, 'Quiet');
		await makeScene(quiet.id, 'Hush', 'Sea sea sea.');
		await indexUniverse(userId, universeId);
		await saveStoryLlmOverride(db, quiet.id, { enabled: false });
		const { results } = await (await search({ universeId, query: 'sea' })).json();
		expect(results.map((r: { sceneId: string }) => r.sceneId)).toEqual([sea]);
	});

	it('refuses an empty or long query and a universe with no index, sending nothing', async () => {
		await makeScene(storyId, 'Harbour', 'The sea.');
		expect((await refused(search({ universeId, query: 'sea' }))).status).toBe(404);
		await indexUniverse(userId, universeId);
		stub.inputs = [];
		expect((await refused(search({ universeId, query: '   ' }))).status).toBe(400);
		expect((await refused(search({ universeId, query: 'x'.repeat(501) }))).status).toBe(400);
		expect((await refused(search({ universeId: 'nope', query: 'sea' }))).status).toBe(400);
		expect(stub.inputs).toEqual([]);
	});

	it('answers a failed request with a plain message', async () => {
		await makeScene(storyId, 'Harbour', 'The sea.');
		await indexUniverse(userId, universeId);
		stub.failWith = new SpendCapError();
		expect(await refused(search({ universeId, query: 'sea' }))).toEqual({
			status: 403,
			message: 'This search could take you past your spend cap, so it was not sent.'
		});
		stub.failWith = new EmbeddingsDisabledError();
		expect((await refused(search({ universeId, query: 'sea' }))).status).toBe(403);
		stub.failWith = new Error('Endpoint returned 401: Unauthorized');
		expect((await refused(search({ universeId, query: 'sea' }))).status).toBe(502);
	});
});

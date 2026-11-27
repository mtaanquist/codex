import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assistantUsage,
	chapters,
	characters,
	entityMentions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import type { EmbeddingsProvider } from '../../src/lib/server/llm/embeddings';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Suggest details with an embeddings index (#1786): the read of the scenes
// that mention an entity also sends the passages closest in meaning to what is
// known about it. Against the test database, a stub chat provider, and a fake
// embeddings provider whose vectors count a few words.

process.env.APP_SECRET = process.env.APP_SECRET || 'entity-enrich-related-test-secret';

const { enrichEntityFromText, estimateEntityEnrich } =
	await import('../../src/lib/server/llm/enrich');
const { RELATED_HEADING } = await import('../../src/lib/server/llm/enrich-context');
const { saveAccountLlmConfig, saveStoryLlmOverride } =
	await import('../../src/lib/server/llm/config');
const { saveEmbeddingsConfig } = await import('../../src/lib/server/llm/embeddings/config');
const { enableEmbeddingIndex, completeEmbeddingIndex, indexScenes } =
	await import('../../src/lib/server/llm/embeddings/scene-index');
const { SpendMeter } = await import('../../src/lib/server/llm/spend');
const { encryptSecret } = await import('../../src/lib/server/crypto');

let prompts: string[] = [];
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(req) {
		prompts.push(req.messages.map((m) => m.content).join('\n'));
		return { content: '{"aliases":["The Old Man"],"details":[],"summary":null}', toolCalls: [] };
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};

const WORDS = ['grey', 'fisherman', 'net'];
function vectorOf(text: string): number[] {
	const lower = text.toLowerCase();
	return [...WORDS.map((w) => lower.split(w).length - 1), 1];
}
// Every text sent to the embeddings model.
let embedded: string[] = [];
let embedFails: Error | null = null;
const embeddingsProvider: EmbeddingsProvider = {
	async embed(request) {
		if (embedFails) throw embedFails;
		embedded.push(...request.input);
		return {
			vectors: request.input.map(vectorOf),
			usage: { promptTokens: request.input.length * 10, completionTokens: 0 }
		};
	}
};
const embedDeps = { provider: embeddingsProvider, sleep: async () => {} };
const deps: GatewayDeps & { embeddings: typeof embedDeps } = {
	provider: stubProvider,
	http: noHttp,
	sleep: async () => {},
	embeddings: embedDeps
};

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;
let storyId: string;
let bram: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

async function embeddingsOn(pricePerToken = 0.000001) {
	await saveEmbeddingsConfig(db, ownerId, {
		enabled: true,
		provider: 'custom',
		endpoint: 'http://embeddings.test/v1',
		apiKey: '',
		model: 'fake-embed',
		pricePerToken
	});
}

beforeEach(async () => {
	prompts = [];
	embedded = [];
	embedFails = null;
	await pool.query(
		'truncate table scene_chunks, embedding_indexes, assistant_usage, assistant_job_spend, entity_suggestions, entity_mentions, revisions, characters, scenes, stories, universes, app_settings, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'o@example.com', displayName: 'Olwen', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	universeId = universe.id;
	storyId = await makeStory('The Tide Below');
	const [c] = await db
		.insert(characters)
		.values({
			universeId,
			ownerId,
			name: 'Bram',
			summaryMd: 'An old fisherman with grey eyes who mends nets.'
		})
		.returning({ id: characters.id });
	bram = c.id;
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
	await embeddingsOn();
});

async function makeStory(title: string) {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title })
		.returning({ id: stories.id });
	return story.id;
}

// Scenes in reading order; a body that names Bram is indexed as a mention.
async function writeScenes(inStoryId: string, bodies: string[]) {
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId: inStoryId, position: 1, title: 'One' })
		.returning({ id: chapters.id });
	for (const [i, bodyMd] of bodies.entries()) {
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId: inStoryId,
				chapterId: chapter.id,
				globalPosition: i + 1,
				title: `Scene ${i + 1}`,
				bodyMd
			})
			.returning({ id: scenes.id });
		const at = bodyMd.indexOf('Bram');
		if (at !== -1) {
			await db.insert(entityMentions).values({
				sourceType: 'scene',
				sourceId: scene.id,
				targetType: 'character',
				targetId: bram,
				position: at,
				surroundingText: bodyMd
			});
		}
	}
}

// The story's scenes: Bram named in the first, the second its neighbour, and
// the old fisherman described without his name far from both.
async function writeBook() {
	await writeScenes(storyId, [
		'Bram counted the boats.',
		'NEIGHBOUR the tide came in.',
		'FILLER the gulls cried.',
		'FILLER-TWO the bells rang.',
		'UNNAMED the grey fisherman sat with his net, grey eyes on the water.'
	]);
}

async function indexUniverse() {
	await enableEmbeddingIndex(db, ownerId, universeId);
	const result = await indexScenes(db, {
		userId: ownerId,
		scope: { universeId },
		deps: embedDeps
	});
	expect(result.complete).toBe(true);
	await completeEmbeddingIndex(db, ownerId, universeId, 'fake-embed');
	embedded = [];
	await db.delete(assistantUsage);
}

const read = (
	mode: 'scenes' | 'book' = 'scenes',
	scope: { storyId: string } | { universeId: string } = { storyId },
	extra: { meter?: InstanceType<typeof SpendMeter> } = {}
) => enrichEntityFromText(db, { userId: ownerId, scope, entityId: bram, mode, ...extra }, deps);

const count = (text: string, part: string) => text.split(part).length - 1;

describe('Suggest details with an embeddings index', () => {
	it('also sends a passage that does not name the entity, labelled, after the scenes read, once', async () => {
		await writeBook();
		await indexUniverse();
		const result = await read();

		expect(prompts).toHaveLength(1);
		const prompt = prompts[0];
		expect(prompt).toContain('UNNAMED the grey fisherman');
		expect(prompt).toContain(RELATED_HEADING);
		expect(prompt.indexOf('Bram counted')).toBeLessThan(prompt.indexOf(RELATED_HEADING));
		expect(prompt.indexOf(RELATED_HEADING)).toBeLessThan(prompt.indexOf('UNNAMED'));
		// The closest passage comes first among them.
		const related = prompt.slice(prompt.indexOf(RELATED_HEADING));
		expect(related.indexOf('UNNAMED')).toBeLessThan(related.indexOf('FILLER'));
		// Scenes already read are not sent again as passages.
		expect(count(prompt, 'Bram counted')).toBe(1);
		expect(count(prompt, 'NEIGHBOUR')).toBe(1);
		expect(result).toMatchObject({ scenes: 2, requests: 1 });
		expect(result.related).toBeGreaterThanOrEqual(1);

		// One query, from what is known about him, logged as embeddings usage.
		expect(embedded).toHaveLength(1);
		expect(embedded[0]).toContain('Bram');
		expect(embedded[0]).toContain('An old fisherman with grey eyes');
		const usage = await db.select().from(assistantUsage);
		expect(usage.filter((u) => u.role === 'embeddings')).toHaveLength(1);
	});

	it('counts the query against the read spend meter', async () => {
		await writeBook();
		await indexUniverse();
		const meter = new SpendMeter({
			capUsd: 100,
			pricing: { 'chat-model': { prompt: 0, completion: 0 } }
		});
		await read('scenes', { storyId }, { meter });
		// 10 tokens at the embeddings price; the chat model is free.
		expect(meter.spentUsd).toBeCloseTo(0.00001, 10);

		prompts = [];
		const capped = new SpendMeter({
			capUsd: 0.000001,
			pricing: { 'chat-model': { prompt: 0, completion: 0 } }
		});
		await embeddingsOn(1);
		const result = await read('scenes', { storyId }, { meter: capped });
		// The query could pass the cap, so nothing is sent and the read stops.
		expect(embedded).toHaveLength(1);
		expect(prompts).toHaveLength(0);
		expect(result).toMatchObject({ capped: true, requests: 0 });
	});

	it('leaves out passages from a story muted for the Assistant', async () => {
		await writeBook();
		const quiet = await makeStory('The Quiet Book');
		await writeScenes(quiet, ['MUTED the grey fisherman and his grey net.']);
		await indexUniverse();
		await saveStoryLlmOverride(db, quiet, { enabled: false });
		await read('scenes', { universeId });
		expect(prompts[0]).toContain('UNNAMED');
		expect(prompts[0]).not.toContain('MUTED');
	});

	it('does not search when reading the whole book', async () => {
		await writeBook();
		await indexUniverse();
		await read('book');
		expect(embedded).toEqual([]);
		expect(prompts[0]).not.toContain(RELATED_HEADING);
	});

	it('counts room for the passages in the estimate', async () => {
		await writeBook();
		const before = await estimateEntityEnrich(db, {
			userId: ownerId,
			scope: { storyId },
			entityId: bram
		});
		await indexUniverse();
		const after = await estimateEntityEnrich(db, {
			userId: ownerId,
			scope: { storyId },
			entityId: bram
		});
		expect(after!.scenes.scenes).toBe(before!.scenes.scenes);
		expect(after!.scenes.estTokens).toBeGreaterThan(before!.scenes.estTokens);
		expect(embedded).toEqual([]);
	});
});

describe('Suggest details without an index', () => {
	async function baseline() {
		await read();
		const prompt = prompts[0];
		prompts = [];
		return prompt;
	}

	it('sends the same request as before when the universe has no index', async () => {
		await writeBook();
		await enableEmbeddingIndex(db, ownerId, universeId);
		// Turned on but its first full index not finished.
		await indexScenes(db, { userId: ownerId, scope: { universeId }, deps: embedDeps });
		embedded = [];
		const prompt = await baseline();
		expect(prompt).not.toContain('UNNAMED');
		expect(prompt).not.toContain(RELATED_HEADING);
		expect(embedded).toEqual([]);
	});

	it('sends the same request when embeddings are off, the index from another model, or the query fails', async () => {
		await writeBook();
		const plain = await baseline();
		await indexUniverse();

		await saveEmbeddingsConfig(db, ownerId, {
			enabled: false,
			provider: 'custom',
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'fake-embed'
		});
		expect(await baseline()).toBe(plain);

		await saveEmbeddingsConfig(db, ownerId, {
			enabled: true,
			provider: 'custom',
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'other-embed'
		});
		expect(await baseline()).toBe(plain);

		// A stored key sealed with an APP_SECRET since rotated (#1887).
		await embeddingsOn();
		const secret = process.env.APP_SECRET;
		process.env.APP_SECRET = 'a-secret-since-rotated';
		const sealed = encryptSecret('sk-embed');
		process.env.APP_SECRET = secret;
		await pool.query(
			`update users set llm_config = jsonb_set(llm_config, '{embeddings,apiKeyEnc}', to_jsonb($1::text)) where id = $2`,
			[sealed, ownerId]
		);
		expect(await baseline()).toBe(plain);
		expect(
			await estimateEntityEnrich(db, { userId: ownerId, scope: { storyId }, entityId: bram })
		).toBeTruthy();
		expect(embedded).toEqual([]);

		await pool.query(
			`update users set llm_config = llm_config #- '{embeddings,apiKeyEnc}' where id = $1`,
			[ownerId]
		);
		embedFails = new Error('the endpoint is down');
		const result = await read();
		expect(prompts[0]).toBe(plain);
		expect(result).toMatchObject({ requests: 1 });
		expect(result.related).toBeUndefined();
		expect(embedded).toEqual([]);
	});
});

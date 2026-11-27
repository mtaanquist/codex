import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { assistantUsage, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'llm-embeddings-test-secret';

const { saveAccountLlmConfig, accountLlmView } = await import('../../src/lib/server/llm/config');
const { embed, testEmbeddings, EmbeddingsDisabledError, EMBED_BATCH_SIZE, embeddingsView } =
	await import('../../src/lib/server/llm/embeddings');
const { saveEmbeddingsConfig } = await import('../../src/lib/server/llm/embeddings/config');
const { egressHttpRequest } = await import('../../src/lib/server/llm/egress');
const { SpendCapError, SpendMeter } = await import('../../src/lib/server/llm/spend');

// The embeddings setting and embed(), against the test database and a fake
// embeddings server on loopback, reached through the real egress transport.

let pool: pg.Pool;
let db: Database;
let userId: string;
let server: Server;
let base: string;
let requests: { input: string[]; authorization?: string }[] = [];
let failNext = 0;

const http = egressHttpRequest({ policy: 'open', allowlist: [] });
const noSleep = async () => {};

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const { input } = JSON.parse(raw) as { input: string[] };
			requests.push({ input, authorization: req.headers.authorization });
			if (failNext > 0) {
				failNext -= 1;
				res.writeHead(500).end('busy');
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					data: input.map((text, index) => ({ embedding: [text.length, index, 0.5, 1], index })),
					usage: { prompt_tokens: input.length * 10, total_tokens: input.length * 10 }
				})
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

beforeEach(async () => {
	await pool.query('truncate table assistant_usage, app_settings, users cascade');
	const [user] = await db
		.insert(users)
		.values({ email: 'w@example.com', displayName: 'Wren', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	requests = [];
	failNext = 0;
});

afterAll(async () => {
	server.closeAllConnections();
	server.close();
	await pool.end();
});

// The Assistant on (its kill switch off) on Claude, which has no embeddings
// endpoint of its own.
async function assistantOn(enabled = true) {
	await saveAccountLlmConfig(db, userId, {
		enabled,
		assistantName: '',
		persona: 'balanced',
		provider: 'anthropic',
		endpoint: '',
		apiKey: 'sk-ant',
		models: {},
		spendCapUsd: 1
	});
}

async function setUp(fields: Partial<Parameters<typeof saveEmbeddingsConfig>[2]> = {}) {
	const result = await saveEmbeddingsConfig(db, userId, {
		enabled: true,
		provider: 'custom',
		endpoint: base,
		apiKey: 'local-key',
		model: 'nomic-embed-text',
		pricePerToken: 0.0000001,
		...fields
	});
	expect(result.ok).toBe(true);
	return result;
}

describe('the embeddings setting', () => {
	it('is off by default and never exposes the key', async () => {
		const view = await embeddingsView(db, userId);
		expect(view).toMatchObject({ enabled: false, ready: false, hasKey: false });
		await assistantOn();
		await setUp();
		const after = await embeddingsView(db, userId);
		expect(after).toMatchObject({
			enabled: true,
			ready: true,
			hasKey: true,
			model: 'nomic-embed-text'
		});
		expect(JSON.stringify(after)).not.toContain('local-key');
		const [row] = await db.select({ c: users.llmConfig }).from(users).where(eq(users.id, userId));
		expect(JSON.stringify(row.c)).not.toContain('local-key');
	});

	it('sits beside the Assistant settings without either save undoing the other', async () => {
		await assistantOn();
		await setUp();
		await assistantOn(false);
		expect((await embeddingsView(db, userId)).model).toBe('nomic-embed-text');
		await setUp({ model: 'mxbai-embed-large' });
		expect((await accountLlmView(db, userId)).provider).toBe('anthropic');
	});

	it('drops the key on a switch to another server, and a carried-over price on a new model', async () => {
		await setUp();
		const moved = await saveEmbeddingsConfig(db, userId, {
			enabled: true,
			endpoint: 'http://other.example/v1',
			apiKey: '',
			model: 'nomic-embed-text',
			pricePerToken: 0.0000001
		});
		expect(moved).toEqual({ ok: true, priceCleared: true });
		expect(await embeddingsView(db, userId)).toMatchObject({
			hasKey: false,
			pricePerToken: undefined
		});
		// A price typed in the same save as the new model is kept.
		await setUp({ endpoint: 'http://other.example/v1', pricePerToken: 0.0000002 });
		const retyped = await saveEmbeddingsConfig(db, userId, {
			enabled: true,
			endpoint: 'http://other.example/v1',
			apiKey: '',
			model: 'mxbai-embed-large',
			pricePerToken: 0.0000003
		});
		expect(retyped).toEqual({ ok: true });
		expect((await embeddingsView(db, userId)).pricePerToken).toBe(0.0000003);
	});

	it('stores the preset URL for a preset, whatever the form sent', async () => {
		await setUp({ provider: 'voyage', endpoint: 'http://evil.example', model: 'voyage-3.5' });
		expect((await embeddingsView(db, userId)).endpoint).toBe('https://api.voyageai.com/v1');
	});
});

describe('testEmbeddings', () => {
	it('reports and stores the vector size, before embeddings are switched on', async () => {
		await setUp({ enabled: false });
		const result = await testEmbeddings(db, userId, { http });
		expect(result).toEqual({ ok: true, dimensions: 4 });
		expect((await embeddingsView(db, userId)).dimensions).toBe(4);
		// A test is not a billed run, so it leaves no usage row.
		expect(await db.select().from(assistantUsage)).toHaveLength(0);
		// A new model clears the size until it is tested again.
		await setUp({ model: 'mxbai-embed-large' });
		expect((await embeddingsView(db, userId)).dimensions).toBeUndefined();
	});

	it('says what is missing, and what the endpoint said', async () => {
		expect(await testEmbeddings(db, userId, { http })).toEqual({
			ok: false,
			reason: 'Enter a base URL first.'
		});
		await setUp();
		failNext = 1;
		const failed = await testEmbeddings(db, userId, { http });
		expect(failed.ok).toBe(false);
		expect(!failed.ok && failed.reason).toMatch(/Endpoint returned 500/);
	});

	it('is refused by the egress guard for a private address by default', async () => {
		await setUp();
		const result = await testEmbeddings(db, userId);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/Blocked egress/);
	});
});

describe('embed', () => {
	it('is refused while the Assistant kill switch is engaged, and while off', async () => {
		await setUp();
		await expect(embed(db, userId, ['a'], {}, { http })).rejects.toBeInstanceOf(
			EmbeddingsDisabledError
		);
		await assistantOn();
		await setUp({ enabled: false });
		await expect(embed(db, userId, ['a'], {}, { http })).rejects.toBeInstanceOf(
			EmbeddingsDisabledError
		);
		expect(requests).toHaveLength(0);
	});

	it('is refused for a story muted for the Assistant', async () => {
		await assistantOn();
		await setUp();
		const story = await pool.query<{ id: string }>(
			`with u as (
				insert into universes (owner_id, name, slug) values ($1, 'U', 'u') returning id
			)
			insert into stories (universe_id, owner_id, title, slug, llm_config)
			select u.id, $1, 'S', 's', '{"enabled": false}'::jsonb from u returning id`,
			[userId]
		);
		await expect(
			embed(db, userId, ['a'], { storyId: story.rows[0].id }, { http })
		).rejects.toBeInstanceOf(EmbeddingsDisabledError);
		expect(requests).toHaveLength(0);
	});

	it('returns one vector per text in order, in batches, with a priced usage row per request', async () => {
		await assistantOn();
		await setUp();
		const texts = Array.from({ length: EMBED_BATCH_SIZE + 2 }, (_, i) => `text ${i}`);
		const result = await embed(db, userId, texts, {}, { http });
		expect(result.model).toBe('nomic-embed-text');
		expect(result.dimensions).toBe(4);
		expect(result.vectors).toHaveLength(texts.length);
		expect(result.vectors[EMBED_BATCH_SIZE + 1]).toEqual([
			texts[EMBED_BATCH_SIZE + 1].length,
			1,
			0.5,
			1
		]);
		expect(requests.map((r) => r.input.length)).toEqual([EMBED_BATCH_SIZE, 2]);
		expect(requests[0].authorization).toBe('Bearer local-key');
		const rows = await db.select().from(assistantUsage);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.role === 'embeddings' && row.provider === 'custom')).toBe(true);
		expect(rows.map((row) => row.promptTokens).sort()).toEqual([20, EMBED_BATCH_SIZE * 10]);
		expect(rows[0].price).toEqual({ prompt: 0.0000001, completion: 0 });
	});

	it('retries a server that is busy for a moment', async () => {
		await assistantOn();
		await setUp();
		failNext = 1;
		const result = await embed(db, userId, ['a'], {}, { http, sleep: noSleep });
		expect(result.vectors).toHaveLength(1);
		expect(requests).toHaveLength(2);
	});

	it('counts against a spend meter, and holds back a request that could pass the cap', async () => {
		await assistantOn();
		await setUp({ pricePerToken: 0.001 });
		const meter = new SpendMeter({ capUsd: 0.05 });
		// Two texts: 20 tokens reported, at 0.001 a token.
		await embed(db, userId, ['first', 'second'], { meter }, { http });
		expect(meter.spentUsd).toBeCloseTo(0.02);
		// 120 characters count as 40 tokens at most: 0.04 more would pass 0.05.
		await expect(embed(db, userId, ['x'.repeat(120)], { meter }, { http })).rejects.toBeInstanceOf(
			SpendCapError
		);
		expect(meter.capReached).toBe(true);
		expect(requests).toHaveLength(1);
	});

	it('says the cap could not be applied when the model has no price', async () => {
		await assistantOn();
		await setUp({ pricePerToken: null });
		const meter = new SpendMeter({ capUsd: 1 });
		await embed(db, userId, ['a'], { meter }, { http });
		expect(meter.notApplied).toBe(true);
		const [row] = await db.select().from(assistantUsage);
		expect(row.price).toBeNull();
	});
});

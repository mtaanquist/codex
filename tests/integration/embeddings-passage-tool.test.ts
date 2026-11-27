import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { assistantUsage, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { EmbeddingsProvider } from '../../src/lib/server/llm/embeddings';
import type {
	HttpRequest,
	Provider,
	ProviderToolCall,
	ChatMessage
} from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase } from './test-db';

// The search_passages tool on both surfaces it is offered on: the Assistant's
// tool loop and the MCP endpoint. What must hold: only the caller's own live,
// unmuted stories come back, and with no index the tool is not offered and
// answers plainly when called anyway.

process.env.APP_SECRET = process.env.APP_SECRET || 'embeddings-passage-tool-test-secret';

vi.mock('#lib/server/db', async () => {
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { createPool } = await import('../../src/lib/server/db/pool');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = createPool(TEST_DATABASE_URL);
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { saveAccountLlmConfig, saveStoryLlmOverride } = await import('#lib/server/llm/config');
const { saveEmbeddingsConfig } = await import('#lib/server/llm/embeddings/config');
const { indexScenes, enableEmbeddingIndex, completeEmbeddingIndex } =
	await import('#lib/server/llm/embeddings/scene-index');
const { completeDetailed } = await import('#lib/server/llm/gateway');
const { dispatchToolCall } = await import('#lib/server/llm/tools/dispatch');
const { toolSpecs } = await import('#lib/server/llm/tools/registry');
const { MAX_PASSAGES, NO_PASSAGE_INDEX, PASSAGES_CAPPED } =
	await import('#lib/server/llm/tools/passages');
const { SpendCapError, SpendMeter } = await import('#lib/server/llm/spend');
const { createPersonalToken, resolveBearer } = await import('#lib/server/mcp/oauth');
const { callMcpTool, mcpTools } = await import('#lib/server/mcp/tools');
const { serveMcp } = await import('#lib/server/mcp/server');
const { resetRateLimits } = await import('#lib/server/rate-limit');

const ORIGIN = 'http://localhost';

// A passage's vector counts a few words, so a query for "sea" lands nearest
// the passages about the sea.
const WORDS = ['sea', 'fire', 'love'];
function vectorOf(text: string): number[] {
	const lower = text.toLowerCase();
	return [...WORDS.map((w) => lower.split(w).length - 1), 1];
}
let embedded: string[][] = [];
const embeddingsProvider: EmbeddingsProvider = {
	async embed(request) {
		embedded.push(request.input);
		return {
			vectors: request.input.map(vectorOf),
			usage: { promptTokens: request.input.length * 10, completionTokens: 0 }
		};
	}
};
const embedDeps = { provider: embeddingsProvider, sleep: async () => {} };

const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};

type Writer = {
	userId: string;
	universeId: string;
	storyId: string;
	sceneId: string;
	mutedStoryId: string;
	otherUniverseId: string;
};

let alice: Writer;
let bob: Writer;

async function makeWriter(name: string): Promise<Writer> {
	const [user] = await db
		.insert(users)
		.values({
			email: `${name.toLowerCase()}@example.com`,
			displayName: name,
			passwordHash: 'x',
			role: 'user',
			emailVerifiedAt: new Date(),
			approvedAt: new Date(),
			mcpEnabled: true
		})
		.returning({ id: users.id });
	const userId = user.id;
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model' },
		toolCallBudget: 8
	});
	await saveEmbeddingsConfig(db, userId, {
		enabled: true,
		provider: 'custom',
		endpoint: 'http://embeddings.test/v1',
		apiKey: '',
		model: 'fake-embed',
		pricePerToken: 0.000001
	});
	const universe = async (title: string) =>
		(
			await db
				.insert(universes)
				.values({ ownerId: userId, name: title })
				.returning({ id: universes.id })
		)[0].id;
	const universeId = await universe(`${name} Main`);
	const otherUniverseId = await universe(`${name} Other`);
	const story = async (title: string, inUniverse = universeId) =>
		(
			await db
				.insert(stories)
				.values({ universeId: inUniverse, ownerId: userId, title })
				.returning({ id: stories.id })
		)[0].id;
	const scene = async (ofStory: string, title: string, bodyMd: string) =>
		(
			await db
				.insert(scenes)
				.values({ storyId: ofStory, globalPosition: 1, title, bodyMd })
				.returning({ id: scenes.id })
		)[0].id;
	const storyId = await story(`${name} Open Book`);
	const sceneId = await scene(storyId, `${name} Quay`, `${name} walked by the sea, the sea.`);
	const mutedStoryId = await story(`${name} Muted Book`);
	await scene(mutedStoryId, `${name} Secret`, `${name} secret sea sea sea.`);
	const otherStoryId = await story(`${name} Far Book`, otherUniverseId);
	await scene(otherStoryId, `${name} Far`, `${name} far sea sea.`);
	return { userId, universeId, storyId, sceneId, mutedStoryId, otherUniverseId };
}

// Indexes the writer's main universe, the muted story too before muting it,
// so its rows exist and only the search can leave them out.
async function indexMain(writer: Writer) {
	await enableEmbeddingIndex(db, writer.userId, writer.universeId);
	await indexScenes(db, {
		userId: writer.userId,
		scope: { universeId: writer.universeId },
		deps: embedDeps
	});
	await completeEmbeddingIndex(db, writer.userId, writer.universeId, 'fake-embed');
	await saveStoryLlmOverride(db, writer.mutedStoryId, { enabled: false });
	embedded = [];
}

type Passages = { passages: { sceneId: string; text: string; storyTitle: string }[] };

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users, oauth_clients cascade');
	await pool.query(`delete from app_settings where key = 'mcp'`);
	resetRateLimits();
	embedded = [];
	alice = await makeWriter('Alice');
	bob = await makeWriter('Bob');
});

afterAll(async () => {
	await pool.end();
});

// ============ The Assistant ============

// Plays search_passages once, then answers; records what was offered and the
// tool's answer.
function scripted(call: Omit<ProviderToolCall, 'id'> | null) {
	const offered: string[][] = [];
	const seen: ChatMessage[][] = [];
	let i = 0;
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			offered.push((req.tools ?? []).map((tool) => tool.name));
			seen.push(req.messages);
			i += 1;
			if (i === 1 && call) {
				return { content: '', toolCalls: [{ id: 'call-1', ...call }] };
			}
			return { content: 'done', toolCalls: [] };
		},
		async listModels() {
			return [];
		}
	};
	const toolAnswer = () =>
		seen.at(-1)?.find((message) => message.role === 'tool')?.content ?? undefined;
	return { provider, offered, toolAnswer };
}

function askAssistant(
	writer: Writer,
	provider: Provider,
	extra: { meter?: InstanceType<typeof SpendMeter> } = {}
) {
	return completeDetailed(
		db,
		{
			userId: writer.userId,
			storyId: writer.storyId,
			role: 'chat',
			enableTools: true,
			messages: [{ role: 'user', content: 'Find the sea.' }],
			...extra
		},
		{ provider, http: noHttp, embeddings: embedDeps }
	);
}

const searchCall = { name: 'search_passages', arguments: JSON.stringify({ query: 'sea' }) };

describe('search_passages in the Assistant', () => {
	it('is not offered, and refuses, when the universe has no index', async () => {
		const run = scripted(searchCall);
		await askAssistant(alice, run.provider);
		expect(run.offered[0]).toContain('search_text');
		expect(run.offered[0]).not.toContain('search_passages');
		// Called anyway (a cached schema): refused before anything is sent.
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId, embedDeps },
			{ id: 'x', ...searchCall }
		);
		expect(outcome.result).toBe(NO_PASSAGE_INDEX);
		expect(embedded).toEqual([]);
	});

	it('is not offered once the index is on another model', async () => {
		await indexMain(alice);
		await saveEmbeddingsConfig(db, alice.userId, {
			enabled: true,
			provider: 'custom',
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'other-embed',
			pricePerToken: 0.000001
		});
		const run = scripted(null);
		await askAssistant(alice, run.provider);
		expect(run.offered[0]).not.toContain('search_passages');
	});

	it('is not offered while embeddings are off', async () => {
		await indexMain(alice);
		await saveEmbeddingsConfig(db, alice.userId, {
			enabled: false,
			provider: 'custom',
			endpoint: 'http://embeddings.test/v1',
			apiKey: '',
			model: 'fake-embed',
			pricePerToken: 0.000001
		});
		const run = scripted(null);
		await askAssistant(alice, run.provider);
		expect(run.offered[0]).not.toContain('search_passages');
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId, embedDeps },
			{ id: 'x', ...searchCall }
		);
		expect(outcome.result).toBe(NO_PASSAGE_INDEX);
	});

	it("returns the writer's own passages only, leaving out muted stories and other universes", async () => {
		await indexMain(alice);
		await indexMain(bob);
		const run = scripted(searchCall);
		const result = await askAssistant(alice, run.provider);
		expect(result.content).toBe('done');
		expect(run.offered[0]).toContain('search_passages');
		const answer = JSON.parse(run.toolAnswer()!) as Passages;
		expect(answer.passages.map((p) => p.sceneId)).toEqual([alice.sceneId]);
		const text = JSON.stringify(answer);
		expect(text).not.toContain('Bob');
		expect(text).not.toContain('secret');
		expect(text).not.toContain('far sea');
		// The query was embedded, once, and logged as usage.
		expect(embedded).toEqual([['sea']]);
		const usage = await db
			.select()
			.from(assistantUsage)
			.where(eq(assistantUsage.userId, alice.userId));
		expect(usage.filter((row) => row.role === 'embeddings').at(-1)?.storyId).toBeNull();
	});

	it("counts the query against a run's spend meter", async () => {
		await indexMain(alice);
		const meter = new SpendMeter({ capUsd: 100 });
		const run = scripted(searchCall);
		await askAssistant(alice, run.provider, { meter });
		expect(meter.spentUsd).toBeGreaterThan(0);
	});

	it('answers as the tool, not a crash, when the query could pass the cap', async () => {
		await indexMain(alice);
		const meter = new SpendMeter({ capUsd: 1e-9 });
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId, embedDeps, meter },
			{ id: 'x', ...searchCall }
		);
		expect(outcome).toEqual({ result: PASSAGES_CAPPED, staged: false });
		expect(embedded).toEqual([]);
		// Through the loop, the held query stops the run at its next request.
		const run = scripted(searchCall);
		await expect(
			askAssistant(alice, run.provider, { meter: new SpendMeter({ capUsd: 1e-9 }) })
		).rejects.toBeInstanceOf(SpendCapError);
		expect(embedded).toEqual([]);
	});

	it('reports a failing endpoint as a failed call, without its text', async () => {
		await indexMain(alice);
		const outcome = await dispatchToolCall(
			{
				db,
				userId: alice.userId,
				universeId: alice.universeId,
				embedDeps: {
					...embedDeps,
					provider: {
						async embed() {
							throw new Error('endpoint down');
						}
					}
				}
			},
			{ id: 'x', ...searchCall }
		);
		expect(outcome.failed).toBe(true);
		expect(outcome.staged).toBe(false);
	});

	it('keeps to the focus story where the reads are confined', async () => {
		await indexMain(alice);
		const otherStory = (
			await db
				.insert(stories)
				.values({ universeId: alice.universeId, ownerId: alice.userId, title: 'Second' })
				.returning({ id: stories.id })
		)[0].id;
		await db
			.insert(scenes)
			.values({ storyId: otherStory, globalPosition: 1, bodyMd: 'More sea sea sea sea.' });
		await indexScenes(db, {
			userId: alice.userId,
			scope: { universeId: alice.universeId },
			deps: embedDeps
		});
		const confined = await dispatchToolCall(
			{
				db,
				userId: alice.userId,
				universeId: alice.universeId,
				storyId: alice.storyId,
				scope: { storyOnly: true },
				embedDeps
			},
			{ id: 'x', ...searchCall }
		);
		expect((JSON.parse(confined.result) as Passages).passages.map((p) => p.sceneId)).toEqual([
			alice.sceneId
		]);
		const wide = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId, embedDeps },
			{ id: 'x', ...searchCall }
		);
		expect((JSON.parse(wide.result) as Passages).passages).toHaveLength(2);
	});

	it('bounds what it returns', async () => {
		await indexMain(alice);
		const outcome = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId, embedDeps },
			{ id: 'x', name: 'search_passages', arguments: JSON.stringify({ query: 'sea', limit: 500 }) }
		);
		expect((JSON.parse(outcome.result) as Passages).passages.length).toBeLessThanOrEqual(
			MAX_PASSAGES
		);
		const long = await dispatchToolCall(
			{ db, userId: alice.userId, universeId: alice.universeId, embedDeps },
			{ id: 'x', name: 'search_passages', arguments: JSON.stringify({ query: 'x'.repeat(5000) }) }
		);
		expect(long.result).toContain('too long');
	});

	it('is left out of a surface that names its own tools, and of the default set', () => {
		expect(toolSpecs().map((t) => t.name)).not.toContain('search_passages');
		expect(toolSpecs(['get_scene'], { passageSearch: true }).map((t) => t.name)).toEqual([
			'get_scene'
		]);
		expect(toolSpecs(undefined, { passageSearch: true }).map((t) => t.name)).toContain(
			'search_passages'
		);
	});
});

// ============ The MCP endpoint ============

let tokens = 0;
async function identityOf(writer: Writer) {
	tokens += 1;
	const made = await createPersonalToken(db, {
		userId: writer.userId,
		name: `Script ${tokens}`,
		permissions: ['read'],
		expiresInDays: 30
	});
	if (!made.ok) throw new Error(made.reason);
	return (await resolveBearer(db, made.token))!;
}

async function listedTools(writer: Writer): Promise<string[]> {
	const identity = await identityOf(writer);
	const request = new Request(`${ORIGIN}/api/mcp`, {
		method: 'POST',
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		}
	});
	const response = await serveMcp(request, { db, identity, origin: ORIGIN });
	const text = await response.text();
	const json = response.headers.get('content-type')?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5))
				.join('')
		: text;
	const tools = (JSON.parse(json) as { result: { tools: { name: string }[] } }).result.tools;
	return tools.map((tool) => tool.name);
}

describe('search_passages on the MCP endpoint', () => {
	it('is listed only when one of the writer universes has an index', async () => {
		expect(await listedTools(alice)).not.toContain('search_passages');
		expect(mcpTools(['read']).map((t) => t.name)).not.toContain('search_passages');
		await indexMain(alice);
		expect(await listedTools(alice)).toContain('search_passages');
		// Bob's index does not list it for Alice, nor Alice's for Bob.
		expect(await listedTools(bob)).not.toContain('search_passages');
		const tool = mcpTools(['read'], { passageSearch: true }).find(
			(t) => t.name === 'search_passages'
		)!;
		expect(tool.readOnly).toBe(true);
		expect((tool.inputSchema as { required: string[] }).required).toEqual(['universeId', 'query']);
	});

	it("returns the connected writer's own passages, and refuses where there is no index", async () => {
		await indexMain(alice);
		await indexMain(bob);
		const identity = await identityOf(alice);
		const search = (universeId: string) =>
			callMcpTool(db, identity, 'search_passages', { universeId, query: 'sea' }, ORIGIN, {
				embeddings: embedDeps
			});
		const own = await search(alice.universeId);
		expect(own.isError).toBe(false);
		const passages = (JSON.parse(own.text) as Passages).passages;
		expect(passages.map((p) => p.sceneId)).toEqual([alice.sceneId]);
		expect(own.text).not.toContain('secret');
		// Bob's universe is refused as if it did not exist.
		const theirs = await search(bob.universeId);
		expect(theirs).toEqual({ text: 'No universe with that id.', isError: true });
		expect(theirs.text).not.toContain('Bob');
		// Alice's other universe has no index.
		expect((await search(alice.otherUniverseId)).text).toBe(NO_PASSAGE_INDEX);
		// Only Alice's query was embedded: no call for the refused universe.
		expect(embedded).toEqual([['sea']]);
	});
});

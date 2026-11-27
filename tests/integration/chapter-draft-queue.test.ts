import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assistantDrafts,
	chapters,
	notifications,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { GatewayDeps } from '../../src/lib/server/llm/gateway';
import type { HttpRequest, Provider } from '../../src/lib/server/llm/providers/types';
import { saveAccountLlmConfig } from '../../src/lib/server/llm/config';
import { runChapterDraft } from '../../src/lib/server/llm/scene-draft';
import { discardSceneDraft, requestChapterDraft } from '../../src/lib/server/scene-drafts';
import {
	ASSISTANT_DRAFT_QUEUE,
	ASSISTANT_JOB_EXPIRY_SECONDS,
	ASSISTANT_QUEUE_OPTIONS,
	JOB_HEARTBEAT_SECONDS
} from '../../src/lib/server/queues';
import { createHandlers } from '../../src/worker/handlers';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// #1334: a chapter draft through a real pg-boss queue and the worker's own
// handler, from the request to the notice. Only the model is stubbed. The
// other chapter draft tests run the job by hand.

process.env.APP_SECRET = process.env.APP_SECRET || 'chapter-draft-queue-test-secret';

let pool: pg.Pool;
let db: Database;
let boss: PgBoss;
let ownerId: string;
let storyId: string;
let chapterId: string;
let sceneIds: string[];

// While request N is out, the hook runs with the request's signal.
let whileWriting: ((call: number, signal?: AbortSignal) => Promise<void>) | null = null;
let calls = 0;
const stubProvider: Provider = {
	async *chatStream() {
		yield { type: 'done' };
	},
	async respond(_req, _conn, _http, signal) {
		const call = ++calls;
		await whileWriting?.(call, signal);
		return {
			content: `Draft ${call}. The river ran on.`,
			toolCalls: [],
			usage: { promptTokens: 1000, completionTokens: 500 }
		};
	},
	async listModels() {
		return [];
	}
};
const noHttp: HttpRequest = async () => {
	throw new Error('the injected provider should not call the transport');
};
const deps: GatewayDeps = { provider: stubProvider, http: noHttp, sleep: async () => {} };

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	boss = new PgBoss({ connectionString: TEST_DATABASE_URL, supervise: false, schedule: false });
	boss.on('error', (error) => console.error(error));
	await boss.start();
	await boss.createQueue(ASSISTANT_DRAFT_QUEUE, ASSISTANT_QUEUE_OPTIONS);
	const handlers = createHandlers({
		db,
		boss,
		origin: 'https://codex.test',
		services: {
			runChapterDraft: (database, opts) => runChapterDraft(database, { ...opts, watchMs: 20 }, deps)
		}
	});
	await boss.work(
		ASSISTANT_DRAFT_QUEUE,
		{ includeMetadata: true, pollingIntervalSeconds: 0.5 },
		handlers.assistantDraft
	);
});

beforeEach(async () => {
	calls = 0;
	whileWriting = null;
	await boss.deleteAllJobs(ASSISTANT_DRAFT_QUEUE);
	await pool.query('truncate table notifications, users cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'q@example.com', displayName: 'Quinn', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	ownerId = owner.id;
	await saveAccountLlmConfig(db, ownerId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { chat: 'chat-model', coauthor: 'write-model' }
	});
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Aldermoor' })
		.returning({ id: universes.id });
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'The Tide Below' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [chapter] = await db
		.insert(chapters)
		.values({ storyId, position: 1, title: 'The River' })
		.returning({ id: chapters.id });
	chapterId = chapter.id;
	sceneIds = [];
	for (const [index, title] of ['The Quay', 'The Crossing', 'The Far Bank'].entries()) {
		const [scene] = await db
			.insert(scenes)
			.values({
				storyId,
				chapterId,
				positionInChapter: index + 1,
				globalPosition: index + 1,
				title,
				status: 'outline'
			})
			.returning({ id: scenes.id });
		sceneIds.push(scene.id);
	}
});

afterAll(async () => {
	await boss.stop({ graceful: false });
	await pool.end();
});

// Asks for the chapter draft as the endpoint does, queued the way
// queueAssistantChapterDraft queues it.
async function askForChapter() {
	const result = await requestChapterDraft(
		db,
		{
			userId: ownerId,
			storyId,
			chapterId,
			brief: 'Ilse flees across the river with the ledger.',
			targetWords: 800,
			scenes: sceneIds.map((sceneId) => ({ sceneId, brief: '' }))
		},
		{
			queue: async ({ jobId, ...data }) =>
				(await boss.send(ASSISTANT_DRAFT_QUEUE, data, {
					id: jobId,
					singletonKey: `draft-chapter:${data.chapterId}`,
					expireInSeconds: ASSISTANT_JOB_EXPIRY_SECONDS,
					heartbeatSeconds: JOB_HEARTBEAT_SECONDS,
					retryLimit: 2,
					group: { id: data.userId }
				})) ?? 'coalesced'
		}
	);
	if (!result.ok) throw new Error(result.reason);
	return result;
}

async function settled(jobId: string): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const job = await boss.getJobById(ASSISTANT_DRAFT_QUEUE, jobId);
		if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) return job.state;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('the job did not finish');
}

async function statuses(draftIds: string[]) {
	const rows = await db
		.select({ status: assistantDrafts.status })
		.from(assistantDrafts)
		.where(inArray(assistantDrafts.id, draftIds))
		.orderBy(asc(assistantDrafts.position));
	return rows.map((row) => row.status);
}

async function notices(): Promise<string[]> {
	const rows = await db.select().from(notifications).where(eq(notifications.userId, ownerId));
	return rows.map((row) => (row.payload as { title: string }).title);
}

describe('a chapter draft on the real queue', () => {
	it('is picked up by the worker, writes every scene, and tells the writer', async () => {
		const started = await askForChapter();
		expect(await settled(started.jobId)).toBe('completed');
		expect(await statuses(started.draftIds)).toEqual(['ready', 'ready', 'ready']);
		expect(calls).toBe(3);
		// The scenes themselves are untouched until the writer keeps a draft.
		const bodies = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(inArray(scenes.id, sceneIds));
		expect(bodies.every((row) => row.bodyMd === '')).toBe(true);
		expect(await notices()).toEqual([
			'The Assistant drafted 3 scenes in the chapter "The River". Open each scene to keep or discard its draft.'
		]);
	});

	it('names an untitled role chapter by its type', async () => {
		await db
			.update(chapters)
			.set({ title: null, role: 'prologue' })
			.where(eq(chapters.id, chapterId));
		const started = await askForChapter();
		expect(await settled(started.jobId)).toBe('completed');
		expect(await notices()).toEqual([
			'The Assistant drafted 3 scenes in the chapter "Prologue". Open each scene to keep or discard its draft.'
		]);
	});

	it('names an untitled regular chapter by its number', async () => {
		await db.insert(chapters).values({ storyId, position: 0, title: 'Before' });
		await db.update(chapters).set({ title: null }).where(eq(chapters.id, chapterId));
		const started = await askForChapter();
		expect(await settled(started.jobId)).toBe('completed');
		expect(await notices()).toEqual([
			'The Assistant drafted 3 scenes in Chapter 2. Open each scene to keep or discard its draft.'
		]);
	});

	it('calls off the scene the writer discards while it is written, and finishes the rest', async () => {
		const started = await askForChapter();
		whileWriting = async (call, signal) => {
			if (call !== 2) return;
			expect(await discardSceneDraft(db, ownerId, started.draftIds[1])).toMatchObject({
				ok: true,
				stopJobId: null
			});
			await new Promise<void>((_resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('the request ran on')), 5000);
				signal!.addEventListener('abort', () => {
					clearTimeout(timeout);
					reject(signal!.reason);
				});
			});
		};
		expect(await settled(started.jobId)).toBe('completed');
		expect(await statuses(started.draftIds)).toEqual(['ready', 'discarded', 'ready']);
		expect(await notices()).toEqual([
			'The Assistant drafted 2 of 3 scenes in the chapter "The River". Open each scene to keep or discard its draft.'
		]);
	});
});

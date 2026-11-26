import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import {
	reviewSuggestions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { McpPermission } from '../../src/lib/mcp-access';
import { ensureTestDatabase } from './test-db';

// The guided pass card an outside app shows (MCP Apps), through the route the
// app calls. The rules under test: only a connection the writer gave the apply
// permission is offered it; the pass reaches only the app's own notes in the
// writer's open stories; and an accept needs the card's key and the wording
// the writer was shown.

process.env.APP_SECRET = process.env.APP_SECRET || 'mcp-pass-card-test-secret';

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
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { saveStoryLlmOverride } = await import('#lib/server/llm/config');
const { TOOLS } = await import('#lib/server/llm/tools/registry');
const { registerClient } = await import('#lib/server/mcp/clients');
const { createAuthorizationCode, exchangeCode } = await import('#lib/server/mcp/oauth');
const { CARD_KEY_META, PASS_CARD_MIME, PASS_CARD_URI } = await import('#lib/server/mcp/pass-card');
const { addComment, ensureSuggestionThread } = await import('#lib/server/review');
const route = await import('../../src/routes/api/mcp/+server');

const ORIGIN = 'http://localhost';
const MISSING = '00000000-0000-4000-8000-000000000000';
const NO_NOTE = 'No pattern note of yours with that id.';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const PATTERN = 'Pattern note (lanterns): the word carries every sentence.';
const BODY = 'The open door creaked.\n\nA dark lantern swung in the open wind.';

type World = {
	userId: string;
	universeId: string;
	storyId: string;
	sceneId: string;
	mutedSceneId: string;
	// A connection that may suggest and apply, one that may only suggest, and
	// a second app with every permission.
	token: string;
	suggestOnly: string;
	otherApp: string;
};

let alice: World;
let bob: World;

async function connect(
	userId: string,
	name: string,
	permissions: McpPermission[],
	host = 'app.example'
): Promise<string> {
	const redirect = `https://${host}/callback`;
	const registered = await registerClient(db, { client_name: name, redirect_uris: [redirect] });
	if (!registered.ok) throw new Error(registered.description);
	const code = await createAuthorizationCode(db, {
		userId,
		client: registered.client,
		permissions,
		redirectUri: redirect,
		codeChallenge: CHALLENGE
	});
	if (!code) throw new Error('no code was issued');
	const result = await exchangeCode(db, {
		code,
		clientId: registered.client.clientId,
		redirectUri: redirect,
		codeVerifier: VERIFIER
	});
	if (!result.ok) throw new Error('the exchange was refused');
	return result.tokens.accessToken;
}

async function buildWorld(name: string): Promise<World> {
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
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: `${name} Main` })
		.returning({ id: universes.id });
	const story = async (title: string) =>
		(
			await db
				.insert(stories)
				.values({ universeId: universe.id, ownerId: user.id, title })
				.returning({ id: stories.id })
		)[0].id;
	const storyId = await story(`${name} Open Book`);
	const mutedStoryId = await story(`${name} Muted Book`);
	const scene = async (ofStory: string, title: string) =>
		(
			await db
				.insert(scenes)
				.values({ storyId: ofStory, globalPosition: 1, title, bodyMd: BODY })
				.returning({ id: scenes.id })
		)[0].id;
	const sceneId = await scene(storyId, `${name} Quay`);
	const mutedSceneId = await scene(mutedStoryId, `${name} Secret`);
	return {
		userId: user.id,
		universeId: universe.id,
		storyId,
		sceneId,
		mutedSceneId,
		token: await connect(user.id, 'Writing Desk', ['read', 'suggest', 'apply']),
		suggestOnly: await connect(user.id, 'Suggester', ['read', 'suggest'], 'suggest.example'),
		otherApp: await connect(user.id, 'Other Desk', ['read', 'suggest', 'apply'], 'other.example')
	};
}

async function rpc(token: string, method: string, params: unknown = {}) {
	const request = new Request(`${ORIGIN}/api/mcp`, {
		method: 'POST',
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${token}`
		}
	});
	const response = (await route.POST({
		request,
		url: new URL(request.url),
		getClientAddress: () => '203.0.113.1'
	} as never)) as Response;
	expect(response.status).toBe(200);
	const text = await response.text();
	const json = response.headers.get('content-type')?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5))
				.join('')
		: text;
	return JSON.parse(json) as {
		result?: Record<string, unknown>;
		error?: { code: number; message: string };
	};
}

type CardEdit = {
	id: string;
	status: string;
	before: string;
	text: string;
	replacement: string;
	after: string;
	stamp: string | null;
	placed: boolean;
};
type Pass = { noteId: string; universeId: string; name: string; link: string; edits: CardEdit[] };
type Answer = { text: string; isError: boolean; pass?: Pass; key?: string };

async function call(token: string, name: string, args: Record<string, unknown>): Promise<Answer> {
	const { result, error } = await rpc(token, 'tools/call', { name, arguments: args });
	if (!result) return { text: error?.message ?? '', isError: true };
	const content = result.content as { type: string; text: string }[];
	return {
		text: content.map((part) => part.text).join(''),
		isError: result.isError === true,
		pass: result.structuredContent as Pass | undefined,
		key: (result._meta as Record<string, string> | undefined)?.[CARD_KEY_META]
	};
}

const idIn = (text: string) => /id ([0-9a-f-]{36})/.exec(text)?.[1] ?? '';

const EDITS = [
	{ original: 'open door', replacement: 'shut door' },
	{ original: 'dark lantern', replacement: 'dim lantern' }
];

async function patternNote(
	token: string,
	who: World,
	comment = PATTERN,
	edits = EDITS
): Promise<string> {
	const result = await call(token, 'leave_pattern_note', {
		universeId: who.universeId,
		sceneId: who.sceneId,
		comment,
		edits
	});
	const id = idIn(result.text);
	expect(id).not.toBe('');
	return id;
}

const open = (token: string, who: World, noteId: string) =>
	call(token, 'open_guided_pass', { universeId: who.universeId, noteId });

async function sceneBody(sceneId: string): Promise<string> {
	const [row] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
	return row.bodyMd;
}

async function statuses(): Promise<string[]> {
	return (await db.select().from(reviewSuggestions)).map((row) => row.status).sort();
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users, oauth_clients cascade');
	await pool.query(`delete from app_settings where key = 'mcp'`);
	resetRateLimits();
	alice = await buildWorld('Alice');
	bob = await buildWorld('Bob');
	const [muted] = await db.select().from(scenes).where(eq(scenes.id, alice.mutedSceneId));
	await saveStoryLlmOverride(db, muted.storyId, { enabled: false });
});

afterAll(async () => {
	await pool.end();
});

describe('what a connection is offered', () => {
	type Listed = {
		name: string;
		_meta?: { ui?: { resourceUri: string; visibility: string[] }; 'ui/resourceUri'?: string };
	};
	const listed = async (token: string) =>
		((await rpc(token, 'tools/list')).result!.tools as Listed[]).filter((tool) =>
			['open_guided_pass', 'decide_suggestion'].includes(tool.name)
		);

	it('offers the card tools only with the apply permission, the accept to the card alone', async () => {
		expect(await listed(alice.suggestOnly)).toEqual([]);
		const tools = await listed(alice.token);
		expect(tools.map((tool) => [tool.name, tool._meta?.ui])).toEqual([
			['open_guided_pass', { resourceUri: PASS_CARD_URI, visibility: ['model', 'app'] }],
			['decide_suggestion', { resourceUri: PASS_CARD_URI, visibility: ['app'] }]
		]);
		expect(tools[0]._meta?.['ui/resourceUri']).toBe(PASS_CARD_URI);
	});

	it('serves the card page to a connection that may be shown it', async () => {
		const read = await rpc(alice.token, 'resources/read', { uri: PASS_CARD_URI });
		const [content] = read.result!.contents as { mimeType: string; text: string }[];
		expect(content.mimeType).toBe(PASS_CARD_MIME);
		expect(content.text).toContain('ui/initialize');
		expect(
			(await rpc(alice.suggestOnly, 'resources/read', { uri: PASS_CARD_URI })).error
		).toBeTruthy();
	});

	it('keeps the card tools out of the in-app toolbox', () => {
		const names = TOOLS.map((tool) => tool.name);
		expect(names).not.toContain('open_guided_pass');
		expect(names).not.toContain('decide_suggestion');
	});

	it('refuses the card tools to a connection without the apply permission', async () => {
		const noteId = await patternNote(alice.suggestOnly, alice);
		const opened = await open(alice.suggestOnly, alice, noteId);
		expect(opened.isError).toBe(true);
		expect(opened.pass).toBeUndefined();
	});
});

describe('open_guided_pass', () => {
	it("gives the pass over the app's own note, in scene order, with each change in its paragraph", async () => {
		const noteId = await patternNote(alice.token, alice);
		const opened = await open(alice.token, alice, noteId);
		expect(opened.isError).toBe(false);
		expect(opened.text).toContain('lanterns');
		expect(opened.text).toContain(
			`/stories/${alice.storyId}/review?scene=${alice.sceneId}&pass=${noteId}`
		);
		expect(opened.key).toEqual(expect.any(String));
		expect(opened.pass).toMatchObject({ noteId, universeId: alice.universeId, name: 'lanterns' });
		expect(
			opened.pass!.edits.map((edit) => [edit.before, edit.text, edit.replacement, edit.after])
		).toEqual([
			['The ', 'open door', 'shut door', ' creaked.'],
			['A ', 'dark lantern', 'dim lantern', ' swung in the open wind.']
		]);
		expect(opened.pass!.edits.every((edit) => edit.placed && edit.stamp)).toBe(true);
	});

	it('gives one not-found for a note that is not this apps own, in an open story', async () => {
		const own = await patternNote(alice.token, alice);
		const otherApps = await patternNote(alice.otherApp, alice);
		const bobs = await patternNote(bob.token, bob);
		const editId = (await open(alice.token, alice, own)).pass!.edits[0].id;
		for (const noteId of [otherApps, bobs, editId, MISSING, 'nope']) {
			expect(await open(alice.token, alice, noteId)).toMatchObject({
				text: NO_NOTE,
				isError: true
			});
		}
		// A note in a story the writer turned the Assistant off for afterwards.
		await saveStoryLlmOverride(db, alice.storyId, { enabled: false });
		expect(await open(alice.token, alice, own)).toMatchObject({ text: NO_NOTE, isError: true });
	});

	it('gives the not-found of any universe for one that is not the writers', async () => {
		const noteId = await patternNote(alice.token, alice);
		const opened = await call(alice.token, 'open_guided_pass', {
			universeId: bob.universeId,
			noteId
		});
		expect(opened).toMatchObject({ text: 'No universe with that id.', isError: true });
	});
});

describe('decide_suggestion', () => {
	async function opened() {
		const noteId = await patternNote(alice.token, alice);
		const pass = await open(alice.token, alice, noteId);
		return { noteId, pass: pass.pass!, key: pass.key! };
	}
	const decide = (token: string, args: Record<string, unknown>) =>
		call(token, 'decide_suggestion', { universeId: alice.universeId, ...args });

	it('accepts an edit the card shows, and gives the pass as it is now', async () => {
		const { noteId, pass, key } = await opened();
		const [first] = pass.edits;
		const result = await decide(alice.token, {
			noteId,
			suggestionId: first.id,
			seen: first.stamp,
			cardKey: key
		});
		expect(result.isError).toBe(false);
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('open door', 'shut door'));
		expect(result.pass!.edits.map((edit) => edit.status)).toEqual(['accepted', 'pending']);
		expect(result.key).toEqual(expect.any(String));
	});

	it("accepts the writer's own wording", async () => {
		const { noteId, pass, key } = await opened();
		const second = pass.edits[1];
		const result = await decide(alice.token, {
			noteId,
			suggestionId: second.id,
			seen: second.stamp,
			cardKey: key,
			replacement: 'faint lantern'
		});
		expect(result.isError).toBe(false);
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('dark lantern', 'faint lantern'));
	});

	it('changes nothing without the key of this pass on this connection', async () => {
		const { noteId, pass, key } = await opened();
		const otherNote = await patternNote(alice.token, alice, 'Pattern note (wind): another habit.', [
			{ original: 'swung', replacement: 'swayed' }
		]);
		const otherKey = (await open(alice.token, alice, otherNote)).key;
		const otherAppNote = await patternNote(alice.otherApp, alice);
		const otherAppKey = (await open(alice.otherApp, alice, otherAppNote)).key;
		expect(otherKey).toEqual(expect.any(String));
		expect(otherAppKey).toEqual(expect.any(String));
		const [first] = pass.edits;
		for (const cardKey of [undefined, '', 'forged', otherKey, otherAppKey, `${key}x`]) {
			const result = await decide(alice.token, {
				noteId,
				suggestionId: first.id,
				seen: first.stamp,
				...(cardKey === undefined ? {} : { cardKey })
			});
			expect(result.isError).toBe(true);
		}
		// Another app holding this pass's key cannot use it either.
		expect(
			(
				await call(alice.otherApp, 'decide_suggestion', {
					universeId: alice.universeId,
					noteId,
					suggestionId: first.id,
					seen: first.stamp,
					cardKey: key
				})
			).isError
		).toBe(true);
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
		expect(new Set(await statuses())).toEqual(new Set(['pending']));
	});

	it('refuses an edit of another note, and one revised since the writer saw it', async () => {
		const { noteId, pass, key } = await opened();
		const otherNote = await patternNote(alice.otherApp, alice);
		const foreign = (await open(alice.otherApp, alice, otherNote)).pass!.edits[0];
		expect(
			(
				await decide(alice.token, {
					noteId,
					suggestionId: foreign.id,
					seen: foreign.stamp,
					cardKey: key
				})
			).text
		).toBe('That edit is not part of this note.');

		// The app revises the first edit after the writer answered in its discussion.
		const [first] = pass.edits;
		const thread = await ensureSuggestionThread(db, {
			storyId: alice.storyId,
			suggestionId: first.id
		});
		if (!thread.ok) throw new Error(thread.reason);
		const said = await addComment(db, {
			storyId: alice.storyId,
			threadId: thread.threadId,
			author: { userId: alice.userId },
			body: 'Maybe another word?'
		});
		expect(said.ok).toBe(true);
		const revised = await call(alice.token, 'update_suggestion', {
			universeId: alice.universeId,
			suggestionId: first.id,
			replacement: 'closed door'
		});
		expect(revised.isError).toBe(false);
		const stale = await decide(alice.token, {
			noteId,
			suggestionId: first.id,
			seen: first.stamp,
			cardKey: key
		});
		expect(stale.isError).toBe(true);
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
	});
});

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
const { resetRateLimits, slidingRateLimit } = await import('#lib/server/rate-limit');
const { readGate, stagingGate, stagingKey } = await import('#lib/server/mcp/call-gate');
const { MAX_READ_CALLS_WAITING, STAGING_CALLS_PER_MINUTE } =
	await import('#lib/server/mcp/constants');
const { saveMcpInstanceEnabled } = await import('#lib/server/mcp/settings');
const { NO_UNIVERSE_RESULT } = await import('#lib/server/mcp/tools');
const { saveStoryLlmOverride } = await import('#lib/server/llm/config');
const { TOOLS } = await import('#lib/server/llm/tools/registry');
const { registerClient } = await import('#lib/server/mcp/clients');
const { createAuthorizationCode, exchangeCode, resolveBearer, revokeGrant } =
	await import('#lib/server/mcp/oauth');
const {
	CARD_KEY_META,
	MAX_CARD_CHARS,
	MAX_CARD_EDITS,
	PASS_CARD_MIME,
	PASS_CARD_URI,
	cardKeyValid
} = await import('#lib/server/mcp/pass-card');
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
type Pass = {
	noteId: string;
	universeId: string;
	name: string;
	link: string;
	edits: CardEdit[];
	more: number;
};
type Answer = {
	text: string;
	isError: boolean;
	pass?: Pass;
	keys?: Record<string, string>;
};

async function call(token: string, name: string, args: Record<string, unknown>): Promise<Answer> {
	const { result, error } = await rpc(token, 'tools/call', { name, arguments: args });
	if (!result) return { text: error?.message ?? '', isError: true };
	const content = result.content as { type: string; text: string }[];
	return {
		text: content.map((part) => part.text).join(''),
		isError: result.isError === true,
		pass: result.structuredContent as Pass | undefined,
		keys: (result._meta as Record<string, Record<string, string>> | undefined)?.[CARD_KEY_META]
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
		expect(Object.keys(opened.keys!).sort()).toEqual(opened.pass!.edits.map((e) => e.id).sort());
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

	it('sends at most MAX_CARD_EDITS edits and counts the rest as more', async () => {
		const words = Array.from({ length: MAX_CARD_EDITS + 5 }, (_, n) => `word${n}x`);
		await db
			.update(scenes)
			.set({ bodyMd: words.join(' ') })
			.where(eq(scenes.id, alice.sceneId));
		const edits = words.map((word) => ({ original: word, replacement: `${word}y` }));
		// One call carries at most 40 edits; a second with the same opening adds to the note.
		const noteId = await patternNote(alice.token, alice, PATTERN, edits.slice(0, 40));
		expect(await patternNote(alice.token, alice, PATTERN, edits.slice(40))).toBe(noteId);
		const opened = await open(alice.token, alice, noteId);
		expect(opened.pass!.edits).toHaveLength(MAX_CARD_EDITS);
		expect(opened.pass!.more).toBe(5);
		expect(Object.keys(opened.keys!)).toHaveLength(MAX_CARD_EDITS);
	});

	it('sends the edits past MAX_CARD_CHARS as more', async () => {
		const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
		await db
			.update(scenes)
			.set({ bodyMd: words.join(' ') })
			.where(eq(scenes.id, alice.sceneId));
		// Each wording is just under a fifth of the cap, so the sixth goes past it.
		const long = 'z'.repeat(Math.floor(MAX_CARD_CHARS / 5) - 100);
		const noteId = await patternNote(
			alice.token,
			alice,
			PATTERN,
			words.map((word) => ({ original: word, replacement: long }))
		);
		const opened = await open(alice.token, alice, noteId);
		expect(opened.pass!.edits).toHaveLength(5);
		expect(opened.pass!.more).toBe(1);
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
	async function opened(token = alice.token) {
		const noteId = await patternNote(token, alice);
		const pass = await open(token, alice, noteId);
		return { noteId, pass: pass.pass!, keys: pass.keys! };
	}
	const decide = (token: string, args: Record<string, unknown>) =>
		call(token, 'decide_suggestion', { universeId: alice.universeId, ...args });
	const accepting = (noteId: string, edit: CardEdit, keys: Record<string, string>) => ({
		noteId,
		suggestionId: edit.id,
		seen: edit.stamp,
		cardKey: keys[edit.id]
	});

	it('accepts an edit the card shows, and gives the pass as it is now', async () => {
		const { noteId, pass, keys } = await opened();
		const [first] = pass.edits;
		const result = await decide(alice.token, accepting(noteId, first, keys));
		expect(result.isError).toBe(false);
		expect(result.text).toBe('Accepted.');
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('open door', 'shut door'));
		expect(result.pass!.edits.map((edit) => edit.status)).toEqual(['accepted', 'pending']);
		// Keys for what is still waiting only.
		expect(Object.keys(result.keys!)).toEqual([pass.edits[1].id]);
	});

	it("accepts the writer's own wording, and not an empty one or one that cannot be saved", async () => {
		const { noteId, pass, keys } = await opened();
		const second = pass.edits[1];
		for (const replacement of ['  ', 'faint\u0000lantern']) {
			const refused = await decide(alice.token, {
				...accepting(noteId, second, keys),
				replacement
			});
			expect(refused.isError).toBe(true);
		}
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
		const result = await decide(alice.token, {
			...accepting(noteId, second, keys),
			replacement: 'faint lantern'
		});
		expect(result.isError).toBe(false);
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('dark lantern', 'faint lantern'));
	});

	it('changes nothing without the key of this edit on this connection', async () => {
		const { noteId, pass, keys } = await opened();
		const [first, second] = pass.edits;
		const otherAppNote = await patternNote(alice.otherApp, alice);
		const otherAppKeys = (await open(alice.otherApp, alice, otherAppNote)).keys!;
		for (const cardKey of [
			undefined,
			'',
			'forged',
			keys[second.id],
			Object.values(otherAppKeys)[0],
			`${keys[first.id]}x`
		]) {
			const result = await decide(alice.token, {
				noteId,
				suggestionId: first.id,
				seen: first.stamp,
				...(cardKey === undefined ? {} : { cardKey })
			});
			expect(result.isError).toBe(true);
		}
		// Another app holding this edit's key cannot use it either.
		expect((await decide(alice.otherApp, accepting(noteId, first, keys))).isError).toBe(true);
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
		expect(new Set(await statuses())).toEqual(new Set(['pending']));
	});

	it('refuses a key past its time', async () => {
		const { noteId, pass, keys } = await opened();
		const grantId = (await resolveBearer(db, alice.token))!.grantId;
		const [first] = pass.edits;
		const target = { grantId, noteId, suggestionId: first.id, stamp: first.stamp! };
		expect(cardKeyValid(keys[first.id], target)).toBe(true);
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
			expect(cardKeyValid(keys[first.id], target)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('takes one of two accepts of the same edit sent at once', async () => {
		const { noteId, pass, keys } = await opened();
		const results = await Promise.all([
			decide(alice.token, accepting(noteId, pass.edits[0], keys)),
			decide(alice.token, accepting(noteId, pass.edits[0], keys))
		]);
		expect(results.filter((result) => !result.isError)).toHaveLength(1);
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('open door', 'shut door'));
	});

	it('changes nothing in a scene in the trash, or after the story is muted', async () => {
		const { noteId, pass, keys } = await opened();
		await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, alice.sceneId));
		expect((await decide(alice.token, accepting(noteId, pass.edits[0], keys))).isError).toBe(true);
		await db.update(scenes).set({ deletedAt: null }).where(eq(scenes.id, alice.sceneId));
		await saveStoryLlmOverride(db, alice.storyId, { enabled: false });
		expect(await decide(alice.token, accepting(noteId, pass.edits[0], keys))).toMatchObject({
			text: NO_NOTE,
			isError: true
		});
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
	});

	it('refuses an edit whose passage the writer changed since, and places one they did not', async () => {
		const { noteId, pass, keys } = await opened();
		const changed = 'Rain fell.\n\nThe red door creaked.\n\nA dark lantern swung in the open wind.';
		await db.update(scenes).set({ bodyMd: changed }).where(eq(scenes.id, alice.sceneId));
		expect((await decide(alice.token, accepting(noteId, pass.edits[0], keys))).isError).toBe(true);
		expect(await sceneBody(alice.sceneId)).toBe(changed);
		const result = await decide(alice.token, accepting(noteId, pass.edits[1], keys));
		expect(result.isError).toBe(false);
		expect(await sceneBody(alice.sceneId)).toBe(changed.replace('dark lantern', 'dim lantern'));
	});

	it('refuses an edit revised since the writer saw it', async () => {
		const { noteId, pass, keys } = await opened();
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
		expect((await decide(alice.token, accepting(noteId, first, keys))).isError).toBe(true);
		// The revised wording needs a key of its own, from the pass opened again.
		const again = await open(alice.token, alice, noteId);
		const now = again.pass!.edits.find((edit) => edit.id === first.id)!;
		expect(
			(await decide(alice.token, { ...accepting(noteId, first, keys), seen: now.stamp })).isError
		).toBe(true);
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
		expect((await decide(alice.token, accepting(noteId, now, again.keys!))).isError).toBe(false);
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('open door', 'closed door'));
	});

	it('answers busy, changes nothing and gives the call back while the lock is held', async () => {
		const { noteId, pass, keys } = await opened();
		const grantId = (await resolveBearer(db, alice.token))!.grantId;
		// Spend all but one of the connection's accepts for this minute.
		for (let i = 0; i < STAGING_CALLS_PER_MINUTE - 1; i++) {
			slidingRateLimit(`mcp:card:grant:${grantId}`, STAGING_CALLS_PER_MINUTE, 60_000);
		}
		const holder = await pool.connect();
		try {
			await holder.query('begin');
			await holder.query('select pg_advisory_xact_lock(hashtext($1))', [stagingKey(alice.userId)]);
			expect(await decide(alice.token, accepting(noteId, pass.edits[0], keys))).toMatchObject({
				text: 'Another call is still running. Try again.',
				isError: true
			});
		} finally {
			await holder.query('rollback');
			holder.release();
		}
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
		// The busy call was given back, so the last accept of the minute still goes.
		expect((await decide(alice.token, accepting(noteId, pass.edits[0], keys))).isError).toBe(false);
		expect((await decide(alice.token, accepting(noteId, pass.edits[1], keys))).text).toMatch(
			/^Too many calls/
		);
	});

	it('changes nothing when the connection is revoked while the accept waits its turn', async () => {
		const { noteId, pass, keys } = await opened();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const ahead = stagingGate.run(alice.userId, () => gate);
		const waiting = decide(alice.token, accepting(noteId, pass.edits[0], keys));
		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			const grantId = (await resolveBearer(db, alice.token))!.grantId;
			expect(await revokeGrant(db, alice.userId, grantId)).toBe(true);
		} finally {
			release();
			await ahead;
		}
		expect(await waiting).toMatchObject({ text: NO_UNIVERSE_RESULT, isError: true });
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
		expect(new Set(await statuses())).toEqual(new Set(['pending']));
	});

	it('changes nothing when access for apps is turned off while the accept waits its turn', async () => {
		const { noteId, pass, keys } = await opened();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const ahead = stagingGate.run(alice.userId, () => gate);
		const waiting = decide(alice.token, accepting(noteId, pass.edits[0], keys));
		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			await saveMcpInstanceEnabled(db, false);
		} finally {
			release();
			await ahead;
		}
		expect(await waiting).toMatchObject({ text: NO_UNIVERSE_RESULT, isError: true });
		expect(await sceneBody(alice.sceneId)).toBe(BODY);
	});

	it('reports the accept even when the pass cannot be built again afterwards', async () => {
		const { noteId, pass, keys } = await opened();
		// Fill the writer's reading line, so building the pass again is turned away.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const held = Array.from({ length: 2 + MAX_READ_CALLS_WAITING }, () =>
			readGate.run(alice.userId, () => gate)
		);
		try {
			const result = await decide(alice.token, accepting(noteId, pass.edits[0], keys));
			expect(result).toMatchObject({ text: 'Accepted.', isError: false });
			expect(result.pass).toBeUndefined();
		} finally {
			release();
			await Promise.all(held);
		}
		expect(await sceneBody(alice.sceneId)).toBe(BODY.replace('open door', 'shut door'));
	});
});

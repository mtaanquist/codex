import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	revisions,
	sceneMarkers,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	createMarker,
	deleteMarker,
	listSceneMarkers,
	listStoryTodos,
	setMarkerResolved,
	updateMarkerAnchors
} from '../../src/lib/server/markers';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { recordRevision, restoreRevision } from '../../src/lib/server/revisions';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import {
	join,
	paragraph,
	paragraphStarts,
	phraseIn,
	replaceShe,
	sceneParagraphs,
	seeded,
	shortParagraphs
} from '../prose';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let strangerId: string;
let storyId: string;
let sceneId: string;

const BODY = 'Alice pays the toll.\nTODO: sharpen this exchange\nShe rides on.';

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table scene_markers, revisions, scenes, stories, universes, users cascade'
	);

	const [owner] = await db
		.insert(users)
		.values({ email: 'mark@example.com', displayName: 'Mark', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [stranger] = await db
		.insert(users)
		.values({ email: 'mark2@example.com', displayName: 'Mark2', passwordHash: 'x', role: 'user' })
		.returning();
	strangerId = stranger.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId, title: 'S' })
		.returning();
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'Toll', bodyMd: BODY })
		.returning();
	sceneId = scene.id;
});

afterAll(async () => {
	await pool.end();
});

describe('createMarker', () => {
	it('creates from a selection, clamping anchors to the body', async () => {
		const result = await createMarker(db, ownerId, sceneId, 0, 5);
		expect(result).toMatchObject({ ok: true });
		const clamped = await createMarker(db, ownerId, sceneId, 6, 9999, 'check this');
		expect(clamped).toMatchObject({ ok: true });
		const markers = await listSceneMarkers(db, sceneId);
		expect(markers).toHaveLength(2);
		expect(markers[1].anchorEnd).toBe(BODY.length);
	});

	it('rejects an empty selection and a foreign scene', async () => {
		expect(await createMarker(db, ownerId, sceneId, 3, 3)).toMatchObject({ ok: false });
		expect(await createMarker(db, strangerId, sceneId, 0, 5)).toMatchObject({
			ok: false,
			code: 'not_found'
		});
	});
});

describe('listStoryTodos', () => {
	it('lists markers and TODO: lines in scene order', async () => {
		await createMarker(db, ownerId, sceneId, 0, 5);
		await createMarker(db, ownerId, sceneId, 6, 9999, 'check this');
		const todos = await listStoryTodos(db, storyId);
		// Two markers plus one text TODO.
		expect(todos).toHaveLength(3);
		const textTodo = todos.find((todo) => todo.markerId === null);
		expect(textTodo).toMatchObject({ sceneTitle: 'Toll', text: 'sharpen this exchange' });
		const noted = todos.find((todo) => todo.text === 'check this');
		expect(noted?.markerId).not.toBeNull();
		// A marker without a note falls back to the selected text.
		expect(todos.some((todo) => todo.text === 'Alice')).toBe(true);
	});

	it('slices un-noted snippets and skips scenes with nothing to do', async () => {
		// No "TODO:" in this body, so only the un-noted marker can make it
		// come back. Astral characters ahead of the anchor: UTF-16 offsets
		// must still land.
		const body = 'A \u{1F409} dragon wakes.';
		const [quiet] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 10, title: 'Quiet', bodyMd: 'Nothing left here.' })
			.returning();
		const [marked] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 11, title: 'Dragon', bodyMd: body })
			.returning();
		const [midLine] = await db
			.insert(scenes)
			.values({
				storyId,
				globalPosition: 12,
				title: 'Aside',
				bodyMd: 'She said TODO: not a marker'
			})
			.returning();
		const start = body.indexOf('dragon');
		const plain = await createMarker(db, ownerId, marked.id, start, start + 6);
		const noted = await createMarker(db, ownerId, quiet.id, 0, 7, 'tighten');
		if (!plain.ok || !noted.ok) throw new Error('setup failed');

		const todos = await listStoryTodos(db, storyId);
		expect(todos.filter((todo) => todo.sceneId === marked.id)).toEqual([
			{ sceneId: marked.id, sceneTitle: 'Dragon', markerId: plain.id, text: 'dragon' }
		]);
		expect(todos.filter((todo) => todo.sceneId === quiet.id)).toEqual([
			{ sceneId: quiet.id, sceneTitle: 'Quiet', markerId: noted.id, text: 'tighten' }
		]);
		expect(todos.filter((todo) => todo.sceneId === midLine.id)).toEqual([]);
	});
	it('quotes the marked words in a body stored with Windows line endings', async () => {
		// Anchors count each \r\n as one character, as the editor does.
		const stored = 'One line.\r\nTwo lines.\r\nThree lines.';
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 10, title: 'Lines', bodyMd: stored })
			.returning();
		const shown = stored.replace(/\r\n/g, '\n');
		const start = shown.indexOf('Three');
		await db
			.insert(sceneMarkers)
			.values({ sceneId: scene.id, ownerId, anchorStart: start, anchorEnd: start + 5 });
		const todos = await listStoryTodos(db, storyId);
		expect(todos.find((todo) => todo.sceneId === scene.id)?.text).toBe('Three');
	});
});

describe('resolve and anchors', () => {
	it('checking off hides a marker from the lists; unchecking brings it back', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 5);
		if (!created.ok) throw new Error('setup failed');
		const marker = { id: created.id };
		expect(await setMarkerResolved(db, strangerId, marker.id, true)).toBe(false);
		expect(await setMarkerResolved(db, ownerId, marker.id, true)).toBe(true);
		expect((await listSceneMarkers(db, sceneId)).map((m) => m.id)).not.toContain(marker.id);
		expect(await setMarkerResolved(db, ownerId, marker.id, false)).toBe(true);
		expect((await listSceneMarkers(db, sceneId)).map((m) => m.id)).toContain(marker.id);
	});

	it('moves anchors and ignores ids from other scenes', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 5);
		if (!created.ok) throw new Error('setup failed');
		const marker = { id: created.id };
		const [otherScene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 2, bodyMd: 'Elsewhere.' })
			.returning();
		const foreign = await createMarker(db, ownerId, otherScene.id, 0, 4);
		if (!foreign.ok) throw new Error('setup failed');

		await updateMarkerAnchors(
			db,
			sceneId,
			[
				{ id: marker.id, anchorStart: 10, anchorEnd: 15 },
				{ id: foreign.id, anchorStart: 0, anchorEnd: 1 }
			],
			BODY.length
		);
		const [moved] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
		expect([moved.anchorStart, moved.anchorEnd]).toEqual([10, 15]);
		const [untouched] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, foreign.id));
		expect([untouched.anchorStart, untouched.anchorEnd]).toEqual([0, 4]);
	});

	it('clamps out-of-range anchors to the body on save', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 5);
		if (!created.ok) throw new Error('setup failed');
		await updateMarkerAnchors(
			db,
			sceneId,
			[{ id: created.id, anchorStart: -5, anchorEnd: 9999 }],
			BODY.length
		);
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, created.id));
		expect(row.anchorStart).toBe(0);
		expect(row.anchorEnd).toBe(BODY.length);
	});

	it('deletes own markers only', async () => {
		const created = await createMarker(db, ownerId, sceneId, 0, 3);
		if (!created.ok) throw new Error('setup failed');
		expect(await deleteMarker(db, strangerId, created.id)).toBe(false);
		expect(await deleteMarker(db, ownerId, created.id)).toBe(true);
	});
});

// Body rewrites that do not come from the Write editor carry no anchors;
// the stored ones must follow the text rather than keep their old offsets.
describe('anchors follow body rewrites outside the Write editor', () => {
	const TEXT = 'The bridge creaks. Alice pays the toll. She rides on.';

	async function markedScene(phrase: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 10, bodyMd: TEXT })
			.returning();
		const start = TEXT.indexOf(phrase);
		const marker = await createMarker(db, ownerId, scene.id, start, start + phrase.length);
		if (!marker.ok) throw new Error('setup failed');
		return { sceneId: scene.id, markerId: marker.id };
	}

	async function anchors(markerId: string) {
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, markerId));
		return [row.anchorStart, row.anchorEnd];
	}

	function quote(body: string, range: (number | null)[]) {
		return body.slice(range[0]!, range[1]!);
	}

	it('a save without markers maps them through the edit', async () => {
		const { sceneId: id, markerId } = await markedScene('pays the toll');
		const edited = 'A new opening line.\n\n' + TEXT;
		const result = await saveSceneBody(db, id, {
			title: null,
			bodyMd: edited,
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(result.ok).toBe(true);
		expect(quote(edited, await anchors(markerId))).toBe('pays the toll');
	});

	it('a save without markers drops the anchor when its text is gone', async () => {
		const { sceneId: id, markerId } = await markedScene('pays the toll');
		await saveSceneBody(db, id, {
			title: null,
			bodyMd: 'The bridge creaks. She rides on.',
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(await anchors(markerId)).toEqual([null, null]);
	});

	it('restoring a revision maps anchors onto the restored text', async () => {
		const { sceneId: id, markerId } = await markedScene('She rides on');
		const older = 'Long before: ' + TEXT;
		await recordRevision(db, 'scene', id, older, 'checkpoint');
		const [revision] = await db
			.select({ id: revisions.id })
			.from(revisions)
			.where(and(eq(revisions.entityType, 'scene'), eq(revisions.entityId, id)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		expect(await restoreRevision(db, ownerId, revision.id, 'scene', id)).toMatchObject({
			ok: true
		});
		expect(quote(older, await anchors(markerId))).toBe('She rides on');
	});

	// Bodies imported before line endings were normalised keep their \r\n,
	// while anchors count each one as a single character, as the editor does.
	const CRLF = 'The bridge creaks.\r\nAlice pays the toll.\r\nShe rides on.';
	const SHOWN = CRLF.replace(/\r\n/g, '\n');

	async function crlfScene(phrase: string) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 10, bodyMd: CRLF })
			.returning();
		const start = SHOWN.indexOf(phrase);
		const [marker] = await db
			.insert(sceneMarkers)
			.values({ sceneId: scene.id, ownerId, anchorStart: start, anchorEnd: start + phrase.length })
			.returning();
		return { sceneId: scene.id, markerId: marker.id };
	}

	it('a save without markers maps them through the edit on a Windows line-ending body', async () => {
		const { sceneId: id, markerId } = await crlfScene('She rides on');
		const edited = 'A new opening line.\n' + SHOWN;
		const result = await saveSceneBody(db, id, {
			title: null,
			bodyMd: edited,
			anchors: null,
			baseHashes: null,
			overwrite: false
		});
		expect(result.ok).toBe(true);
		expect(quote(edited, await anchors(markerId))).toBe('She rides on');
	});

	it('restoring onto a Windows line-ending body maps anchors onto the restored text', async () => {
		const { sceneId: id, markerId } = await crlfScene('She rides on');
		const older = 'Long before: ' + SHOWN;
		await recordRevision(db, 'scene', id, older, 'checkpoint');
		const [revision] = await db
			.select({ id: revisions.id })
			.from(revisions)
			.where(and(eq(revisions.entityType, 'scene'), eq(revisions.entityId, id)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		expect(await restoreRevision(db, ownerId, revision.id, 'scene', id)).toMatchObject({
			ok: true
		});
		expect(quote(older, await anchors(markerId))).toBe('She rides on');
	});
});

// A long scene with ten to-do markers spread over it, rewritten in ways a
// writer does in one go. A marker whose words are still there must keep
// pointing at them, however much changed elsewhere.
describe('markers on a long scene survive large rewrites outside the Write editor', () => {
	async function markedLongScene(before: string[]) {
		const body = join(before);
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 20, bodyMd: body })
			.returning();
		const starts = paragraphStarts(before);
		const marked: { id: string; index: number; phrase: string }[] = [];
		for (let n = 0; n < 10; n++) {
			let index = Math.floor(((n + 0.5) * before.length) / 10);
			while (!phraseIn(before[index])) index++;
			const [from, to] = phraseIn(before[index])!;
			const [marker] = await db
				.insert(sceneMarkers)
				.values({
					sceneId: scene.id,
					ownerId,
					anchorStart: starts[index] + from,
					anchorEnd: starts[index] + to
				})
				.returning();
			marked.push({ id: marker.id, index, phrase: before[index].slice(from, to) });
		}
		return { sceneId: scene.id, marked };
	}

	// The markers that still quote their own words in `body`, and those left
	// without an anchor.
	async function kept(body: string, marked: { id: string; phrase: string }[]) {
		let quoted = 0;
		let detached = 0;
		for (const marker of marked) {
			const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marker.id));
			if (row.anchorStart === null) detached++;
			else if (body.slice(row.anchorStart, row.anchorEnd!) === marker.phrase) quoted++;
		}
		return { quoted, detached };
	}

	const save = (id: string, bodyMd: string) =>
		saveSceneBody(db, id, {
			title: null,
			bodyMd,
			anchors: null,
			baseHashes: null,
			overwrite: false
		});

	// Rewrites `count` paragraphs spread from the first to the last, none of
	// them holding a marker, each as `size` paragraphs' worth of new text.
	function rewrite(before: string[], count: number, keep: Set<number>, seed: number, size = 1) {
		const next = seeded(seed);
		const after = [...before];
		for (let n = 0; n < count; n++) {
			let index = Math.round((n * (before.length - 1)) / (count - 1));
			while (keep.has(index)) index++;
			after[index] = Array.from({ length: size }, () => paragraph(next)).join(' ');
		}
		return after;
	}

	it('keeps all ten after "she" becomes "Mara" everywhere in a 120,000 character scene', async () => {
		const before = sceneParagraphs(11, 120_000);
		const { sceneId: id, marked } = await markedLongScene(before);
		const after = join(before.map(replaceShe));
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await kept(after, marked)).toEqual({ quoted: 10, detached: 0 });
	});

	it('keeps all ten after three paragraphs of a 120,000 character scene are rewritten', async () => {
		const before = sceneParagraphs(12, 120_000);
		const { sceneId: id, marked } = await markedLongScene(before);
		const keep = new Set(marked.map((marker) => marker.index));
		const after = join(rewrite(before, 3, keep, 13, 4));
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await kept(after, marked)).toEqual({ quoted: 10, detached: 0 });
	});

	it('keeps all ten after a tenth of the paragraphs of a 60,000 character scene are rewritten', async () => {
		const before = sceneParagraphs(14, 60_000);
		const { sceneId: id, marked } = await markedLongScene(before);
		const keep = new Set(marked.map((marker) => marker.index));
		const after = join(rewrite(before, Math.floor(before.length / 10), keep, 15));
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await kept(after, marked)).toEqual({ quoted: 10, detached: 0 });
	});

	it('keeps all ten after a tenth of the paragraphs of a 120,000 character scene are rewritten', async () => {
		const before = sceneParagraphs(16, 120_000);
		const { sceneId: id, marked } = await markedLongScene(before);
		const keep = new Set(marked.map((marker) => marker.index));
		const after = join(rewrite(before, Math.floor(before.length / 10), keep, 17));
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await kept(after, marked)).toEqual({ quoted: 10, detached: 0 });
	});

	it('keeps all ten when History restores a version with "she" replaced everywhere', async () => {
		const before = sceneParagraphs(18, 120_000);
		const { sceneId: id, marked } = await markedLongScene(before);
		const older = join(before.map(replaceShe));
		await recordRevision(db, 'scene', id, older, 'checkpoint');
		const [revision] = await db
			.select({ id: revisions.id })
			.from(revisions)
			.where(and(eq(revisions.entityType, 'scene'), eq(revisions.entityId, id)))
			.orderBy(desc(revisions.createdAt))
			.limit(1);
		expect(await restoreRevision(db, ownerId, revision.id, 'scene', id)).toMatchObject({
			ok: true
		});
		expect(await kept(older, marked)).toEqual({ quoted: 10, detached: 0 });
	});

	it('still detaches a marker whose own paragraph was deleted', async () => {
		const before = sceneParagraphs(19, 120_000);
		const { sceneId: id, marked } = await markedLongScene(before);
		const keep = new Set(marked.map((marker) => marker.index));
		const rewritten = rewrite(before, Math.floor(before.length / 10), keep, 20);
		const after = join(rewritten.filter((_, index) => index !== marked[4].index));
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await kept(after, marked)).toEqual({ quoted: 9, detached: 1 });
		const [gone] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, marked[4].id));
		expect(gone.anchorStart).toBeNull();
	});
});

// Regressions from the review of the levelled comparison, through a save
// from outside the Write editor (anchors null), as the review centre saves.
describe('markers through a save, review findings', () => {
	const save = (id: string, bodyMd: string) =>
		saveSceneBody(db, id, {
			title: null,
			bodyMd,
			anchors: null,
			baseHashes: null,
			overwrite: false
		});

	async function sceneWith(body: string, phrases: string[]) {
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 30, bodyMd: body })
			.returning();
		const ids: string[] = [];
		for (const phrase of phrases) {
			const start = body.indexOf(phrase);
			const [marker] = await db
				.insert(sceneMarkers)
				.values({
					sceneId: scene.id,
					ownerId,
					anchorStart: start,
					anchorEnd: start + phrase.length
				})
				.returning();
			ids.push(marker.id);
		}
		return { sceneId: scene.id, ids };
	}
	async function anchorOf(id: string) {
		const [row] = await db.select().from(sceneMarkers).where(eq(sceneMarkers.id, id));
		return row.anchorStart === null ? null : { start: row.anchorStart, end: row.anchorEnd! };
	}

	const A = 'The kettle was cold when she came down to the kitchen.';
	const P1 = 'Snow had come in the night and the yard held the light.';
	const P2 = 'Tobin was already at the door with the cart and the mule.';
	const C = 'They set out before the bell rang for the morning office.';
	const cases: [string, string, string][] = [
		['split', `${A}\n\n${P1} ${P2}\n\n${C}`, `${A}\n\n${P1}\n\n${P2}\n\n${C}`],
		['join', `${A}\n\n${P1}\n\n${P2}\n\n${C}`, `${A}\n\n${P1} ${P2}\n\n${C}`],
		[
			'split inside a sentence',
			`${A}\n\n${P1} ${P2}\n\n${C}`,
			`${A}\n\n${P1} ${P2.replace(' with', '\n\nwith')}\n\n${C}`
		],
		[
			'CRLF and a split',
			`${A}\n\n${P1} ${P2}\n\n${C}`,
			`${A}\r\n\r\n${P1}\r\n\r\n${P2}\r\n\r\n${C}`
		]
	];
	for (const [name, before, after] of cases) {
		it(`H1: keeps a marker in the half that moved (${name})`, async () => {
			const phrases = ['the cart', 'yard held'];
			const { sceneId: id, ids } = await sceneWith(before, phrases);
			expect(await save(id, after)).toMatchObject({ ok: true });
			const shown = after.replace(/\r\n/g, '\n');
			for (const [n, markerId] of ids.entries()) {
				const at = await anchorOf(markerId);
				expect(at && shown.slice(at.start, at.end)).toBe(phrases[n]);
			}
		});
	}

	it('H2: a marker whose words were rewritten is not stored on the same words elsewhere', async () => {
		const before = shortParagraphs(41, 1400);
		before[10] = 'She lit the candle and waited by the door for the cart.';
		before[900] = 'Tobin walked out to the shed, lit the lamp and sat down.';
		const next = seeded(42);
		const after = before.map((text) => {
			const words = text.split(' ');
			const at = next(words.length);
			words[at] = words[at].replace(/^[a-z]+/i, 'Mara');
			return words.join(' ');
		});
		after[10] = 'Night came on and nobody came up the road to the house.';
		after[900] = 'Tobin walked out to the shed, lit the candle and sat down.';
		const { sceneId: id, ids } = await sceneWith(join(before), ['lit the candle']);
		expect(await save(id, join(after))).toMatchObject({ ok: true });
		const at = await anchorOf(ids[0]);
		// Detached, or (as main would) somewhere in what paragraph 10 became.
		const p10 = paragraphStarts(after)[10];
		if (at) {
			expect(at.start).toBeGreaterThanOrEqual(p10);
			expect(at.end).toBeLessThanOrEqual(p10 + after[10].length);
		}
	});

	// Round 8, 1a: B moved down past He and C, C respaced, D rewritten.
	// Round 8, 2: C moved up past B and respaced.
	const B8 =
		'Tobin had gone out before dawn to see to the mule. The yard was white and the ' +
		'gate stood open where he had left it. He came back with his hands raw and said ' +
		'nothing about the road. She set bread on the table and waited for him to eat ' +
		'before she asked.';
	const He8 = 'He did not look up from the fire.';
	const C8 =
		'She asked about the letter twice that morning. Neither of them spoke of the ' +
		'debt that lay on the table between them.';
	const C8b = C8.replace('the letter', 'the  letter');
	const moves: [string, string, string][] = [
		[
			'1a',
			[A, P1, B8, He8, C8, C].join('\n\n'),
			[A, P1, He8, C8b, B8, 'Rain fell all the way down the valley road to the mill.'].join('\n\n')
		],
		['2', [A, B8, C8, C].join('\n'), [A, C8b, B8, C].join('\n')]
	];
	for (const [name, before, after] of moves) {
		it(`round 8, ${name}: a marker in a paragraph that moved is kept on its words or detached`, async () => {
			const phrases = ['debt that lay', 'asked about the', 'twice that morning'];
			const { sceneId: id, ids } = await sceneWith(before, phrases);
			expect(await save(id, after)).toMatchObject({ ok: true });
			const into = after.indexOf(C8b);
			for (const [n, markerId] of ids.entries()) {
				const at = await anchorOf(markerId);
				// The untouched sentence is placed; the respaced one is placed in
				// it or detached, never stored anywhere else.
				if (n === 0) expect(at && after.slice(at.start, at.end)).toBe(phrases[0]);
				if (at) {
					expect(at.start).toBeGreaterThanOrEqual(into);
					expect(at.end).toBeLessThanOrEqual(into + C8b.length);
				}
			}
		});
	}

	// Round 8, 1b: a marker inside a rewritten sentence is detached, not
	// stored on what chance letters the new sentence shares.
	it('round 8, 1b: detaches a marker whose sentence was rewritten', async () => {
		const before = [A, 'She walked to the harbour at dawn and waited.', C].join('\n\n');
		const after = [A, 'He ran home through the rain, then slept.', C].join('\n\n');
		const { sceneId: id, ids } = await sceneWith(before, ['walked to the harbour']);
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await anchorOf(ids[0])).toBeNull();
	});

	// Round 9, H1: a version with one word in fifteen changed, as History
	// restores, keeps every marker, whatever edits fall inside or beside it.
	// Two have a first word that became one sharing a letter ("of" -> "long",
	// "only" -> "slowly"); they take the new word, as main's marker rule does.
	it('round 9, H1: keeps 40 markers when one word in fifteen of a 30,000 character scene changes', async () => {
		const before = sceneParagraphs(71, 30_000);
		const body = join(before);
		const [scene] = await db
			.insert(scenes)
			.values({ storyId, globalPosition: 32, bodyMd: body })
			.returning();
		const starts = paragraphStarts(before);
		const rows = Array.from({ length: 40 }, (_, n) => {
			let index = Math.floor(((n + 0.5) * before.length) / 40);
			while (!phraseIn(before[index], 4)) index++;
			const [from, to] = phraseIn(before[index], 4)!;
			return {
				sceneId: scene.id,
				ownerId,
				anchorStart: starts[index] + from,
				anchorEnd: starts[index] + to
			};
		});
		const markers = await db.insert(sceneMarkers).values(rows).returning();
		const next = seeded(72);
		const others = ['grey', 'cold', 'still', 'long', 'Mara', 'slowly'];
		let count = 0;
		const after = before.map((text) =>
			text
				.split(' ')
				.map((word) => (++count % 15 === 0 ? word.replace(/[a-z]+/i, others[next(6)]) : word))
				.join(' ')
		);
		expect(await save(scene.id, join(after))).toMatchObject({ ok: true });
		let detached = 0;
		for (const marker of markers) if ((await anchorOf(marker.id)) === null) detached++;
		expect(detached).toBe(0);
	});

	// Round 9, M1: a marker reaching into a sentence that moved is detached,
	// not stretched over what the sentence was carried past.
	it('round 9, M1: detaches a marker reaching into a sentence that moved', async () => {
		const before =
			'The kettle sang on the stove all morning. Mara watched the rain against the window. ' +
			'Then she left.\n\nTobin came home late that evening with the letter. He did not speak at all.';
		const after =
			'The kettle sang on the stove all morning. Then she left.\n\nTobin came home late that ' +
			'evening with the letter. He did not speak at all. Mara watched the rain against the window.';
		const { sceneId: id, ids } = await sceneWith(before, ['all morning. Mara watched']);
		expect(await save(id, after)).toMatchObject({ ok: true });
		expect(await anchorOf(ids[0])).toBeNull();
	});

	// Round 10, M3: one rewritten paragraph of about 2,100 characters before a
	// marked sentence with a typo in it is compared in one go on save, so the
	// marker is kept and the save does not wait.
	it('round 10, M3: keeps a marker beside a rewritten paragraph of 2,100 characters, quickly', async () => {
		const old = sceneParagraphs(81, 2100).join(' ').slice(0, 2100);
		const now = sceneParagraphs(82, 2100).join(' ').slice(0, 2100);
		const marked = 'She lit the candle and waited by the door for the cart to come.';
		const before = [A, old, marked, C].join('\n\n');
		const after = [A, now, marked.replace('waited', 'wiated'), C].join('\n\n');
		const { sceneId: id, ids } = await sceneWith(before, ['lit the candle']);
		const started = performance.now();
		expect(await save(id, after)).toMatchObject({ ok: true });
		const took = performance.now() - started;
		const at = await anchorOf(ids[0]);
		expect(at && after.slice(at.start, at.end)).toBe('lit the candle');
		expect(took).toBeLessThan(1000);
	});

	// Round 10, M3: a whole scene replaced with unrelated text detaches its
	// markers without the save waiting on a comparison that cannot finish.
	it('round 10, M3: detaches the markers of a 120,000 character scene replaced outright, quickly', async () => {
		const before = join(sceneParagraphs(83, 120_000));
		const phrases = ['the', 'and', 'of'].map((word) => ` ${word} `);
		const { sceneId: id, ids } = await sceneWith(before, phrases);
		const after = join(sceneParagraphs(84, 120_000));
		const started = performance.now();
		expect(await save(id, after)).toMatchObject({ ok: true });
		const took = performance.now() - started;
		for (const markerId of ids) expect(await anchorOf(markerId)).toBeNull();
		expect(took).toBeLessThan(1000);
	});

	for (const changed of [450, 520, 1400]) {
		it(`H3: keeps 300 markers with one word put into ${changed} of 1400 paragraphs`, async () => {
			const before = shortParagraphs(43, 1400);
			const after = before.map((text, index) =>
				changed === 1400 || index % Math.ceil(1400 / changed) === 0 ? `Then ${text}` : text
			);
			const body = join(before);
			const [scene] = await db
				.insert(scenes)
				.values({ storyId, globalPosition: 31, bodyMd: body })
				.returning();
			const starts = paragraphStarts(before);
			const rows = Array.from({ length: 300 }, (_, n) => {
				const index = Math.floor((n * 1400) / 300);
				const length = Math.min(12, before[index].length);
				const start = starts[index] + before[index].length - length;
				return { sceneId: scene.id, ownerId, anchorStart: start, anchorEnd: start + length };
			});
			const markers = await db.insert(sceneMarkers).values(rows).returning();
			const now = join(after);
			expect(await save(scene.id, now)).toMatchObject({ ok: true });
			let kept = 0;
			for (const [n, marker] of markers.entries()) {
				const at = await anchorOf(marker.id);
				const was = body.slice(rows[n].anchorStart, rows[n].anchorEnd);
				if (at && now.slice(at.start, at.end) === was) kept++;
			}
			expect(kept).toBe(300);
		});
	}
});

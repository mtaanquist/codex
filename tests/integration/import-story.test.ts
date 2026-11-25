import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	characterStoryMemberships,
	characterStoryNotes,
	entityCategories,
	loreEntries,
	notes,
	places,
	scenes,
	stories,
	tags,
	universes,
	users
} from '../../src/lib/server/db/schema';
import { buildStoryZip, gatherStory } from '../../src/lib/server/export';
import { parseStoryZip } from '../../src/lib/import-markdown';
import { previewImport, runImport } from '../../src/lib/server/import-story';
import { checkTagNames, setStoryList, setStoryTags, storyTagView } from '../../src/lib/server/tags';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { zipBytes } from '../../src/lib/server/zip-stream';
import { isCoverColor } from '../../src/lib/entity-color';
import { MAX_ASSISTANT_NOTES } from '../../src/lib/assistant-preferences';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universe: { id: string; ownerId: string };

const noAssets = async () => [];

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table scenes, chapters, stories, universes, users, tags cascade');
	const [owner] = await db
		.insert(users)
		.values({ email: 'imp@example.com', displayName: 'I', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [row] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
	universe = { id: row.id, ownerId };
	await db
		.insert(entityCategories)
		.values({ universeId: row.id, ownerId, name: 'Lore', sortOrder: 1 });
});

afterAll(async () => {
	await pool.end();
});

// A story with chapters, an unfiled scene, and story notes, built through
// the real tables so the round trip exercises the real exporter.
async function seedStory() {
	const [story] = await db
		.insert(stories)
		.values({
			universeId: universe.id,
			ownerId,
			title: 'Halden',
			author: 'A. Vane',
			brief: 'A toll-road story.',
			descriptionMd: 'The long road.'
		})
		.returning();
	const [one] = await db
		.insert(chapters)
		.values({ storyId: story.id, title: 'The Caravan', position: 1 })
		.returning();
	const [two] = await db
		.insert(chapters)
		.values({ storyId: story.id, title: 'The Toll', position: 2 })
		.returning();
	const sceneRows = await db
		.insert(scenes)
		.values([
			{
				storyId: story.id,
				chapterId: one.id,
				positionInChapter: 1,
				globalPosition: 1,
				title: 'Departure',
				status: 'final',
				bodyMd: 'The gate opened.'
			},
			{
				storyId: story.id,
				chapterId: one.id,
				positionInChapter: 2,
				globalPosition: 2,
				title: 'Night',
				status: 'draft',
				bodyMd: 'Stars over the road.'
			},
			{
				storyId: story.id,
				chapterId: two.id,
				positionInChapter: 1,
				globalPosition: 3,
				title: 'Tollgate',
				status: 'revised',
				bodyMd: 'They paid in silver.'
			},
			{
				storyId: story.id,
				globalPosition: 4,
				title: 'Loose end',
				bodyMd: 'A stray thought.'
			}
		])
		.returning();
	const [alice] = await db
		.insert(characters)
		.values({ universeId: universe.id, ownerId, name: 'Alice Vane' })
		.returning();
	await db
		.insert(characterStoryNotes)
		.values({ characterId: alice.id, storyId: story.id, notesMd: 'Limps in this book.' });
	await db.insert(notes).values([
		{
			ownerId,
			universeId: universe.id,
			storyId: story.id,
			sceneId: sceneRows.find((scene) => scene.title === 'Night')!.id,
			title: 'Threads',
			bodyMd: 'Who paid the toll?',
			pinned: true,
			createdAt: new Date('2026-01-01T10:00:00Z')
		},
		{
			ownerId,
			universeId: universe.id,
			storyId: story.id,
			bodyMd: 'An untitled idea.',
			createdAt: new Date('2026-01-02T10:00:00Z')
		}
	]);
	return story;
}

async function exportPlan(story: Awaited<ReturnType<typeof seedStory>>) {
	const bytes = await zipBytes(
		(await buildStoryZip(story, await gatherStory(db, story), noAssets)).entries
	);
	return parseStoryZip(bytes);
}

describe('previewImport', () => {
	it('counts the work and resolves every note before anything is written', async () => {
		const plan = await exportPlan(await seedStory());
		// A second character named Alice makes the note ambiguous; Bram is new.
		await db.insert(characters).values({ universeId: universe.id, ownerId, name: 'alice vane' });
		plan.notes.push({ kind: 'character', name: 'Bram', notesMd: 'New here.' });

		const preview = await previewImport(db, universe, plan);
		expect(preview.storyTitle).toBe('Halden');
		expect(preview.titleTaken).toBe(true);
		expect(preview.chapterCount).toBe(2);
		expect(preview.sceneCount).toBe(4);
		expect(preview.words).toBeGreaterThan(0);
		expect(preview.freeformNoteCount).toBe(2);
		expect(preview.notes).toEqual([
			{ kind: 'character', name: 'Alice Vane', outcome: 'ambiguous' },
			{ kind: 'character', name: 'Bram', outcome: 'create' }
		]);

		// Nothing was written.
		const storyRows = await db.select().from(stories);
		expect(storyRows).toHaveLength(1);
	});
});

describe('runImport', () => {
	it('round-trips a story export: chapters, scenes, statuses, and notes', async () => {
		const original = await seedStory();
		const plan = await exportPlan(original);
		const result = await runImport(db, universe, plan);

		expect(result.sceneCount).toBe(4);
		expect(result.notesAttached).toBe(1);
		expect(result.entitiesCreated).toBe(0);
		expect(result.notesSkipped).toBe(0);
		expect(result.freeformNotesCreated).toBe(2);

		const [imported] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(imported.title).toBe('Halden');
		expect(imported.author).toBe('A. Vane');
		expect(imported.brief).toBe('A toll-road story.');
		expect(imported.descriptionMd).toBe('The long road.');
		expect(imported.slug).not.toBe(original.slug);

		const chapterRows = await db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, result.storyId))
			.orderBy(asc(chapters.position));
		expect(chapterRows.map((c) => c.title)).toEqual(['The Caravan', 'The Toll']);

		const sceneRows = await db
			.select()
			.from(scenes)
			.where(eq(scenes.storyId, result.storyId))
			.orderBy(asc(scenes.globalPosition));
		expect(sceneRows.map((s) => [s.title, s.status, s.bodyMd])).toEqual([
			['Departure', 'final', 'The gate opened.'],
			['Night', 'draft', 'Stars over the road.'],
			['Tollgate', 'revised', 'They paid in silver.'],
			['Loose end', 'draft', 'A stray thought.']
		]);
		expect(sceneRows[0].chapterId).toBe(chapterRows[0].id);
		expect(sceneRows[2].chapterId).toBe(chapterRows[1].id);
		expect(sceneRows[3].chapterId).toBeNull();
		expect(sceneRows[0].wordCount).toBeGreaterThan(0);

		// The note attached to the existing Alice, who joined the new story.
		const [alice] = await db.select().from(characters).where(eq(characters.name, 'Alice Vane'));
		const noteRows = await db
			.select()
			.from(characterStoryNotes)
			.where(eq(characterStoryNotes.storyId, result.storyId));
		expect(noteRows).toEqual([
			expect.objectContaining({ characterId: alice.id, notesMd: 'Limps in this book.' })
		]);
		const memberships = await db
			.select()
			.from(characterStoryMemberships)
			.where(eq(characterStoryMemberships.storyId, result.storyId));
		expect(memberships).toEqual([expect.objectContaining({ characterId: alice.id })]);

		const freeform = await db
			.select()
			.from(notes)
			.where(eq(notes.storyId, result.storyId))
			.orderBy(asc(notes.createdAt));
		// Freeform notes keep their title, body, pin, scene, and created time.
		expect(
			freeform.map((n) => [
				n.title,
				n.bodyMd,
				n.pinned,
				n.sceneId,
				n.createdAt.toISOString(),
				n.universeId,
				n.ownerId
			])
		).toEqual([
			[
				'Threads',
				'Who paid the toll?',
				true,
				sceneRows[1].id,
				'2026-01-01T10:00:00.000Z',
				universe.id,
				ownerId
			],
			[null, 'An untitled idea.', false, null, '2026-01-02T10:00:00.000Z', universe.id, ownerId]
		]);
	});

	it('combines two notes that match the same entity instead of failing', async () => {
		const plan = await exportPlan(await seedStory());
		plan.notes.push({ kind: 'character', name: 'alice vane', notesMd: 'Hates the rain.' });

		const preview = await previewImport(db, universe, plan);
		expect(preview.notes).toEqual([{ kind: 'character', name: 'Alice Vane', outcome: 'match' }]);
		expect(preview.problems).toEqual([
			'The notes for "Alice Vane" and "alice vane" both belong to the character "Alice Vane", so they were combined into one note.'
		]);

		const result = await runImport(db, universe, plan);
		expect(result.notesAttached).toBe(1);
		expect(result.problems).toEqual(preview.problems);
		const noteRows = await db
			.select()
			.from(characterStoryNotes)
			.where(eq(characterStoryNotes.storyId, result.storyId));
		expect(noteRows.map((row) => row.notesMd)).toEqual(['Limps in this book.\n\nHates the rain.']);
	});

	it('creates missing entities, skips ambiguous ones, and reports both', async () => {
		const plan = await exportPlan(await seedStory());
		await db.insert(places).values([
			{ universeId: universe.id, ownerId, name: 'The Toll Road' },
			{ universeId: universe.id, ownerId, name: 'The toll road' }
		]);
		plan.notes.push(
			{ kind: 'place', name: 'The Toll Road', notesMd: 'Crowded.' },
			{ kind: 'lore', name: 'The Silver Tax', notesMd: 'Steep this year.' }
		);

		const result = await runImport(db, universe, plan);
		expect(result.notesAttached).toBe(2);
		expect(result.entitiesCreated).toBe(1);
		expect(result.notesSkipped).toBe(1);
		expect(result.problems).toEqual([expect.stringContaining('The Toll Road')]);

		const [created] = await db
			.select()
			.from(loreEntries)
			.where(eq(loreEntries.title, 'The Silver Tax'));
		expect(created).toBeTruthy();
	});

	it('round-trips the reader labels: adult, genres, warnings, tags and fandoms', async () => {
		const original = await seedStory();
		await db.update(stories).set({ isAdult: true }).where(eq(stories.id, original.id));
		const listed = await db
			.insert(tags)
			.values([
				{ kind: 'fandom', name: 'Forgotten Realms', slug: 'forgotten-realms' },
				{ kind: 'genre', name: 'Fantasy', slug: 'fantasy' },
				{ kind: 'warning', name: 'Death', slug: 'death' }
			])
			.returning();
		for (const tag of listed) {
			await setStoryList(db, original.id, tag.kind as 'fandom' | 'genre' | 'warning', [tag.id]);
		}
		const checked = await checkTagNames(db, ['Found Family']);
		if (!checked.ok) throw new Error(checked.message);
		await setStoryTags(db, original.id, checked.tags);

		const [labelled] = await db.select().from(stories).where(eq(stories.id, original.id));
		const plan = await exportPlan(labelled);
		// A fandom this site does not list is left off and reported.
		plan.story.fandoms = [...(plan.story.fandoms ?? []), 'Elsewhere'];
		const result = await runImport(db, universe, plan);

		const [imported] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(imported.isAdult).toBe(true);
		const view = await storyTagView(db, result.storyId);
		expect(view.genres.map((tag) => tag.name)).toEqual(['Fantasy']);
		expect(view.warnings.map((tag) => tag.name)).toEqual(['Death']);
		expect(view.tags.map((tag) => tag.name)).toEqual(['Found Family']);
		expect(view.fandoms.map((tag) => tag.name)).toEqual(['Forgotten Realms']);
		expect(result.problems.some((problem) => problem.includes('Elsewhere'))).toBe(true);
	});

	it('round-trips the style notes, language and Assistant preferences', async () => {
		const original = await seedStory();
		const settings = {
			styleNotes: 'Epic fantasy serial,\nomniscient narrator.',
			language: 'en-GB',
			assistantPreferences: { quoteMarks: 'single', tense: 'past', epithets: 'leave' },
			assistantNotes: 'Keep "ye" and "thee".\n\nLeave the dialect alone.'
		};
		await db.update(stories).set(settings).where(eq(stories.id, original.id));
		const [configured] = await db.select().from(stories).where(eq(stories.id, original.id));
		const plan = await exportPlan(configured);
		expect(plan.problems).toEqual([]);

		const result = await runImport(db, universe, plan);
		const [imported] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(imported).toMatchObject(settings);
	});

	it('round-trips text with line and paragraph separators, emoji, quotes and blank lines', async () => {
		const original = await seedStory();
		// U+2028 and U+2029 come in with text pasted from Word or a PDF, and
		// JSON.stringify leaves them raw in the front matter.
		const odd = 'One\u2028two\u2029three "quoted" \'single\' \u{1F409}';
		const fields = {
			title: `Halden ${odd}`,
			author: `A. Vane ${odd}`,
			brief: `A toll road.\u2028${odd}`,
			descriptionMd: `The long road.\n\n\n${odd}`,
			styleNotes: `Omniscient.\n\n${odd}\n\nNo slang.`,
			// Notes up to the limit, emoji counting as two characters.
			assistantNotes: `${odd}\n\n`.padEnd(MAX_ASSISTANT_NOTES - 2, 'x') + '\u{1F409}'
		};
		expect(fields.assistantNotes).toHaveLength(MAX_ASSISTANT_NOTES);
		await db.update(stories).set(fields).where(eq(stories.id, original.id));
		await db
			.update(chapters)
			.set({ title: `The Caravan ${odd}` })
			.where(eq(chapters.storyId, original.id));
		await db
			.update(scenes)
			.set({ title: `Departure ${odd}`, bodyMd: `The gate opened.\n\n\n${odd}` })
			.where(eq(scenes.title, 'Departure'));
		await db
			.update(notes)
			.set({ title: `Threads ${odd}`, bodyMd: `Who paid?\u2029${odd}` })
			.where(eq(notes.title, 'Threads'));
		await db
			.update(characterStoryNotes)
			.set({ notesMd: `Limps.\n\n${odd}` })
			.where(eq(characterStoryNotes.storyId, original.id));
		await db
			.update(characters)
			.set({ name: `Alice ${odd}` })
			.where(eq(characters.name, 'Alice Vane'));

		const [configured] = await db.select().from(stories).where(eq(stories.id, original.id));
		const plan = await exportPlan(configured);
		expect(plan.problems).toEqual([]);
		const result = await runImport(db, universe, plan);
		expect(result.problems).toEqual([]);

		const [imported] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(imported).toMatchObject(fields);
		const [chapter] = await db
			.select()
			.from(chapters)
			.where(eq(chapters.storyId, result.storyId))
			.orderBy(asc(chapters.position));
		expect(chapter.title).toBe(`The Caravan ${odd}`);
		const [scene] = await db
			.select()
			.from(scenes)
			.where(eq(scenes.storyId, result.storyId))
			.orderBy(asc(scenes.globalPosition));
		expect([scene.title, scene.bodyMd]).toEqual([
			`Departure ${odd}`,
			`The gate opened.\n\n\n${odd}`
		]);
		const [note] = await db
			.select()
			.from(notes)
			.where(eq(notes.storyId, result.storyId))
			.orderBy(asc(notes.createdAt));
		expect([note.title, note.bodyMd]).toEqual([`Threads ${odd}`, `Who paid?\u2029${odd}`]);
		const [entityNote] = await db
			.select()
			.from(characterStoryNotes)
			.where(eq(characterStoryNotes.storyId, result.storyId));
		expect(entityNote.notesMd).toBe(`Limps.\n\n${odd}`);
		expect(result.notesAttached).toBe(1);
		expect(result.entitiesCreated).toBe(0);
	});

	it('leaves unset settings out of story.md and imports them as unset', async () => {
		const original = await seedStory();
		const files = unzipSync(
			await zipBytes(
				(await buildStoryZip(original, await gatherStory(db, original), noAssets)).entries
			)
		);
		const front = strFromU8(files['halden/story.md']);
		for (const key of ['style-notes', 'language', 'assistant-preferences', 'assistant-notes']) {
			expect(front).not.toContain(`${key}:`);
		}
		const result = await runImport(db, universe, parseStoryZip(zipSync(files)));
		const [imported] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(imported).toMatchObject({
			styleNotes: null,
			language: null,
			assistantPreferences: {},
			assistantNotes: null
		});
	});

	it('resolves merged label names and keeps the first ones in file order', async () => {
		const original = await seedStory();
		const listed = await db
			.insert(tags)
			.values(
				['Fantasy', 'Horror', 'Romance', 'Mystery', 'Grimdark'].map((name) => ({
					kind: 'genre' as const,
					name,
					slug: name.toLowerCase()
				}))
			)
			.returning();
		const id = (name: string) => listed.find((tag) => tag.name === name)!.id;
		await db
			.update(tags)
			.set({ mergedIntoId: id('Fantasy') })
			.where(eq(tags.id, id('Grimdark')));
		const plan = await exportPlan(original);
		// A merged alias and its survivor are one genre; an unknown name takes no slot.
		plan.story.genres = ['Mystery', 'Grimdark', 'Nope', 'Fantasy', 'Romance'];
		plan.story.tags = ['A', 'a', 'B'];
		const result = await runImport(db, universe, plan);
		const view = await storyTagView(db, result.storyId);
		expect(view.genres.map((tag) => tag.name)).toEqual(['Fantasy', 'Mystery', 'Romance']);
		expect(result.problems.some((problem) => problem.startsWith('Only the first'))).toBe(false);

		plan.story.genres = ['Romance', 'Horror', 'Grimdark', 'Mystery'];
		const over = await runImport(db, universe, plan);
		expect((await storyTagView(db, over.storyId)).genres.map((tag) => tag.name)).toEqual([
			'Fantasy',
			'Horror',
			'Romance'
		]);
		expect(over.problems).toContain('Only the first 3 genres were kept.');
	});

	it('counts a merged tag name and its survivor once toward the 20 tags', async () => {
		const original = await seedStory();
		await db.insert(tags).values([
			{ kind: 'tag', name: 'Target', slug: 'target' },
			{ kind: 'tag', name: 'M', slug: 'm' }
		]);
		await pool.query(
			`update tags set merged_into_id = (select id from tags where slug = 'target') where slug = 'm'`
		);
		const plan = await exportPlan(original);
		const nineteen = Array.from({ length: 19 }, (_, i) => `t${i}`);
		plan.story.tags = ['Target', ...nineteen, 'M'];
		const result = await runImport(db, universe, plan);
		expect((await storyTagView(db, result.storyId)).tags).toHaveLength(20);
		expect(result.problems.some((problem) => problem.startsWith('Only the first'))).toBe(false);

		plan.story.tags = ['Target', ...nineteen, 'M', 'Extra'];
		const over = await runImport(db, universe, plan);
		const shown = (await storyTagView(db, over.storyId)).tags.map((tag) => tag.name);
		expect(shown).toHaveLength(20);
		expect(shown).not.toContain('Extra');
		expect(over.problems).toContain('Only the first 20 tags were kept.');
	});

	it('keeps a fandom from the universe on export, and does not store it twice on import', async () => {
		const original = await seedStory();
		const [discworld] = await db
			.insert(tags)
			.values({ kind: 'fandom', name: 'Discworld', slug: 'discworld' })
			.returning();
		await db.update(universes).set({ fandomId: discworld.id }).where(eq(universes.id, universe.id));
		const plan = await exportPlan(original);
		expect(plan.story.fandoms).toEqual(['Discworld']);

		const result = await runImport(db, universe, plan);
		const stored = await pool.query('select tag_id from story_tags where story_id = $1', [
			result.storyId
		]);
		expect(stored.rows).toEqual([]);
		const view = await storyTagView(db, result.storyId);
		expect(view.fandoms).toMatchObject([{ name: 'Discworld', inherited: true }]);
	});

	it('imports the same zip twice as two independent stories', async () => {
		const plan = await exportPlan(await seedStory());
		const first = await runImport(db, universe, plan);
		const second = await runImport(db, universe, plan);
		expect(second.storyId).not.toBe(first.storyId);
		expect(second.slug).not.toBe(first.slug);
		const titles = await db.select({ title: stories.title }).from(stories);
		expect(titles.filter((row) => row.title === 'Halden')).toHaveLength(3);
	});

	// Only the story slug index is a clash a fresh pick can fix.
	it('does not try again after a clash other than the slug', async () => {
		let writes = 0;
		const counting = new Proxy(db, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== 'function') return value;
				if (prop !== 'transaction') return value.bind(target);
				return (...args: unknown[]) => {
					writes += 1;
					return value.apply(target, args);
				};
			}
		});
		// A scene holds one waiting draft; the parser keeps the first, so only a
		// hand-built plan carries two.
		const draft = {
			scene: { chapter: null, index: 0 },
			brief: 'Go on.',
			targetWords: null,
			pov: null,
			note: null,
			chapterBrief: null,
			source: 'assistant' as const,
			textMd: 'More prose.'
		};
		await expect(
			runImport(counting, universe, {
				story: { title: 'Twice', author: null, brief: null, descriptionMd: '' },
				chapters: [],
				unfiled: [{ title: null, status: null, bodyMd: 'Prose.' }],
				notes: [],
				waitingDrafts: [draft, draft],
				assets: [],
				problems: []
			})
		).rejects.toMatchObject({ cause: { constraint: 'assistant_drafts_open_scene_idx' } });
		expect(writes).toBe(1);
		expect(await db.select().from(stories).where(eq(stories.title, 'Twice'))).toEqual([]);
	});

	it('writes the adult flag and chapter summaries a document plan carries', async () => {
		const result = await runImport(db, universe, {
			story: {
				title: 'Rated',
				author: null,
				brief: null,
				descriptionMd: 'Summary.',
				isAdult: true
			},
			chapters: [
				{
					title: 'One',
					summaryMd: 'What happens.',
					scenes: [{ title: null, status: null, bodyMd: 'Prose.' }]
				}
			],
			unfiled: [],
			notes: [],
			freeformNotes: [
				{
					title: 'Chapter 1 notes',
					bodyMd: 'A note.',
					pinned: false,
					scene: { chapter: 0, index: 0 },
					createdAt: null
				}
			],
			assets: [],
			problems: []
		});
		const [story] = await db.select().from(stories).where(eq(stories.id, result.storyId));
		expect(story.isAdult).toBe(true);
		expect(story.descriptionMd).toBe('Summary.');
		// Imports get a placeholder cover colour like any new story.
		expect(isCoverColor(story.coverColor)).toBe(true);
		const [chapter] = await db.select().from(chapters).where(eq(chapters.storyId, story.id));
		expect(chapter.summaryMd).toBe('What happens.');
		const [scene] = await db.select().from(scenes).where(eq(scenes.storyId, story.id));
		const [note] = await db.select().from(notes).where(eq(notes.storyId, story.id));
		expect(note.sceneId).toBe(scene.id);
	});
});

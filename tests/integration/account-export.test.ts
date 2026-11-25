import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { and, asc, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assistantDrafts,
	chapters,
	characters,
	characterStoryNotes,
	entityRelationships,
	places,
	relationTypes,
	reviewComments,
	reviewInvitations,
	reviewers,
	reviewThreads,
	revisions,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	buildAccountExport,
	buildStoryZip,
	gatherStory,
	inMemoryAsset,
	type AssetLoader
} from '../../src/lib/server/export';
import { parseStoryZip } from '../../src/lib/import-markdown';
import { runImport } from '../../src/lib/server/import-story';
import { countProposals, listProposals } from '../../src/lib/server/proposals';
import { reviewLoader } from '../../src/lib/server/export-reviews';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';
import { zipBytes } from '../../src/lib/server/zip-stream';

let pool: pg.Pool;
let db: Database;
let ownerId: string;

const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const stubLoader: AssetLoader = async (ids) =>
	ids
		.filter((id) => id === ASSET_ID)
		.map((id) => inMemoryAsset(id, 'image/png', new Uint8Array([1, 2, 3])));

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table scenes, chapters, characters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({ email: 'export@example.com', displayName: 'Ex', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
});

afterAll(async () => {
	await pool.end();
});

function entries(bytes: Uint8Array) {
	const unzipped = unzipSync(bytes);
	return {
		names: Object.keys(unzipped),
		text: (path: string) => strFromU8(unzipped[path]),
		raw: (path: string) => unzipped[path]
	};
}

describe('buildAccountExport', () => {
	it('archives universes, entities, stories, scenes, and bundled assets', async () => {
		const [universe] = await db
			.insert(universes)
			.values({ ownerId, name: 'Mythos', descriptionMd: 'The world.' })
			.returning();
		await db.insert(characters).values({
			universeId: universe.id,
			ownerId,
			name: 'Alice Vane',
			aliases: ['Mrs. Fenwick'],
			summaryMd: 'A smuggler.',
			bodyMd: 'Long history.'
		});
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId, title: 'Halden' })
			.returning();
		const [chapter] = await db
			.insert(chapters)
			.values({ storyId: story.id, title: 'One', position: 1, summaryMd: 'They set out.' })
			.returning();
		await db.insert(scenes).values({
			storyId: story.id,
			chapterId: chapter.id,
			globalPosition: 1,
			title: 'Departure',
			bodyMd: 'A picture ![x](/assets/11111111-1111-1111-1111-111111111111) here.'
		});

		const bytes = await zipBytes((await buildAccountExport(db, ownerId, stubLoader)).entries);
		const zip = entries(bytes);

		expect(zip.text('universes/mythos/universe.md')).toContain('The world.');
		const character = zip.text('universes/mythos/characters/alice-vane.md');
		expect(character).toContain('"Mrs. Fenwick"');
		expect(character).toContain('A smuggler.');
		expect(character).toContain('Long history.');
		expect(zip.names).toContain('universes/mythos/stories/halden/story.md');
		expect(zip.text('universes/mythos/stories/halden/chapters/01-one/chapter.md')).toBe(
			'---\ntitle: "One"\n---\nThey set out.'
		);

		const sceneFile = zip.names.find(
			(n) => n.includes('/stories/halden/chapters/') && !n.endsWith('chapter.md')
		);
		expect(sceneFile).toBeTruthy();
		// The asset link is rewritten to the bundled, depth-relative path.
		expect(zip.text(sceneFile!)).toContain('assets/11111111-1111-1111-1111-111111111111.png');
		expect(zip.raw('assets/11111111-1111-1111-1111-111111111111.png')).toEqual(
			new Uint8Array([1, 2, 3])
		);
	});

	it('carries the universe and story settings in their front matter', async () => {
		const [universe] = await db
			.insert(universes)
			.values({
				ownerId,
				name: 'Mythos',
				language: 'da',
				assistantPreferences: { serialComma: 'no', repetition: 'leave' },
				assistantNotes: 'Danish names keep their letters.'
			})
			.returning();
		await db.insert(stories).values({
			universeId: universe.id,
			ownerId,
			title: 'Halden',
			styleNotes: 'Formal prose.',
			language: 'en-US',
			assistantPreferences: { thoughts: 'italics' },
			assistantNotes: 'Line one.\nLine two.'
		});
		await db.insert(stories).values({ universeId: universe.id, ownerId, title: 'Plain' });

		const zip = entries(
			await zipBytes((await buildAccountExport(db, ownerId, stubLoader)).entries)
		);
		expect(zip.text('universes/mythos/universe.md')).toContain(
			[
				'language: "da"',
				'assistant-preferences:',
				'  - "serialComma: no"',
				'  - "repetition: leave"',
				'assistant-notes: "Danish names keep their letters."'
			].join('\n')
		);
		const story = zip.text('universes/mythos/stories/halden/story.md');
		expect(story).toContain(
			[
				'style-notes: "Formal prose."',
				'language: "en-US"',
				'assistant-preferences:',
				'  - "thoughts: italics"',
				'assistant-notes: "Line one.\\nLine two."'
			].join('\n')
		);
		// A story with nothing set writes none of the keys.
		const plain = zip.text('universes/mythos/stories/plain/story.md');
		expect(plain).not.toMatch(/style-notes|language|assistant-/);
	});

	it('produces a readable archive for an empty account', async () => {
		const bytes = await zipBytes((await buildAccountExport(db, ownerId, stubLoader)).entries);
		expect(entries(bytes).names).toEqual(['README.md']);
	});

	it('keeps colliding names apart instead of overwriting files', async () => {
		const [universe] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
		// Two characters whose names slugify identically.
		await db.insert(characters).values([
			{ universeId: universe.id, ownerId, name: 'Jon', bodyMd: 'The first Jon.' },
			{ universeId: universe.id, ownerId, name: 'J\u00f6n', bodyMd: 'The other Jon.' }
		]);
		// Two stories with the same title, as the importer deliberately creates.
		for (const n of [1, 2]) {
			const [story] = await db
				.insert(stories)
				.values({ universeId: universe.id, ownerId, title: 'Halden' })
				.returning();
			await db.insert(scenes).values({
				storyId: story.id,
				globalPosition: 1,
				title: 'Only scene',
				bodyMd: `Copy number ${n}.`
			});
		}

		const bytes = await zipBytes((await buildAccountExport(db, ownerId, stubLoader)).entries);
		const zip = entries(bytes);

		expect(zip.text('universes/mythos/characters/jon.md')).toContain('The first Jon.');
		expect(zip.text('universes/mythos/characters/jon-2.md')).toContain('The other Jon.');
		const storyFiles = zip.names.filter((n) => n.endsWith('/story.md'));
		expect(storyFiles).toContain('universes/mythos/stories/halden/story.md');
		expect(storyFiles).toContain('universes/mythos/stories/halden-2/story.md');
		// Both manuscripts survive, not interleaved into one folder.
		expect(zip.text('universes/mythos/stories/halden/unfiled/01-only-scene.md')).toContain(
			'Copy number 1.'
		);
		expect(zip.text('universes/mythos/stories/halden-2/unfiled/01-only-scene.md')).toContain(
			'Copy number 2.'
		);
	});

	it('archives story notes, relationships, and review feedback', async () => {
		const [universe] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
		const [alice] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId, name: 'Alice Vane' })
			.returning();
		const [corvin] = await db
			.insert(characters)
			.values({ universeId: universe.id, ownerId, name: 'Corvin' })
			.returning();
		await db.insert(places).values({ universeId: universe.id, ownerId, name: 'The Toll Road' });
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId, title: 'Halden' })
			.returning();
		const body = 'The gate opened on the toll road.';
		const [scene] = await db
			.insert(scenes)
			.values({ storyId: story.id, globalPosition: 1, title: 'Departure', bodyMd: body })
			.returning();

		await db
			.insert(characterStoryNotes)
			.values({ characterId: alice.id, storyId: story.id, notesMd: 'Limps in this book.' });

		// The truncate cascade clears the seeded built-ins, so insert one.
		const [allyOf] = await db
			.insert(relationTypes)
			.values({
				key: 'ally_of',
				forwardLabel: 'ally of',
				bidirectional: true,
				fromType: 'character',
				toType: 'character'
			})
			.returning();
		await db.insert(entityRelationships).values({
			universeId: universe.id,
			ownerId,
			fromType: 'character',
			fromId: alice.id,
			toType: 'character',
			toId: corvin.id,
			relationTypeId: allyOf.id,
			notesMd: 'Since the siege.'
		});

		const [invitation] = await db
			.insert(reviewInvitations)
			.values({ storyId: story.id, createdBy: ownerId, tokenHash: 'hash' })
			.returning();
		const [reviewer] = await db
			.insert(reviewers)
			.values({ invitationId: invitation.id, displayName: 'Maren' })
			.returning();
		const [base] = await db
			.insert(revisions)
			.values({ entityType: 'scene', entityId: scene.id, bodyMd: body })
			.returning();
		const anchorStart = body.indexOf('toll road');
		const [anchored] = await db
			.insert(reviewThreads)
			.values({
				storyId: story.id,
				sceneId: scene.id,
				anchorStart,
				anchorEnd: anchorStart + 'toll road'.length,
				baseRevisionId: base.id,
				resolvedAt: new Date()
			})
			.returning();
		const [wholeScene] = await db
			.insert(reviewThreads)
			.values({ storyId: story.id, sceneId: scene.id })
			.returning();
		await db.insert(reviewComments).values([
			{ threadId: anchored.id, authorReviewerId: reviewer.id, bodyMd: 'Rename this road.' },
			{ threadId: wholeScene.id, authorReviewerId: reviewer.id, bodyMd: 'Pacing drags here.' },
			{ threadId: wholeScene.id, authorUserId: ownerId, bodyMd: 'Will tighten.' }
		]);

		const bytes = await zipBytes(
			(await buildAccountExport(db, ownerId, stubLoader, reviewLoader(db))).entries
		);
		const zip = entries(bytes);

		const note = zip.text('universes/mythos/stories/halden/notes/characters/alice-vane.md');
		expect(note).toContain('kind: "character"');
		expect(note).toContain('Limps in this book.');

		const relationships = zip.text('universes/mythos/relationships.md');
		expect(relationships.startsWith('# Relationships')).toBe(true);
		expect(relationships).toContain(
			'- Alice Vane (character) - ally of - Corvin (character)\n  Since the siege.'
		);

		const reviews = zip.text('universes/mythos/stories/halden/reviews.md');
		expect(reviews.startsWith('# Review feedback')).toBe(true);
		expect(reviews).toContain('## Departure (resolved)');
		expect(reviews).toContain('> toll road');
		expect(reviews).toContain('## Departure (open)');
		expect(reviews).toContain('> On the whole scene.');
		expect(reviews).toContain('Maren (reviewer),');
		expect(reviews).toContain('Ex (author),');
		expect(reviews).toContain('Will tighten.');
	});

	it('carries waiting drafts out and back in through the story import', async () => {
		const [universe] = await db.insert(universes).values({ ownerId, name: 'Mythos' }).returning();
		const [story] = await db
			.insert(stories)
			.values({ universeId: universe.id, ownerId, title: 'Halden' })
			.returning();
		const [chapter] = await db
			.insert(chapters)
			.values({ storyId: story.id, title: 'One', position: 1 })
			.returning();
		const [gate, road, gone, ford] = await db
			.insert(scenes)
			.values([
				{ storyId: story.id, chapterId: chapter.id, globalPosition: 1, title: 'Gate', bodyMd: '' },
				{ storyId: story.id, globalPosition: 2, title: 'Road', bodyMd: 'Kept prose.' },
				{
					storyId: story.id,
					globalPosition: 3,
					title: 'Gone',
					bodyMd: '',
					deletedAt: new Date()
				},
				{ storyId: story.id, globalPosition: 4, title: 'Ford', bodyMd: '' }
			])
			.returning();
		const draft = (sceneId: string, status: 'ready' | 'running' | 'accepted', textMd: string) => ({
			userId: ownerId,
			storyId: story.id,
			sceneId,
			brief: 'Mara reaches the gate.',
			targetWords: 900,
			status,
			textMd
		});
		await db.insert(assistantDrafts).values([
			{
				...draft(gate.id, 'ready', 'Rain on the gate.\n\nShe knocked.'),
				pov: 'Mara',
				note: 'Drafted by Helper.',
				chapterBrief: 'The caravan arrives.',
				position: 0,
				chapterId: chapter.id,
				jobId: 'a-job',
				source: 'assistant' as const
			},
			{
				...draft(ford.id, 'ready', 'Cold water.'),
				note: 'Drafted by Helper.',
				source: 'app' as const
			},
			// Being written, decided, or on a scene in the trash: none rides along.
			draft(road.id, 'running', 'Half a'),
			draft(road.id, 'accepted', 'Kept prose.'),
			draft(gone.id, 'ready', 'Nobody reads this.')
		]);

		const bytes = await zipBytes((await buildAccountExport(db, ownerId, stubLoader)).entries);
		const unzipped = unzipSync(bytes);
		const storyDir = 'universes/mythos/stories/halden/';
		const waiting = Object.keys(unzipped).filter((n) => n.startsWith(`${storyDir}waiting-drafts/`));
		expect(waiting.sort()).toEqual([
			`${storyDir}waiting-drafts/01-one-01-gate.md`,
			`${storyDir}waiting-drafts/unfiled-02-ford.md`
		]);
		const file = strFromU8(unzipped[waiting[0]]);
		expect(file).toContain('scene: "chapters/01-one/01-gate.md"');
		expect(file).toContain('note: "Drafted by Helper."');
		expect(file).toContain('Rain on the gate.\n\nShe knocked.');

		// The story export stays as it was.
		const storyZip = unzipSync(
			await zipBytes((await buildStoryZip(story, await gatherStory(db, story), stubLoader)).entries)
		);
		expect(Object.keys(storyZip).some((n) => n.includes('waiting-drafts'))).toBe(false);

		// The story's folder, zipped on its own, imports with its draft back on its scene.
		const folder = Object.fromEntries(
			Object.entries(unzipped)
				.filter(([name]) => name.startsWith(storyDir))
				.map(([name, data]) => [name.slice(storyDir.length), data])
		);
		const plan = parseStoryZip(zipSync(folder));
		expect(plan.problems).toEqual([]);
		const imported = await runImport(db, { id: universe.id, ownerId }, plan);
		expect(imported.waitingDraftsCreated).toBe(2);
		const sceneOf = async (title: string) =>
			(
				await db
					.select({ id: scenes.id })
					.from(scenes)
					.where(and(eq(scenes.storyId, imported.storyId), eq(scenes.title, title)))
			)[0];
		const newGate = await sceneOf('Gate');
		const newFord = await sceneOf('Ford');
		const rows = await db
			.select()
			.from(assistantDrafts)
			.where(eq(assistantDrafts.storyId, imported.storyId))
			.orderBy(asc(assistantDrafts.createdAt));
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.sceneId === newFord.id)).toMatchObject({
			source: 'app',
			note: 'Drafted by Helper.',
			textMd: 'Cold water.'
		});
		// Only the app's draft waits on Suggestions: the Assistant's stays the
		// Assistant's though it comes back with no job.
		const listed = (await listProposals(db, ownerId, universe.id)).drafts.filter(
			(d) => d.storyId === imported.storyId
		);
		expect(listed.map((d) => d.sceneId)).toEqual([newFord.id]);
		expect((await countProposals(db, ownerId)).get(universe.id)).toBe(2);
		expect(rows.find((row) => row.sceneId === newGate.id)).toMatchObject({
			source: 'assistant',
			userId: ownerId,
			sceneId: newGate.id,
			status: 'ready',
			brief: 'Mara reaches the gate.',
			targetWords: 900,
			pov: 'Mara',
			note: 'Drafted by Helper.',
			chapterBrief: 'The caravan arrives.',
			textMd: 'Rain on the gate.\n\nShe knocked.',
			position: null,
			jobId: null
		});
	});
});

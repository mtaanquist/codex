import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { publications, stories, tags, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import {
	addListEntries,
	checkTagNames,
	findFandoms,
	listedByName,
	listEntries,
	mergeTag,
	pickListed,
	renameTag,
	setStoryList,
	setStoryTags,
	setTagRemoved,
	storyTagView,
	unmergeTag
} from '../../src/lib/server/tags';
import { publishStory } from '../../src/lib/server/publish';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let storyId: string;
let otherStoryId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users, tags cascade');
	const [owner] = await db
		.insert(users)
		.values({
			email: 'tags@example.com',
			displayName: 'T',
			passwordHash: 'x',
			role: 'user',
			handle: 'tagger',
			publicArchiveEnabled: true
		})
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'U' }).returning();
	const [one, two] = await db
		.insert(stories)
		.values([
			{ universeId: universe.id, ownerId, title: 'One', slug: 'one' },
			{ universeId: universe.id, ownerId, title: 'Two', slug: 'two' }
		])
		.returning();
	storyId = one.id;
	otherStoryId = two.id;
});

afterAll(async () => {
	await pool.end();
});

async function tagStory(id: string, names: string[]) {
	const checked = checkTagNames(names);
	if (!checked.ok) throw new Error(checked.message);
	return await setStoryTags(db, id, checked.tags);
}

async function names(id: string) {
	return (await storyTagView(db, id)).tags.map((tag) => tag.name);
}

async function tagId(slug: string) {
	const [row] = await db.select().from(tags).where(eq(tags.slug, slug));
	return row.id;
}

const addFandoms = (text: string) => addListEntries(db, 'fandom', text);

describe('story tags', () => {
	it('reuses a tag by slug and keeps the first spelling', async () => {
		await tagStory(storyId, ['Found Family', 'found-family', 'Slow Burn']);
		await tagStory(otherStoryId, ['found_family']);
		expect(await names(storyId)).toEqual(['Found Family', 'Slow Burn']);
		expect(await names(otherStoryId)).toEqual(['Found Family']);
		expect(await db.select().from(tags)).toHaveLength(2);
	});

	it('replaces the tags on a save and leaves the fandoms alone', async () => {
		await addFandoms('Middle-earth');
		const fandoms = await findFandoms(db, ['middle earth']);
		if (!fandoms.ok) throw new Error(fandoms.message);
		await setStoryList(db, storyId, 'fandom', fandoms.ids);
		await tagStory(storyId, ['A', 'B']);
		await tagStory(storyId, ['B']);
		const view = await storyTagView(db, storyId);
		expect(view.tags.map((tag) => tag.name)).toEqual(['B']);
		expect(view.fandoms.map((tag) => tag.name)).toEqual(['Middle-earth']);
	});

	it('refuses more than 20 tags and a tag with odd characters', () => {
		expect(checkTagNames(Array.from({ length: 21 }, (_, i) => `t${i}`)).ok).toBe(false);
		expect(checkTagNames(['fine', '<b>']).ok).toBe(false);
	});

	it('shows a merged tag as its target, and undoing the merge splits them again', async () => {
		await tagStory(storyId, ['Fam']);
		await tagStory(otherStoryId, ['Found Family']);
		expect(await mergeTag(db, await tagId('fam'), 'found family')).toEqual({ ok: true });
		expect(await names(storyId)).toEqual(['Found Family']);
		// Typing the old name later lands on the same entry, which still points on.
		await tagStory(otherStoryId, ['fam', 'Found Family']);
		expect(await names(otherStoryId)).toEqual(['Found Family']);

		expect(await unmergeTag(db, await tagId('fam'))).toBe(true);
		expect(await names(storyId)).toEqual(['Fam']);
	});

	it('follows a chain of merges and refuses one that would loop', async () => {
		await tagStory(storyId, ['A']);
		await db.insert(tags).values([
			{ kind: 'tag', name: 'B', slug: 'b' },
			{ kind: 'tag', name: 'C', slug: 'c' }
		]);
		await mergeTag(db, await tagId('a'), 'B');
		await mergeTag(db, await tagId('b'), 'C');
		expect(await names(storyId)).toEqual(['C']);
		expect((await mergeTag(db, await tagId('c'), 'A')).ok).toBe(false);
		expect((await mergeTag(db, await tagId('a'), 'A')).ok).toBe(false);
	});

	it('hides a removed tag everywhere and will not let authors add it back', async () => {
		await tagStory(storyId, ['Spoilers', 'Kept']);
		await setTagRemoved(db, await tagId('spoilers'), true, ownerId);
		expect(await names(storyId)).toEqual(['Kept']);
		expect(await tagStory(otherStoryId, ['spoilers'])).toEqual({ skipped: ['Spoilers'] });
		expect(await names(otherStoryId)).toEqual([]);

		await setTagRemoved(db, await tagId('spoilers'), false, ownerId);
		expect(await names(storyId)).toEqual(['Kept', 'Spoilers']);
	});

	it('renames, refusing a name another tag has', async () => {
		await tagStory(storyId, ['Slowburn', 'Slow Burn']);
		expect((await renameTag(db, await tagId('slowburn'), 'slow burn')).ok).toBe(false);
		expect(await renameTag(db, await tagId('slowburn'), 'Slow-Burning')).toEqual({ ok: true });
		expect(await names(storyId)).toEqual(['Slow Burn', 'Slow-Burning']);
	});
});

describe('fandoms', () => {
	it('adds from lines, skipping ones already listed, and lists them for authors', async () => {
		expect(await addFandoms('Forgotten Realms\n\nMiddle-earth\nforgotten realms')).toEqual({
			ok: true,
			added: ['Forgotten Realms', 'Middle-earth'],
			skipped: []
		});
		expect(await addFandoms('Middle earth\nDiscworld')).toEqual({
			ok: true,
			added: ['Discworld'],
			skipped: ['Middle earth']
		});
		expect((await listEntries(db, 'fandom')).map((entry) => entry.name)).toEqual([
			'Discworld',
			'Forgotten Realms',
			'Middle-earth'
		]);
	});

	it('refuses a fandom not on the list, and more than five', async () => {
		await addFandoms('A\nB\nC\nD\nE\nF');
		expect((await findFandoms(db, ['Nowhere'])).ok).toBe(false);
		expect((await findFandoms(db, ['A', 'B', 'C', 'D', 'E', 'F'])).ok).toBe(false);
		expect((await findFandoms(db, ['a', 'B'])).ok).toBe(true);
	});

	it('keeps a fandom and a tag with the same slug apart', async () => {
		await addFandoms('Discworld');
		await tagStory(storyId, ['Discworld']);
		const view = await storyTagView(db, storyId);
		expect(view.fandoms).toEqual([]);
		expect(view.tags.map((tag) => tag.kind)).toEqual(['tag']);
	});
});

describe('genres and content warnings', () => {
	it('keeps only current entries of the right list, and genres apart from warnings', async () => {
		await addListEntries(db, 'genre', 'Fantasy\nHorror\nOld\nGone');
		await addListEntries(db, 'warning', 'Death');
		const fantasy = await tagId('fantasy');
		const old = await tagId('old');
		const death = await tagId('death');
		await mergeTag(db, old, 'Horror');
		const removedId = await tagId('gone');
		await setTagRemoved(db, removedId, true, ownerId);
		expect(await pickListed(db, 'genre', [fantasy, old, death, removedId, 'nope', 3])).toEqual([
			fantasy
		]);
		await setStoryList(db, storyId, 'genre', [fantasy]);
		await setStoryList(db, storyId, 'warning', [death]);
		const view = await storyTagView(db, storyId);
		expect(view.genres.map((tag) => tag.name)).toEqual(['Fantasy']);
		expect(view.warnings.map((tag) => tag.name)).toEqual(['Death']);
		expect((await listEntries(db, 'genre')).map((entry) => entry.name)).toEqual([
			'Fantasy',
			'Horror'
		]);
		expect(await listedByName(db, 'warning', ['death', 'Fantasy'])).toEqual({
			ids: [death],
			missing: ['Fantasy']
		});
	});
});

describe('content warnings on editions', () => {
	it('freezes the warning names at publish; a later change or rename waits for the next one', async () => {
		await addListEntries(db, 'warning', 'Death\nAbuse');
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		await setStoryList(db, storyId, 'warning', [await tagId('death')]);
		await pool.query(
			`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'Words.')`,
			[storyId]
		);
		const published = await publishStory(db, ownerId, storyId);
		if (!published.ok) throw new Error(published.reason);
		await setStoryList(db, storyId, 'warning', [await tagId('abuse')]);
		await renameTag(db, await tagId('death'), 'Character death');
		const [edition] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, published.publicationId));
		expect(edition.contentWarnings).toEqual(['Death']);
	});
});

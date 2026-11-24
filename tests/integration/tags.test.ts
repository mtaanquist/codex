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
	setUniverseFandom,
	suggestFandoms,
	universeFandom,
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

	it('a save while merged or removed keeps the old entry, so undoing gives it back', async () => {
		await tagStory(storyId, ['Fam', 'Spoilers', 'Kept']);
		await tagStory(otherStoryId, ['Found Family']);
		expect(await mergeTag(db, await tagId('fam'), 'Found Family')).toEqual({ ok: true });
		await setTagRemoved(db, await tagId('spoilers'), true, ownerId);
		// The form shows "Found Family" and "Kept" and sends them back as they are.
		await tagStory(storyId, ['Found Family', 'Kept']);
		expect(await names(storyId)).toEqual(['Found Family', 'Kept']);

		await unmergeTag(db, await tagId('fam'));
		await setTagRemoved(db, await tagId('spoilers'), false, ownerId);
		expect(await names(storyId)).toEqual(['Fam', 'Kept', 'Spoilers']);

		// Dropping the survivor drops the merged entry with it.
		await mergeTag(db, await tagId('fam'), 'Found Family');
		await tagStory(storyId, ['Kept', 'Spoilers']);
		await unmergeTag(db, await tagId('fam'));
		expect(await names(storyId)).toEqual(['Kept', 'Spoilers']);
	});

	it('a merged entry whose own row is removed goes when the writer drops its survivor', async () => {
		await tagStory(storyId, ['Fam']);
		await tagStory(otherStoryId, ['Found Family']);
		await mergeTag(db, await tagId('fam'), 'Found Family');
		await setTagRemoved(db, await tagId('fam'), true, ownerId);
		expect(await names(storyId)).toEqual(['Found Family']);
		await tagStory(storyId, []);
		expect(await names(storyId)).toEqual([]);
	});

	it('keeps a merged curated entry on a save too', async () => {
		await addListEntries(db, 'genre', 'Grimdark\nDark fantasy');
		await setStoryList(db, storyId, 'genre', [await tagId('grimdark')]);
		expect(await mergeTag(db, await tagId('grimdark'), 'Dark fantasy')).toEqual({ ok: true });
		await setStoryList(db, storyId, 'genre', [await tagId('dark-fantasy')]);
		await unmergeTag(db, await tagId('grimdark'));
		expect((await storyTagView(db, storyId)).genres.map((tag) => tag.name)).toEqual(['Grimdark']);
	});

	it('lets a story over 20 tags after an unmerge keep them but not add more', () => {
		const names = Array.from({ length: 21 }, (_, i) => `t${i}`);
		expect(checkTagNames(names).ok).toBe(false);
		expect(checkTagNames(names, 21).ok).toBe(true);
		expect(checkTagNames([...names, 'extra'], 21).ok).toBe(false);
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

describe('a universe linked to a fandom', () => {
	async function linked() {
		await addListEntries(db, 'fandom', 'Forgotten Realms\nRealms of Old\nDiscworld');
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		return story.universeId;
	}

	it('gives every story in it the fandom, and ticks Established setting', async () => {
		const universeId = await linked();
		expect(await setUniverseFandom(db, universeId, await tagId('forgotten-realms'))).toBe(true);
		const [universe] = await db.select().from(universes).where(eq(universes.id, universeId));
		expect(universe.establishedSetting).toBe(true);
		for (const id of [storyId, otherStoryId]) {
			const view = await storyTagView(db, id);
			expect(view.fandoms).toMatchObject([{ name: 'Forgotten Realms', inherited: true }]);
		}
		// Unlinking leaves the flag as it is.
		await setUniverseFandom(db, universeId, null);
		const [after] = await db.select().from(universes).where(eq(universes.id, universeId));
		expect(after.establishedSetting).toBe(true);
		expect((await storyTagView(db, storyId)).fandoms).toEqual([]);
	});

	it('follows a merge, hides a removed fandom, and refuses an entry not on the list', async () => {
		const universeId = await linked();
		await setUniverseFandom(db, universeId, await tagId('realms-of-old'));
		await mergeTag(db, await tagId('realms-of-old'), 'Forgotten Realms');
		expect(await universeFandom(db, universeId)).toMatchObject({ name: 'Forgotten Realms' });
		expect((await storyTagView(db, storyId)).fandoms.map((tag) => tag.name)).toEqual([
			'Forgotten Realms'
		]);
		await setTagRemoved(db, await tagId('forgotten-realms'), true, ownerId);
		expect(await universeFandom(db, universeId)).toBeNull();
		expect((await storyTagView(db, storyId)).fandoms).toEqual([]);
		expect(await setUniverseFandom(db, universeId, await tagId('forgotten-realms'))).toBe(false);
		expect(await setUniverseFandom(db, universeId, 'not-an-id')).toBe(false);
	});

	it('counts the inherited fandom toward the five, and does not store it again', async () => {
		const universeId = await linked();
		await setUniverseFandom(db, universeId, await tagId('discworld'));
		await addListEntries(db, 'fandom', 'A\nB\nC\nD\nE');
		expect((await findFandoms(db, ['A', 'B', 'C', 'D', 'E'], ['discworld'])).ok).toBe(false);
		const found = await findFandoms(db, ['Discworld', 'A', 'B', 'C', 'D'], ['discworld']);
		if (!found.ok) throw new Error(found.message);
		expect(found.ids).toHaveLength(4);
		await setStoryList(db, storyId, 'fandom', [await tagId('discworld')]);
		// Both on the story and from the universe: shown once, as the story's own.
		const view = await storyTagView(db, storyId);
		expect(view.fandoms).toEqual([expect.objectContaining({ name: 'Discworld' })]);
		expect(view.fandoms[0].inherited).toBeUndefined();
	});

	it('lets a story over the limit after a link keep its fandoms, but not add more', async () => {
		const universeId = await linked();
		await addListEntries(db, 'fandom', 'A\nB\nC\nD\nE\nF');
		const own = await findFandoms(db, ['A', 'B', 'C', 'D', 'E']);
		if (!own.ok) throw new Error(own.message);
		await setStoryList(db, storyId, 'fandom', own.ids);
		await setUniverseFandom(db, universeId, await tagId('discworld'));
		const shown = (await storyTagView(db, storyId)).fandoms;
		expect(shown).toHaveLength(6);
		expect((await findFandoms(db, ['A', 'B', 'C', 'D', 'E'], ['discworld'], 6)).ok).toBe(true);
		expect((await findFandoms(db, ['A', 'B', 'C', 'D', 'F'], ['discworld'], 6)).ok).toBe(true);
		const more = await findFandoms(db, ['A', 'B', 'C', 'D', 'E', 'F'], ['discworld'], 6);
		expect(more).toMatchObject({ ok: false, message: expect.stringMatching(/universe/) });
	});

	it('suggests close matches from the list as a writer types', async () => {
		await linked();
		expect((await suggestFandoms(db, 'forgoten realm')).map((row) => row.name)[0]).toBe(
			'Forgotten Realms'
		);
		expect((await suggestFandoms(db, 'disc')).map((row) => row.name)).toEqual(['Discworld']);
		expect(await suggestFandoms(db, 'x')).toEqual([]);
	});
});

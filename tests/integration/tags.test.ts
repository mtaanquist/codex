import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
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
	listTagsForModeration,
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
	const checked = await checkTagNames(db, names);
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

// Runs `run` while another connection holds an open transaction from `hold`,
// and finishes that transaction once `run` is stuck waiting on a lock.
async function whileHeld<T>(
	hold: (client: pg.PoolClient) => Promise<unknown>,
	run: () => Promise<T>
): Promise<T> {
	const holder = await pool.connect();
	try {
		await holder.query('begin');
		await hold(holder);
		const pending = run();
		for (let i = 0; i < 200; i++) {
			const { rows } = await pool.query(
				`select count(*)::int as n from pg_stat_activity
				 where datname = current_database() and wait_event_type = 'Lock'`
			);
			if (rows[0].n > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await holder.query('commit');
		return await pending;
	} finally {
		holder.release();
	}
}

async function mergedInto(slug: string) {
	const [row] = await db.select().from(tags).where(eq(tags.slug, slug));
	return row.mergedIntoId;
}

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

	it('refuses more than 20 tags and a tag with odd characters', async () => {
		expect(
			(
				await checkTagNames(
					db,
					Array.from({ length: 21 }, (_, i) => `t${i}`)
				)
			).ok
		).toBe(false);
		expect((await checkTagNames(db, ['fine', '<b>'])).ok).toBe(false);
	});

	it('counts a merged-away name and its survivor once toward the 20', async () => {
		const twenty = Array.from({ length: 19 }, (_, i) => `t${i}`).concat('Target');
		await tagStory(storyId, twenty);
		await tagStory(otherStoryId, ['Gone']);
		await db.insert(tags).values({ kind: 'tag', name: 'M', slug: 'm' });
		expect(await mergeTag(db, 'tag', await tagId('m'), 'Target')).toEqual({ ok: true });
		await setTagRemoved(db, 'tag', await tagId('gone'), true, ownerId);
		// "M" shows as Target and the removed "Gone" does not show, so the story
		// still shows 20.
		const checked = await checkTagNames(db, [...twenty, 'M', 'Gone'], 20);
		expect(checked.ok).toBe(true);
		if (checked.ok) await setStoryTags(db, storyId, checked.tags);
		expect(await names(storyId)).toHaveLength(20);
		expect((await checkTagNames(db, [...twenty, 'M', 'New'], 20)).ok).toBe(false);
	});

	it('shows a merged tag as its target, and undoing the merge splits them again', async () => {
		await tagStory(storyId, ['Fam']);
		await tagStory(otherStoryId, ['Found Family']);
		expect(await mergeTag(db, 'tag', await tagId('fam'), 'found family')).toEqual({ ok: true });
		expect(await names(storyId)).toEqual(['Found Family']);
		// Typing the old name later lands on the same entry, which still points on.
		await tagStory(otherStoryId, ['fam', 'Found Family']);
		expect(await names(otherStoryId)).toEqual(['Found Family']);

		expect(await unmergeTag(db, 'tag', await tagId('fam'))).toBe(true);
		expect(await names(storyId)).toEqual(['Fam']);
	});

	it('a save while merged or removed keeps the old entry, so undoing gives it back', async () => {
		await tagStory(storyId, ['Fam', 'Spoilers', 'Kept']);
		await tagStory(otherStoryId, ['Found Family']);
		expect(await mergeTag(db, 'tag', await tagId('fam'), 'Found Family')).toEqual({ ok: true });
		await setTagRemoved(db, 'tag', await tagId('spoilers'), true, ownerId);
		// The form shows "Found Family" and "Kept" and sends them back as they are.
		await tagStory(storyId, ['Found Family', 'Kept']);
		expect(await names(storyId)).toEqual(['Found Family', 'Kept']);

		await unmergeTag(db, 'tag', await tagId('fam'));
		await setTagRemoved(db, 'tag', await tagId('spoilers'), false, ownerId);
		expect(await names(storyId)).toEqual(['Fam', 'Kept', 'Spoilers']);

		// Dropping the survivor drops the merged entry with it.
		await mergeTag(db, 'tag', await tagId('fam'), 'Found Family');
		await tagStory(storyId, ['Kept', 'Spoilers']);
		await unmergeTag(db, 'tag', await tagId('fam'));
		expect(await names(storyId)).toEqual(['Kept', 'Spoilers']);
	});

	it('a merged entry whose own row is removed goes when the writer drops its survivor', async () => {
		await tagStory(storyId, ['Fam']);
		await tagStory(otherStoryId, ['Found Family']);
		await mergeTag(db, 'tag', await tagId('fam'), 'Found Family');
		await setTagRemoved(db, 'tag', await tagId('fam'), true, ownerId);
		expect(await names(storyId)).toEqual(['Found Family']);
		await tagStory(storyId, []);
		expect(await names(storyId)).toEqual([]);
	});

	it('keeps a merged curated entry on a save too', async () => {
		await addListEntries(db, 'genre', 'Grimdark\nDark fantasy');
		await setStoryList(db, storyId, 'genre', [await tagId('grimdark')]);
		expect(await mergeTag(db, 'genre', await tagId('grimdark'), 'Dark fantasy')).toEqual({
			ok: true
		});
		await setStoryList(db, storyId, 'genre', [await tagId('dark-fantasy')]);
		await unmergeTag(db, 'genre', await tagId('grimdark'));
		expect((await storyTagView(db, storyId)).genres.map((tag) => tag.name)).toEqual(['Grimdark']);
	});

	it('lets a story over 20 tags after an unmerge keep them but not add more', async () => {
		const names = Array.from({ length: 21 }, (_, i) => `t${i}`);
		expect((await checkTagNames(db, names)).ok).toBe(false);
		expect((await checkTagNames(db, names, 21)).ok).toBe(true);
		expect((await checkTagNames(db, [...names, 'extra'], 21)).ok).toBe(false);
	});

	it('merges into the survivor and keeps every chain one step deep', async () => {
		await tagStory(storyId, ['A']);
		await db.insert(tags).values([
			{ kind: 'tag', name: 'B', slug: 'b' },
			{ kind: 'tag', name: 'C', slug: 'c' },
			{ kind: 'tag', name: 'D', slug: 'd' }
		]);
		await mergeTag(db, 'tag', await tagId('a'), 'B');
		// B's merged entries move with it.
		expect(await mergeTag(db, 'tag', await tagId('b'), 'C')).toEqual({ ok: true });
		expect(await mergedInto('a')).toBe(await tagId('c'));
		expect(await names(storyId)).toEqual(['C']);
		// Naming a merged entry lands on its survivor.
		expect(await mergeTag(db, 'tag', await tagId('d'), 'A')).toEqual({ ok: true });
		expect(await mergedInto('d')).toBe(await tagId('c'));
		expect((await mergeTag(db, 'tag', await tagId('c'), 'A')).ok).toBe(false);
		expect((await mergeTag(db, 'tag', await tagId('a'), 'A')).ok).toBe(false);
	});

	it('refuses a merge whose target was merged into the source meanwhile', async () => {
		await db.insert(tags).values([
			{ kind: 'tag', name: 'A', slug: 'a' },
			{ kind: 'tag', name: 'B', slug: 'b' }
		]);
		const a = await tagId('a');
		const b = await tagId('b');
		// Another moderator is merging B into A when this merge of A into B starts.
		const result = await whileHeld(
			(client) => client.query('update tags set merged_into_id = $1 where id = $2', [a, b]),
			() => mergeTag(db, 'tag', a, 'B')
		);
		expect(result.ok).toBe(false);
		expect(await mergedInto('a')).toBeNull();
		expect(await mergedInto('b')).toBe(a);
	});

	it('hides a removed tag everywhere and will not let authors add it back', async () => {
		await tagStory(storyId, ['Spoilers', 'Kept']);
		await setTagRemoved(db, 'tag', await tagId('spoilers'), true, ownerId);
		expect(await names(storyId)).toEqual(['Kept']);
		expect(await tagStory(otherStoryId, ['spoilers'])).toEqual({ skipped: ['Spoilers'] });
		expect(await names(otherStoryId)).toEqual([]);

		await setTagRemoved(db, 'tag', await tagId('spoilers'), false, ownerId);
		expect(await names(storyId)).toEqual(['Kept', 'Spoilers']);
	});

	it('will not add a tag merged into a removed tag, and says so', async () => {
		await tagStory(otherStoryId, ['Spoilers', 'Spoiler']);
		expect(await mergeTag(db, 'tag', await tagId('spoiler'), 'Spoilers')).toEqual({ ok: true });
		await setTagRemoved(db, 'tag', await tagId('spoilers'), true, ownerId);
		expect(await tagStory(storyId, ['spoiler', 'Kept'])).toEqual({ skipped: ['Spoiler'] });
		const [{ n }] = (
			await pool.query(
				'select count(*)::int as n from story_tags st join tags t on t.id = st.tag_id where st.story_id = $1 and t.slug = $2',
				[storyId, 'spoiler']
			)
		).rows;
		expect(n).toBe(0);
		expect(await names(storyId)).toEqual(['Kept']);
	});

	it('renames, refusing a name another tag has', async () => {
		await tagStory(storyId, ['Slowburn', 'Slow Burn']);
		expect((await renameTag(db, 'tag', await tagId('slowburn'), 'slow burn')).ok).toBe(false);
		expect(await renameTag(db, 'tag', await tagId('slowburn'), 'Slow-Burning')).toEqual({
			ok: true
		});
		expect(await names(storyId)).toEqual(['Slow Burn', 'Slow-Burning']);
	});

	it('refuses a rename to a name a writer added since the check', async () => {
		await tagStory(storyId, ['Slowburn']);
		const id = await tagId('slowburn');
		const result = await whileHeld(
			(client) =>
				client.query(
					`insert into tags (kind, name, slug) values ('tag', 'Slow Burn', 'slow-burn')`
				),
			() => renameTag(db, 'tag', id, 'Slow Burn')
		);
		expect(result).toEqual({
			ok: false,
			message: 'Another entry already has that name. Merge them instead.'
		});
	});
});

// Data from before every merge was kept one step deep can hold a loop or a
// chain longer than reads follow. Migration 0125 repairs those rows once.
describe('broken merges (migration 0125)', () => {
	const repairSql = readFileSync('drizzle/0125_flatten-tag-merges.sql', 'utf8');

	// Inserts tags named by slug, oldest first, then points each at the next.
	async function chain(slugs: string[], loop = false) {
		for (const [i, slug] of slugs.entries()) {
			await db.insert(tags).values({
				kind: 'tag',
				name: slug.toUpperCase(),
				slug,
				createdAt: new Date(Date.UTC(2020, 0, 1 + i))
			});
		}
		const ids = await Promise.all(slugs.map(tagId));
		for (const [i, id] of ids.entries()) {
			const next = ids[i + 1] ?? (loop ? ids[0] : null);
			if (next) await db.update(tags).set({ mergedIntoId: next }).where(eq(tags.id, id));
		}
		return ids;
	}

	it('says why a merge into a loop or a long chain fails, instead of asking to try again', async () => {
		await chain(['a', 'b'], true);
		await chain(Array.from({ length: 12 }, (_, i) => `c${i}`));
		await db.insert(tags).values({ kind: 'tag', name: 'X', slug: 'x' });
		for (const target of ['B', 'c0']) {
			const result = await mergeTag(db, 'tag', await tagId('x'), target);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toMatch(/loop or a chain too long/);
		}
	});

	it('gives a loop its oldest entry as survivor and points long chains at the end', async () => {
		const loop = await chain(['b', 'a', 'z'], true);
		const long = await chain(Array.from({ length: 12 }, (_, i) => `c${i}`));
		// A fine chain of two steps, and a plain merge, stay as they are.
		const fine = await chain(['f0', 'f1', 'f2']);
		await tagStory(storyId, ['a', 'c0', 'f0']);
		await pool.query(repairSql);

		expect(await mergedInto('b')).toBeNull();
		expect(await mergedInto('a')).toBe(await tagId('z'));
		expect(await mergedInto('z')).toBe(loop[0]);
		// c0 to c2 were more than 8 steps from c11; c3 to c10 still reach it.
		for (let i = 0; i < 11; i++) {
			expect(await mergedInto(`c${i}`)).toBe(i < 3 ? long[11] : long[i + 1]);
		}
		expect(await mergedInto('f0')).toBe(fine[1]);
		expect(await mergedInto('f1')).toBe(fine[2]);
		expect(await names(storyId)).toEqual(['B', 'C11', 'F2']);

		await db.insert(tags).values({ kind: 'tag', name: 'X', slug: 'x' });
		expect(await mergeTag(db, 'tag', await tagId('x'), 'a')).toEqual({ ok: true });
		expect(await mergedInto('x')).toBe(loop[0]);
		expect(await mergeTag(db, 'tag', await tagId('f2'), 'c0')).toEqual({ ok: true });
		expect(await mergedInto('f2')).toBe(long[11]);
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

	it('counts a merged-away fandom and its survivor once, in the order typed', async () => {
		await addFandoms('Discworld\nPratchett\nDune\nA\nB\nC\nD');
		await mergeTag(db, 'fandom', await tagId('pratchett'), 'Discworld');
		expect(await listedByName(db, 'fandom', ['dune', 'Pratchett', 'nope', 'discworld'])).toEqual({
			ids: [await tagId('dune'), await tagId('discworld')],
			slugs: ['dune', 'discworld'],
			missing: ['nope']
		});
		const found = await findFandoms(db, ['Pratchett', 'Discworld', 'Dune', 'A', 'B']);
		expect(found).toEqual({
			ok: true,
			ids: [await tagId('discworld'), await tagId('dune'), await tagId('a'), await tagId('b')]
		});
		// Old code counted Pratchett and Discworld as two of the five.
		expect((await findFandoms(db, ['Pratchett', 'Discworld', 'Dune', 'A', 'B', 'C'])).ok).toBe(
			true
		);
		expect((await findFandoms(db, ['Pratchett', 'Dune', 'A', 'B', 'C'], ['discworld'])).ok).toBe(
			true
		);
		expect((await findFandoms(db, ['Dune', 'A', 'B', 'C', 'D'], ['discworld'])).ok).toBe(false);
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
		await mergeTag(db, 'genre', old, 'Horror');
		const removedId = await tagId('gone');
		await setTagRemoved(db, 'genre', removedId, true, ownerId);
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
			slugs: ['death'],
			missing: ['Fantasy']
		});
	});
});

describe('moderation by kind', () => {
	it('does not find an entry of another kind than the page manages', async () => {
		await addListEntries(db, 'genre', 'Fantasy\nHorror');
		await addFandoms('Discworld');
		const fandom = await tagId('discworld');
		const fantasy = await tagId('fantasy');
		await mergeTag(db, 'genre', fantasy, 'Horror');
		expect((await renameTag(db, 'genre', fandom, 'Other')).ok).toBe(false);
		expect((await mergeTag(db, 'genre', fandom, 'Horror')).ok).toBe(false);
		expect(await unmergeTag(db, 'fandom', fantasy)).toBe(false);
		expect(await setTagRemoved(db, 'genre', fandom, true, ownerId)).toBe(false);
		const [row] = await db.select().from(tags).where(eq(tags.id, fandom));
		expect(row).toMatchObject({ name: 'Discworld', removedAt: null, mergedIntoId: null });
		expect(await mergedInto('fantasy')).toBe(await tagId('horror'));
	});

	it('lists a huge page number as an empty page, and Infinity as the first', async () => {
		await addListEntries(db, 'genre', 'Fantasy\nHorror');
		expect((await listTagsForModeration(db, 'genre')).rows).toHaveLength(2);
		expect(await listTagsForModeration(db, 'genre', { page: 1e20 })).toMatchObject({
			rows: [],
			more: false
		});
		// Not a number at all reads as the first page.
		const odd = await listTagsForModeration(db, 'genre', { page: Infinity });
		expect(odd.page).toBe(0);
		expect(odd.rows).toHaveLength(2);
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
		await renameTag(db, 'warning', await tagId('death'), 'Character death');
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
		await mergeTag(db, 'fandom', await tagId('realms-of-old'), 'Forgotten Realms');
		expect(await universeFandom(db, universeId)).toMatchObject({ name: 'Forgotten Realms' });
		expect((await storyTagView(db, storyId)).fandoms.map((tag) => tag.name)).toEqual([
			'Forgotten Realms'
		]);
		await setTagRemoved(db, 'fandom', await tagId('forgotten-realms'), true, ownerId);
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

	it('counts stories that get the fandom from their universe in its uses, each once', async () => {
		const universeId = await linked();
		const discworld = await tagId('discworld');
		const [elsewhere] = await db.insert(universes).values({ ownerId, name: 'V' }).returning();
		const [third] = await db
			.insert(stories)
			.values({ universeId: elsewhere.id, ownerId, title: 'Three', slug: 'three' })
			.returning();
		await setUniverseFandom(db, universeId, discworld);
		// One story has it both ways, one only from the universe, one only directly.
		await setStoryList(db, storyId, 'fandom', [discworld]);
		await setStoryList(db, third.id, 'fandom', [discworld]);
		const uses = async (name: string) =>
			(await listTagsForModeration(db, 'fandom')).rows.find((row) => row.name === name)?.uses;
		expect(await uses('Discworld')).toBe(3);
		expect(await uses('Forgotten Realms')).toBe(0);
		await setUniverseFandom(db, universeId, null);
		expect(await uses('Discworld')).toBe(2);
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

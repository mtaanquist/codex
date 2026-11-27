import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import { publications, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The similar stories under a public reading page: how they are scored, who
// is left out, the adult gate, and when the section is hidden.

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('#lib/server/jobs', () => ({
	queueNotificationDigest: vi.fn(async () => undefined),
	queueReviewerDigest: vi.fn(async () => undefined)
}));

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { createStoryInUniverse } = await import('../../src/lib/server/story-create');
const { publishStory, takedownPublication } = await import('../../src/lib/server/publish');
const { clearBrowseCache, saveBrowseEnabled } = await import('../../src/lib/server/settings');
const { addListEntries, checkTagNames, mergeTag, setStoryList, setStoryTags } =
	await import('../../src/lib/server/tags');
const { similarStories } = await import('../../src/lib/server/browse');
const storyPage = await import('../../src/routes/@[handle]/[story=ref]/+page.server');
const similarRoute = await import('../../src/routes/@[handle]/[story=ref]/similar/+server');

let author: { id: string };
let universeId: string;

async function user(email: string, extra = {}) {
	const [row] = await db
		.insert(users)
		.values({
			email,
			displayName: email.split('@')[0],
			passwordHash: 'x',
			role: 'user',
			publicArchiveEnabled: true,
			...extra
		})
		.returning();
	return row;
}

// A published, public story listed in Browse, with the given free-form tags
// and genres, published after every story made before it.
async function story(
	title: string,
	options: {
		tags?: string[];
		genres?: string[];
		owner?: string;
		universe?: string;
		listed?: boolean;
		adult?: boolean;
	} = {}
) {
	const owner = options.owner ?? author.id;
	const created = await createStoryInUniverse(db, owner, options.universe ?? universeId, title);
	await db
		.update(stories)
		.set({
			visibility: 'public',
			listedInBrowse: options.listed ?? true,
			isAdult: options.adult ?? false
		})
		.where(eq(stories.id, created.id));
	if (options.tags) {
		const checked = await checkTagNames(db, options.tags);
		if (!checked.ok) throw new Error(checked.message);
		await setStoryTags(db, created.id, checked.tags);
	}
	if (options.genres) {
		const { rows } = await pool.query(
			"select id from tags where kind = 'genre' and slug = any($1::text[])",
			[options.genres]
		);
		await setStoryList(
			db,
			created.id,
			'genre',
			rows.map((row) => row.id)
		);
	}
	await pool.query(
		`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'Words.')`,
		[created.id]
	);
	const published = await publishStory(db, owner, created.id);
	if (!published.ok) throw new Error(published.reason);
	return { id: created.id, publicationId: published.publicationId, slug: created.slug };
}

// Stories with no labels in common, so a tag shared by a few stories is rare.
async function filler(count: number) {
	for (let i = 0; i < count; i++) await story(`Filler ${i}`, { tags: [`unique ${i}`] });
}

async function similar(storyId: string, adult = false) {
	return (await similarStories(db, storyId, { adult })).map((book) => book.title);
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users, tags, app_settings cascade');
	clearBrowseCache();
	resetRateLimits();
	author = await user('author@example.com', { handle: 'teller', penName: 'Ada Teller' });
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: author.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
	await addListEntries(db, 'genre', 'Fantasy\nHorror\nMystery');
});

describe('scoring', () => {
	it('ranks rarer shared tags higher and leaves out the story itself', async () => {
		await filler(10);
		// Of 16 listed stories, "dragons" is on 4 and "lighthouse" on 3.
		const source = await story('Source', { tags: ['dragons', 'lighthouse'] });
		await story('Common tag', { tags: ['dragons'] });
		await story('Rare tag', { tags: ['lighthouse'] });
		await story('Both tags', { tags: ['dragons', 'lighthouse'] });
		await story('More dragons', { tags: ['dragons'] });
		await story('Nothing shared', { tags: ['ships'] });
		expect(await similar(source.id)).toEqual([
			'Both tags',
			'Rare tag',
			'More dragons',
			'Common tag'
		]);
	});

	it('adds a little for shared genres, but genres alone are not enough', async () => {
		await filler(10);
		const source = await story('Source', {
			tags: ['dragons'],
			genres: ['fantasy', 'horror', 'mystery']
		});
		await story('Genres only', { genres: ['fantasy', 'horror', 'mystery'] });
		await story('Tag only', { tags: ['dragons'] });
		await story('Tag and genre', { tags: ['dragons'], genres: ['fantasy'] });
		expect(await similar(source.id)).toEqual(['Tag and genre', 'Tag only']);
	});

	it('needs a shared tag even when a story keeps more genres than it may pick', async () => {
		await filler(10);
		// An unmerge can leave a story with more genres than the limit.
		await addListEntries(db, 'genre', 'Romance');
		const genres = ['fantasy', 'horror', 'mystery', 'romance'];
		const source = await story('Source', { tags: ['dragons'], genres });
		await story('Genres only', { genres });
		expect(await similar(source.id)).toEqual([]);
	});

	it('leaves out a match on a tag most listed stories carry', async () => {
		const source = await story('Source', { tags: ['fiction'] });
		await story('Also fiction', { tags: ['fiction'] });
		await story('Fiction too', { tags: ['fiction'] });
		expect(await similar(source.id)).toEqual([]);
	});

	it('does not count content warnings or fandoms', async () => {
		await filler(10);
		await addListEntries(db, 'warning', 'Death');
		await addListEntries(db, 'fandom', 'Discworld');
		const { rows } = await pool.query(
			"select id, kind from tags where kind in ('warning', 'fandom')"
		);
		const id = (kind: string) => rows.find((row) => row.kind === kind).id as string;
		const source = await story('Source');
		const other = await story('Other');
		for (const s of [source, other]) {
			await setStoryList(db, s.id, 'warning', [id('warning')]);
			await setStoryList(db, s.id, 'fandom', [id('fandom')]);
		}
		expect(await similar(source.id)).toEqual([]);
	});

	it('matches a tag through a merge', async () => {
		await filler(10);
		const source = await story('Source', { tags: ['dragons'] });
		await story('Old spelling', { tags: ['dragon'] });
		const { rows } = await pool.query("select id from tags where kind = 'tag' and slug = 'dragon'");
		await mergeTag(db, 'tag', rows[0].id, 'dragons');
		expect(await similar(source.id)).toEqual(['Old spelling']);
	});

	it('shows at most six, newest first among equal matches', async () => {
		await filler(20);
		const source = await story('Source', { tags: ['dragons'] });
		for (let i = 1; i <= 7; i++) await story(`Match ${i}`, { tags: ['dragons'] });
		expect(await similar(source.id)).toEqual([
			'Match 7',
			'Match 6',
			'Match 5',
			'Match 4',
			'Match 3',
			'Match 2'
		]);
	});
});

describe('who is left out', () => {
	it('shows only current editions of listed stories by authors in good standing', async () => {
		await filler(20);
		const tags = ['dragons'];
		const source = await story('Source', { tags });
		await story('Listed', { tags });
		await story('Not listed', { tags, listed: false });
		const unlisted = await story('Unlisted', { tags });
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, unlisted.id));
		const down = await story('Taken down', { tags });
		await takedownPublication(db, down.publicationId, null, 'other');
		const blocked = await story('Blocked', { tags });
		await db.update(stories).set({ browseBlockedAt: new Date() }).where(eq(stories.id, blocked.id));
		const hidden = await user('hidden@example.com', { handle: 'hidden', hiddenFromBrowse: true });
		const [hiddenUniverse] = await db
			.insert(universes)
			.values({ ownerId: hidden.id, name: 'H' })
			.returning();
		await story('Opted out', { tags, owner: hidden.id, universe: hiddenUniverse.id });
		const suspended = await user('gone@example.com', { handle: 'gone' });
		const [goneUniverse] = await db
			.insert(universes)
			.values({ ownerId: suspended.id, name: 'G' })
			.returning();
		await story('Suspended', { tags, owner: suspended.id, universe: goneUniverse.id });
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, suspended.id));

		expect(await similar(source.id)).toEqual(['Listed']);
	});

	it('leaves out trashed stories, trashed universes and authors leaving', async () => {
		await filler(20);
		const tags = ['dragons'];
		const source = await story('Source', { tags });
		await story('Listed', { tags });
		const trashed = await story('Trashed', { tags });
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, trashed.id));
		const [doomed] = await db
			.insert(universes)
			.values({ ownerId: author.id, name: 'Doomed' })
			.returning();
		await story('In a trashed universe', { tags, universe: doomed.id });
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, doomed.id));
		const leaving = await user('leaving@example.com', { handle: 'leaving' });
		const [leavingUniverse] = await db
			.insert(universes)
			.values({ ownerId: leaving.id, name: 'L' })
			.returning();
		await story('Author leaving', { tags, owner: leaving.id, universe: leavingUniverse.id });
		await db.update(users).set({ deletionScheduledAt: new Date() }).where(eq(users.id, leaving.id));

		expect(await similar(source.id)).toEqual(['Listed']);
	});

	it('finds matches for a story that is not listed itself', async () => {
		await filler(10);
		const source = await story('Source', { tags: ['dragons'], listed: false });
		await story('Listed', { tags: ['dragons'] });
		expect(await similar(source.id)).toEqual(['Listed']);
	});

	it('shows adult work only when the reader confirmed they may see it', async () => {
		await filler(10);
		const source = await story('Source', { tags: ['dragons'] });
		const grown = await story('Adult', { tags: ['dragons'] });
		await db
			.update(publications)
			.set({ isAdult: true })
			.where(eq(publications.id, grown.publicationId));
		expect(await similar(source.id)).toEqual([]);
		expect(await similar(source.id, true)).toEqual(['Adult']);
	});
});

describe('the reading page', () => {
	const load = (slug: string, search = '') =>
		storyPage.load({
			params: { handle: 'teller', story: slug },
			url: new URL(`http://localhost/@teller/${slug}${search}`),
			setHeaders: () => {}
		} as never) as Promise<Record<string, unknown>>;

	const fetchSimilar = (slug: string, search = '') =>
		similarRoute.GET({
			params: { handle: 'teller', story: slug },
			url: new URL(`http://localhost/@teller/${slug}/similar${search}`),
			getClientAddress: () => '203.0.113.9',
			setHeaders: () => {}
		} as never);

	const titlesOf = (books: unknown) => (books as { title: string }[]).map((book) => book.title);

	it('has no section while Browse is off', async () => {
		await filler(10);
		const source = await story('Source', { tags: ['dragons'] });
		await story('Match', { tags: ['dragons'] });
		expect((await load(source.slug)).similar).toBeNull();
		try {
			await fetchSimilar(source.slug, '?adult=show');
			expect.unreachable();
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(404);
		}
	});

	it('lists matches once Browse is on, and none when nothing scores high enough', async () => {
		await saveBrowseEnabled(db, true);
		await filler(10);
		const source = await story('Source', { tags: ['dragons'] });
		const lonely = await story('Lonely', { tags: ['nobody else'] });
		await story('Match', { tags: ['dragons'] });
		expect(titlesOf((await load(source.slug)).similar)).toEqual(['Match']);
		expect((await load(lonely.slug)).similar).toEqual([]);
	});

	it('answers 404 from the endpoint for a story with no public edition', async () => {
		await saveBrowseEnabled(db, true);
		await filler(10);
		const hidden = await story('Gone private', { tags: ['dragons'] });
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, hidden.id));
		const down = await story('Taken down', { tags: ['dragons'] });
		await takedownPublication(db, down.publicationId, null, 'other');
		for (const slug of [hidden.slug, down.slug, 'no-such-story']) {
			try {
				await fetchSimilar(slug);
				expect.unreachable();
			} catch (err) {
				expect(isHttpError(err) && err.status).toBe(404);
			}
		}
	});

	it('limits how often one address asks, and says when to try again', async () => {
		await saveBrowseEnabled(db, true);
		const headers: Record<string, string> = {};
		const ask = () =>
			similarRoute.GET({
				params: { handle: 'teller', story: 'no-such-story' },
				url: new URL('http://localhost/@teller/no-such-story/similar'),
				getClientAddress: () => '203.0.113.10',
				setHeaders: (set: Record<string, string>) => Object.assign(headers, set)
			} as never);
		const statusOf = async () => {
			try {
				await ask();
				return 200;
			} catch (err) {
				return isHttpError(err) ? err.status : 0;
			}
		};
		for (let i = 0; i < 120; i++) expect(await statusOf()).toBe(404);
		expect(await statusOf()).toBe(429);
		expect(Number(headers['retry-after'])).toBeGreaterThan(0);
	});

	it('includes adult work on a confirmed adult story, and from the endpoint when asked', async () => {
		await saveBrowseEnabled(db, true);
		await filler(10);
		const plain = await story('Plain', { tags: ['dragons'] });
		const grown = await story('Grown', { tags: ['dragons'], adult: true });
		await story('Also grown', { tags: ['dragons'], adult: true });

		// The gate shows nothing of the story, and no similar stories either.
		expect((await load(grown.slug)).similar).toBeUndefined();
		expect(titlesOf((await load(grown.slug, '?adult=ok')).similar).sort()).toEqual([
			'Also grown',
			'Plain'
		]);

		expect(titlesOf((await load(plain.slug)).similar)).toEqual([]);
		const shown = await fetchSimilar(plain.slug, '?adult=show');
		expect(titlesOf(((await shown.json()) as { books: unknown }).books).sort()).toEqual([
			'Also grown',
			'Grown'
		]);
		const left = await fetchSimilar(plain.slug);
		expect(((await left.json()) as { books: unknown[] }).books).toEqual([]);
	});
});

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	publicationReports,
	publications,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The public Browse page: which stories it lists, its filters and paging,
// and taking a story off it.

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
const { createReport } = await import('../../src/lib/server/reports');
const { clearBrowseCache, saveBrowseEnabled } = await import('../../src/lib/server/settings');
const { addListEntries, checkTagNames, mergeTag, renameTag, setStoryList, setStoryTags } =
	await import('../../src/lib/server/tags');
const {
	allowInBrowse,
	browseAuthors,
	browseStories,
	removeFromBrowse,
	resolveFilters,
	saveStoryVisibility
} = await import('../../src/lib/server/browse');
const { parseBrowseQuery, BROWSE_PAGE_SIZE } = await import('../../src/lib/browse');
const browsePage = await import('../../src/routes/browse/+page.server');
const storySettings =
	await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');

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

// A published, public story, listed in Browse unless told otherwise.
async function story(
	title: string,
	options: { owner?: string; listed?: boolean; universe?: string } = {}
) {
	const owner = options.owner ?? author.id;
	const created = await createStoryInUniverse(db, owner, options.universe ?? universeId, title);
	await db
		.update(stories)
		.set({ visibility: 'public', listedInBrowse: options.listed ?? true })
		.where(eq(stories.id, created.id));
	await pool.query(
		`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'Words.')`,
		[created.id]
	);
	const published = await publishStory(db, owner, created.id);
	if (!published.ok) throw new Error(published.reason);
	return { id: created.id, publicationId: published.publicationId };
}

async function titles(search = '') {
	const query = parseBrowseQuery(new URLSearchParams(search));
	const result = await browseStories(db, query, await resolveFilters(db, query));
	return result.books.map((book) => book.title);
}

async function writers(search: string) {
	const query = parseBrowseQuery(new URLSearchParams(search));
	return browseAuthors(db, query, await resolveFilters(db, query));
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
});

describe('who appears', () => {
	it('lists only current editions of public, listed stories by authors in good standing', async () => {
		await story('Listed');
		await story('Not listed', { listed: false });
		const unlisted = await story('Unlisted');
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, unlisted.id));
		const down = await story('Taken down');
		await takedownPublication(db, down.publicationId, null, 'other');
		const blocked = await story('Blocked');
		await db.update(stories).set({ browseBlockedAt: new Date() }).where(eq(stories.id, blocked.id));
		const trashed = await story('Trashed');
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, trashed.id));

		const hidden = await user('hidden@example.com', { handle: 'hidden', hiddenFromBrowse: true });
		const [hiddenUniverse] = await db
			.insert(universes)
			.values({ ownerId: hidden.id, name: 'H' })
			.returning();
		await story('Opted out', { owner: hidden.id, universe: hiddenUniverse.id });
		const suspended = await user('sus@example.com', { handle: 'sus' });
		const [susUniverse] = await db
			.insert(universes)
			.values({ ownerId: suspended.id, name: 'S' })
			.returning();
		await story('Suspended', { owner: suspended.id, universe: susUniverse.id });
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, suspended.id));

		expect(await titles()).toEqual(['Listed']);
	});

	it('leaves out private stories, trashed universes, owners leaving, and editions of a story given away', async () => {
		await story('Listed');
		const hidden = await story('Private');
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, hidden.id));

		const [binned] = await db
			.insert(universes)
			.values({ ownerId: author.id, name: 'Binned' })
			.returning();
		await story('In a trashed universe', { universe: binned.id });
		await db.update(universes).set({ deletedAt: new Date() }).where(eq(universes.id, binned.id));

		const leaving = await user('leaving@example.com', { handle: 'leaving' });
		const [leavingUniverse] = await db
			.insert(universes)
			.values({ ownerId: leaving.id, name: 'L' })
			.returning();
		await story('Owner leaving', { owner: leaving.id, universe: leavingUniverse.id });
		await db.update(users).set({ deletionScheduledAt: new Date() }).where(eq(users.id, leaving.id));

		// The edition was published by its old owner; the story now belongs to
		// someone else, so the old edition is not theirs to list.
		const other = await user('other@example.com', { handle: 'other' });
		const moved = await story('Given away');
		await db.update(stories).set({ ownerId: other.id }).where(eq(stories.id, moved.id));

		expect(await titles()).toEqual(['Listed']);
	});

	it('leaves authors who opted out of Browse, or are leaving, out of Writers', async () => {
		await story('Shown');
		const hidden = await user('quiet@example.com', {
			handle: 'quiet',
			penName: 'Ada Quiet',
			hiddenFromBrowse: true
		});
		const [quietUniverse] = await db
			.insert(universes)
			.values({ ownerId: hidden.id, name: 'Q' })
			.returning();
		await story('Quiet one', { owner: hidden.id, universe: quietUniverse.id });
		const leaving = await user('gone@example.com', { handle: 'gone', penName: 'Ada Gone' });
		const [goneUniverse] = await db
			.insert(universes)
			.values({ ownerId: leaving.id, name: 'G' })
			.returning();
		await story('Going', { owner: leaving.id, universe: goneUniverse.id });
		await db.update(users).set({ deletionScheduledAt: new Date() }).where(eq(users.id, leaving.id));
		expect((await writers('q=ada')).map((row) => row.handle)).toEqual(['teller']);
	});

	it('hides adult work unless asked, and names the author and universe', async () => {
		const adult = await story('Grown');
		await db.update(stories).set({ isAdult: true }).where(eq(stories.id, adult.id));
		await publishStory(db, author.id, adult.id);
		await story('Plain');
		expect(await titles()).toEqual(['Plain']);
		const query = parseBrowseQuery(new URLSearchParams('adult=show'));
		const { books } = await browseStories(db, query, await resolveFilters(db, query));
		expect(books.map((book) => book.title)).toEqual(['Plain', 'Grown']);
		expect(books[0]).toMatchObject({
			handle: 'teller',
			byline: 'Ada Teller',
			universe: { name: 'Ardenfall', slug: 'ardenfall' }
		});
	});
});

describe('search and filters', () => {
	it('searches titles, authors and universe names, and finds authors', async () => {
		await story('The Bell');
		const other = await user('b@example.com', { handle: 'bea', displayName: 'Bea' });
		const [standalone] = await db
			.insert(universes)
			.values({ ownerId: other.id, name: 'Ardenfall too', standalone: true })
			.returning();
		await story('Quiet Hours', { owner: other.id, universe: standalone.id });
		expect(await titles('q=bell')).toEqual(['The Bell']);
		expect(await titles('q=teller')).toEqual(['The Bell']);
		// A standalone story's hidden universe is not searched.
		expect(await titles('q=ardenfall')).toEqual(['The Bell']);
		expect(await titles('q=100%25')).toEqual([]);
		expect(await writers('q=bea')).toEqual([{ handle: 'bea', name: 'Bea', stories: 1 }]);
	});

	it('does not match the account name of an author who uses a pen name', async () => {
		await story('The Bell');
		// The author's display name is "author"; readers only see "Ada Teller".
		expect(await titles('q=author')).toEqual([]);
		expect(await writers('q=author')).toEqual([]);
		expect(await writers('q=ada')).toEqual([{ handle: 'teller', name: 'Ada Teller', stories: 1 }]);
	});

	it('leaves authors with only adult stories out of Writers unless adult work is shown', async () => {
		const grown = await story('Grown');
		await db
			.update(publications)
			.set({ isAdult: true })
			.where(eq(publications.id, grown.publicationId));
		expect(await writers('q=ada')).toEqual([]);
		expect(await writers('q=ada&adult=show')).toHaveLength(1);
	});

	it('counts only the stories the other filters let through in Writers', async () => {
		await addListEntries(db, 'genre', 'Fantasy');
		await addListEntries(db, 'warning', 'Death');
		const { rows } = await pool.query('select id, kind from tags');
		const id = (kind: string) => rows.find((row) => row.kind === kind).id as string;
		const a = await story('A');
		const b = await story('B');
		await story('C');
		await setStoryList(db, a.id, 'genre', [id('genre')]);
		await setStoryList(db, b.id, 'genre', [id('genre')]);
		await setStoryList(db, b.id, 'warning', [id('warning')]);
		expect(await writers('q=ada')).toEqual([{ handle: 'teller', name: 'Ada Teller', stories: 3 }]);
		expect(await writers('q=ada&genre=fantasy')).toEqual([
			{ handle: 'teller', name: 'Ada Teller', stories: 2 }
		]);
		expect(await writers('q=ada&genre=fantasy&hide=death')).toEqual([
			{ handle: 'teller', name: 'Ada Teller', stories: 1 }
		]);
		expect(await writers('q=ada&genre=nothing')).toEqual([]);
	});

	it('filters by genre, following merges, and hides chosen warnings', async () => {
		await addListEntries(db, 'genre', 'Fantasy\nHigh fantasy\nHorror');
		await addListEntries(db, 'warning', 'Death');
		const [fantasy, high, death] = await Promise.all(
			['fantasy', 'high-fantasy', 'death'].map(async (slug) => {
				const { rows } = await pool.query('select id from tags where slug = $1', [slug]);
				return rows[0].id as string;
			})
		);
		const a = await story('A');
		const b = await story('B');
		await story('C');
		await setStoryList(db, a.id, 'genre', [fantasy]);
		await setStoryList(db, b.id, 'genre', [high]);
		await setStoryList(db, b.id, 'warning', [death]);
		expect(await titles('genre=fantasy')).toEqual(['A']);
		await mergeTag(db, 'genre', high, 'Fantasy');
		expect((await titles('genre=fantasy')).sort()).toEqual(['A', 'B']);
		// The old slug lands on the surviving genre too.
		expect((await titles('genre=high-fantasy')).sort()).toEqual(['A', 'B']);
		expect(await titles('genre=horror')).toEqual([]);
		expect(await titles('genre=nothing')).toEqual([]);
		expect((await titles('hide=death')).sort()).toEqual(['A', 'C']);
	});

	it("matches a fandom given by the story's universe", async () => {
		await addListEntries(db, 'fandom', 'Discworld');
		const { rows } = await pool.query("select id from tags where slug = 'discworld'");
		await story('Inherits');
		await db.update(universes).set({ fandomId: rows[0].id }).where(eq(universes.id, universeId));
		expect(await titles('fandom=discworld')).toEqual(['Inherits']);
	});

	it('hides a story whose edition carried a warning even if the story no longer does', async () => {
		await addListEntries(db, 'warning', 'Death');
		const { rows } = await pool.query("select id from tags where slug = 'death'");
		const s = await story('Frozen');
		await setStoryList(db, s.id, 'warning', [rows[0].id]);
		await publishStory(db, author.id, s.id);
		await setStoryList(db, s.id, 'warning', []);
		expect(await titles('hide=death')).toEqual([]);
	});

	it('hides a story whose edition froze the name of a warning since merged into the hidden one', async () => {
		await addListEntries(db, 'warning', 'Death\nCharacter death');
		const { rows } = await pool.query("select id, slug from tags where kind = 'warning'");
		const id = (slug: string) => rows.find((row) => row.slug === slug).id as string;
		const s = await story('Frozen');
		await setStoryList(db, s.id, 'warning', [id('character-death')]);
		await publishStory(db, author.id, s.id);
		await mergeTag(db, 'warning', id('character-death'), 'Death');
		await setStoryList(db, s.id, 'warning', []);
		expect(await titles()).toEqual(['Frozen']);
		expect(await titles('hide=death')).toEqual([]);
		// The old slug resolves to the survivor and hides it too.
		expect(await titles('hide=character-death')).toEqual([]);
	});

	it('hides a story whose edition carried a warning since renamed', async () => {
		await addListEntries(db, 'warning', 'Gore');
		const { rows } = await pool.query("select id from tags where slug = 'gore'");
		const s = await story('Frozen');
		await setStoryList(db, s.id, 'warning', [rows[0].id]);
		await publishStory(db, author.id, s.id);
		await renameTag(db, 'warning', rows[0].id, 'Graphic violence');
		await setStoryList(db, s.id, 'warning', []);
		expect(await titles('hide=graphic-violence')).toEqual([]);
	});

	it('matches an edition from before warning ids were frozen by name', async () => {
		await addListEntries(db, 'warning', 'Death');
		const s = await story('Older');
		// An older edition carries the names alone.
		await pool.query(
			`update publications set content_warnings = '{Death}', content_warning_ids = '{}' where story_id = $1`,
			[s.id]
		);
		expect(await titles('hide=death')).toEqual([]);
	});

	it('hides an edition from before ids were frozen by the name of a warning since merged into the hidden one', async () => {
		await addListEntries(db, 'warning', 'Death\nCharacter death');
		const { rows } = await pool.query("select id from tags where slug = 'character-death'");
		const s = await story('Older');
		await pool.query(
			`update publications set content_warnings = '{Character death}', content_warning_ids = '{}' where story_id = $1`,
			[s.id]
		);
		await mergeTag(db, 'warning', rows[0].id, 'Death');
		expect(await titles()).toEqual(['Older']);
		expect(await titles('hide=death')).toEqual([]);
	});

	it('pages newest first with a keyset cursor', async () => {
		for (let i = 0; i < BROWSE_PAGE_SIZE + 2; i++) await story(`S${i}`);
		const first = parseBrowseQuery(new URLSearchParams(''));
		const page1 = await browseStories(db, first, await resolveFilters(db, first));
		expect(page1.books).toHaveLength(BROWSE_PAGE_SIZE);
		expect(page1.books[0].title).toBe(`S${BROWSE_PAGE_SIZE + 1}`);
		expect(page1.next).not.toBeNull();
		const second = parseBrowseQuery(new URLSearchParams(`after=${page1.next}`));
		const page2 = await browseStories(db, second, await resolveFilters(db, second));
		expect(page2.books.map((book) => book.title)).toEqual(['S1', 'S0']);
		expect(page2.next).toBeNull();
	});
});

describe('paging within one millisecond', () => {
	it('neither skips nor repeats editions published in the same millisecond', async () => {
		for (let i = 0; i < BROWSE_PAGE_SIZE + 2; i++) await story(`M${i}`);
		// Microseconds apart, all inside one millisecond.
		await pool.query(`
			update publications p set published_at = '2026-01-01 00:00:00.123'::timestamptz
				+ (r.n * interval '1 microsecond')
			from (select id, row_number() over (order by published_at) as n from publications) r
			where r.id = p.id
		`);
		const seen: string[] = [];
		let search = '';
		for (let guard = 0; guard < 3; guard++) {
			const query = parseBrowseQuery(new URLSearchParams(search));
			const page = await browseStories(db, query, await resolveFilters(db, query));
			seen.push(...page.books.map((book) => book.title));
			if (!page.next) break;
			search = `after=${page.next}`;
		}
		expect(seen).toHaveLength(BROWSE_PAGE_SIZE + 2);
		expect(new Set(seen).size).toBe(BROWSE_PAGE_SIZE + 2);
	});

	it('takes the largest cursor the parser allows without an error', async () => {
		await story('Any');
		const query = parseBrowseQuery(
			new URLSearchParams('after=999999999999999999_00000000-0000-4000-8000-000000000000')
		);
		expect(query.after).not.toBeNull();
		const page = await browseStories(db, query, await resolveFilters(db, query));
		expect(page.books.map((book) => book.title)).toEqual(['Any']);
	});
});

describe('listing and moderation', () => {
	it('lists only a public story, and keeps a removed one off until allowed', async () => {
		const mod = await user('mod@example.com', { role: 'moderator' });
		const s = await story('Toll', { listed: false });
		const listed = async () =>
			(await db.select().from(stories).where(eq(stories.id, s.id)))[0].listedInBrowse;
		await saveStoryVisibility(db, s.id, 'unlisted', false, true);
		expect(await listed()).toBe(false);
		await saveStoryVisibility(db, s.id, 'public', false, true);
		expect(await listed()).toBe(true);
		// With Browse off the box is hidden, so the stored choice is kept.
		await saveStoryVisibility(db, s.id, 'public', false, null);
		expect(await listed()).toBe(true);

		await createReport(db, s.publicationId, 'spam', '');
		await createReport(db, s.publicationId, 'illegal', '');
		const [acted] = await db
			.select()
			.from(publicationReports)
			.where(eq(publicationReports.reason, 'spam'));
		expect(await removeFromBrowse(db, s.id, mod.id, 'spam', acted.id)).toBe(true);
		expect(await removeFromBrowse(db, s.id, mod.id, 'spam')).toBe(false);
		const [row] = await db.select().from(stories).where(eq(stories.id, s.id));
		expect(row).toMatchObject({ listedInBrowse: false, browseBlockedReason: 'spam' });
		// Only the report acted on closes; the other may still need a takedown.
		const reports = await db.select().from(publicationReports);
		expect(reports.find((r) => r.id === acted.id)?.resolution).toBe('removed_from_browse');
		expect(reports.find((r) => r.id !== acted.id)?.resolvedAt).toBeNull();
		// The pages stay up.
		const [edition] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, s.publicationId));
		expect(edition.removedAt).toBeNull();

		await saveStoryVisibility(db, s.id, 'public', false, true);
		expect(await listed()).toBe(false);
		expect(await allowInBrowse(db, s.id, null)).toBe(true);
		// Allowing it again does not list it for the author.
		expect(await listed()).toBe(false);
		await saveStoryVisibility(db, s.id, 'public', false, true);
		expect(await listed()).toBe(true);
		// Leaving public clears the listing.
		await saveStoryVisibility(db, s.id, 'private', false, null);
		expect(await listed()).toBe(false);
	});
});

describe('the visibility form', () => {
	function save(storyId: string, fields: Record<string, string>) {
		const body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		return storySettings.actions.setVisibility({
			request: new Request('http://localhost/', { method: 'POST', body }),
			params: { id: storyId },
			locals: { user: author, session: null }
		} as never);
	}
	const row = async (id: string) => (await db.select().from(stories).where(eq(stories.id, id)))[0];

	it('keeps the stored Browse choice while Browse is off, since the box is not shown', async () => {
		const s = await story('Kept');
		expect(await save(s.id, { visibility: 'public' })).toMatchObject({ saved: true });
		expect(await row(s.id)).toMatchObject({ visibility: 'public', listedInBrowse: true });
		// Leaving public clears the choice, so coming back does not list it again.
		expect(await save(s.id, { visibility: 'unlisted' })).toMatchObject({ saved: true });
		expect(await row(s.id)).toMatchObject({ visibility: 'unlisted', listedInBrowse: false });
		await save(s.id, { visibility: 'public' });
		expect((await row(s.id)).listedInBrowse).toBe(false);
	});

	it('saves the Browse box while Browse is on, and refuses an unknown visibility', async () => {
		await saveBrowseEnabled(db, true);
		const s = await story('Toggled', { listed: false });
		await save(s.id, { visibility: 'public', listedInBrowse: 'on' });
		expect((await row(s.id)).listedInBrowse).toBe(true);
		await save(s.id, { visibility: 'public' });
		expect((await row(s.id)).listedInBrowse).toBe(false);
		expect(await save(s.id, { visibility: 'everyone' })).toMatchObject({ status: 400 });
		expect((await row(s.id)).visibility).toBe('public');
	});
});

describe('the page', () => {
	const load = (search = '') =>
		browsePage.load({
			url: new URL(`http://localhost/browse${search}`),
			getClientAddress: () => '203.0.113.9',
			setHeaders: () => {}
		} as never);

	it('does not exist while Browse is off', async () => {
		await story('Hidden away');
		try {
			await load();
			expect.unreachable();
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(404);
		}
	});

	it('lists stories once Browse is on, and marks searches noindex', async () => {
		await saveBrowseEnabled(db, true);
		await story('Shown');
		const plain = (await load()) as { books: { title: string }[]; indexable: boolean };
		expect(plain.books.map((book) => book.title)).toEqual(['Shown']);
		expect(plain.indexable).toBe(true);
		expect(((await load('?q=shown')) as { indexable: boolean }).indexable).toBe(false);
		// A filter naming nothing that exists is an empty page, kept out of search engines.
		expect(((await load('?tag=no-such-tag')) as { indexable: boolean }).indexable).toBe(false);
	});

	it('names a filter by the surviving entry when it came in by a merged slug', async () => {
		await saveBrowseEnabled(db, true);
		await addListEntries(db, 'genre', 'Sci-fi\nScience fiction');
		const [{ id }] = (await pool.query("select id from tags where slug = 'sci-fi'")).rows;
		await mergeTag(db, 'genre', id, 'Science fiction');
		const shown = await story('Far Off');
		await setStoryList(db, shown.id, 'genre', [id]);
		const result = (await load('?genre=sci-fi')) as {
			resolved: { genre: string | null };
			indexable: boolean;
		};
		expect(result.resolved.genre).toBe('science-fiction');
		expect(result.indexable).toBe(true);
	});

	it('does not reveal a tag that only private stories carry', async () => {
		await saveBrowseEnabled(db, true);
		const hidden = await story('Draft', { listed: false });
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, hidden.id));
		const checked = await checkTagNames(db, ['Project Nightjar']);
		if (!checked.ok) throw new Error(checked.message);
		await setStoryTags(db, hidden.id, checked.tags);
		const result = (await load('?tag=project-nightjar')) as {
			filters: { tag: unknown };
			indexable: boolean;
		};
		expect(result.filters.tag).toBeNull();
		expect(result.indexable).toBe(false);
	});

	it('limits how many pages one address can load', async () => {
		await saveBrowseEnabled(db, true);
		for (let i = 0; i < 120; i++) await load('?genre=none');
		await expect(load('?genre=none')).rejects.toMatchObject({ status: 429 });
	});
});

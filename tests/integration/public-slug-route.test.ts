import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The public loaders, called as the router would, so the redirect status and
// target are checked end to end against the database.
vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { publishStory } = await import('../../src/lib/server/publish');
const { saveStoryDetails } = await import('../../src/lib/server/story-details');
const { saveUniverseDetails } = await import('../../src/lib/server/universe-details');
const storyPage = await import('../../src/routes/@[handle]/[story=ref]/+page.server');
const universePage =
	await import('../../src/routes/@[handle]/universes/[universe=ref]/+page.server');
const shelfPage = await import('../../src/routes/@[handle]/+page.server');

let ownerId: string;
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table slug_history, publication_assets, publications, scenes, chapters, stories, universes, users cascade'
	);
	const [owner] = await db
		.insert(users)
		.values({
			email: 'route@example.com',
			displayName: 'R',
			passwordHash: 'x',
			role: 'user',
			handle: 'inkwright',
			publicArchiveEnabled: true
		})
		.returning();
	ownerId = owner.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId, name: 'Ember Reach', slug: 'ember-reach' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId, title: 'Ember', slug: 'ember', visibility: 'public' })
		.returning();
	storyId = story.id;
	await db.insert(scenes).values({ storyId, globalPosition: 1, bodyMd: 'The gate opened.' });
	await publishStory(db, ownerId, storyId);
});

afterAll(async () => {
	await pool.end();
});

// What a loader threw or returned: a redirect, an error status, or data.
// Headers it set ride along on a redirect, where the cache rule matters.
async function outcome(run: (setHeaders: (h: Record<string, string>) => void) => unknown) {
	const headers: Record<string, string> = {};
	const setHeaders = (h: Record<string, string>) => Object.assign(headers, h);
	try {
		return { data: await run(setHeaders) };
	} catch (thrown) {
		const t = thrown as { status?: number; location?: string };
		if (t.location) return { status: t.status, location: t.location, headers };
		return { status: t.status, location: t.location };
	}
}

const loadStory = (story: string, search = '') =>
	outcome((setHeaders) =>
		storyPage.load({
			params: { handle: 'inkwright', story },
			url: new URL(`http://localhost/@inkwright/${story}${search}`),
			setHeaders
		} as never)
	);

const loadUniverse = (universe: string, search = '') =>
	outcome((setHeaders) =>
		universePage.load({
			params: { handle: 'inkwright', universe },
			url: new URL(`http://localhost/@inkwright/universes/${universe}${search}`),
			setHeaders
		} as never)
	);

const loadShelf = (handle: string, user: { id: string } | null = null) =>
	outcome(() =>
		shelfPage.load({
			params: { handle },
			url: new URL(`http://localhost/@${handle}`),
			locals: { user }
		} as never)
	);

const noCache = { 'cache-control': 'no-cache' };

async function renameStory(title: string) {
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
	await saveStoryDetails(db, ownerId, story, {
		title,
		author: null,
		brief: null,
		descriptionMd: null,
		styleNotes: null,
		coverColor: null
	});
}

async function renameUniverse(name: string) {
	const [universe] = await db.select().from(universes).where(eq(universes.id, universeId));
	await saveUniverseDetails(db, ownerId, universe, {
		name,
		descriptionMd: null,
		establishedSetting: false
	});
}

describe('old slugs on the public pages', () => {
	it('redirects an old story slug permanently, keeping the query', async () => {
		await renameStory('Ember Rising');
		expect(await loadStory('ember', '?adult=ok')).toEqual({
			status: 308,
			location: '/@inkwright/ember-rising?adult=ok',
			headers: noCache
		});
		expect(await loadStory('ember-rising')).toHaveProperty('data');
	});

	it('404s an old slug of an unlisted story rather than giving its id away', async () => {
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		await saveStoryDetails(db, ownerId, story, {
			title: 'Ember Rising',
			author: null,
			brief: null,
			descriptionMd: null,
			styleNotes: null,
			coverColor: null
		});
		await db.update(stories).set({ visibility: 'unlisted' }).where(eq(stories.id, storyId));
		expect(await loadStory('ember')).toEqual({ status: 404, location: undefined });
	});

	it('redirects an old universe slug permanently', async () => {
		await renameUniverse('Far Shore');
		expect(await loadUniverse('ember-reach', '?ref=news')).toEqual({
			status: 308,
			location: '/@inkwright/universes/far-shore?ref=news',
			headers: noCache
		});
		expect(await loadUniverse('never-was')).toEqual({ status: 404, location: undefined });
	});
});

describe('a rename back to an old slug', () => {
	// A browser that kept the first redirect would loop once the server sends
	// the reverse one, so neither may be cached.
	it('turns the story redirect around, uncached both ways', async () => {
		await renameStory('Ember Rising');
		expect(await loadStory('ember')).toEqual({
			status: 308,
			location: '/@inkwright/ember-rising',
			headers: noCache
		});
		await renameStory('Ember');
		expect(await loadStory('ember')).toHaveProperty('data');
		expect(await loadStory('ember-rising')).toEqual({
			status: 308,
			location: '/@inkwright/ember',
			headers: noCache
		});
	});

	it('turns the universe redirect around, uncached both ways', async () => {
		await renameUniverse('Far Shore');
		await renameUniverse('Ember Reach');
		expect(await loadUniverse('ember-reach')).toHaveProperty('data');
		expect(await loadUniverse('far-shore')).toEqual({
			status: 308,
			location: '/@inkwright/universes/ember-reach',
			headers: noCache
		});
	});
});

describe('addresses typed in another case', () => {
	it('reads a story at its slug or id in upper case', async () => {
		expect(await loadStory('EMBER')).toHaveProperty('data');
		expect(await loadStory(storyId.toUpperCase())).toHaveProperty('data');
	});

	it('redirects an old slug typed in upper case', async () => {
		await renameStory('Ember Rising');
		expect(await loadStory('EMBER')).toEqual({
			status: 308,
			location: '/@inkwright/ember-rising',
			headers: noCache
		});
	});

	it('opens a universe page at its slug or id in upper case', async () => {
		expect(await loadUniverse('EMBER-REACH')).toHaveProperty('data');
		expect(await loadUniverse(universeId.toUpperCase())).toHaveProperty('data');
	});
});

describe('the shelf', () => {
	it('shows a known handle, in any case', async () => {
		expect(await loadShelf('inkwright')).toHaveProperty('data');
		expect(await loadShelf('InkWright')).toHaveProperty('data');
	});

	it('404s a handle nobody holds', async () => {
		expect(await loadShelf('nobody-here')).toEqual({ status: 404, location: undefined });
	});

	it('404s a suspended author, like their story and universe pages', async () => {
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, ownerId));
		expect(await loadShelf('inkwright')).toEqual({ status: 404, location: undefined });
		expect(await loadStory('ember')).toEqual({ status: 404, location: undefined });
		expect(await loadUniverse('ember-reach')).toEqual({ status: 404, location: undefined });
	});
});

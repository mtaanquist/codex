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
async function outcome(run: () => unknown) {
	try {
		return { data: await run() };
	} catch (thrown) {
		const t = thrown as { status?: number; location?: string };
		return { status: t.status, location: t.location };
	}
}

const loadStory = (story: string, search = '') =>
	outcome(() =>
		storyPage.load({
			params: { handle: 'inkwright', story },
			url: new URL(`http://localhost/@inkwright/${story}${search}`)
		} as never)
	);

const loadUniverse = (universe: string) =>
	outcome(() =>
		universePage.load({
			params: { handle: 'inkwright', universe },
			url: new URL(`http://localhost/@inkwright/universes/${universe}`)
		} as never)
	);

describe('old slugs on the public pages', () => {
	it('redirects an old story slug permanently, keeping the query', async () => {
		const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
		await saveStoryDetails(db, ownerId, story, {
			title: 'Ember Rising',
			author: null,
			brief: null,
			descriptionMd: null,
			styleNotes: null,
			coverColor: null
		});
		expect(await loadStory('ember', '?adult=ok')).toEqual({
			status: 308,
			location: '/@inkwright/ember-rising?adult=ok'
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
		const [universe] = await db.select().from(universes).where(eq(universes.id, universeId));
		await saveUniverseDetails(db, ownerId, universe, {
			name: 'Far Shore',
			descriptionMd: null,
			establishedSetting: false
		});
		expect(await loadUniverse('ember-reach')).toEqual({
			status: 308,
			location: '/@inkwright/universes/far-shore'
		});
		expect(await loadUniverse('never-was')).toEqual({ status: 404, location: undefined });
	});
});

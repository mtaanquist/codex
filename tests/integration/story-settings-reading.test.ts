import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The story settings page reads the app's db; point it at the test database.
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
const { createStoryInUniverse } = await import('../../src/lib/server/story-create');
const { publishStory, takedownPublication } = await import('../../src/lib/server/publish');
const settings = await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');

let user: { id: string; displayName: string };
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({
			email: 'reading@example.com',
			displayName: 'R',
			passwordHash: 'x',
			role: 'user',
			handle: 'reader',
			publicArchiveEnabled: true
		})
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	const story = await createStoryInUniverse(db, user.id, universe.id, 'The Toll');
	storyId = story.id;
	await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
	await pool.query(
		`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'The bell rang.')`,
		[storyId]
	);
});

afterAll(async () => {
	await pool.end();
});

async function reading() {
	const data = (await settings.load({
		params: { id: 'the-toll', section: 'publish' },
		locals: { user, session: null }
	} as never)) as { reading: { handle: string; story: string } | null };
	return data.reading;
}

describe('the reading link in story settings', () => {
	it('shows only while readers can open the edition', async () => {
		expect(await reading()).toBeNull();
		const published = await publishStory(db, user.id, storyId);
		if (!published.ok) throw new Error(published.reason);
		expect(await reading()).toEqual({ handle: 'reader', story: 'the-toll' });

		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, user.id));
		expect(await reading()).toBeNull();
		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, user.id));

		expect(await takedownPublication(db, published.publicationId, null, 'other')).toBe(true);
		expect(await reading()).toBeNull();
	});
});

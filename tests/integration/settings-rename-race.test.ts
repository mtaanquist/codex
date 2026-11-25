import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The settings pages read the app's db; point it at the test database.
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
const storySettings =
	await import('../../src/routes/stories/[id]/settings/[[section]]/+page.server');
const universeSettings = await import('../../src/routes/universes/[id]/[[section]]/+page.server');

// A Details field saved while a rename is still in flight was posted before
// the page moved, so it must not depend on the old address (#1667).

let user: { id: string };
let universeId: string;
let storyId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'race@example.com', displayName: 'R', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: user.id, title: 'The Toll', slug: 'the-toll' })
		.returning();
	storyId = story.id;
});

afterAll(async () => {
	await pool.end();
});

function post(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return new Request('http://localhost/', { method: 'POST', body });
}

// Runs an action and returns what it threw (a redirect or an error), if anything.
async function run(action: () => unknown) {
	try {
		return { returned: await action() };
	} catch (thrown) {
		return { thrown: thrown as { status: number; location?: string } };
	}
}

function storyUpdate(ref: string, fields: Record<string, string>) {
	return run(() =>
		storySettings.actions.update({
			request: post(fields),
			params: { id: ref },
			locals: { user, session: null }
		} as never)
	);
}

function universeUpdate(ref: string, fields: Record<string, string>) {
	return run(() =>
		universeSettings.actions.update({
			request: post(fields),
			params: { id: ref },
			locals: { user, session: null }
		} as never)
	);
}

describe('a story Details save racing a rename', () => {
	it('404s at the old slug but saves at the story id', async () => {
		const renamed = await storyUpdate(storyId, { title: 'The Bell' });
		expect(renamed.thrown).toMatchObject({ status: 303, location: '/stories/the-bell/settings' });

		// The address the page had when the second field saved.
		const stale = await storyUpdate('the-toll', { title: 'The Bell', author: 'A. Writer' });
		expect(stale.thrown).toMatchObject({ status: 404 });

		const byId = await storyUpdate(storyId, { title: 'The Bell', author: 'A. Writer' });
		expect(byId.returned).toEqual({ action: 'update', saved: true });
		const [row] = await db.select().from(stories).where(eq(stories.id, storyId));
		expect(row).toMatchObject({ slug: 'the-bell', author: 'A. Writer' });
	});
});

describe('a universe Details save racing a rename', () => {
	it('404s at the old slug but saves at the universe id', async () => {
		const renamed = await universeUpdate(universeId, { name: 'Emberfall' });
		expect(renamed.thrown).toMatchObject({ status: 303, location: '/universes/emberfall' });

		const stale = await universeUpdate('ardenfall', {
			name: 'Emberfall',
			description: 'Ash and bells.'
		});
		expect(stale.thrown).toMatchObject({ status: 404 });

		const byId = await universeUpdate(universeId, {
			name: 'Emberfall',
			description: 'Ash and bells.'
		});
		expect(byId.returned).toEqual({ action: 'update', saved: true });
		const [row] = await db.select().from(universes).where(eq(universes.id, universeId));
		expect(row).toMatchObject({ slug: 'emberfall', descriptionMd: 'Ash and bells.' });
	});
});

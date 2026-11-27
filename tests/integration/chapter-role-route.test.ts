import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { chapters, stories, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// Setting a chapter's role from the outline's chapter menu, through the
// Write page's form action.

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
const writePage = await import('../../src/routes/stories/[id]/+page.server');

let user: { id: string };
let stranger: { id: string };
let storyId: string;
let chapterId: string;

function post(fields: Record<string, string>, as: { id: string }) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/', { method: 'POST', body }),
		params: { id: storyId },
		locals: { user: as, session: null }
	} as never;
}

async function setRole(role: string, as = user) {
	try {
		return await writePage.actions.setChapterRole(post({ chapterId, role }, as));
	} catch (thrown) {
		return thrown;
	}
}

async function storedRole() {
	const [row] = await db
		.select({ role: chapters.role })
		.from(chapters)
		.where(eq(chapters.id, chapterId));
	return row.role;
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table chapters, stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'role@example.com', displayName: 'R', passwordHash: 'x', role: 'user' })
		.returning();
	[stranger] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db.insert(universes).values({ ownerId: user.id, name: 'U' }).returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: user.id, title: 'Roles' })
		.returning();
	storyId = story.id;
	const [chapter] = await db.insert(chapters).values({ storyId, position: 1 }).returning();
	chapterId = chapter.id;
});

afterAll(async () => {
	await pool.end();
});

describe('setChapterRole action', () => {
	it('sets a role and clears it again', async () => {
		expect(await setRole('dedication')).toMatchObject({ status: 303 });
		expect(await storedRole()).toBe('dedication');
		expect(await setRole('')).toMatchObject({ status: 303 });
		expect(await storedRole()).toBeNull();
	});

	it('refuses a role that is not on the list', async () => {
		await setRole('prologue');
		expect(await setRole('interlude')).toMatchObject({ status: 400 });
		expect(await storedRole()).toBe('prologue');
	});

	it("does not change another writer's chapter", async () => {
		expect(await setRole('epilogue', stranger)).toMatchObject({ status: 404 });
		expect(await storedRole()).toBeNull();
	});
});

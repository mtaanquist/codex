import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { tags, universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The known setting (fandom) picked on a new universe and changed on the
// universe's details form.

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
const { addListEntries, setTagRemoved } = await import('../../src/lib/server/tags');
const libraryPage = await import('../../src/routes/+page.server');
const universePage = await import('../../src/routes/universes/[id]/[[section]]/+page.server');

let user: { id: string; displayName: string };
let universeId: string;

function post(fields: Record<string, string>, params: Record<string, string> = {}) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/', { method: 'POST', body }),
		params,
		locals: { user, session: null }
	} as never;
}

async function fandomId(name: string) {
	const [row] = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, name));
	return row.id;
}

async function universeRow(id = universeId) {
	const [row] = await db.select().from(universes).where(eq(universes.id, id));
	return row;
}

// Runs an action that ends in a redirect and returns where it went.
async function redirected(run: unknown) {
	try {
		await run;
	} catch (err) {
		if (isRedirect(err)) return err.location;
		throw err;
	}
	throw new Error('expected a redirect');
}

const update = (fields: Record<string, string>) =>
	universePage.actions.update(post({ name: 'Ardenfall', ...fields }, { id: universeId }));

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users, tags cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'fandom@example.com', displayName: 'F', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
	await addListEntries(db, 'fandom', 'Discworld\nForgotten Realms');
});

afterAll(async () => {
	await pool.end();
});

describe('a new universe', () => {
	it('links the fandom picked from the suggestions', async () => {
		const location = await redirected(
			libraryPage.actions.createUniverse(
				post({ name: 'Ankh', fandomId: await fandomId('Discworld') })
			)
		);
		const [made] = await db.select().from(universes).where(eq(universes.name, 'Ankh'));
		expect(location).toBe(`/universes/${made.slug}`);
		expect(made).toMatchObject({ fandomId: await fandomId('Discworld'), establishedSetting: true });
	});

	it('is still made, unlinked, when the fandom is no longer on the list or not an id', async () => {
		const gone = await fandomId('Discworld');
		await setTagRemoved(db, 'fandom', gone, true, user.id);
		await redirected(libraryPage.actions.createUniverse(post({ name: 'Ankh', fandomId: gone })));
		await redirected(libraryPage.actions.createUniverse(post({ name: 'Moria', fandomId: 'x' })));
		const made = await db.select().from(universes).where(eq(universes.ownerId, user.id));
		expect(made.map((row) => [row.name, row.fandomId]).sort()).toEqual([
			['Ankh', null],
			['Ardenfall', null],
			['Moria', null]
		]);
	});
});

describe('the universe details form', () => {
	it('links a fandom and ticks Established setting, even with the box left unticked', async () => {
		expect(await update({ fandomId: await fandomId('Discworld') })).toMatchObject({
			saved: true
		});
		expect(await universeRow()).toMatchObject({
			fandomId: await fandomId('Discworld'),
			establishedSetting: true
		});
	});

	it('changes the fandom, unlinks it with an empty field, and keeps it when the field is left out', async () => {
		await update({ fandomId: await fandomId('Discworld') });
		await update({ fandomId: await fandomId('Forgotten Realms'), establishedSetting: 'on' });
		expect((await universeRow()).fandomId).toBe(await fandomId('Forgotten Realms'));
		await update({ establishedSetting: 'on' });
		expect((await universeRow()).fandomId).toBe(await fandomId('Forgotten Realms'));
		await update({ fandomId: '', establishedSetting: 'on' });
		expect(await universeRow()).toMatchObject({ fandomId: null, establishedSetting: true });
	});

	it('refuses a fandom no longer on the list and saves nothing of the form', async () => {
		const gone = await fandomId('Discworld');
		await setTagRemoved(db, 'fandom', gone, true, user.id);
		const result = await universePage.actions.update(
			post({ name: 'Renamed', fandomId: gone }, { id: universeId })
		);
		expect(result).toMatchObject({ status: 400 });
		expect(await universeRow()).toMatchObject({ name: 'Ardenfall', fandomId: null });
		expect(await update({ fandomId: 'not-an-id' })).toMatchObject({ status: 400 });
	});

	it('keeps a link to a fandom removed since, when the form does not change it', async () => {
		await update({ fandomId: await fandomId('Discworld') });
		await setTagRemoved(db, 'fandom', await fandomId('Discworld'), true, user.id);
		expect(
			await update({ fandomId: await fandomId('Discworld'), establishedSetting: 'on' })
		).toMatchObject({ saved: true });
		expect((await universeRow()).fandomId).toBe(await fandomId('Discworld'));
	});
});

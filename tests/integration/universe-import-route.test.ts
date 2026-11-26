import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { strToU8, zipSync } from 'fflate';
import { universes, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The universe page actions read the app's db; point it at the test database.
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
const { resetRateLimits } = await import('#lib/server/rate-limit');
const page = await import('../../src/routes/universes/[id]/[[section]]/+page.server');

let user: { id: string };
let universeId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	resetRateLimits();
	await pool.query('truncate table stories, universes, users cascade');
	[user] = await db
		.insert(users)
		.values({ email: 'import@example.com', displayName: 'I', passwordHash: 'x', role: 'user' })
		.returning();
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: user.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	universeId = universe.id;
});

afterAll(async () => {
	await pool.end();
});

function epub(): Uint8Array {
	return zipSync({
		'META-INF/container.xml': strToU8('<container><rootfile full-path="c.opf"/></container>'),
		'c.opf': strToU8(
			'<package><metadata><dc:title>Toll</dc:title></metadata>' +
				'<manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>'
		),
		'a.xhtml': strToU8('<html><body><h1>One</h1><p>Text.</p></body></html>')
	});
}

function call(action: 'previewImport' | 'runImport', file?: File) {
	const form = new FormData();
	if (file) form.set('archive', file);
	return page.actions[action]({
		params: { id: universeId },
		locals: { user, session: null },
		request: new Request('http://localhost/', { method: 'POST', body: form })
	} as never) as Promise<
		{ status?: number; data?: { message?: string } } & Record<string, unknown>
	>;
}

describe('universe import actions', () => {
	it('stop one writer previewing and importing in a loop', async () => {
		const book = () => new File([epub() as BlobPart], 'toll.epub');
		const preview = await call('previewImport', book());
		expect(preview).toMatchObject({ action: 'import', preview: expect.anything() });
		for (let i = 1; i < 60; i++) {
			expect((await call('previewImport')).status).toBe(400);
		}

		const refused = await call('previewImport', book());
		expect(refused.status).toBe(429);
		expect(refused.data?.message).toMatch(/Too many imports/);
		expect((await call('runImport', book())).status).toBe(429);
	});
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { entitlements, plans, users } from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { MEGABYTE } from '../../src/lib/quota';
import { ensureTestDatabase } from './test-db';

// Admin > Plans, called as the real savePlan action against the test
// database, with the plan read back afterwards.

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
const { createPlan, listPlans } = await import('#lib/server/plans');
const { actions } = await import('../../src/routes/admin/[[section]]/+page.server');

let adminId: string;
let planId: string;

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table users cascade');
	await resetPlans();
	const [admin] = await db
		.insert(users)
		.values({
			email: 'plans-admin@example.com',
			displayName: 'A',
			passwordHash: 'x',
			role: 'admin'
		})
		.returning({ id: users.id });
	adminId = admin.id;
	const created = await createPlan(db, 'Small');
	if (!created.ok) throw new Error(created.reason);
	planId = created.id;
});

afterAll(async () => {
	await resetPlans();
	await pool.end();
});

// Back to what the migration left: one default plan with no limits.
async function resetPlans() {
	await db.delete(entitlements);
	await db.delete(plans).where(sql`${plans.key} <> 'default'`);
	await db.update(plans).set({ isDefault: true, name: 'Default' });
}

function savePlan(fields: Record<string, string>) {
	const form = new FormData();
	form.set('planId', planId);
	form.set('name', 'Small');
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const run = actions.savePlan as (event: unknown) => Promise<unknown>;
	return run({
		request: { formData: async () => form },
		locals: { user: { id: adminId, role: 'admin' } }
	});
}

async function limits() {
	return (await listPlans(db)).find((plan) => plan.id === planId)!.limits;
}

describe('savePlan: largest image', () => {
	it('stores a size in MB, and blank clears it back to the ceiling', async () => {
		expect(await savePlan({ maxImageMb: '2' })).toMatchObject({ saved: true });
		expect((await limits()).max_image_bytes).toBe(2 * MEGABYTE);
		expect(await savePlan({ maxImageMb: '' })).toMatchObject({ saved: true });
		expect((await limits()).max_image_bytes).toBeNull();
	});

	it('refuses a size above the 10 MB ceiling and says why', async () => {
		await savePlan({ maxImageMb: '4' });
		const result = await savePlan({ maxImageMb: '11' });
		expect(result).toMatchObject({ status: 400, data: { scope: 'plans', planId } });
		expect((result as { data: { message: string } }).data.message).toContain('from 0 to 10');
		expect((await limits()).max_image_bytes).toBe(4 * MEGABYTE);
	});

	it('leaves the other limits as they were saved', async () => {
		await savePlan({ maxStories: '3', storageMb: '50', maxImageMb: '1' });
		expect(await limits()).toEqual({
			max_universes: null,
			max_stories: 3,
			storage_bytes: 50 * MEGABYTE,
			max_image_bytes: MEGABYTE
		});
	});
});

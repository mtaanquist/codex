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
		expect((result as { data: { message: string } }).data.message).toContain('from 0.1 to 10');
		expect((await limits()).max_image_bytes).toBe(4 * MEGABYTE);
	});

	it('stores a size under 1 MB to one decimal place', async () => {
		expect(await savePlan({ maxImageMb: '0.4', storageMb: '0.5' })).toMatchObject({
			saved: true
		});
		expect(await limits()).toMatchObject({
			max_image_bytes: Math.round(0.4 * MEGABYTE),
			storage_bytes: Math.round(0.5 * MEGABYTE)
		});
		expect(await savePlan({ maxImageMb: '0.45' })).toMatchObject({ status: 400 });
	});

	it('refuses 0, which would refuse every image', async () => {
		expect(await savePlan({ maxImageMb: '0' })).toMatchObject({ status: 400 });
		expect((await limits()).max_image_bytes).toBeNull();
	});

	it('keeps a size set to the byte when the form is saved unchanged', async () => {
		await db.insert(entitlements).values([
			{ planId, key: 'max_image_bytes', value: 1000 },
			{ planId, key: 'storage_bytes', value: 2_500_000 }
		]);
		// What the form posts untouched: the rounded MB text and the stored bytes.
		expect(
			await savePlan({
				maxImageMb: '0.1',
				maxImageBytes: '1000',
				storageMb: '2.4',
				storageBytes: '2500000'
			})
		).toMatchObject({ saved: true });
		expect(await limits()).toMatchObject({ max_image_bytes: 1000, storage_bytes: 2_500_000 });
		// An edited field is saved as typed.
		await savePlan({ maxImageMb: '0.2', maxImageBytes: '1000', storageBytes: '2500000' });
		expect(await limits()).toMatchObject({
			max_image_bytes: Math.round(0.2 * MEGABYTE),
			storage_bytes: null
		});
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

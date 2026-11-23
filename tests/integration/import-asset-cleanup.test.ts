import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import { assets, scenes, stories, universes, users } from '../../src/lib/server/db/schema';
import type { AssetConfig, AssetObjectStore } from '../../src/lib/server/assets';
import type { ImportPlan } from '../../src/lib/import-markdown';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// An import that fails after storing some of its images must delete them and
// give their bytes back, wherever the failure happens. Object storage here is
// an in-memory store whose second write fails.

const objects = new Map<string, Buffer>();
let puts = 0;
const store: AssetObjectStore = {
	async put(key, body) {
		puts += 1;
		if (puts === 2) throw new Error('storage went away');
		objects.set(key, body);
	},
	async upload() {
		throw new Error('not used');
	},
	async get() {
		throw new Error('not used');
	},
	async remove(key) {
		objects.delete(key);
	}
};
const config: AssetConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-assets',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};

vi.mock('../../src/lib/server/assets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/server/assets')>();
	return {
		...actual,
		effectiveAssetConfig: async () => config,
		s3AssetStore: () => store
	};
});

vi.mock('../../src/lib/server/jobs', () => ({ queueUniverseMentions: async () => {} }));

const { runImport } = await import('../../src/lib/server/import-story');

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let universeId: string;

// A PNG signature padded to the size wanted.
function png(bytes: number) {
	const out = new Uint8Array(bytes);
	out.set(Buffer.from('89504e470d0a1a0a', 'hex'));
	return out;
}

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');
	objects.clear();
	puts = 0;
	const [owner] = await db
		.insert(users)
		.values({ email: 'import@example.com', displayName: 'I', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [universe] = await db.insert(universes).values({ ownerId, name: 'World' }).returning();
	universeId = universe.id;
});

afterAll(async () => {
	await pool.end();
});

describe('runImport', () => {
	it('deletes the images it stored when a later image fails', async () => {
		const plan: ImportPlan = {
			story: { title: 'Maps', author: null, brief: null, descriptionMd: '' },
			chapters: [],
			unfiled: [{ title: null, status: null, bodyMd: '![a](assets/a.png)' }],
			notes: [],
			assets: [
				{ id: 'assets/a.png', path: 'assets/a.png', bytes: png(100) },
				{ id: 'assets/b.png', path: 'assets/b.png', bytes: png(200) }
			],
			problems: []
		};
		await expect(runImport(db, { id: universeId, ownerId }, plan)).rejects.toThrow(
			'storage went away'
		);
		expect(await db.select().from(assets)).toHaveLength(0);
		expect(await db.select().from(stories)).toHaveLength(0);
		const [row] = await db
			.select({ used: users.storageUsedBytes })
			.from(users)
			.where(eq(users.id, ownerId));
		expect(row.used).toBe(0);
	});

	// The commit lands but its reply is lost (the connection drops): the
	// story is there, so its images must stay.
	it('keeps the images when the story committed though the write reported an error', async () => {
		let calls = 0;
		const lossy = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
				return async (...args: Parameters<Database['transaction']>) => {
					const result = await target.transaction(...args);
					// The image's own upload is the first transaction; the story
					// write is the second.
					calls += 1;
					if (calls === 2) throw new Error('Connection terminated unexpectedly');
					return result;
				};
			}
		}) as Database;
		const oldId = '6f1c2a9e-0b7d-4c3e-9a51-2d8e4f6a7b10';
		const plan: ImportPlan = {
			story: { title: 'Maps', author: null, brief: null, descriptionMd: '' },
			chapters: [],
			unfiled: [{ title: null, status: null, bodyMd: `![a](assets/${oldId}.png)` }],
			notes: [],
			assets: [{ id: oldId, path: `assets/${oldId}.png`, bytes: png(100) }],
			problems: []
		};
		const result = await runImport(lossy, { id: universeId, ownerId }, plan);

		const [story] = await db.select().from(stories);
		expect(result).toMatchObject({ storyId: story.id, slug: story.slug, sceneCount: 1 });
		const [image] = await db.select().from(assets);
		expect(image).toBeDefined();
		const [scene] = await db.select().from(scenes).where(eq(scenes.storyId, story.id));
		expect(scene.bodyMd).toContain(`/assets/${image.id}`);
		expect(objects.size).toBe(1);
	});
});

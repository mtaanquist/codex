import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import {
	assets,
	publicationReports,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import type { Role } from '../../src/lib/roles';
import { ensureTestDatabase } from './test-db';

// The image route (/assets/<id>): who may fetch an uploaded image and how
// long the answer may be cached.

vi.mock('#lib/server/db', async () => {
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { createPool } = await import('../../src/lib/server/db/pool');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = createPool(TEST_DATABASE_URL);
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});

// The bucket, in memory: every key holds BYTES except MISSING_KEY.
const BYTES = Buffer.from('PNGBYTES');
const MISSING_KEY = 'codex-assets/gone';
vi.mock('#lib/server/assets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/server/assets')>();
	return {
		...actual,
		effectiveAssetConfig: async () => ({ region: 'auto', bucket: 'test', prefix: '' }),
		s3AssetStore: () => ({
			async get(key: string) {
				if (key === MISSING_KEY) throw new actual.ObjectNotFoundError(key);
				return Readable.from([BYTES]);
			}
		})
	};
});

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { publishStory, takedownPublication } = await import('#lib/server/publish');
const { createReport, dismissReport } = await import('#lib/server/reports');
const route = await import('../../src/routes/assets/[id=uuid]/+server');

let authorId: string;
let assetId: string;
let publicationId: string;

async function user(email: string, role: Role) {
	const [row] = await db
		.insert(users)
		.values({ email, displayName: email, passwordHash: 'x', role })
		.returning();
	return row;
}

async function fetchAsset(who: { id: string; role: Role } | null, id = assetId): Promise<Response> {
	try {
		return (await route.GET({
			params: { id },
			locals: { user: who, session: null }
		} as never)) as Response;
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (typeof status === 'number') return new Response(null, { status });
		throw err;
	}
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table publication_assets, publications, assets, scenes, chapters, stories, universes, users cascade'
	);
	const [author] = await db
		.insert(users)
		.values({
			email: 'author@example.com',
			displayName: 'Author',
			passwordHash: 'x',
			role: 'user',
			handle: 'inkwright',
			publicArchiveEnabled: true
		})
		.returning();
	authorId = author.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: authorId, name: 'U' })
		.returning();
	const [story] = await db
		.insert(stories)
		.values({ universeId: universe.id, ownerId: authorId, title: 'Shown', visibility: 'public' })
		.returning();
	const [asset] = await db
		.insert(assets)
		.values({
			ownerId: authorId,
			universeId: universe.id,
			kind: 'inline',
			filename: 'sketch.png',
			contentType: 'image/png',
			byteSize: BYTES.length,
			storageKey: 'codex-assets/sketch'
		})
		.returning();
	assetId = asset.id;
	await db.insert(scenes).values({
		storyId: story.id,
		globalPosition: 1,
		bodyMd: `A picture: ![sketch](/assets/${asset.id})`
	});
	const published = await publishStory(db, authorId, story.id);
	if (!published.ok) throw new Error(published.reason);
	publicationId = published.publicationId;
});

afterAll(async () => {
	await pool.end();
});

describe('the image route', () => {
	it('serves an image of a live edition to anyone, with the public cache header', async () => {
		const response = await fetchAsset(null);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=300, must-revalidate');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
	});

	it('serves the owner their own image with the long private cache header', async () => {
		const response = await fetchAsset({ id: authorId, role: 'user' });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
	});

	it('answers 404 for an unknown id, or an image whose file is gone from storage', async () => {
		expect((await fetchAsset(null, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
		await pool.query('update assets set storage_key = $1 where id = $2', [MISSING_KEY, assetId]);
		expect((await fetchAsset(null)).status).toBe(404);
		expect((await fetchAsset({ id: authorId, role: 'user' })).status).toBe(404);
	});

	it("shows a taken-down edition's image to a moderator only, and never caches it", async () => {
		await takedownPublication(db, publicationId, null, 'other');
		const writer = await user('writer@example.com', 'user');
		expect((await fetchAsset(null)).status).toBe(404);
		expect((await fetchAsset({ id: writer.id, role: 'user' })).status).toBe(404);
		for (const role of ['moderator', 'admin'] as const) {
			const moderator = await user(`${role}@example.com`, role);
			const response = await fetchAsset({ id: moderator.id, role });
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('private, no-store');
		}
	});

	it("shows a private story's image to a moderator only while it has an open report", async () => {
		const moderator = await user('moderator@example.com', 'moderator');
		const asModerator = { id: moderator.id, role: 'moderator' as const };
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		await pool.query(`update stories set visibility = 'private'`);
		expect((await fetchAsset(null)).status).toBe(404);
		expect((await fetchAsset(asModerator)).status).toBe(200);
		const [report] = await db.select().from(publicationReports);
		expect(await dismissReport(db, report.id, moderator.id)).toBe(true);
		expect((await fetchAsset(asModerator)).status).toBe(404);
	});

	it("does not show an image only in a private story's newer edition that a takedown also put down", async () => {
		const moderator = await user('moderator@example.com', 'moderator');
		const asModerator = { id: moderator.id, role: 'moderator' as const };
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		// The newer edition has a second image the reported one does not.
		const [first] = await db.select().from(assets);
		const [extra] = await db
			.insert(assets)
			.values({
				...first,
				id: undefined,
				filename: 'second.png',
				storageKey: 'codex-assets/second'
			})
			.returning();
		await pool.query(`update scenes set body_md = $1`, [`Another: ![second](/assets/${extra.id})`]);
		const [story] = await db.select().from(stories);
		const newer = await publishStory(db, authorId, story.id);
		if (!newer.ok) throw new Error(newer.reason);
		await pool.query(`update stories set visibility = 'private'`);
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		expect((await fetchAsset(asModerator)).status).toBe(200);
		expect((await fetchAsset(asModerator, extra.id)).status).toBe(404);
	});
});

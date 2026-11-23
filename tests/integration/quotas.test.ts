import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	assets,
	characters,
	entitlements,
	plans,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	createAsset,
	deleteAsset,
	ObjectNotFoundError,
	setUserAvatar,
	type AssetConfig,
	type AssetObjectStore
} from '../../src/lib/server/assets';
import {
	accountLimits,
	holdCountQuota,
	QuotaExceededError,
	recountStorageUsed
} from '../../src/lib/server/quotas';
import {
	createPlan,
	listAccountUsage,
	listPlans,
	savePlan,
	setDefaultPlan,
	setUserPlan
} from '../../src/lib/server/plans';
import {
	createStoryInUniverse,
	createUniverse,
	standaloneUniverse
} from '../../src/lib/server/story-create';
import { restoreStory, trashStory } from '../../src/lib/server/story-lifecycle';
import { setEntityBadgeImage } from '../../src/lib/server/entity-badge';
import {
	purgeUniverse,
	restoreUniverse,
	trashUniverse
} from '../../src/lib/server/universe-lifecycle';
import { newStoryFromDraft, saveDraft } from '../../src/lib/server/story-drafts';
import { sweepUnusedAssets } from '../../src/lib/server/unused-assets';
import { previewImport, runImport } from '../../src/lib/server/import-story';
import type { ImportPlan } from '../../src/lib/import-markdown';
import { MAX_IMAGE_BYTES, MEGABYTE, NO_LIMITS, type Limits } from '../../src/lib/quota';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

let pool: pg.Pool;
let db: Database;
let ownerId: string;
let otherId: string;
let defaultPlanId: string;

const config: AssetConfig = {
	endpoint: undefined,
	region: 'auto',
	bucket: 'test',
	prefix: 'codex-assets',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};

function memoryStore() {
	const objects = new Map<string, Buffer>();
	const store: AssetObjectStore = {
		async put(key, body) {
			objects.set(key, body);
		},
		async upload() {
			throw new Error('not used');
		},
		async get(key) {
			const body = objects.get(key);
			if (!body) throw new ObjectNotFoundError(key);
			return Readable.from(body);
		},
		async remove(key) {
			objects.delete(key);
		}
	};
	return { store, objects };
}

// A PNG signature padded to the size wanted.
function png(bytes: number) {
	const out = Buffer.alloc(bytes);
	Buffer.from('89504e470d0a1a0a', 'hex').copy(out);
	return out;
}

async function planWith(limits: Partial<Limits>) {
	const created = await createPlan(db, `Plan ${Math.random()}`);
	if (!created.ok) throw new Error(created.reason);
	const saved = await savePlan(db, created.id, {
		name: 'Limited',
		limits: { ...NO_LIMITS, ...limits }
	});
	if (!saved.ok) throw new Error(saved.reason);
	return created.id;
}

async function limitOwner(limits: Partial<Limits>) {
	await setUserPlan(db, ownerId, await planWith(limits));
}

async function used(userId = ownerId) {
	const [row] = await db
		.select({ used: users.storageUsedBytes })
		.from(users)
		.where(eq(users.id, userId));
	return row.used;
}

async function universe(name = 'World') {
	return createUniverse(db, ownerId, name);
}

const importPlan = (title: string): ImportPlan => ({
	story: { title, author: null, brief: null, descriptionMd: '' },
	chapters: [],
	unfiled: [{ title: null, status: null, bodyMd: 'Prose.' }],
	notes: [],
	assets: [],
	problems: []
});

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 6 });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');
	// Back to what the migration left: one default plan with no limits.
	await db.delete(entitlements);
	await db.delete(plans).where(sql`${plans.key} <> 'default'`);
	await db.update(plans).set({ isDefault: true, name: 'Default' });
	const [row] = await db.select({ id: plans.id }).from(plans);
	defaultPlanId = row.id;
	const [owner] = await db
		.insert(users)
		.values({ email: 'quota@example.com', displayName: 'Q', passwordHash: 'x', role: 'user' })
		.returning();
	ownerId = owner.id;
	const [other] = await db
		.insert(users)
		.values({ email: 'other@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
		.returning();
	otherId = other.id;
});

afterAll(async () => {
	await pool.query('truncate table assets, pending_object_deletions, universes, users cascade');
	await db.delete(entitlements);
	await db.delete(plans).where(sql`${plans.key} <> 'default'`);
	await db.update(plans).set({ isDefault: true, name: 'Default' });
	await pool.end();
});

describe('plans', () => {
	it('starts every account on a default plan with no limits', async () => {
		const listed = await listPlans(db);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ key: 'default', isDefault: true, accounts: 2 });
		expect(await accountLimits(db, ownerId)).toEqual(NO_LIMITS);
	});

	it('falls back to the default plan, and an account plan wins over it', async () => {
		await savePlan(db, defaultPlanId, {
			name: 'Default',
			limits: { ...NO_LIMITS, max_universes: 5 }
		});
		const own = await planWith({ max_stories: 2 });
		await setUserPlan(db, ownerId, own);
		expect(await accountLimits(db, otherId)).toEqual({ ...NO_LIMITS, max_universes: 5 });
		expect(await accountLimits(db, ownerId)).toEqual({ ...NO_LIMITS, max_stories: 2 });
		await setUserPlan(db, ownerId, null);
		expect((await accountLimits(db, ownerId)).max_universes).toBe(5);
	});

	it('clears a limit back to no limit', async () => {
		const id = await planWith({ max_stories: 2, storage_bytes: 1000 });
		await savePlan(db, id, { name: 'Open', limits: { ...NO_LIMITS, storage_bytes: 1000 } });
		const plan = (await listPlans(db)).find((p) => p.id === id);
		expect(plan).toMatchObject({ name: 'Open', limits: { ...NO_LIMITS, storage_bytes: 1000 } });
	});

	it('keeps exactly one default', async () => {
		const id = await planWith({});
		expect(await setDefaultPlan(db, id)).toBe(true);
		const defaults = (await listPlans(db)).filter((p) => p.isDefault);
		expect(defaults.map((p) => p.id)).toEqual([id]);
		expect(await setDefaultPlan(db, '00000000-0000-4000-8000-000000000000')).toBe(false);
	});

	it('refuses a plan that does not exist for an account', async () => {
		expect(await setUserPlan(db, ownerId, '00000000-0000-4000-8000-000000000000')).toBe(false);
	});

	it('refuses a blank name', async () => {
		expect(await createPlan(db, '   ')).toMatchObject({ ok: false, code: 'invalid' });
	});
});

describe('universe and story limits', () => {
	it('refuses a universe past the limit and counts only live ones', async () => {
		await limitOwner({ max_universes: 1 });
		const first = await universe('One');
		await expect(universe('Two')).rejects.toBeInstanceOf(QuotaExceededError);
		await trashUniverse(db, ownerId, first.id);
		const second = await universe('Two');
		// Restoring the first would make two.
		await expect(restoreUniverse(db, ownerId, first.id)).rejects.toThrow(/^Restoring this/);
		await trashUniverse(db, ownerId, second.id);
		expect(await restoreUniverse(db, ownerId, first.id)).toBe(true);
	});

	it('never counts the standalone universe', async () => {
		await limitOwner({ max_universes: 1 });
		await standaloneUniverse(db, ownerId);
		await expect(universe('One')).resolves.toBeTruthy();
	});

	it('refuses a story past the limit across every create path', async () => {
		await limitOwner({ max_stories: 1 });
		const world = await universe();
		const first = await createStoryInUniverse(db, ownerId, world.id, 'First');
		await expect(createStoryInUniverse(db, ownerId, world.id, 'Second')).rejects.toBeInstanceOf(
			QuotaExceededError
		);

		await expect(runImport(db, world, importPlan('Imported'))).rejects.toBeInstanceOf(
			QuotaExceededError
		);

		await db.insert(scenes).values({ storyId: first.id, globalPosition: 1, bodyMd: 'Text.' });
		const draft = await saveDraft(db, ownerId, first.id, { label: 'Take', note: '' });
		if (!draft.ok) throw new Error(draft.reason);
		const [row] = await db.select().from(stories).where(eq(stories.id, first.id));
		expect(await newStoryFromDraft(db, ownerId, row, draft.id, 'Copy')).toMatchObject({
			ok: false,
			code: 'over_limit'
		});

		const titles = await db.select({ title: stories.title }).from(stories);
		expect(titles.map((t) => t.title)).toEqual(['First']);
	});

	it('frees a place when a story goes to the trash, and checks the restore', async () => {
		await limitOwner({ max_stories: 1 });
		const world = await universe();
		const first = await createStoryInUniverse(db, ownerId, world.id, 'First');
		await trashStory(db, ownerId, first.id);
		await createStoryInUniverse(db, ownerId, world.id, 'Second');
		await expect(restoreStory(db, ownerId, first.id)).rejects.toBeInstanceOf(QuotaExceededError);
		const [still] = await db
			.select({ deletedAt: stories.deletedAt })
			.from(stories)
			.where(eq(stories.id, first.id));
		expect(still.deletedAt).not.toBeNull();
	});

	it('counts the stories a restored universe brings back', async () => {
		await limitOwner({ max_stories: 2 });
		const old = await universe('Old');
		await createStoryInUniverse(db, ownerId, old.id, 'A');
		await createStoryInUniverse(db, ownerId, old.id, 'B');
		await trashUniverse(db, ownerId, old.id);
		const fresh = await universe('Fresh');
		await createStoryInUniverse(db, ownerId, fresh.id, 'C');
		await expect(restoreUniverse(db, ownerId, old.id)).rejects.toThrow(/2 stories/);
	});

	it('does not bring a trashed standalone universe back past the limit', async () => {
		await limitOwner({ max_stories: 3 });
		const solo = await standaloneUniverse(db, ownerId);
		await createStoryInUniverse(db, ownerId, solo.id, 'A');
		await createStoryInUniverse(db, ownerId, solo.id, 'B');
		await trashUniverse(db, ownerId, solo.id);
		const world = await universe();
		await createStoryInUniverse(db, ownerId, world.id, 'C');
		await expect(standaloneUniverse(db, ownerId)).rejects.toBeInstanceOf(QuotaExceededError);
		await expect(standaloneUniverse(db, ownerId)).rejects.toThrow(
			/standalone stories are in the trash/
		);
		const [still] = await db
			.select({ deletedAt: universes.deletedAt })
			.from(universes)
			.where(eq(universes.id, solo.id));
		expect(still.deletedAt).not.toBeNull();
	});

	it('treats a second restore of the same story as done, not over the limit', async () => {
		await limitOwner({ max_stories: 1 });
		const world = await universe();
		const story = await createStoryInUniverse(db, ownerId, world.id, 'Only');
		await trashStory(db, ownerId, story.id);
		const results = await Promise.all([
			restoreStory(db, ownerId, story.id),
			restoreStory(db, ownerId, story.id)
		]);
		expect(results.sort()).toEqual([false, true]);
	});

	it('makes a create wait for one still in flight, then counts it', async () => {
		await limitOwner({ max_stories: 1 });
		const world = await universe();
		let second: Promise<unknown> | undefined;
		let settled = false;
		await db.transaction(async (tx) => {
			await holdCountQuota(tx, ownerId, { stories: 1 });
			await tx.insert(stories).values({ universeId: world.id, ownerId, title: 'First' });
			second = createStoryInUniverse(db, ownerId, world.id, 'Second').finally(() => {
				settled = true;
			});
			second.catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(settled).toBe(false);
		});
		await expect(second).rejects.toBeInstanceOf(QuotaExceededError);
	});

	it('lets only one of two creates at once take the last place', async () => {
		await limitOwner({ max_stories: 1 });
		const world = await universe();
		const results = await Promise.allSettled([
			createStoryInUniverse(db, ownerId, world.id, 'Left'),
			createStoryInUniverse(db, ownerId, world.id, 'Right'),
			createStoryInUniverse(db, ownerId, world.id, 'Middle')
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		for (const r of results.filter((r) => r.status === 'rejected')) {
			expect((r as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceededError);
		}
	});

	it('takes no lock and refuses nothing on a plan without limits', async () => {
		const world = await universe();
		for (let i = 0; i < 5; i++) await createStoryInUniverse(db, ownerId, world.id, `S${i}`);
		await expect(holdCountQuota(db, ownerId, { universes: 50, stories: 50 })).resolves.toBe(
			undefined
		);
	});
});

describe('storage', () => {
	it('counts uploads and takes deletes back off', async () => {
		const { store } = memoryStore();
		const a = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'avatar',
			filename: 'a.png',
			contentType: 'image/png',
			bytes: png(300)
		});
		expect(a.ok).toBe(true);
		expect(await used()).toBe(300);
		if (a.ok) await deleteAsset(db, ownerId, a.id);
		expect(await used()).toBe(0);
	});

	it('refuses an upload past the limit and leaves nothing in the bucket', async () => {
		await limitOwner({ storage_bytes: 500 });
		const { store, objects } = memoryStore();
		const input = {
			universeId: null,
			kind: 'inline' as const,
			filename: 'a.png',
			contentType: 'image/png'
		};
		expect((await createAsset(db, store, config, ownerId, { ...input, bytes: png(400) })).ok).toBe(
			true
		);
		const over = await createAsset(db, store, config, ownerId, { ...input, bytes: png(200) });
		expect(over).toMatchObject({ ok: false, code: 'over_limit' });
		expect(over.ok === false && over.reason).toContain('500 bytes of uploaded images');
		expect(objects.size).toBe(1);
		expect(await used()).toBe(400);
	});

	it('lets only one of two uploads at once take the last of the space', async () => {
		await limitOwner({ storage_bytes: 500 });
		const { store, objects } = memoryStore();
		const upload = () =>
			createAsset(db, store, config, ownerId, {
				universeId: null,
				kind: 'inline',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: png(300)
			});
		const results = await Promise.all([upload(), upload(), upload()]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(await used()).toBe(300);
		expect(objects.size).toBe(1);
		expect(await db.select().from(assets)).toHaveLength(1);
	});

	// A replaced avatar, badge or cover stays until the unused image sweep
	// frees it, so it still counts in the usage. The swap itself counts it as
	// freed, so a writer at the limit can still swap, once.
	it('lets a writer at the limit replace an avatar or badge', async () => {
		await limitOwner({ storage_bytes: 500 });
		const { store } = memoryStore();
		const image = { filename: 'a.png', contentType: 'image/png', bytes: png(400) };
		expect((await setUserAvatar(db, store, config, ownerId, image)).ok).toBe(true);
		expect((await setUserAvatar(db, store, config, ownerId, image)).ok).toBe(true);
		// Above the limit until the sweep frees the old one.
		expect(await used()).toBe(800);
		// The old avatar is already counted as freed, so a second swap is not.
		expect(await setUserAvatar(db, store, config, ownerId, image)).toMatchObject({
			ok: false,
			code: 'over_limit'
		});
		expect(await used()).toBe(800);

		await limitOwner({ storage_bytes: 1200 });
		const world = await universe();
		const [character] = await db
			.insert(characters)
			.values({ universeId: world.id, ownerId, name: 'Aldric' })
			.returning({ id: characters.id });
		expect((await setEntityBadgeImage(db, store, config, ownerId, character.id, image)).ok).toBe(
			true
		);
		expect(await used()).toBe(1200);
		expect((await setEntityBadgeImage(db, store, config, ownerId, character.id, image)).ok).toBe(
			true
		);
		expect(await used()).toBe(1600);
		// Nor is a second badge swap while the first old badge still counts.
		expect(
			await setEntityBadgeImage(db, store, config, ownerId, character.id, image)
		).toMatchObject({ ok: false, code: 'over_limit' });
		expect(await used()).toBe(1600);
		// A new image with nothing to replace still has to fit.
		expect(
			await createAsset(db, store, config, ownerId, {
				universeId: null,
				kind: 'inline',
				filename: 'b.png',
				contentType: 'image/png',
				bytes: png(10)
			})
		).toMatchObject({ ok: false, code: 'over_limit' });
		expect(await db.select().from(assets)).toHaveLength(4);
	});

	it('counts a replaced cover as freed, but only one the writer owns', async () => {
		await limitOwner({ storage_bytes: 500 });
		const { store } = memoryStore();
		const upload = (userId: string, bytes: number, replaces?: string) =>
			createAsset(db, store, config, userId, {
				universeId: null,
				kind: 'cover',
				filename: 'c.png',
				contentType: 'image/png',
				bytes: png(bytes),
				replaces
			});
		const first = await upload(ownerId, 400);
		if (!first.ok) throw new Error('expected an upload');
		expect((await upload(ownerId, 300)).ok).toBe(false);
		const second = await upload(ownerId, 300, first.id);
		if (!second.ok) throw new Error('expected a swap');
		expect(await used()).toBe(700);
		// The old cover still counts, so swapping again at the limit is refused.
		expect(await upload(ownerId, 300, second.id)).toMatchObject({
			ok: false,
			code: 'over_limit'
		});
		expect(await used()).toBe(700);
		const theirs = await upload(otherId, 400);
		if (!theirs.ok) throw new Error('expected an upload');
		await limitOwner({ storage_bytes: 800 });
		expect((await upload(ownerId, 300, theirs.id)).ok).toBe(false);
	});

	it('checks an upload against the plan as it is when the file lands', async () => {
		const { store } = memoryStore();
		const id = await planWith({ storage_bytes: 100 });
		await setUserPlan(db, ownerId, id);
		const lands = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'inline',
			filename: 'a.png',
			contentType: 'image/png',
			bytes: png(50)
		});
		expect(lands.ok).toBe(true);
		await savePlan(db, id, { name: 'Tight', limits: { ...NO_LIMITS, storage_bytes: 60 } });
		const refused = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'inline',
			filename: 'b.png',
			contentType: 'image/png',
			bytes: png(20)
		});
		expect(refused).toMatchObject({ ok: false, code: 'over_limit' });
	});

	it("refuses an image over the plan's per-image limit, naming it", async () => {
		await limitOwner({ max_image_bytes: 2 * MEGABYTE });
		const { store, objects } = memoryStore();
		const upload = (bytes: number) =>
			createAsset(db, store, config, ownerId, {
				universeId: null,
				kind: 'inline',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: png(bytes)
			});
		const refused = await upload(2 * MEGABYTE + 1);
		expect(refused).toMatchObject({ ok: false, code: 'over_limit' });
		expect(!refused.ok && refused.reason).toContain('limit of 2 MB per image');
		expect(objects.size).toBe(0);
		expect(await used()).toBe(0);
		expect((await upload(2 * MEGABYTE)).ok).toBe(true);
		// Another account on the default plan is not held to it.
		const other = await createAsset(db, store, config, otherId, {
			universeId: null,
			kind: 'inline',
			filename: 'b.png',
			contentType: 'image/png',
			bytes: png(2 * MEGABYTE + 1)
		});
		expect(other.ok).toBe(true);
	});

	it('names the images an import will skip for the per-image limit', async () => {
		await limitOwner({ max_image_bytes: MEGABYTE });
		const world = await universe();
		const plan = importPlan('Pictures');
		plan.assets = [
			{ id: 'a', path: 'assets/small.png', bytes: png(MEGABYTE) },
			{ id: 'b', path: 'assets/big.png', bytes: png(MEGABYTE + 1) }
		];
		const preview = await previewImport(db, world, plan);
		expect(preview.problems).toEqual([
			'The image assets/big.png is larger than 1 MB and will not be imported.'
		]);
	});

	it('warns before an import when its images do not fit in the storage left', async () => {
		await limitOwner({ storage_bytes: 10_000 });
		await pool.query('update users set storage_used_bytes = 4000 where id = $1', [ownerId]);
		const world = await universe();
		const plan = importPlan('Pictures');
		plan.assets = [
			{ id: 'a', path: 'assets/one.png', bytes: png(3000) },
			{ id: 'b', path: 'assets/two.png', bytes: png(3000) }
		];
		expect((await previewImport(db, world, plan)).problems).toEqual([]);
		plan.assets.push({ id: 'c', path: 'assets/three.png', bytes: png(2000) });
		expect((await previewImport(db, world, plan)).problems).toEqual([
			'The images in this file take 7.8 KB, but you have 5.9 KB of image storage left. Images that do not fit will not be imported.'
		]);
	});

	it('keeps the 10 MB ceiling when a plan sets a higher per-image limit', async () => {
		await limitOwner({ max_image_bytes: 50 * MEGABYTE });
		const { store } = memoryStore();
		const result = await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'inline',
			filename: 'a.png',
			contentType: 'image/png',
			bytes: png(MAX_IMAGE_BYTES + 1)
		});
		expect(result).toMatchObject({ ok: false, code: 'invalid' });
	});

	it('holds avatars and badges to the per-image limit too', async () => {
		await limitOwner({ max_image_bytes: 1000 });
		const { store } = memoryStore();
		const image = { filename: 'a.png', contentType: 'image/png', bytes: png(1001) };
		expect(await setUserAvatar(db, store, config, ownerId, image)).toMatchObject({
			ok: false,
			code: 'over_limit'
		});
		const world = await universe();
		const [character] = await db
			.insert(characters)
			.values({ universeId: world.id, ownerId, name: 'Aldric' })
			.returning({ id: characters.id });
		expect(
			await setEntityBadgeImage(db, store, config, ownerId, character.id, image)
		).toMatchObject({ ok: false, code: 'over_limit' });
	});

	it('takes a purged universe off its owner', async () => {
		const { store } = memoryStore();
		const world = await universe();
		await createAsset(db, store, config, ownerId, {
			universeId: world.id,
			kind: 'cover',
			filename: 'c.png',
			contentType: 'image/png',
			bytes: png(250)
		});
		await trashUniverse(db, ownerId, world.id);
		// The trash keeps the images until the purge.
		expect(await used()).toBe(250);
		// The purge leaves the images for the unused image sweep, which frees
		// them once they have been unused, and uploaded, long enough ago.
		await purgeUniverse(db, world.id);
		expect(await used()).toBe(250);
		const longAgo = new Date(Date.now() - 60 * 86_400_000);
		await db.update(assets).set({ createdAt: longAgo, unreferencedSince: longAgo });
		await sweepUnusedAssets(db);
		expect(await used()).toBe(0);
	});

	it('recounts from the asset rows', async () => {
		const { store } = memoryStore();
		await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'avatar',
			filename: 'a.png',
			contentType: 'image/png',
			bytes: png(120)
		});
		await db.update(users).set({ storageUsedBytes: 99_999 });
		await recountStorageUsed(db);
		expect(await used()).toBe(120);
		expect(await used(otherId)).toBe(0);
	});
});

describe('account usage', () => {
	it('lists live counts and storage for each account', async () => {
		const { store } = memoryStore();
		const world = await universe();
		const trashed = await universe('Gone');
		await trashUniverse(db, ownerId, trashed.id);
		await createStoryInUniverse(db, ownerId, world.id, 'Kept');
		const binned = await createStoryInUniverse(db, ownerId, world.id, 'Binned');
		await trashStory(db, ownerId, binned.id);
		await createStoryInUniverse(db, ownerId, (await standaloneUniverse(db, ownerId)).id, 'Solo');
		await createAsset(db, store, config, ownerId, {
			universeId: null,
			kind: 'avatar',
			filename: 'a.png',
			contentType: 'image/png',
			bytes: png(64)
		});
		const usage = await listAccountUsage(db);
		expect(usage.find((u) => u.id === ownerId)).toMatchObject({
			planId: null,
			universes: 1,
			stories: 2,
			storageBytes: 64
		});
		expect(usage.find((u) => u.id === otherId)).toMatchObject({
			universes: 0,
			stories: 0,
			storageBytes: 0
		});
		expect(await db.select().from(universes)).toHaveLength(3);
	});
});

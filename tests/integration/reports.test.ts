import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	notifications,
	publicationReports,
	publications,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// Reports on published stories: the reader's form, the queue's actions, and
// who hears about a report.

vi.mock('#lib/server/db', async () => {
	const { default: pgModule } = await import('pg');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schemaModule = await import('../../src/lib/server/db/schema');
	const { TEST_DATABASE_URL } = await import('./test-db');
	const testPool = new pgModule.Pool({ connectionString: TEST_DATABASE_URL });
	return { db: drizzle(testPool, { schema: schemaModule }), pool: testPool };
});
vi.mock('#lib/server/jobs', () => ({
	queueNotificationDigest: vi.fn(async () => undefined),
	queueReviewerDigest: vi.fn(async () => undefined)
}));

const { db, pool } = (await import('#lib/server/db')) as unknown as {
	db: Database;
	pool: pg.Pool;
};
const { resetRateLimits } = await import('#lib/server/rate-limit');
const { createStoryInUniverse } = await import('../../src/lib/server/story-create');
const { publishStory, restorePublication, takedownPublication } =
	await import('../../src/lib/server/publish');
const { createReport, dismissReport, listOpenReports, countOpenReports } =
	await import('../../src/lib/server/reports');
const reportPage = await import('../../src/routes/@[handle]/[story=ref]/report/+page.server');

let author: { id: string };
let publicationId: string;

async function user(email: string, role: 'admin' | 'moderator' | 'user', extra = {}) {
	const [row] = await db
		.insert(users)
		.values({ email, displayName: email.split('@')[0], passwordHash: 'x', role, ...extra })
		.returning();
	return row;
}

beforeAll(async () => {
	await ensureTestDatabase();
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query('truncate table stories, universes, users cascade');
	resetRateLimits();
	author = await user('author@example.com', 'user', {
		handle: 'teller',
		publicArchiveEnabled: true
	});
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: author.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	const story = await createStoryInUniverse(db, author.id, universe.id, 'The Toll');
	await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, story.id));
	await pool.query(
		`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'The bell rang.')`,
		[story.id]
	);
	const published = await publishStory(db, author.id, story.id);
	if (!published.ok) throw new Error(published.reason);
	publicationId = published.publicationId;
});

afterAll(async () => {
	await pool.end();
});

function report(fields: Record<string, string>, ip = '203.0.113.9', story = 'the-toll') {
	const url = new URL(`http://localhost/@teller/${story}/report`);
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return (reportPage.actions.default as (e: unknown) => Promise<unknown>)({
		params: { handle: 'teller', story },
		url,
		request: new Request(url, { method: 'POST', body: form }),
		getClientAddress: () => ip
	});
}

describe('createReport', () => {
	it('stores the report and tells admins and moderators, not writers or suspended moderators', async () => {
		const admin = await user('admin@example.com', 'admin');
		const mod = await user('mod@example.com', 'moderator');
		const gone = await user('gone@example.com', 'moderator', { suspendedAt: new Date() });

		await createReport(db, publicationId, 'spam', '  It is an advert.  ');

		const open = await listOpenReports(db);
		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({
			reason: 'spam',
			comment: 'It is an advert.',
			title: 'The Toll'
		});
		const told = (await db.select().from(notifications)).map((row) => row.userId).sort();
		expect(told).toEqual([admin.id, mod.id].sort());
		expect(told).not.toContain(gone.id);
		expect(told).not.toContain(author.id);
	});

	it('keeps an empty comment as null and caps a long one', async () => {
		await createReport(db, publicationId, 'other', '   ');
		await createReport(db, publicationId, 'other', 'x'.repeat(900));
		const rows = await db.select().from(publicationReports).orderBy(publicationReports.createdAt);
		expect(rows[0].comment).toBeNull();
		expect(rows[1].comment).toHaveLength(500);
	});
});

describe('the queue', () => {
	it('a takedown closes every open report on the edition and records the reason', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await createReport(db, publicationId, 'copyright', '');
		await createReport(db, publicationId, 'spam', '');
		expect(await countOpenReports(db)).toBe(2);

		expect(await takedownPublication(db, publicationId, mod.id, 'copyright')).toBe(true);
		expect(await countOpenReports(db)).toBe(0);
		const closed = await db.select().from(publicationReports);
		expect(
			closed.every((row) => row.resolution === 'taken_down' && row.resolvedBy === mod.id)
		).toBe(true);
		const [edition] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, publicationId));
		expect(edition).toMatchObject({ removedBy: mod.id, removedReason: 'copyright' });
	});

	it('taking down a superseded edition also takes down the current one', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await createReport(db, publicationId, 'copyright', '');
		const [{ storyId }] = await db
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		const again = await publishStory(db, author.id, storyId);
		if (!again.ok) throw new Error(again.reason);

		expect(await takedownPublication(db, publicationId, mod.id, 'copyright')).toBe(true);
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows.every((row) => row.removedAt !== null && row.removedReason === 'copyright')).toBe(
			true
		);
		expect(await countOpenReports(db)).toBe(0);
	});

	it('taking down the current edition closes reports on older editions too', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await createReport(db, publicationId, 'spam', '');
		const [{ storyId }] = await db
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		const again = await publishStory(db, author.id, storyId);
		if (!again.ok) throw new Error(again.reason);
		expect(await takedownPublication(db, again.publicationId, mod.id, 'spam')).toBe(true);
		expect(await countOpenReports(db)).toBe(0);
	});

	it('publishing again after a takedown is refused until the edition is restored', async () => {
		const mod = await user('mod@example.com', 'moderator');
		const [{ storyId }] = await db
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		await takedownPublication(db, publicationId, mod.id, 'spam');

		const refused = await publishStory(db, author.id, storyId);
		expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/taken down/) });
		expect(await db.select().from(publications)).toHaveLength(1);

		expect(await restorePublication(db, publicationId)).toBe(true);
		expect(await restorePublication(db, publicationId)).toBe(false);
		expect((await publishStory(db, author.id, storyId)).ok).toBe(true);
	});

	it('dismissing closes one report, once', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await createReport(db, publicationId, 'spam', '');
		const [open] = await listOpenReports(db);
		expect(await dismissReport(db, open.id, mod.id)).toBe(true);
		expect(await dismissReport(db, open.id, mod.id)).toBe(false);
		expect(await countOpenReports(db)).toBe(0);
	});
});

describe('the report form', () => {
	it('files a report for a readable story', async () => {
		expect(await report({ reason: 'labels', comment: 'No warnings at all.' })).toEqual({
			sent: true
		});
		expect(await countOpenReports(db)).toBe(1);
	});

	it('refuses a reason that is not on the list, and a comment that is too long', async () => {
		expect(await report({ reason: 'rude' })).toMatchObject({ status: 400 });
		expect(await report({ reason: 'spam', comment: 'x'.repeat(501) })).toMatchObject({
			status: 400
		});
		expect(await countOpenReports(db)).toBe(0);
	});

	it('limits how many reports come from one address', async () => {
		for (let i = 0; i < 5; i++) expect(await report({ reason: 'spam' })).toEqual({ sent: true });
		expect(await report({ reason: 'spam' })).toMatchObject({ status: 429 });
		expect(await report({ reason: 'spam' }, '198.51.100.1')).toEqual({ sent: true });
	});

	it('is a 404 for a story readers cannot open', async () => {
		await takedownPublication(db, publicationId);
		try {
			await report({ reason: 'spam' });
			throw new Error('expected a 404');
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(404);
		}
	});
});

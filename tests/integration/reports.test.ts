import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
const { listTakenDown, publishStory, restorePublication, takedownPublication } =
	await import('../../src/lib/server/publish');
const { createReport, dismissReport, listOpenReports, countOpenReports } =
	await import('../../src/lib/server/reports');
const { scheduleAccountDeletion, cancelAccountDeletion } =
	await import('../../src/lib/server/account-deletion');
const { sentToken } = await import('./token-helpers');
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

		expect(await createReport(db, publicationId, 'spam', '  It is an advert.  ')).toBe(true);

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

	it('files nothing and tells nobody once the edition is taken down', async () => {
		await user('mod@example.com', 'moderator');
		await takedownPublication(db, publicationId, null, 'spam');
		expect(await createReport(db, publicationId, 'spam', '')).toBe(false);
		expect(await db.select().from(publicationReports)).toHaveLength(0);
		expect(await db.select().from(notifications)).toHaveLength(0);
	});

	it('files nothing once readers can no longer open the edition', async () => {
		const [edition] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, publicationId));
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, edition.storyId));
		expect(await createReport(db, publicationId, 'spam', '')).toBe(false);
		await db
			.update(stories)
			.set({ visibility: 'public', deletedAt: new Date() })
			.where(eq(stories.id, edition.storyId));
		expect(await createReport(db, publicationId, 'spam', '')).toBe(false);
		await db.update(stories).set({ deletedAt: null }).where(eq(stories.id, edition.storyId));
		const newer = await publishStory(db, author.id, edition.storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect(await createReport(db, publicationId, 'spam', '')).toBe(false);
		expect(await db.select().from(publicationReports)).toHaveLength(0);
		expect(await createReport(db, newer.publicationId, 'spam', '')).toBe(true);
	});

	it('a report filed while the writer makes the story private waits and files nothing', async () => {
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query(
				`update stories set visibility = 'private' where id = (select story_id from publications where id = $1)`,
				[publicationId]
			);
			let settled = false;
			const filing = createReport(db, publicationId, 'spam', '').then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await filing).toBe(false);
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
		expect(await db.select().from(publicationReports)).toHaveLength(0);
	});

	for (const [what, statement] of [
		[
			'trashes the universe',
			`update universes set deleted_at = now() where id = (select universe_id from stories where id = (select story_id from publications where id = $1))`
		],
		[
			'is suspended',
			`update users set suspended_at = now() where id = (select owner_id from publications where id = $1)`
		],
		[
			// As a publish does: the story row locked, the edition replaced.
			'publishes a newer edition',
			`with s as (select id from stories where id = (select story_id from publications where id = $1) for update)
			 update publications set is_current = false where id = $1 and exists (select 1 from s)`
		]
	]) {
		it(`a report filed while the writer ${what} waits and files nothing`, async () => {
			const client = await pool.connect();
			try {
				await client.query('begin');
				await client.query(statement, [publicationId]);
				let settled = false;
				const filing = createReport(db, publicationId, 'spam', '').then((value) => {
					settled = true;
					return value;
				});
				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(settled).toBe(false);
				await client.query('commit');
				expect(await filing).toBe(false);
			} finally {
				await client.query('rollback').catch(() => {});
				client.release();
			}
			expect(await db.select().from(publicationReports)).toHaveLength(0);
		});
	}

	it('a report filed while a takedown runs waits for it and files nothing', async () => {
		await user('mod@example.com', 'moderator');
		const client = await pool.connect();
		try {
			// The takedown's own steps: the story lock, the edition, its reports.
			await client.query('begin');
			await client.query(
				'select id from stories where id = (select story_id from publications where id = $1) for update',
				[publicationId]
			);
			await client.query(
				`update publications set removed_at = now(), removed_reason = 'spam' where id = $1`,
				[publicationId]
			);
			await client.query(
				`update publication_reports set resolved_at = now(), resolution = 'taken_down' where resolved_at is null`
			);
			let settled = false;
			const filing = createReport(db, publicationId, 'copyright', '').then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await filing).toBe(false);
		} finally {
			client.release();
		}
		expect(await countOpenReports(db)).toBe(0);
		expect(await db.select().from(notifications)).toHaveLength(0);
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
	async function editionState() {
		const [row] = await db.select().from(publications).where(eq(publications.id, publicationId));
		return { removed: row.removedAt !== null, removedReason: row.removedReason };
	}

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

		expect(await restorePublication(db, publicationId, null)).toBe(true);
		expect(await restorePublication(db, publicationId, null)).toBe(false);
		expect((await publishStory(db, author.id, storyId)).ok).toBe(true);
	});

	it("editions the author's own deletion took down do not hold and cannot be restored", async () => {
		const [{ storyId }] = await db
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		expect(await restorePublication(db, publicationId, null)).toBe(false);
		expect(await cancelAccountDeletion(db, token)).toBe(true);
		expect((await publishStory(db, author.id, storyId)).ok).toBe(true);
	});

	it('a takedown holds an edition hidden by account deletion, and restore waits for the deletion', async () => {
		const mod = await user('mod@example.com', 'moderator');
		const [{ storyId }] = await db
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		expect(await takedownPublication(db, publicationId, mod.id, 'copyright')).toBe(true);
		expect(await restorePublication(db, publicationId, null)).toBe(false);

		expect(await cancelAccountDeletion(db, token)).toBe(true);
		expect((await publishStory(db, author.id, storyId)).ok).toBe(false);
		expect(await restorePublication(db, publicationId, null)).toBe(true);
		// The restore lifts the hold but does not make the edition public; the
		// writer publishes again if they want it back.
		expect(await editionState()).toMatchObject({ removed: true, removedReason: null });
		expect((await publishStory(db, author.id, storyId)).ok).toBe(true);
	});

	it('a takedown from before the deletion stays down after the deletion is cancelled and the edition restored', async () => {
		const mod = await user('mod@example.com', 'moderator');
		expect(await takedownPublication(db, publicationId, mod.id, 'spam')).toBe(true);
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		expect(await cancelAccountDeletion(db, token)).toBe(true);
		expect(await restorePublication(db, publicationId, null)).toBe(true);
		expect(await editionState()).toMatchObject({ removed: true, removedReason: null });
	});

	// Editions hidden by a deletion scheduled before migration 0124 have the
	// flag false: it was added with no backfill.
	async function legacyDeletionHide() {
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		await db
			.update(publications)
			.set({ hiddenByAccountDeletion: false })
			.where(eq(publications.id, publicationId));
		expect(await cancelAccountDeletion(db, token)).toBe(true);
	}

	it('a takedown of an edition hidden by a deletion from before 0124 keeps it down on restore', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await legacyDeletionHide();
		expect(await takedownPublication(db, publicationId, mod.id, 'copyright')).toBe(true);
		expect(await restorePublication(db, publicationId, null)).toBe(true);
		expect(await editionState()).toMatchObject({ removed: true, removedReason: null });
	});

	it('migration 0127 marks only editions down without a takedown reason', async () => {
		const repairSql = readFileSync('drizzle/0127_mark-legacy-deletion-hides.sql', 'utf8');
		const mod = await user('mod@example.com', 'moderator');
		await legacyDeletionHide();
		// A second story, taken down by a moderator while it was up.
		const [universe] = await db
			.insert(universes)
			.values({ ownerId: author.id, name: 'Second', slug: 'second' })
			.returning();
		const story = await createStoryInUniverse(db, author.id, universe.id, 'The Ferry');
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, story.id));
		await pool.query(
			`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'The oars.')`,
			[story.id]
		);
		const second = await publishStory(db, author.id, story.id);
		if (!second.ok) throw new Error(second.reason);
		await takedownPublication(db, second.publicationId, mod.id, 'spam');

		await pool.query(repairSql);
		await takedownPublication(db, publicationId, mod.id, 'copyright');
		expect(await restorePublication(db, publicationId, null)).toBe(true);
		expect(await editionState()).toMatchObject({ removed: true, removedReason: null });
		expect(await restorePublication(db, second.publicationId, null)).toBe(true);
		const [up] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, second.publicationId));
		expect(up).toMatchObject({ removedAt: null, hiddenByAccountDeletion: false });
	});

	it('migration 0127 marks every edition of an owner whose deletion is pending', async () => {
		const repairSql = readFileSync('drizzle/0127_mark-legacy-deletion-hides.sql', 'utf8');
		const mod = await user('mod@example.com', 'moderator');
		const [{ storyId }] = await db
			.select({ storyId: publications.storyId })
			.from(publications)
			.where(eq(publications.id, publicationId));
		// A deletion pending at upgrade time, with the edition taken down while
		// it was pending (before the upgrade, that left the flag false).
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		await takedownPublication(db, publicationId, mod.id, 'copyright');
		await db
			.update(publications)
			.set({ hiddenByAccountDeletion: false })
			.where(eq(publications.storyId, storyId));

		await pool.query(repairSql);
		expect(await cancelAccountDeletion(db, token)).toBe(true);
		expect(await restorePublication(db, publicationId, null)).toBe(true);
		expect(await editionState()).toMatchObject({ removed: true, removedReason: null });
	});

	it('says whether the deletion of a taken-down edition is still pending', async () => {
		const mod = await user('mod@example.com', 'moderator');
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		await takedownPublication(db, publicationId, mod.id, 'spam');
		expect(await listTakenDown(db)).toMatchObject([
			{ id: publicationId, hiddenByAccountDeletion: true, ownerDeletionPending: true }
		]);
		expect(await cancelAccountDeletion(db, token)).toBe(true);
		expect(await listTakenDown(db)).toMatchObject([
			{ id: publicationId, hiddenByAccountDeletion: true, ownerDeletionPending: false }
		]);
	});

	it('a restore that starts while a takedown runs waits, then lifts all of it', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await takedownPublication(db, publicationId, mod.id, 'spam');
		const [edition] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, publicationId));
		const client = await pool.connect();
		try {
			// Another moderator's action in progress holds the story row, as
			// takedownPublication does, and puts down an edition the restore has
			// not seen yet.
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [edition.storyId]);
			await client.query(
				`insert into publications (story_id, owner_id, handle, title, content, is_current, removed_at, removed_reason, taken_down_at)
				 values ($1, $2, 'teller', 'The Toll', '{"chapters":[],"unfiled":[]}', false, now(), 'spam', now())`,
				[edition.storyId, author.id]
			);
			let settled = false;
			const restoring = restorePublication(db, publicationId, null).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await restoring).toBe(true);
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
		// No edition of the story is left down, so the story is not split.
		const rows = await db
			.select()
			.from(publications)
			.where(eq(publications.storyId, edition.storyId));
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.removedReason)).toEqual([null, null]);
	});

	it('a restore waits for a deletion being scheduled, then refuses', async () => {
		const mod = await user('mod@example.com', 'moderator');
		await takedownPublication(db, publicationId, mod.id, 'spam');
		const client = await pool.connect();
		try {
			// A deletion being scheduled holds the account row, as scheduleAccountDeletion does.
			await client.query('begin');
			await client.query(
				`update users set deletion_scheduled_at = now() + interval '7 days' where id = $1`,
				[author.id]
			);
			let settled = false;
			const restoring = restorePublication(db, publicationId, null).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await restoring).toBe(false);
		} finally {
			client.release();
		}
		expect(await editionState()).toMatchObject({ removed: true, removedReason: 'spam' });
	});

	it('says whether the deletion that hid a reported edition is still pending', async () => {
		await createReport(db, publicationId, 'spam', '');
		const token = await sentToken(db, await scheduleAccountDeletion(db, author.id));
		const [pending] = await listOpenReports(db);
		expect(pending).toMatchObject({ editionRemovedReason: null, ownerDeletionPending: true });
		expect(pending.editionRemovedAt).not.toBeNull();

		expect(await cancelAccountDeletion(db, token)).toBe(true);
		const [cancelled] = await listOpenReports(db);
		expect(cancelled).toMatchObject({ editionRemovedReason: null, ownerDeletionPending: false });
		expect(cancelled.editionRemovedAt).not.toBeNull();
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
		await takedownPublication(db, publicationId, null, 'other');
		try {
			await report({ reason: 'spam' });
			throw new Error('expected a 404');
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(404);
		}
	});
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import type pg from 'pg';
import {
	publicationReports,
	publications,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase } from './test-db';

// The moderation pages called through their real actions and loads (Admin >
// Published, Admin > Reports and the moderator's view of one edition), and a
// publish racing a takedown of the same story.

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
const { createStoryInUniverse } = await import('../../src/lib/server/story-create');
const { publishStory, takedownPublication } = await import('../../src/lib/server/publish');
const { createReport, dismissReport } = await import('../../src/lib/server/reports');
const { adminCancelDeletion, scheduleAccountDeletion } =
	await import('../../src/lib/server/account-deletion');
const publishedPage = await import('../../src/routes/admin/published/+page.server');
const reportsPage = await import('../../src/routes/admin/reports/+page.server');
const editionPage = await import('../../src/routes/admin/published/[id=uuid]/+page.server');

type Locals = { user: { id: string; role: string } | null };

let author: { id: string };
let moderator: { id: string; role: string };
let storyId: string;
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
	author = await user('author@example.com', 'user', {
		handle: 'teller',
		publicArchiveEnabled: true
	});
	moderator = await user('mod@example.com', 'moderator');
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: author.id, name: 'Ardenfall', slug: 'ardenfall' })
		.returning();
	const story = await createStoryInUniverse(db, author.id, universe.id, 'The Toll');
	storyId = story.id;
	await db
		.update(stories)
		.set({ visibility: 'public', listedInBrowse: true })
		.where(eq(stories.id, storyId));
	await pool.query(
		`insert into scenes (story_id, global_position, body_md) values ($1, 1, 'The bell rang.')`,
		[storyId]
	);
	const published = await publishStory(db, author.id, storyId);
	if (!published.ok) throw new Error(published.reason);
	publicationId = published.publicationId;
});

afterAll(async () => {
	await pool.end();
});

function act(
	page: { actions: Record<string, unknown> },
	name: string,
	fields: Record<string, string>,
	locals: Locals = { user: moderator }
) {
	const url = new URL('http://localhost/admin/published');
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return (page.actions[name] as (event: unknown) => Promise<unknown>)({
		url,
		request: new Request(url, { method: 'POST', body: form }),
		locals
	});
}

async function loadPublished(locals: Locals = { user: moderator }) {
	const load = publishedPage.load as (event: unknown) => Promise<{
		live: { editions: Record<string, unknown>[] };
		takenDown: Record<string, unknown>[];
		browseBlocked: Record<string, unknown>[];
	}>;
	return await load({ locals, url: new URL('http://localhost/admin/published') });
}

async function loadEdition(id: string, locals: Locals = { user: moderator }) {
	const load = editionPage.load as (event: unknown) => Promise<{
		edition: Record<string, unknown> & { content: { chapters: unknown[]; unfiled: unknown[] } };
	}>;
	return await load({ locals, params: { id }, setHeaders: () => {} });
}

async function edition() {
	const [row] = await db.select().from(publications).where(eq(publications.id, publicationId));
	return row;
}

async function storyRow() {
	const [row] = await db.select().from(stories).where(eq(stories.id, storyId));
	return row;
}

// The Restore and Allow in Browse forms, as the Published page posts them: with
// when the page showed the edition taken down or the story removed ('' when it
// is not, for a page that is out of date).
async function restoreForm(id: string) {
	const { rows } = await pool.query(
		`select (extract(epoch from coalesce(taken_down_at, removed_at)) * 1000000)::bigint::text as at
		from publications where id = $1 and removed_reason is not null`,
		[id]
	);
	return { publicationId: id, takenDownAt: rows[0]?.at ?? '' };
}

async function allowForm() {
	const { rows } = await pool.query(
		`select (extract(epoch from browse_blocked_at) * 1000000)::bigint::text as at
		from stories where id = $1`,
		[storyId]
	);
	return { storyId, browseBlockedAt: rows[0]?.at ?? '' };
}

async function expect404(run: Promise<unknown>) {
	const caught = await run.then(
		() => null,
		(e: unknown) => e
	);
	expect(isHttpError(caught) && caught.status).toBe(404);
}

describe('Admin > Published actions', () => {
	it('takes an edition down and restores it, recording who restored it', async () => {
		expect(
			await act(publishedPage, 'takedown', { publicationId, reason: 'copyright' })
		).toMatchObject({ done: true });
		expect(await edition()).toMatchObject({ removedBy: moderator.id, removedReason: 'copyright' });
		expect((await loadPublished()).takenDown).toMatchObject([
			{ id: publicationId, removedByName: 'mod' }
		]);

		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			done: true
		});
		const restored = await edition();
		expect(restored).toMatchObject({ removedAt: null, restoredBy: moderator.id });
		expect(restored.restoredAt).toBeInstanceOf(Date);
		expect((await loadPublished()).live.editions).toMatchObject([
			{ id: publicationId, restoredByName: 'mod' }
		]);

		// A second restore has nothing to undo.
		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			status: 400
		});
	});

	it('removes a story from Browse and allows it again, recording who allowed it', async () => {
		expect(await act(publishedPage, 'removeFromBrowse', { storyId, reason: 'spam' })).toMatchObject(
			{ done: true }
		);
		expect(await storyRow()).toMatchObject({
			listedInBrowse: false,
			browseBlockedBy: moderator.id
		});
		expect((await loadPublished()).browseBlocked).toMatchObject([
			{ storyId, browseBlockedByName: 'mod' }
		]);

		expect(await act(publishedPage, 'allowInBrowse', await allowForm())).toMatchObject({
			done: true
		});
		const allowed = await storyRow();
		expect(allowed).toMatchObject({ browseBlockedAt: null, browseAllowedBy: moderator.id });
		expect(allowed.browseAllowedAt).toBeInstanceOf(Date);
		expect((await loadPublished()).live.editions).toMatchObject([
			{ id: publicationId, browseAllowedByName: 'mod' }
		]);

		expect(await act(publishedPage, 'allowInBrowse', await allowForm())).toMatchObject({
			status: 400
		});
	});

	it('says whether Browse shows the story, which also depends on its author', async () => {
		expect((await loadPublished()).live.editions).toMatchObject([
			{ listedInBrowse: true, shownInBrowse: true }
		]);
		await db.update(users).set({ hiddenFromBrowse: true }).where(eq(users.id, author.id));
		expect((await loadPublished()).live.editions).toMatchObject([
			{ listedInBrowse: true, shownInBrowse: false }
		]);
		await db
			.update(users)
			.set({ hiddenFromBrowse: false, suspendedAt: new Date() })
			.where(eq(users.id, author.id));
		expect((await loadPublished()).live.editions).toMatchObject([{ shownInBrowse: false }]);
	});

	it('refuses a bad reason or id', async () => {
		expect(await act(publishedPage, 'takedown', { publicationId, reason: 'nope' })).toMatchObject({
			status: 400
		});
		expect(await act(publishedPage, 'restore', { publicationId: 'not-a-uuid' })).toMatchObject({
			status: 400
		});
		expect(await act(publishedPage, 'removeFromBrowse', { storyId, reason: '' })).toMatchObject({
			status: 400
		});
		expect((await edition()).removedAt).toBeNull();
	});

	it('is a 404 for writers, and changes nothing', async () => {
		const writer = { user: { id: author.id, role: 'user' } };
		await expect404(act(publishedPage, 'takedown', { publicationId, reason: 'spam' }, writer));
		await takedownPublication(db, publicationId, moderator.id, 'spam');
		await expect404(act(publishedPage, 'restore', { publicationId }, writer));
		await expect404(act(publishedPage, 'removeFromBrowse', { storyId, reason: 'spam' }, writer));
		await expect404(loadPublished(writer));
		expect((await edition()).removedReason).toBe('spam');
		expect((await storyRow()).browseBlockedAt).toBeNull();
	});

	it('says an edition already down is down, as the report queue does', async () => {
		await takedownPublication(db, publicationId, moderator.id, 'spam');
		expect(await act(publishedPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			status: 400,
			data: { message: 'That edition does not exist or is already down.' }
		});
	});

	it('lists an edition hidden by account deletion, which can still be taken down', async () => {
		await scheduleAccountDeletion(db, author.id);
		const listed = (await loadPublished()).live.editions;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: publicationId, ownerDeletionPending: true });
		expect(listed[0].hiddenAt).toBeInstanceOf(Date);

		expect(
			await act(publishedPage, 'takedown', { publicationId, reason: 'illegal' })
		).toMatchObject({ done: true });
		const after = await loadPublished();
		expect(after.live.editions).toEqual([]);
		expect(after.takenDown).toMatchObject([{ id: publicationId, removedReason: 'illegal' }]);
	});

	it('dates a takedown by the takedown, not by an earlier account deletion hide', async () => {
		await scheduleAccountDeletion(db, author.id);
		const hiddenAt = new Date('2020-01-01T00:00:00Z');
		await db
			.update(publications)
			.set({ removedAt: hiddenAt })
			.where(eq(publications.id, publicationId));
		const before = Date.now();
		expect(await act(publishedPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		const [listed] = (await loadPublished()).takenDown;
		expect((listed.takenDownAt as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(
			((await loadEdition(publicationId)).edition.takenDownAt as Date).getTime()
		).toBeGreaterThanOrEqual(before - 1000);
		// The hide keeps its own date, so cancelling the deletion and restoring
		// leaves the edition hidden as before.
		expect((await edition()).removedAt).toEqual(hiddenAt);
		expect(await adminCancelDeletion(db, author.id)).toBe(true);
		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			done: true
		});
		expect(await edition()).toMatchObject({
			removedAt: hiddenAt,
			removedReason: null,
			takenDownAt: null
		});
	});

	it('dates a takedown made before the takedown date was recorded by when it came down', async () => {
		const removedAt = new Date('2021-06-01T00:00:00Z');
		await db
			.update(publications)
			.set({ removedAt, removedReason: 'spam', removedBy: moderator.id })
			.where(eq(publications.id, publicationId));
		expect((await loadPublished()).takenDown).toMatchObject([{ takenDownAt: removedAt }]);
	});
});

describe('Admin > Reports actions', () => {
	async function fileReport() {
		expect(await createReport(db, publicationId, 'spam', 'An advert.')).toBe(true);
		const [row] = await db.select().from(publicationReports);
		return row.id;
	}
	async function reportRow(id: string) {
		const [row] = await db.select().from(publicationReports).where(eq(publicationReports.id, id));
		return row;
	}

	it('dismisses a report once', async () => {
		const reportId = await fileReport();
		expect(await act(reportsPage, 'dismiss', { reportId })).toMatchObject({ done: true });
		expect(await reportRow(reportId)).toMatchObject({
			resolution: 'dismissed',
			resolvedBy: moderator.id
		});
		expect(await act(reportsPage, 'dismiss', { reportId })).toMatchObject({ status: 400 });
	});

	it('takes the edition down and closes the report', async () => {
		const reportId = await fileReport();
		expect(await act(reportsPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		expect(await reportRow(reportId)).toMatchObject({ resolution: 'taken_down' });
		expect(await act(reportsPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			status: 400
		});
	});

	it('removes the story from Browse and closes only that report', async () => {
		const reportId = await fileReport();
		expect(await createReport(db, publicationId, 'other', '')).toBe(true);
		expect(
			await act(reportsPage, 'removeFromBrowse', { storyId, reportId, reason: 'spam' })
		).toMatchObject({ done: true });
		const rows = await db.select().from(publicationReports);
		expect(rows.find((row) => row.id === reportId)).toMatchObject({
			resolution: 'removed_from_browse'
		});
		expect(rows.filter((row) => row.resolvedAt === null)).toHaveLength(1);
		expect(await act(reportsPage, 'allowInBrowse', await allowForm())).toMatchObject({
			done: true
		});
		expect((await storyRow()).browseAllowedBy).toBe(moderator.id);
	});

	it('marks a report about an edition the writer has since replaced', async () => {
		await fileReport();
		const load = reportsPage.load as (event: unknown) => Promise<{
			reports: { newerEdition: 'up' | 'hidden' | 'closed' | null }[];
		}>;
		const locals = { user: moderator };
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: null }]);
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: 'up' }]);
		// Readers cannot open it anyway while the story is private, in the
		// trash, or its writer is suspended.
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: 'closed' }]);
		await db
			.update(stories)
			.set({ visibility: 'public', deletedAt: new Date() })
			.where(eq(stories.id, storyId));
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: 'closed' }]);
		await db.update(stories).set({ deletedAt: null }).where(eq(stories.id, storyId));
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, author.id));
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: 'closed' }]);
		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, author.id));
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: 'up' }]);
		// Hidden by a pending account deletion (no reason): a takedown still
		// covers it, but readers cannot open it.
		await db
			.update(publications)
			.set({ removedAt: new Date() })
			.where(eq(publications.id, newer.publicationId));
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: 'hidden' }]);
		// Once the newer one is down on its own, a takedown touches only this one.
		await db
			.update(publications)
			.set({ removedAt: new Date(), removedReason: 'spam' })
			.where(eq(publications.id, newer.publicationId));
		expect((await load({ locals })).reports).toMatchObject([{ newerEdition: null }]);
	});

	it('refuses a takedown from the queue when a newer edition appeared since the page loaded', async () => {
		const reportId = await fileReport();
		// The queue showed no newer edition, then the writer published again.
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect(
			await act(reportsPage, 'takedown', { publicationId, reportId, newer: 'none', reason: 'spam' })
		).toMatchObject({
			status: 409,
			data: { message: 'This story has a newer edition. Reload the page and try again.' }
		});
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows.map((row) => row.removedReason)).toEqual([null, null]);
		expect((await reportRow(reportId)).resolvedAt).toBeNull();
		// A newer edition other than the one the queue showed is refused too.
		const newest = await publishStory(db, author.id, storyId);
		if (!newest.ok) throw new Error(newest.reason);
		expect(
			await act(reportsPage, 'takedown', {
				publicationId,
				reportId,
				newer: newer.publicationId,
				reason: 'spam'
			})
		).toMatchObject({ status: 409 });
		// After a reload the queue shows the newest edition, and the takedown goes ahead.
		const load = reportsPage.load as (event: unknown) => Promise<{
			reports: { newerEditionId: string | null }[];
		}>;
		const [shown] = (await load({ locals: { user: moderator } })).reports;
		expect(shown.newerEditionId).toBe(newest.publicationId);
		expect(
			await act(reportsPage, 'takedown', {
				publicationId,
				reportId,
				newer: shown.newerEditionId!,
				reason: 'spam'
			})
		).toMatchObject({ done: true });
		const after = await db
			.select()
			.from(publications)
			.where(and(eq(publications.storyId, storyId), eq(publications.isCurrent, true)));
		expect(after.map((row) => row.removedReason)).toEqual(['spam']);
		expect((await edition()).removedReason).toBe('spam');
	});

	it('takes down a reported current edition the queue showed with no newer one', async () => {
		const reportId = await fileReport();
		expect(
			await act(reportsPage, 'takedown', { publicationId, reportId, newer: 'none', reason: 'spam' })
		).toMatchObject({ done: true });
		expect(await reportRow(reportId)).toMatchObject({ resolution: 'taken_down' });
	});

	it('a takedown covers the newer edition an account deletion hid', async () => {
		await fileReport();
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		await db
			.update(publications)
			.set({ removedAt: new Date() })
			.where(eq(publications.id, newer.publicationId));
		expect(await act(reportsPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		const [current] = await db
			.select()
			.from(publications)
			.where(eq(publications.id, newer.publicationId));
		expect(current).toMatchObject({ removedReason: 'spam', hiddenByAccountDeletion: true });
	});

	it("accepts the queue's newer edition after an account deletion hid both", async () => {
		const reportId = await fileReport();
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		await scheduleAccountDeletion(db, author.id);
		const load = reportsPage.load as (event: unknown) => Promise<{
			reports: { newerEdition: string | null; newerEditionId: string | null }[];
		}>;
		const [shown] = (await load({ locals: { user: moderator } })).reports;
		expect(shown).toMatchObject({ newerEdition: 'hidden', newerEditionId: newer.publicationId });
		expect(
			await act(reportsPage, 'takedown', {
				publicationId,
				reportId,
				newer: shown.newerEditionId!,
				reason: 'spam'
			})
		).toMatchObject({ done: true });
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows.map((row) => row.removedReason)).toEqual(['spam', 'spam']);
	});

	it('says the story has a newer edition when the reported one is hidden by an account deletion', async () => {
		const reportId = await fileReport();
		// The queue showed no newer edition, then the writer published again and
		// scheduled their account's deletion, which hid both editions.
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		await scheduleAccountDeletion(db, author.id);
		expect(
			await act(reportsPage, 'takedown', { publicationId, reportId, newer: 'none', reason: 'spam' })
		).toMatchObject({
			status: 409,
			data: { message: 'This story has a newer edition. Reload the page and try again.' }
		});
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows.map((row) => row.removedReason)).toEqual([null, null]);
	});

	it('says whether the reported edition is current and readers can open it', async () => {
		await fileReport();
		const load = reportsPage.load as (event: unknown) => Promise<{
			reports: { editionCurrent: boolean; editionReadable: boolean }[];
		}>;
		const locals = { user: moderator };
		expect((await load({ locals })).reports).toMatchObject([
			{ editionCurrent: true, editionReadable: true }
		]);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect((await load({ locals })).reports).toMatchObject([
			{ editionCurrent: true, editionReadable: false }
		]);
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect((await load({ locals })).reports).toMatchObject([
			{ editionCurrent: false, editionReadable: false }
		]);
	});

	it('is a 404 for writers', async () => {
		const reportId = await fileReport();
		await expect404(
			act(reportsPage, 'dismiss', { reportId }, { user: { id: author.id, role: 'user' } })
		);
		expect((await reportRow(reportId)).resolvedAt).toBeNull();
	});
});

describe("the moderator's view of an edition", () => {
	it('shows a taken-down edition with who took it down', async () => {
		await takedownPublication(db, publicationId, moderator.id, 'copyright');
		const { edition: shown } = await loadEdition(publicationId);
		expect(shown).toMatchObject({
			id: publicationId,
			title: 'The Toll',
			removedReason: 'copyright',
			removedByName: 'mod'
		});
		expect(shown.content.chapters.length + shown.content.unfiled.length).toBe(1);
	});

	it('shows an edition an account deletion hid, to admins too', async () => {
		await scheduleAccountDeletion(db, author.id);
		const admin = await user('admin@example.com', 'admin');
		const { edition: shown } = await loadEdition(publicationId, { user: admin });
		expect(shown).toMatchObject({ ownerDeletionPending: true, readable: false });
		expect(shown.removedAt).toBeInstanceOf(Date);
	});

	it('says whether readers can open the edition', async () => {
		expect((await loadEdition(publicationId)).edition.readable).toBe(true);
	});

	it('opens a story made private only once it was reported or taken down', async () => {
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		await expect404(loadEdition(publicationId));
		expect((await loadPublished()).live.editions).toMatchObject([{ viewable: false }]);
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect((await loadEdition(publicationId)).edition).toMatchObject({ readable: false });
		expect((await loadPublished()).live.editions).toMatchObject([{ viewable: true }]);
	});

	it('opens a story in the trash only once it was reported', async () => {
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		await expect404(loadEdition(publicationId));
		// The trash keeps the Browse tick; the page hides "Remove from Browse"
		// on a row that is not viewable.
		expect((await loadPublished()).live.editions).toMatchObject([
			{ viewable: false, listedInBrowse: true, shownInBrowse: false }
		]);
		await db.update(stories).set({ deletedAt: null }).where(eq(stories.id, storyId));
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect((await loadEdition(publicationId)).edition).toMatchObject({ readable: false });
	});

	it('a dismissed report does not open a private story', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		const [report] = await db.select().from(publicationReports);
		expect(await dismissReport(db, report.id, moderator.id)).toBe(true);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		await expect404(loadEdition(publicationId));
		expect((await loadPublished()).live.editions).toMatchObject([{ viewable: false }]);
	});

	it('opens an older edition of a public story only once it was reported', async () => {
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect((await loadEdition(newer.publicationId)).edition).toMatchObject({ readable: true });
		await expect404(loadEdition(publicationId));
		// Filed while it was still the current edition: a reader cannot report a
		// replaced one.
		expect(await createReport(db, publicationId, 'spam', '')).toBe(false);
		await db.insert(publicationReports).values({ publicationId, reason: 'spam' });
		expect((await loadEdition(publicationId)).edition).toMatchObject({
			isCurrent: false,
			readable: false
		});
	});

	it('a takedown of a reported older edition does not open the newer one of a private story', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		// Both are down, but only the reported one opens.
		expect((await loadEdition(publicationId)).edition).toMatchObject({ removedReason: 'spam' });
		await expect404(loadEdition(newer.publicationId));
		expect((await loadPublished()).takenDown).toMatchObject([
			{ id: newer.publicationId, viewable: false, notViewableBecause: 'withdrawn' }
		]);
	});

	it('offers no takedown of the current edition of a private story', async () => {
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect((await loadPublished()).live.editions).toMatchObject([{ viewable: false }]);
		expect(await act(publishedPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			status: 409,
			data: {
				message: 'The writer made this story private or moved it to the trash. Reload the page.'
			}
		});
		expect((await edition()).removedReason).toBeNull();
		await expect404(loadEdition(publicationId));
	});

	it('says the writer withdrew a story moved to the trash since the page loaded', async () => {
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect(await act(publishedPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			status: 409,
			data: {
				message: 'The writer made this story private or moved it to the trash. Reload the page.'
			}
		});
		expect((await edition()).removedReason).toBeNull();
	});

	it('a restored takedown no longer opens the reported edition of a private story', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		// Still down: the moderator can read it before deciding on a restore.
		expect((await loadEdition(publicationId)).edition).toMatchObject({ removedReason: 'spam' });
		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			done: true
		});
		await expect404(loadEdition(publicationId));
	});

	it('a later takedown with no report does not reopen an edition whose takedown was restored', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			done: true
		});
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect(await takedownPublication(db, newer.publicationId, moderator.id, 'other')).toBe(true);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		await expect404(loadEdition(publicationId));
		expect((await loadPublished()).takenDown).toMatchObject([
			{ id: newer.publicationId, viewable: false }
		]);
		// A new report on it, closed by a new takedown, opens it again.
		await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		await act(publishedPage, 'restore', await restoreForm(newer.publicationId));
		await db.insert(publicationReports).values({ publicationId, reason: 'spam' });
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect((await loadEdition(publicationId)).edition).toMatchObject({ removedReason: 'spam' });
	});

	it('restoring a reported older edition also restores the current one taken down with it', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			done: true
		});
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows.map((row) => [row.removedAt, row.removedReason])).toEqual([
			[null, null],
			[null, null]
		]);
		expect((await publishStory(db, author.id, storyId)).ok).toBe(true);
	});

	it('does not offer the public page when the story has changed hands', async () => {
		const other = await user('other@example.com', 'user');
		await db.update(stories).set({ ownerId: other.id }).where(eq(stories.id, storyId));
		expect((await loadEdition(publicationId)).edition.readable).toBe(false);
	});

	it('is a 404 for writers and signed-out visitors, and for an unknown edition', async () => {
		await expect404(loadEdition(publicationId, { user: { id: author.id, role: 'user' } }));
		await expect404(loadEdition(publicationId, { user: null }));
		await expect404(loadEdition('00000000-0000-4000-8000-000000000000'));
	});
});

describe('a dismissal racing a takedown of the same report', () => {
	async function fileReport() {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		const [row] = await db.select().from(publicationReports);
		return row.id;
	}

	it('a dismissal that starts while a takedown runs waits, then finds the report closed', async () => {
		const reportId = await fileReport();
		const client = await pool.connect();
		try {
			// A takedown in progress holds the story row, as takedownPublication does.
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [storyId]);
			await client.query(
				`update publications set removed_at = now(), removed_by = $2, removed_reason = 'spam'
				 where id = $1`,
				[publicationId, moderator.id]
			);
			await client.query(
				`update publication_reports set resolved_at = now(), resolved_by = $2,
				 resolution = 'taken_down' where id = $1`,
				[reportId, moderator.id]
			);
			let settled = false;
			const dismissing = act(reportsPage, 'dismiss', { reportId }).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await dismissing).toMatchObject({ status: 400 });
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
		const [report] = await db
			.select()
			.from(publicationReports)
			.where(eq(publicationReports.id, reportId));
		expect(report.resolution).toBe('taken_down');
	});

	it('a takedown of a replaced edition that starts while a dismissal runs says the report closed', async () => {
		const reportId = await fileReport();
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		const client = await pool.connect();
		try {
			// A dismissal in progress holds the story row, as dismissReport does.
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [storyId]);
			await client.query(
				`update publication_reports set resolved_at = now(), resolved_by = $2,
				 resolution = 'dismissed' where id = $1`,
				[reportId, moderator.id]
			);
			let settled = false;
			const takingDown = act(reportsPage, 'takedown', {
				publicationId,
				reportId,
				reason: 'spam'
			}).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await takingDown).toMatchObject({
				status: 409,
				data: { message: 'This report is already closed. Reload the page to see what changed.' }
			});
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
		// The dismissal stands and nothing came down.
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows.map((row) => row.removedReason)).toEqual([null, null]);
		const [report] = await db
			.select()
			.from(publicationReports)
			.where(eq(publicationReports.id, reportId));
		expect(report.resolution).toBe('dismissed');
	});

	it('a Browse removal that starts while a takedown runs waits, then finds the report closed', async () => {
		const reportId = await fileReport();
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [storyId]);
			await client.query(
				`update publications set removed_at = now(), removed_by = $2, removed_reason = 'spam'
				 where id = $1`,
				[publicationId, moderator.id]
			);
			await client.query(
				`update publication_reports set resolved_at = now(), resolved_by = $2,
				 resolution = 'taken_down' where id = $1`,
				[reportId, moderator.id]
			);
			let settled = false;
			const removing = act(reportsPage, 'removeFromBrowse', {
				storyId,
				reportId,
				reason: 'spam'
			}).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await removing).toMatchObject({
				status: 409,
				data: { message: 'This report is already closed. Reload the page to see what changed.' }
			});
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
		// The takedown stands and the story was not blocked from Browse.
		const story = await storyRow();
		expect(story.browseBlockedAt).toBeNull();
		expect(story.listedInBrowse).toBe(true);
		const [report] = await db
			.select()
			.from(publicationReports)
			.where(eq(publicationReports.id, reportId));
		expect(report.resolution).toBe('taken_down');
	});

	it('a dismissal waits while a takedown holds the story row', async () => {
		const reportId = await fileReport();
		const client = await pool.connect();
		try {
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [storyId]);
			let settled = false;
			const dismissing = dismissReport(db, reportId, moderator.id).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await dismissing).toBe(true);
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
	});
});

describe('a takedown, restored, then taken down again', () => {
	// Whether the moderator could read the edition if the writer made the story
	// private now: only a report closed by a takedown that still holds opens it.
	async function readableWhilePrivate() {
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		try {
			return await loadEdition(publicationId).then(
				() => true,
				() => false
			);
		} finally {
			await db.update(stories).set({ visibility: 'public' }).where(eq(stories.id, storyId));
		}
	}

	it('opens the edition only while a reported takedown holds', async () => {
		const takedown = () => act(publishedPage, 'takedown', { publicationId, reason: 'spam' });
		const restore = async () => act(publishedPage, 'restore', await restoreForm(publicationId));

		// 1. A takedown with no report.
		expect(await takedown()).toMatchObject({ done: true });
		expect((await edition()).takenDownAt).toBeInstanceOf(Date);
		expect(await readableWhilePrivate()).toBe(false);
		// 2. Restored.
		expect(await restore()).toMatchObject({ done: true });
		expect((await edition()).takenDownAt).toBeNull();
		expect(await readableWhilePrivate()).toBe(false);
		// 3. Reported, then taken down: the report it closed opens it.
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		expect(await act(reportsPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		expect(await readableWhilePrivate()).toBe(true);
		// 4. Restored: the closed report no longer opens it.
		expect(await restore()).toMatchObject({ done: true });
		expect(await readableWhilePrivate()).toBe(false);
		// 5. Taken down again with no new report: still closed to the moderator.
		expect(await takedown()).toMatchObject({ done: true });
		expect(await edition()).toMatchObject({ removedReason: 'spam' });
		expect(await readableWhilePrivate()).toBe(false);
		// Public again, the current edition reads as usual.
		expect((await loadEdition(publicationId)).edition).toMatchObject({ removedReason: 'spam' });
	});

	it('a restore from before restores were dated does not let a later takedown reopen a report', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		expect(await act(reportsPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		// Restored before migration 0130: no restored_at.
		await db
			.update(publications)
			.set({ removedAt: null, removedBy: null, removedReason: null, takenDownAt: null })
			.where(eq(publications.id, publicationId));
		expect(await readableWhilePrivate()).toBe(false);
		expect(await act(publishedPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		expect(await readableWhilePrivate()).toBe(false);
	});

	it('a takedown from before takedowns were dated does not open its reports', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		expect(await act(reportsPage, 'takedown', { publicationId, reason: 'spam' })).toMatchObject({
			done: true
		});
		expect(await readableWhilePrivate()).toBe(true);
		// Taken down before migration 0133: no taken_down_at.
		await db
			.update(publications)
			.set({ takenDownAt: null })
			.where(eq(publications.id, publicationId));
		expect(await readableWhilePrivate()).toBe(false);
		// The Taken down list says why it does not link while the story is private.
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect((await loadPublished()).takenDown).toMatchObject([
			{ id: publicationId, viewable: false, notViewableBecause: 'olderTakedown' }
		]);
	});
});

describe('an undo or Browse removal from a page loaded before a change', () => {
	const RELOAD_TAKEDOWN =
		'This edition was taken down again since you loaded the page. Reload the page to see what changed.';
	const RELOAD_BROWSE =
		'This story was removed from Browse again since you loaded the page. Reload the page to see what changed.';
	const WITHDRAWN = 'The writer made this story private or moved it to the trash. Reload the page.';

	async function shownTakedown() {
		const [row] = (await loadPublished()).takenDown;
		return { publicationId: row.id as string, takenDownAt: row.takenDownMicros as string };
	}
	async function shownBlock() {
		const [row] = (await loadPublished()).browseBlocked;
		return { storyId: row.storyId as string, browseBlockedAt: row.browseBlockedMicros as string };
	}

	it('a stale Restore does not lift a takedown placed after the page loaded', async () => {
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		const stale = await shownTakedown();
		// Another moderator restores it, and a third takes it down again.
		expect(await act(publishedPage, 'restore', await restoreForm(publicationId))).toMatchObject({
			done: true
		});
		expect(await takedownPublication(db, publicationId, moderator.id, 'illegal')).toBe(true);
		expect(await act(publishedPage, 'restore', stale)).toMatchObject({
			status: 409,
			data: { message: RELOAD_TAKEDOWN }
		});
		expect(await edition()).toMatchObject({ removedReason: 'illegal' });
		expect((await edition()).removedAt).toBeInstanceOf(Date);
		// The reloaded page restores it.
		expect(await act(publishedPage, 'restore', await shownTakedown())).toMatchObject({
			done: true
		});
		expect(await edition()).toMatchObject({ removedAt: null, removedReason: null });
	});

	it('matches the shown takedown to the microsecond', async () => {
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		await pool.query(
			`update publications set taken_down_at = '2026-03-01 10:00:00.123456+00' where id = $1`,
			[publicationId]
		);
		const shown = await shownTakedown();
		expect(shown.takenDownAt).toBe(String(Date.UTC(2026, 2, 1, 10) * 1000 + 123456));
		// A takedown in the same millisecond, one microsecond later.
		await pool.query(
			`update publications set taken_down_at = '2026-03-01 10:00:00.123457+00' where id = $1`,
			[publicationId]
		);
		expect(await act(publishedPage, 'restore', shown)).toMatchObject({ status: 409 });
		expect((await edition()).removedReason).toBe('spam');
		expect(await act(publishedPage, 'restore', await shownTakedown())).toMatchObject({
			done: true
		});
	});

	it('refuses a Restore that does not say when the page showed the takedown', async () => {
		expect(await takedownPublication(db, publicationId, moderator.id, 'spam')).toBe(true);
		expect(await act(publishedPage, 'restore', { publicationId })).toMatchObject({ status: 400 });
		expect((await edition()).removedReason).toBe('spam');
	});

	it('a stale Allow in Browse does not lift a removal placed after the page loaded', async () => {
		expect(await act(publishedPage, 'removeFromBrowse', { storyId, reason: 'spam' })).toMatchObject(
			{ done: true }
		);
		const stale = await shownBlock();
		expect(await act(publishedPage, 'allowInBrowse', await allowForm())).toMatchObject({
			done: true
		});
		expect(
			await act(publishedPage, 'removeFromBrowse', { storyId, reason: 'other' })
		).toMatchObject({ done: true });
		expect(await act(publishedPage, 'allowInBrowse', stale)).toMatchObject({
			status: 409,
			data: { message: RELOAD_BROWSE }
		});
		expect(await act(reportsPage, 'allowInBrowse', stale)).toMatchObject({ status: 409 });
		expect(await storyRow()).toMatchObject({ browseBlockedReason: 'other' });
		expect(await act(publishedPage, 'allowInBrowse', await shownBlock())).toMatchObject({
			done: true
		});
		expect((await storyRow()).browseBlockedAt).toBeNull();
	});

	it('matches the shown Browse removal to the microsecond', async () => {
		await pool.query(
			`update stories set browse_blocked_at = '2026-03-01 10:00:00.123456+00', browse_blocked_reason = 'spam' where id = $1`,
			[storyId]
		);
		const shown = await shownBlock();
		await pool.query(
			`update stories set browse_blocked_at = '2026-03-01 10:00:00.123457+00' where id = $1`,
			[storyId]
		);
		expect(await act(publishedPage, 'allowInBrowse', shown)).toMatchObject({ status: 409 });
		expect((await storyRow()).browseBlockedAt).toBeInstanceOf(Date);
		expect(await act(publishedPage, 'allowInBrowse', { storyId })).toMatchObject({ status: 400 });
		expect((await storyRow()).browseBlockedAt).toBeInstanceOf(Date);
	});

	it('refuses a Browse removal of a story the writer made private since the page loaded', async () => {
		expect((await loadPublished()).live.editions).toMatchObject([{ listedInBrowse: true }]);
		await db
			.update(stories)
			.set({ visibility: 'private', listedInBrowse: false })
			.where(eq(stories.id, storyId));
		expect(await act(publishedPage, 'removeFromBrowse', { storyId, reason: 'spam' })).toMatchObject(
			{ status: 409, data: { message: WITHDRAWN } }
		);
		expect(await storyRow()).toMatchObject({ browseBlockedAt: null, browseBlockedReason: null });
	});

	it('refuses a Browse removal of a story in the trash or never published', async () => {
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect(await act(publishedPage, 'removeFromBrowse', { storyId, reason: 'spam' })).toMatchObject(
			{ status: 409, data: { message: WITHDRAWN } }
		);
		expect((await storyRow()).browseBlockedAt).toBeNull();

		const [universe] = await db.select().from(universes);
		const draft = await createStoryInUniverse(db, author.id, universe.id, 'Unshared');
		expect(
			await act(publishedPage, 'removeFromBrowse', { storyId: draft.id, reason: 'spam' })
		).toMatchObject({ status: 409, data: { message: WITHDRAWN } });
		const [row] = await db.select().from(stories).where(eq(stories.id, draft.id));
		expect(row.browseBlockedAt).toBeNull();
	});

	it('still removes a story in the trash from Browse from an open report', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		const [report] = await db.select().from(publicationReports);
		// A newer edition, so the report is about an edition no longer current.
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, storyId));
		expect(
			await act(reportsPage, 'removeFromBrowse', { storyId, reportId: report.id, reason: 'spam' })
		).toMatchObject({ done: true });
		expect(await storyRow()).toMatchObject({ browseBlockedReason: 'spam' });
	});

	it('says the report closed when a Browse removal from a dismissed report is refused', async () => {
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		const [report] = await db.select().from(publicationReports);
		expect(await dismissReport(db, report.id, moderator.id)).toBe(true);
		await db.update(stories).set({ visibility: 'private' }).where(eq(stories.id, storyId));
		expect(
			await act(reportsPage, 'removeFromBrowse', { storyId, reportId: report.id, reason: 'spam' })
		).toMatchObject({
			status: 409,
			data: { message: 'This report is already closed. Reload the page to see what changed.' }
		});
	});
});

describe('an account deletion racing a takedown of the same story', () => {
	it("a takedown waits on the owner's account row before it takes the story row", async () => {
		const client = await pool.connect();
		try {
			// A deletion in progress has updated the account row first, as
			// scheduleAccountDeletion does.
			await client.query('begin');
			await client.query('update users set deletion_scheduled_at = now() where id = $1', [
				author.id
			]);
			let settled = false;
			const takingDown = act(publishedPage, 'takedown', { publicationId, reason: 'spam' }).then(
				(value) => {
					settled = true;
					return value;
				}
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			// The takedown holds neither the story row nor any edition row, so
			// the deletion can go on to hide the editions without a deadlock.
			await client.query('select id from stories where id = $1 for update nowait', [storyId]);
			await client.query(
				`update publications set removed_at = now(), hidden_by_account_deletion = true
				 where owner_id = $1`,
				[author.id]
			);
			await client.query('commit');
			expect(await takingDown).toMatchObject({ done: true });
		} finally {
			await client.query('rollback').catch(() => {});
			client.release();
		}
		expect(await edition()).toMatchObject({ removedReason: 'spam', hiddenByAccountDeletion: true });
	});
});

describe('a publish racing a takedown of the same story', () => {
	it('a publish that starts while a takedown runs waits, then is refused', async () => {
		const client = await pool.connect();
		try {
			// A takedown in progress holds the story row, as takedownPublication does.
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [storyId]);
			await client.query(
				`update publications set removed_at = now(), removed_by = $2, removed_reason = 'spam'
				 where story_id = $1 and is_current`,
				[storyId, moderator.id]
			);
			let settled = false;
			const publishing = publishStory(db, author.id, storyId).then((value) => {
				settled = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await publishing).toMatchObject({ ok: false });
		} finally {
			// After a failed expect the transaction is still open; never return
			// a client holding the story lock to the pool.
			await client.query('rollback').catch(() => {});
			client.release();
		}
		const rows = await db.select().from(publications).where(eq(publications.storyId, storyId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ isCurrent: true, removedReason: 'spam' });
	});

	it('a takedown that starts while a publish runs waits, then asks for a reload', async () => {
		const client = await pool.connect();
		let newId: string;
		try {
			// A publish in progress holds the story row and swaps the current edition.
			await client.query('begin');
			await client.query('select id from stories where id = $1 for update', [storyId]);
			await client.query('update publications set is_current = false where story_id = $1', [
				storyId
			]);
			const inserted = await client.query(
				`insert into publications (story_id, owner_id, handle, title, content, is_current)
				 values ($1, $2, 'teller', 'The Toll', '{"chapters":[],"unfiled":[]}', true)
				 returning id`,
				[storyId, author.id]
			);
			newId = inserted.rows[0].id;
			let settled = false;
			// The moderator acts on the edition they saw, now being replaced.
			// They have not seen the newer text, so nothing is taken down.
			const takingDown = act(publishedPage, 'takedown', { publicationId, reason: 'spam' }).then(
				(value) => {
					settled = true;
					return value;
				}
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await takingDown).toMatchObject({
				status: 409,
				data: { message: 'This story has a newer edition. Reload the page and try again.' }
			});
		} finally {
			// After a failed expect the transaction is still open; never return
			// a client holding the story lock to the pool.
			await client.query('rollback').catch(() => {});
			client.release();
		}
		const [current] = await db.select().from(publications).where(eq(publications.id, newId!));
		expect(current).toMatchObject({ isCurrent: true, removedAt: null, removedReason: null });
		expect((await edition()).removedReason).toBeNull();
	});
});

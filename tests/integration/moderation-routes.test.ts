import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
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
const { scheduleAccountDeletion } = await import('../../src/lib/server/account-deletion');
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

		expect(await act(publishedPage, 'restore', { publicationId })).toMatchObject({ done: true });
		const restored = await edition();
		expect(restored).toMatchObject({ removedAt: null, restoredBy: moderator.id });
		expect(restored.restoredAt).toBeInstanceOf(Date);
		expect((await loadPublished()).live.editions).toMatchObject([
			{ id: publicationId, restoredByName: 'mod' }
		]);

		// A second restore has nothing to undo.
		expect(await act(publishedPage, 'restore', { publicationId })).toMatchObject({
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

		expect(await act(publishedPage, 'allowInBrowse', { storyId })).toMatchObject({ done: true });
		const allowed = await storyRow();
		expect(allowed).toMatchObject({ browseBlockedAt: null, browseAllowedBy: moderator.id });
		expect(allowed.browseAllowedAt).toBeInstanceOf(Date);
		expect((await loadPublished()).live.editions).toMatchObject([
			{ id: publicationId, browseAllowedByName: 'mod' }
		]);

		expect(await act(publishedPage, 'allowInBrowse', { storyId })).toMatchObject({ status: 400 });
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
		expect(await act(reportsPage, 'allowInBrowse', { storyId })).toMatchObject({ done: true });
		expect((await storyRow()).browseAllowedBy).toBe(moderator.id);
	});

	it('marks a report about an edition the writer has since replaced', async () => {
		await fileReport();
		const load = reportsPage.load as (event: unknown) => Promise<{
			reports: { newerEditionUp: boolean }[];
		}>;
		const locals = { user: moderator };
		expect((await load({ locals })).reports).toMatchObject([{ newerEditionUp: false }]);
		const newer = await publishStory(db, author.id, storyId);
		if (!newer.ok) throw new Error(newer.reason);
		expect((await load({ locals })).reports).toMatchObject([{ newerEditionUp: true }]);
		// Hidden by a pending account deletion (no reason), it is not up either.
		await db
			.update(publications)
			.set({ removedAt: new Date() })
			.where(eq(publications.id, newer.publicationId));
		expect((await load({ locals })).reports).toMatchObject([{ newerEditionUp: false }]);
		// Once the newer one is down on its own, a takedown touches only this one.
		await db
			.update(publications)
			.set({ removedAt: new Date(), removedReason: 'spam' })
			.where(eq(publications.id, newer.publicationId));
		expect((await load({ locals })).reports).toMatchObject([{ newerEditionUp: false }]);
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
		expect((await loadPublished()).live.editions).toMatchObject([{ viewable: false }]);
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
		expect(await createReport(db, publicationId, 'spam', '')).toBe(true);
		expect((await loadEdition(publicationId)).edition).toMatchObject({
			isCurrent: false,
			readable: false
		});
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

	it('a takedown that starts while a publish runs waits, then takes down the new edition', async () => {
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
			const takingDown = takedownPublication(db, publicationId, moderator.id, 'spam').then(
				(value) => {
					settled = true;
					return value;
				}
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(settled).toBe(false);
			await client.query('commit');
			expect(await takingDown).toBe(true);
		} finally {
			// After a failed expect the transaction is still open; never return
			// a client holding the story lock to the pool.
			await client.query('rollback').catch(() => {});
			client.release();
		}
		const [current] = await db.select().from(publications).where(eq(publications.id, newId!));
		expect(current).toMatchObject({ isCurrent: true, removedReason: 'spam' });
		expect(await publishStory(db, author.id, storyId)).toMatchObject({ ok: false });
	});
});

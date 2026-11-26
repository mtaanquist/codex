import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { publicationReports, publications, stories, users } from './db/schema';
import { notifyUsers } from './notify';
import { storyIsLive } from './universe-scope';
import { readersCanOpen } from './publication-scope';
import { MAX_REPORT_COMMENT, reportReasonLabel, type ReportReason } from '#lib/report-reasons';

// Readers report a published edition; admins and moderators work the queue.

// Returns false when the edition is gone or already taken down, so nothing
// was filed.
export async function createReport(
	db: Database,
	publicationId: string,
	reason: ReportReason,
	comment: string
): Promise<boolean> {
	const trimmed = comment.replaceAll('\u0000', '').trim().slice(0, MAX_REPORT_COMMENT);
	const edition = await db.transaction(async (tx) => {
		const [found] = await tx
			.select({
				storyId: publications.storyId,
				handle: publications.handle,
				title: publications.title
			})
			.from(publications)
			.where(eq(publications.id, publicationId));
		if (!found) return null;
		// A takedown holds the story row for update until it has closed the
		// story's reports, so a report filed meanwhile waits for it and then
		// sees the edition is down.
		await tx
			.select({ id: stories.id })
			.from(stories)
			.where(eq(stories.id, found.storyId))
			.for('share');
		const [up] = await tx
			.select({ id: publications.id })
			.from(publications)
			.where(and(eq(publications.id, publicationId), isNull(publications.removedAt)));
		if (!up) return null;
		await tx.insert(publicationReports).values({ publicationId, reason, comment: trimmed || null });
		return found;
	});
	if (!edition) return false;
	// The bell for every admin and moderator, email per their preference.
	const moderators = await db
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				inArray(users.role, ['admin', 'moderator']),
				isNull(users.suspendedAt),
				isNull(users.deletionScheduledAt)
			)
		);
	await notifyUsers(
		db,
		moderators.map((row) => row.id),
		'publication_report',
		{
			title: `A reader reported "${edition.title}" by @${edition.handle}`,
			detail: reportReasonLabel(reason),
			href: '/admin/reports'
		}
	);
	return true;
}

// The open reports, oldest first so nothing waits behind newer ones.
export async function listOpenReports(db: Database, limit = 100) {
	return await db
		.select({
			id: publicationReports.id,
			publicationId: publicationReports.publicationId,
			reason: publicationReports.reason,
			comment: publicationReports.comment,
			createdAt: publicationReports.createdAt,
			handle: publications.handle,
			title: publications.title,
			storyId: publications.storyId,
			// A newer edition replaced this one and is not taken down, so a
			// takedown takes that one down too: 'up' while readers can open it
			// (the checks publicEdition makes), 'hidden' while the writer's
			// account deletion hides it, 'closed' while readers cannot open it
			// anyway (the story is private or in the trash, or the writer is
			// suspended), else null.
			newerEdition: sql<
				'up' | 'hidden' | 'closed' | null
			>`(select case when c.removed_at is not null then 'hidden' when ${stories.visibility} <> 'private' and ${storyIsLive()} and ${stories.ownerId} = c.owner_id and exists (select 1 from ${users} o where o.id = c.owner_id and o.suspended_at is null) then 'up' else 'closed' end from ${publications} c where c.story_id = ${publications.storyId} and c.is_current and c.removed_reason is null and c.id <> ${publications.id} limit 1)`,
			editionRemovedAt: publications.removedAt,
			editionCurrent: publications.isCurrent,
			// Whether readers can open the reported edition right now.
			editionReadable: readersCanOpen(),
			// Set only by a moderator's takedown, not by account deletion.
			editionRemovedReason: publications.removedReason,
			// An edition down with no reason was hidden by the owner's account
			// deletion; it stays down after they cancel it.
			ownerDeletionPending: sql<boolean>`${users.deletionScheduledAt} is not null`,
			listedInBrowse: stories.listedInBrowse,
			browseBlockedAt: stories.browseBlockedAt
		})
		.from(publicationReports)
		.innerJoin(publications, eq(publications.id, publicationReports.publicationId))
		.innerJoin(stories, eq(stories.id, publications.storyId))
		.innerJoin(users, eq(users.id, publications.ownerId))
		.where(isNull(publicationReports.resolvedAt))
		.orderBy(publicationReports.createdAt)
		.limit(limit);
}

export async function countOpenReports(db: Database): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(publicationReports)
		.where(isNull(publicationReports.resolvedAt));
	return row?.n ?? 0;
}

// Closes one report without acting on the edition.
export async function dismissReport(
	db: Database,
	reportId: string,
	resolvedBy: string
): Promise<boolean> {
	return await db.transaction(async (tx) => {
		const [report] = await tx
			.select({ storyId: publications.storyId })
			.from(publicationReports)
			.innerJoin(publications, eq(publications.id, publicationReports.publicationId))
			.where(eq(publicationReports.id, reportId));
		if (!report) return false;
		// The lock takedownPublication takes before it checks the report is
		// open, so a takedown and a dismissal of the same report run one after
		// the other and the second sees what the first did.
		await tx
			.select({ id: stories.id })
			.from(stories)
			.where(eq(stories.id, report.storyId))
			.for('update');
		const updated = await tx
			.update(publicationReports)
			.set({ resolvedAt: sql`now()`, resolvedBy, resolution: 'dismissed' })
			.where(and(eq(publicationReports.id, reportId), isNull(publicationReports.resolvedAt)))
			.returning({ id: publicationReports.id });
		return updated.length > 0;
	});
}

// Whether a report exists and is closed, so a refused takedown from the
// queue can say another moderator closed it.
export async function reportClosed(db: Database, reportId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: publicationReports.id })
		.from(publicationReports)
		.where(and(eq(publicationReports.id, reportId), isNotNull(publicationReports.resolvedAt)));
	return Boolean(row);
}

// The most recent closed reports, for the queue's history.
export async function listRecentlyResolved(db: Database, limit = 20) {
	return await db
		.select({
			id: publicationReports.id,
			reason: publicationReports.reason,
			resolution: publicationReports.resolution,
			resolvedAt: publicationReports.resolvedAt,
			handle: publications.handle,
			title: publications.title,
			resolvedByName: users.displayName
		})
		.from(publicationReports)
		.innerJoin(publications, eq(publications.id, publicationReports.publicationId))
		.leftJoin(users, eq(users.id, publicationReports.resolvedBy))
		.where(sql`${publicationReports.resolvedAt} is not null`)
		.orderBy(desc(publicationReports.resolvedAt))
		.limit(limit);
}

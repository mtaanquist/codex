import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { publicationReports, publications, stories, users } from './db/schema';
import { notifyUsers } from './notify';
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
			isCurrent: publications.isCurrent,
			editionRemovedAt: publications.removedAt,
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
	const updated = await db
		.update(publicationReports)
		.set({ resolvedAt: sql`now()`, resolvedBy, resolution: 'dismissed' })
		.where(and(eq(publicationReports.id, reportId), isNull(publicationReports.resolvedAt)))
		.returning({ id: publicationReports.id });
	return updated.length > 0;
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

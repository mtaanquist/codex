import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { publicationReports, publications, stories, universes, users } from './db/schema';
import { notifyUsers } from './notify';
import {
	newerEditionId,
	newerEditionState,
	readersCanOpen,
	titleModeratorMayRead
} from './publication-scope';
import { MAX_REPORT_COMMENT, reportReasonLabel, type ReportReason } from '#lib/report-reasons';

// Readers report a published edition; admins and moderators work the queue.

// Returns false when readers can no longer open the edition (it is gone,
// taken down, replaced, or its story is private or in the trash), so nothing
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
				ownerId: publications.ownerId,
				handle: publications.handle,
				title: publications.title
			})
			.from(publications)
			.where(eq(publications.id, publicationId));
		if (!found) return null;
		// The recheck below also reads the writer's suspension and whether the
		// universe is in the trash, which change those rows only, so they are
		// held too: writer, then universe, then story, the order publish and a
		// story restore use.
		await tx.select({ id: users.id }).from(users).where(eq(users.id, found.ownerId)).for('share');
		await tx
			.select({ id: universes.id })
			.from(universes)
			.where(
				eq(
					universes.id,
					tx.select({ id: stories.universeId }).from(stories).where(eq(stories.id, found.storyId))
				)
			)
			.for('share');
		// A takedown holds the story row for update until it has closed the
		// story's reports, so a report filed meanwhile waits for it and then
		// sees the edition is down.
		await tx
			.select({ id: stories.id })
			.from(stories)
			.where(eq(stories.id, found.storyId))
			.for('share');
		// Re-checked under the lock: the writer may have made the story private,
		// trashed it or published a newer edition since the reader's page loaded.
		const [up] = await tx
			.select({ id: publications.id })
			.from(publications)
			.innerJoin(stories, eq(stories.id, publications.storyId))
			.innerJoin(users, eq(users.id, publications.ownerId))
			.where(and(eq(publications.id, publicationId), readersCanOpen()));
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
			// takedown takes that one down too (see newerEditionState).
			newerEdition: newerEditionState(),
			// Its id, which the takedown form posts back (see takedownPublication).
			newerEditionId: newerEditionId(),
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
		// The story lock takedownPublication also takes, so a takedown and a
		// dismissal on the same story run one after the other. A takedown does not
		// check the report it was posted from, so one after a dismissal still
		// goes ahead (when moderatorMayRead allows it) and leaves this report
		// dismissed; a dismissal after a takedown finds the report closed and
		// changes nothing.
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
			// Null when the moderator may no longer open the edition.
			title: titleModeratorMayRead(),
			resolvedByName: users.displayName
		})
		.from(publicationReports)
		.innerJoin(publications, eq(publications.id, publicationReports.publicationId))
		.innerJoin(stories, eq(stories.id, publications.storyId))
		.leftJoin(users, eq(users.id, publicationReports.resolvedBy))
		.where(sql`${publicationReports.resolvedAt} is not null`)
		.orderBy(desc(publicationReports.resolvedAt))
		.limit(limit);
}

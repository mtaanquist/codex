import { fail, type RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { requireModerator } from './roles';
import { formText } from './validation';
import { allowInBrowse, removeFromBrowse } from './browse';
import { editionReplaced, editionWithdrawn, takedownPublication } from './publish';
import { reportClosed } from './reports';
import { isUuid } from '#lib/slug';
import { isMicrosText } from './db-clock';
import { isReportReason } from '#lib/report-reasons';

const WITHDRAWN = 'The writer made this story private or moved it to the trash. Reload the page.';

// "Take down", "Remove from Browse" and "Allow in Browse again", shared by the
// Published and Reports pages. scope is the page's form scope for its messages.
export function moderationActions(scope: string) {
	return {
		takedown: async ({ request, locals }: RequestEvent) => {
			requireModerator(locals);
			const data = await request.formData();
			const publicationId = formText(data, 'publicationId');
			const reason = formText(data, 'reason');
			// Sent from the report queue: the report the moderator was looking at.
			const reportId = formText(data, 'reportId');
			// The newer edition the page showed this takedown also puts down
			// ('none' when it showed none), so a takedown is refused when that changed.
			const newer = data.has('newer') ? formText(data, 'newer') : undefined;
			if (newer !== undefined && newer !== 'none' && !isUuid(newer)) {
				return fail(400, { scope, message: 'Reload the page and try again.' });
			}
			const newerShown = newer === undefined ? undefined : newer === 'none' ? null : newer;
			if (!isReportReason(reason)) {
				return fail(400, { scope, message: 'Pick a reason for the takedown.' });
			}
			const outcome = isUuid(publicationId)
				? await takedownPublication(db, publicationId, locals.user!.id, reason, { newerShown })
				: false;
			if (outcome !== true) {
				if (isUuid(reportId) && (await reportClosed(db, reportId))) {
					return fail(409, {
						scope,
						message: 'This report is already closed. Reload the page to see what changed.'
					});
				}
				if (
					outcome === 'newer-changed' ||
					(isUuid(publicationId) && (await editionReplaced(db, publicationId)))
				) {
					return fail(409, {
						scope,
						message: 'This story has a newer edition. Reload the page and try again.'
					});
				}
				if (isUuid(publicationId) && (await editionWithdrawn(db, publicationId))) {
					return fail(409, { scope, message: WITHDRAWN });
				}
				return fail(400, { scope, message: 'That edition does not exist or is already down.' });
			}
			return { scope, done: true };
		},
		removeFromBrowse: async ({ request, locals }: RequestEvent) => {
			requireModerator(locals);
			const data = await request.formData();
			const storyId = formText(data, 'storyId');
			const reason = formText(data, 'reason');
			const reportId = formText(data, 'reportId') || null;
			if (!isReportReason(reason)) {
				return fail(400, { scope, message: 'Pick a reason.' });
			}
			if (reportId && !isUuid(reportId)) return fail(400, { scope, message: 'Pick a report.' });
			const outcome = isUuid(storyId)
				? await removeFromBrowse(db, storyId, locals.user!.id, reason, reportId)
				: false;
			if (
				outcome === 'report-closed' ||
				(outcome !== true && reportId && (await reportClosed(db, reportId)))
			) {
				return fail(409, {
					scope,
					message: 'This report is already closed. Reload the page to see what changed.'
				});
			}
			if (outcome === 'withdrawn') return fail(409, { scope, message: WITHDRAWN });
			if (!outcome) {
				return fail(400, { scope, message: 'That story does not exist or is already off Browse.' });
			}
			return { scope, done: true };
		},
		allowInBrowse: async ({ request, locals }: RequestEvent) => {
			requireModerator(locals);
			const data = await request.formData();
			const storyId = formText(data, 'storyId');
			// When the page showed the story removed, so a later removal is not lifted.
			const blockedShown = formText(data, 'browseBlockedAt');
			if (!isUuid(storyId)) {
				return fail(400, { scope, message: 'That story is not blocked from Browse.' });
			}
			if (!isMicrosText(blockedShown)) {
				return fail(400, { scope, message: 'Reload the page and try again.' });
			}
			const outcome = await allowInBrowse(db, storyId, locals.user!.id, { blockedShown });
			if (outcome === 'changed') {
				return fail(409, {
					scope,
					message:
						'This story was removed from Browse again since you loaded the page. Reload the page to see what changed.'
				});
			}
			if (!outcome) {
				return fail(400, { scope, message: 'That story is not blocked from Browse.' });
			}
			return { scope, done: true };
		}
	};
}

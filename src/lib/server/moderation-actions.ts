import { fail, type RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { requireModerator } from './roles';
import { formText } from './validation';
import { allowInBrowse, removeFromBrowse } from './browse';
import { editionReplaced, editionWithdrawn, takedownPublication } from './publish';
import { reportClosed } from './reports';
import { isUuid } from '#lib/slug';
import { isReportReason } from '#lib/report-reasons';

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
			if (
				!isUuid(publicationId) ||
				!(await takedownPublication(db, publicationId, locals.user!.id, reason, { newerShown }))
			) {
				if (isUuid(reportId) && (await reportClosed(db, reportId))) {
					return fail(409, {
						scope,
						message: 'This report is already closed. Reload the page to see what changed.'
					});
				}
				if (isUuid(publicationId) && (await editionReplaced(db, publicationId))) {
					return fail(409, {
						scope,
						message: 'This story has a newer edition. Reload the page and try again.'
					});
				}
				if (isUuid(publicationId) && (await editionWithdrawn(db, publicationId))) {
					return fail(409, {
						scope,
						message: 'The writer made this story private or moved it to the trash. Reload the page.'
					});
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
			if (
				!isUuid(storyId) ||
				!(await removeFromBrowse(db, storyId, locals.user!.id, reason, reportId))
			) {
				return fail(400, { scope, message: 'That story does not exist or is already off Browse.' });
			}
			return { scope, done: true };
		},
		allowInBrowse: async ({ request, locals }: RequestEvent) => {
			requireModerator(locals);
			const storyId = formText(await request.formData(), 'storyId');
			if (!isUuid(storyId) || !(await allowInBrowse(db, storyId, locals.user!.id))) {
				return fail(400, { scope, message: 'That story is not blocked from Browse.' });
			}
			return { scope, done: true };
		}
	};
}

import { fail, type RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { requireModerator } from './roles';
import { formText } from './validation';
import { allowInBrowse, removeFromBrowse } from './browse';
import { isUuid } from '#lib/slug';
import { isReportReason } from '#lib/report-reasons';

// "Remove from Browse" and "Allow in Browse again", shared by the Published
// and Reports pages. scope is the page's form scope for its messages.
export function browseModerationActions(scope: string) {
	return {
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
			if (!isUuid(storyId) || !(await allowInBrowse(db, storyId))) {
				return fail(400, { scope, message: 'That story is not blocked from Browse.' });
			}
			return { scope, done: true };
		}
	};
}

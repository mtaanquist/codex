import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import { requireModerator } from '#lib/server/roles';
import { takedownPublication } from '#lib/server/publish';
import { dismissReport, listOpenReports, listRecentlyResolved } from '#lib/server/reports';
import { formText } from '#lib/server/validation';
import { isReportReason } from '#lib/report-reasons';
import { browseModerationActions } from '#lib/server/browse-moderation-actions';

export const load: PageServerLoad = async ({ locals }) => {
	requireModerator(locals);
	return {
		reports: await listOpenReports(db),
		resolved: await listRecentlyResolved(db)
	};
};

export const actions: Actions = {
	...browseModerationActions('reports'),
	takedown: async ({ request, locals }) => {
		requireModerator(locals);
		const data = await request.formData();
		const publicationId = formText(data, 'publicationId');
		const reason = formText(data, 'reason');
		if (!isReportReason(reason)) {
			return fail(400, { scope: 'reports', message: 'Pick a reason for the takedown.' });
		}
		if (
			!isUuid(publicationId) ||
			!(await takedownPublication(db, publicationId, locals.user!.id, reason))
		) {
			return fail(400, {
				scope: 'reports',
				message: 'That edition does not exist or is already down.'
			});
		}
		return { scope: 'reports', done: true };
	},
	dismiss: async ({ request, locals }) => {
		requireModerator(locals);
		const reportId = formText(await request.formData(), 'reportId');
		if (!isUuid(reportId) || !(await dismissReport(db, reportId, locals.user!.id))) {
			return fail(400, { scope: 'reports', message: 'That report is already closed.' });
		}
		return { scope: 'reports', done: true };
	}
};

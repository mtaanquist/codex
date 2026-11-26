import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import { requireModerator } from '#lib/server/roles';
import { dismissReport, listOpenReports, listRecentlyResolved } from '#lib/server/reports';
import { formText } from '#lib/server/validation';
import { moderationActions } from '#lib/server/moderation-actions';

export const load: PageServerLoad = async ({ locals }) => {
	requireModerator(locals);
	return {
		reports: await listOpenReports(db),
		resolved: await listRecentlyResolved(db)
	};
};

export const actions: Actions = {
	...moderationActions('reports'),
	dismiss: async ({ request, locals }) => {
		requireModerator(locals);
		const reportId = formText(await request.formData(), 'reportId');
		if (!isUuid(reportId) || !(await dismissReport(db, reportId, locals.user!.id))) {
			return fail(400, { scope: 'reports', message: 'That report is already closed.' });
		}
		return { scope: 'reports', done: true };
	}
};

import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { publicEdition } from '#lib/server/publish';
import { createReport } from '#lib/server/reports';
import { rateLimit } from '#lib/server/rate-limit';
import { formText } from '#lib/server/validation';
import { isReportReason, MAX_REPORT_COMMENT } from '#lib/report-reasons';

// A reader's report about a published story. Anyone who can open the story
// can report it; nothing about the reporter is kept.
const REPORTS_PER_HOUR = 5;

async function edition(params: { handle: string; story: string }) {
	const found = await publicEdition(db, params.handle.toLowerCase(), params.story.toLowerCase());
	if (!found) error(404, 'Not found');
	return found;
}

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	const found = await edition(params);
	setHeaders({ 'x-robots-tag': 'noindex' });
	return {
		handle: params.handle.toLowerCase(),
		story: found.address,
		title: found.title,
		editionId: found.id
	};
};

export const actions: Actions = {
	default: async ({ params, request, getClientAddress }) => {
		const found = await edition(params);
		const data = await request.formData();
		const reason = formText(data, 'reason');
		const comment = formText(data, 'comment');
		// The edition the reader's page showed. A newer one since means they
		// would be reporting text they have not seen.
		const shown = formText(data, 'editionId');
		if (shown && shown !== found.id) {
			return fail(409, {
				reason,
				comment,
				message: 'This story has changed since you opened this page. Reload the page and try again.'
			});
		}
		if (!isReportReason(reason)) {
			return fail(400, { comment, message: 'Pick a reason for the report.' });
		}
		if (comment.length > MAX_REPORT_COMMENT) {
			return fail(400, {
				reason,
				comment,
				message: `Keep the comment to ${MAX_REPORT_COMMENT} characters.`
			});
		}
		if (!rateLimit(`report:ip:${getClientAddress()}`, REPORTS_PER_HOUR, 3600 * 1000).allowed) {
			return fail(429, {
				reason,
				comment,
				message: 'Too many reports from here just now. Try again in an hour.'
			});
		}
		if (!(await createReport(db, found.id, reason, comment))) {
			return fail(409, {
				reason,
				comment,
				message: 'This story is no longer available, so your report was not sent.'
			});
		}
		return { sent: true };
	}
};

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
		title: found.title
	};
};

export const actions: Actions = {
	default: async ({ params, request, getClientAddress }) => {
		const found = await edition(params);
		const data = await request.formData();
		const reason = formText(data, 'reason');
		const comment = formText(data, 'comment');
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
		await createReport(db, found.id, reason, comment);
		return { sent: true };
	}
};

import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import { requireModerator } from '#lib/server/roles';
import { listPublications, takedownPublication } from '#lib/server/publish';
import { formText } from '#lib/server/validation';
import { isReportReason } from '#lib/report-reasons';
import { browseModerationActions } from '#lib/server/browse-moderation-actions';

export const load: PageServerLoad = async ({ locals }) => {
	requireModerator(locals);
	return { published: await listPublications(db, 50) };
};

export const actions: Actions = {
	...browseModerationActions('published'),
	takedown: async ({ request, locals }) => {
		requireModerator(locals);
		const data = await request.formData();
		const publicationId = formText(data, 'publicationId');
		const reason = formText(data, 'reason');
		if (!isReportReason(reason)) {
			return fail(400, { scope: 'published', message: 'Pick a reason for the takedown.' });
		}
		if (
			!isUuid(publicationId) ||
			!(await takedownPublication(db, publicationId, locals.user!.id, reason))
		) {
			return fail(400, { scope: 'published', message: 'That edition does not exist.' });
		}
		return { scope: 'published', done: true };
	}
};

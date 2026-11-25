import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import { requireModerator } from '#lib/server/roles';
import {
	listBrowseBlocked,
	listLiveEditions,
	listTakenDown,
	restorePublication,
	takedownPublication
} from '#lib/server/publish';
import { formText } from '#lib/server/validation';
import { isReportReason } from '#lib/report-reasons';
import { browseModerationActions } from '#lib/server/browse-moderation-actions';

// The live list pages through ?page=N (zero-based) and searches ?q=.
export const load: PageServerLoad = async ({ locals, url }) => {
	requireModerator(locals);
	return {
		live: await listLiveEditions(db, {
			query: url.searchParams.get('q') ?? '',
			page: Number(url.searchParams.get('page')) || 0
		}),
		browseBlocked: await listBrowseBlocked(db),
		takenDown: await listTakenDown(db)
	};
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
	},
	restore: async ({ request, locals }) => {
		requireModerator(locals);
		const publicationId = formText(await request.formData(), 'publicationId');
		if (!isUuid(publicationId) || !(await restorePublication(db, publicationId))) {
			return fail(400, {
				scope: 'published',
				message: 'That edition is not taken down, or its author has asked to delete their account.'
			});
		}
		return { scope: 'published', done: true };
	}
};

import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import { requireModerator } from '#lib/server/roles';
import {
	listBrowseBlocked,
	listLiveEditions,
	listTakenDown,
	restorePublication
} from '#lib/server/publish';
import { formText } from '#lib/server/validation';
import { moderationActions } from '#lib/server/moderation-actions';

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
	...moderationActions('published'),
	restore: async ({ request, locals }) => {
		requireModerator(locals);
		const publicationId = formText(await request.formData(), 'publicationId');
		if (!isUuid(publicationId) || !(await restorePublication(db, publicationId, locals.user!.id))) {
			return fail(400, {
				scope: 'published',
				message: 'That edition is not taken down, or its author has asked to delete their account.'
			});
		}
		return { scope: 'published', done: true };
	}
};

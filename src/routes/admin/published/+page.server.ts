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
import { isMicrosText } from '#lib/server/db-clock';
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
		const data = await request.formData();
		const publicationId = formText(data, 'publicationId');
		// When the page showed the edition taken down, so a later takedown is not lifted.
		const takenDownShown = formText(data, 'takenDownAt');
		if (isUuid(publicationId) && !isMicrosText(takenDownShown)) {
			return fail(400, { scope: 'published', message: 'Reload the page and try again.' });
		}
		const outcome = isUuid(publicationId)
			? await restorePublication(db, publicationId, locals.user!.id, { takenDownShown })
			: false;
		if (outcome === 'changed') {
			return fail(409, {
				scope: 'published',
				message:
					'This edition was taken down again since you loaded the page. Reload the page to see what changed.'
			});
		}
		if (!outcome) {
			return fail(400, {
				scope: 'published',
				message: 'That edition is not taken down, or its author has asked to delete their account.'
			});
		}
		return { scope: 'published', done: true };
	}
};

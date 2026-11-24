import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import { requireModerator } from '#lib/server/roles';
import { listPublications, takedownPublication } from '#lib/server/publish';
import { formText } from '#lib/server/validation';

export const load: PageServerLoad = async ({ locals }) => {
	requireModerator(locals);
	return { published: await listPublications(db, 50) };
};

export const actions: Actions = {
	takedown: async ({ request, locals }) => {
		requireModerator(locals);
		const data = await request.formData();
		const publicationId = formText(data, 'publicationId');
		if (
			!isUuid(publicationId) ||
			!(await takedownPublication(db, publicationId, locals.user!.id))
		) {
			return fail(400, { scope: 'published', message: 'That edition does not exist.' });
		}
		return { scope: 'published', done: true };
	}
};

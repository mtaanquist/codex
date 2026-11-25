import type { Actions, PageServerLoad } from './$types';
import { loadTagPage, tagActions } from '#lib/server/tag-moderation-actions';

export const load: PageServerLoad = async ({ locals, url }) => loadTagPage(locals, url, 'tag');

export const actions: Actions = tagActions('tag');

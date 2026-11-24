import type { Actions, PageServerLoad } from './$types';
import { listActions, loadTagPage } from '#lib/server/tag-moderation-actions';

export const load: PageServerLoad = async ({ locals, url }) => loadTagPage(locals, url, 'genre');

export const actions: Actions = listActions('genre');

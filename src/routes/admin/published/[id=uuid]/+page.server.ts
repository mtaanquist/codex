import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { requireModerator } from '#lib/server/roles';
import { moderatorEdition } from '#lib/server/publish';

// A moderator's read-only view of one edition in any state, so the text of a
// taken-down or hidden edition can still be checked before a restore.
export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
	requireModerator(locals);
	const edition = await moderatorEdition(db, params.id);
	if (!edition) error(404, 'Not found');
	setHeaders({ 'x-robots-tag': 'noindex' });
	return { edition };
};

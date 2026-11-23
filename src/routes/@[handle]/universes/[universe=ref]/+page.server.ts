import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { publicAuthorIdentity, publicUniverse, publicUniverseRedirect } from '#lib/server/publish';
import { isUuid } from '#lib/slug';
import { OLD_SLUG_REDIRECT_HEADERS } from '#lib/server/slugs';
import { authorNameOrHandle } from '#lib/author-name';

// A universe's public page: its name and the author's listed stories in it,
// at /@handle/universes/<universe slug> (or its id). Public and unguarded
// like the shelf, and like the shelf it shows only frozen editions. A
// universe with nothing listed is a 404, so its name never leaks. A slug
// the universe had before a rename redirects permanently to the current one.
export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
	const handle = params.handle.toLowerCase();
	const ref = params.universe.toLowerCase();
	const [universe, identity] = await Promise.all([
		publicUniverse(db, handle, ref),
		publicAuthorIdentity(db, handle)
	]);
	if (!universe) {
		const moved = isUuid(ref) ? null : await publicUniverseRedirect(db, handle, ref);
		if (moved) {
			setHeaders(OLD_SLUG_REDIRECT_HEADERS);
			redirect(
				308,
				resolve('/@[handle]/universes/[universe=ref]', { handle, universe: moved }) + url.search
			);
		}
		error(404, 'Not found');
	}
	return {
		handle,
		slug: universe.slug,
		name: universe.name,
		shelf: universe.shelf,
		author: authorNameOrHandle(identity, handle)
	};
};

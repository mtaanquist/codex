import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { publicAuthorIdentity, publicUniverse } from '#lib/server/publish';
import { authorNameOrHandle } from '#lib/author-name';

// A universe's public page: its name and the author's listed stories in it,
// at /@handle/universes/<universe slug> (or its id). Public and unguarded
// like the shelf, and like the shelf it shows only frozen editions. A
// universe with nothing listed is a 404, so its name never leaks.
export const load: PageServerLoad = async ({ params }) => {
	const handle = params.handle.toLowerCase();
	const [universe, identity] = await Promise.all([
		publicUniverse(db, handle, params.universe.toLowerCase()),
		publicAuthorIdentity(db, handle)
	]);
	if (!universe) error(404, 'Not found');
	return {
		handle,
		name: universe.name,
		shelf: universe.shelf,
		author: authorNameOrHandle(identity, handle)
	};
};

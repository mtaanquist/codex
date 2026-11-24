import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { browseEnabled } from '#lib/server/settings';
import { browseAuthors, browseStories, resolveFilters } from '#lib/server/browse';
import { listEntries } from '#lib/server/tags';
import { rateLimit } from '#lib/server/rate-limit';
import { browseIndexable, parseBrowseQuery } from '#lib/browse';

const SEARCHES_PER_MINUTE = 30;
// Filter and paging requests run several queries too, so they have a looser
// limit of their own.
const PAGES_PER_MINUTE = 120;

export const load: PageServerLoad = async ({ url, getClientAddress }) => {
	if (!(await browseEnabled(db))) error(404, 'Not found');
	const query = parseBrowseQuery(url.searchParams);
	const ip = getClientAddress();
	if (
		!rateLimit(`browse:pages:${ip}`, PAGES_PER_MINUTE, 60_000).allowed ||
		(query.q && !rateLimit(`browse:ip:${ip}`, SEARCHES_PER_MINUTE, 60_000).allowed)
	) {
		error(429, 'Too many searches just now. Wait a minute and try again.');
	}
	const filters = await resolveFilters(db, query);
	const [{ books, next }, authors, genres, fandoms, warnings] = await Promise.all([
		browseStories(db, query, filters),
		query.after ? Promise.resolve([]) : browseAuthors(db, query.q, query.adult),
		listEntries(db, 'genre'),
		listEntries(db, 'fandom'),
		listEntries(db, 'warning')
	]);
	return {
		query: { ...query, after: query.after !== null },
		filters: {
			genre: filters.genre?.name ?? null,
			fandom: filters.fandom?.name ?? null,
			tag: filters.tag ? { name: filters.tag.name, slug: filters.tag.slug } : null
		},
		books,
		next,
		authors,
		lists: {
			genres: genres.map(({ name, slug }) => ({ name, slug })),
			fandoms: fandoms.map(({ name, slug }) => ({ name, slug })),
			warnings: warnings.map(({ name, slug }) => ({ name, slug }))
		},
		// A filter naming nothing that exists is an empty page; keep it out of
		// search engines.
		indexable:
			browseIndexable(query) &&
			Boolean(query.genre) === Boolean(filters.genre) &&
			Boolean(query.fandom) === Boolean(filters.fandom) &&
			Boolean(query.tag) === Boolean(filters.tag)
	};
};

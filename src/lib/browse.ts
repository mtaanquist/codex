// The Browse page's query string: what the reader searched for and how they
// filtered. Shared with the browser, which builds the filter links.

export const BROWSE_PAGE_SIZE = 24;
const MAX_QUERY = 100;
const MAX_HIDDEN = 20;

export type BrowseQuery = {
	q: string;
	genre: string | null;
	fandom: string | null;
	tag: string | null;
	// Content warning slugs; stories with any of them are left out.
	hide: string[];
	adult: boolean;
	after: { micros: string; id: string } | null;
};

const SLUG = /^[\p{L}\p{N}\p{M}'&.,:!?()/+#_-]{1,60}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slugParam(value: string | null): string | null {
	const trimmed = value?.trim().toLowerCase() ?? '';
	return SLUG.test(trimmed) ? trimmed : null;
}

// The keyset cursor for the next page: the last story's edition time in
// microseconds since 1970 (Postgres keeps microseconds, which a JS Date would
// round away and so skip rows) and its id. The time stays a digit string.
export function encodeCursor(micros: string, id: string): string {
	return `${micros}_${id}`;
}

export function decodeCursor(value: string | null): { micros: string; id: string } | null {
	const match = /^(\d{1,18})_(.+)$/.exec(value ?? '');
	if (!match || !UUID.test(match[2])) return null;
	return { micros: match[1], id: match[2] };
}

export function parseBrowseQuery(params: URLSearchParams): BrowseQuery {
	return {
		q: (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY),
		genre: slugParam(params.get('genre')),
		fandom: slugParam(params.get('fandom')),
		tag: slugParam(params.get('tag')),
		hide: [
			...new Set(
				params
					.getAll('hide')
					.map(slugParam)
					.filter((slug): slug is string => slug !== null)
			)
		].slice(0, MAX_HIDDEN),
		adult: params.get('adult') === 'show',
		after: decodeCursor(params.get('after'))
	};
}

// Search engines may index the plain page and a page for one genre, fandom or
// tag. A search, a combination of filters, adult work or a later page is not.
export function browseIndexable(query: BrowseQuery): boolean {
	const filters = [query.genre, query.fandom, query.tag].filter(Boolean).length;
	return (
		!query.q && filters <= 1 && query.hide.length === 0 && !query.adult && query.after === null
	);
}

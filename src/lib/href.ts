import type { ResolvedPathname } from '$app/types';

export type QueryValue = string | number | boolean | null | undefined | readonly string[];

/**
 * A path from resolve() with query parameters (and an optional hash) added.
 * Null, undefined and empty values are left out, a list repeats its key once
 * per item, and a path that already has a query string is extended. The result keeps the ResolvedPathname type, so
 * links and goto() built from it pass the navigation lint.
 */
export function withQuery(
	path: ResolvedPathname,
	query: Record<string, QueryValue>,
	hash?: string
): ResolvedPathname {
	const hashAt = path.indexOf('#');
	const base = hashAt === -1 ? path : path.slice(0, hashAt);
	const queryAt = base.indexOf('?');
	const params = new URLSearchParams(queryAt === -1 ? '' : base.slice(queryAt + 1));
	for (const [key, value] of Object.entries(query)) {
		if (value === null || value === undefined || value === '') continue;
		if (Array.isArray(value)) {
			params.delete(key);
			for (const item of value) params.append(key, item);
		} else {
			params.set(key, String(value));
		}
	}
	const search = params.toString();
	const pathname = queryAt === -1 ? base : base.slice(0, queryAt);
	const fragment = hash ?? (hashAt === -1 ? '' : path.slice(hashAt + 1));
	return `${pathname}${search ? `?${search}` : ''}${fragment ? `#${fragment}` : ''}` as ResolvedPathname;
}

/**
 * A form action (`?/name`) that keeps the page's own query parameters, so a
 * plain POST renders the same search and page again. A previous action's
 * `/name` key is dropped.
 */
export function actionKeepingQuery(action: string, search: Iterable<[string, string]>): string {
	const params = new URLSearchParams();
	for (const [key, value] of search) if (!key.startsWith('/')) params.append(key, value);
	const rest = params.toString();
	return `?/${action}${rest ? `&${rest}` : ''}`;
}

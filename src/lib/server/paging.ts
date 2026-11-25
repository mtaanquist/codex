// Far past any real list, and small enough that page times page size stays a
// valid Postgres OFFSET (a huge ?page= otherwise fails the query).
export const MAX_PAGE = 100_000;

/** A zero-based page index from untrusted input: whole, at least 0, at most MAX_PAGE. */
export function pageIndex(page: number): number {
	return Math.min(MAX_PAGE, Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)));
}

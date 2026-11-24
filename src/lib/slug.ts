// Slug helpers shared by URLs and export filenames. Used from the worker
// (export bundles), so keep this dependency-free.

export const SLUG_MAX = 60;

export function slugify(text: string | null, fallback: string): string {
	const slug = (text ?? '')
		.toLowerCase()
		.normalize('NFKD')
		// Drop combining marks so accented letters fold to their base form.
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SLUG_MAX)
		.replace(/-+$/, '');
	return slug || fallback;
}

// The bare UUID grammar (lowercase, as crypto.randomUUID writes it), shared
// by the slug check and the asset-link regexes in markdown.ts and
// import-markdown.ts so the export writer and import reader cannot drift on
// what an asset id looks like. Compose it into each regex with its own
// anchors, capture groups, and flags.
export const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const UUID_PATTERN = new RegExp(`^${UUID_BODY}$`);

export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/**
 * A slug an author may set by hand: lowercase letters, digits, and inner
 * hyphens. Never uuid-shaped, so a slug can never shadow an id lookup.
 */
export function isValidSlug(value: string): boolean {
	return (
		value.length <= SLUG_MAX && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) && !isUuid(value)
	);
}

// Looser than SLUG_MAX: the 0035 backfill could append "-N" and an id
// fragment to a 60-character base, and those slugs are still live.
const PUBLIC_REF_MAX = 100;

/**
 * An address under /@handle: a story or universe id, or its slug. Case does
 * not matter here (handles are matched the same way); lookups lowercase it.
 */
export function isPublicRef(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		isUuid(lower) ||
		(lower.length <= PUBLIC_REF_MAX && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(lower))
	);
}

/**
 * The public address of a story or universe listed by slug. A uuid-shaped
 * ref is always looked up as an id, so a slug of that shape is linked by the
 * id instead. Such a slug comes from a title that slugifies to a uuid, saved
 * by the 0035 backfill or by a create or rename before uniqueSlug began
 * giving those a suffix.
 */
export function slugAddress(item: { id: string; slug: string }): string {
	return isUuid(item.slug.toLowerCase()) ? item.id : item.slug;
}

/**
 * The address a story's reading page is linked at: its slug when the story
 * is listed publicly, its id when unlisted. A slug comes from the title and
 * can be guessed, so an unlisted story answers only at its id.
 */
export function readingAddress(story: {
	id: string;
	slug: string;
	visibility: 'private' | 'unlisted' | 'public';
}): string {
	return story.visibility === 'public' ? slugAddress(story) : story.id;
}

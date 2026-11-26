// What a story is (genres), what a reader should know before reading
// (content warnings), and the free-form tags and fandoms an author adds.
// Genres, warnings and fandoms are lists moderators keep in the admin area.

export const MAX_GENRES = 3;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 50;
export const MAX_FANDOMS = 5;

// A tag's hidden key: lowercase, with spaces, hyphens and underscores as one
// separator, so "Found Family", "found-family" and "found_family" are the
// same tag. Empty when nothing usable is left.
export function tagSlug(name: string): string {
	return name
		.normalize('NFKC')
		.toLowerCase()
		.trim()
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// Letters and digits in any script, spaces, and a little punctuation.
const TAG_PATTERN = /^[\p{L}\p{N}\p{M} '&.,:!?()/+#_-]+$/u;

// Cleans one typed name, or says why it cannot be used. An empty name is
// not an error; callers skip it.
export function cleanTagName(
	raw: string
): { ok: true; name: string } | { ok: false; empty: boolean; reason: string } {
	const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
	if (!name) return { ok: false, empty: true, reason: 'Give it a name.' };
	if (name.length > MAX_TAG_LENGTH) {
		return {
			ok: false,
			empty: false,
			reason: `"${name.slice(0, 20)}..." is longer than ${MAX_TAG_LENGTH} characters.`
		};
	}
	if (!TAG_PATTERN.test(name) || !tagSlug(name)) {
		return {
			ok: false,
			empty: false,
			reason: `"${name}" can only use letters, digits, spaces and simple punctuation.`
		};
	}
	return { ok: true, name };
}

// Splits what was typed into the tag box: a comma or a new line ends a tag.
// Text that is exactly one of the suggestions stays whole, since older tags
// can contain a comma.
export function splitTags(text: string, suggestions: string[] = []): string[] {
	if (suggestions.includes(text.trim())) return [text.trim()];
	return text
		.split(/[,\n]/)
		.map((part) => part.trim())
		.filter(Boolean);
}

type ShownTag = { id: string; name: string; inherited?: boolean };

// What the Publish tag form edits, from the story's saved labels: genres by
// id, and the story's own fandoms and tags by name (a fandom from the
// universe is shown apart and cannot be removed here).
export function savedLabels(
	view: { genres: ShownTag[]; fandoms: ShownTag[]; tags: ShownTag[] } | null | undefined
): { genres: string[]; fandoms: string[]; tags: string[] } {
	return {
		genres: view?.genres.map((tag) => tag.id) ?? [],
		fandoms: view?.fandoms.filter((tag) => !tag.inherited).map((tag) => tag.name) ?? [],
		tags: view?.tags.map((tag) => tag.name) ?? []
	};
}

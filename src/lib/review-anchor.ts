import { diffChars, type Change } from 'diff';

// Re-anchors a review thread's character range after the text changed.
// Comments pin a [start, end) range against the revision they were made on;
// when the author edits, the range is mapped onto the current text by
// diffing the two versions. Both endpoints must land in unchanged text:
// edits elsewhere shift the range, insertions inside it stretch it, and
// deletions inside it shrink it, but if an endpoint's own text is gone the
// anchor is lost and the thread degrades to a whole-scene comment.
//
// These two have no limit on the work they do. The server maps through a
// mapper with a budget instead (createAnchorMapper).
export function reanchorRange(
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (start < 0 || end > baseText.length || start >= end) return null;
	if (baseText === currentText) return { start, end };
	return mapRange(compareTexts(baseText, currentText).spans!, start, end);
}

// Re-anchors a single position (a pure insertion point). The position
// survives if it lies in or at the boundary of unchanged text.
export function reanchorPoint(
	baseText: string,
	currentText: string,
	position: number
): number | null {
	if (position < 0 || position > baseText.length) return null;
	if (baseText === currentText) return position;
	return mapPoint(compareTexts(baseText, currentText).spans!, position);
}

// A stretch of text both versions share: where it starts in each, and its
// length.
type Span = { base: number; current: number; length: number };

type Comparison = {
	// The start and the end the two texts share, in characters.
	prefix: number;
	suffix: number;
	// Every shared stretch, in order; null when the middle was not diffed
	// (see createAnchorMapper).
	spans: Span[] | null;
	// What the diff cost, in the units of DiffBudget.
	cost: number;
};

const CHUNK = 256;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The length of the start and of the end two texts share, found by plain
// comparison (in chunks first, which the engine compares far faster than one
// character at a time). Neither may cut a surrogate pair in two, since the
// diff treats a pair as one character.
function sharedEnds(a: string, b: string): { prefix: number; suffix: number } {
	const shortest = Math.min(a.length, b.length);
	let prefix = 0;
	while (
		prefix + CHUNK <= shortest &&
		a.slice(prefix, prefix + CHUNK) === b.slice(prefix, prefix + CHUNK)
	) {
		prefix += CHUNK;
	}
	while (prefix < shortest && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
	if (prefix > 0 && isHighSurrogate(a.charCodeAt(prefix - 1))) prefix--;
	const room = shortest - prefix;
	let suffix = 0;
	while (
		suffix + CHUNK <= room &&
		a.slice(a.length - suffix - CHUNK, a.length - suffix) ===
			b.slice(b.length - suffix - CHUNK, b.length - suffix)
	) {
		suffix += CHUNK;
	}
	while (
		suffix < room &&
		a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
	) {
		suffix++;
	}
	if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--;
	return { prefix, suffix };
}

// Compares two texts: the shared start and end are found by plain comparison
// and only the middle between them is diffed, so a change costs what it
// touches rather than what the whole scene holds. `maxEdits`, given the
// middle's length, says how many characters added and removed the diff may
// look through before it stops; 0 is not to diff at all.
function compareTexts(
	baseText: string,
	currentText: string,
	limits?: { maxEdits: (middle: number) => number }
): Comparison {
	const { prefix, suffix } = sharedEnds(baseText, currentText);
	const baseMiddle = baseText.slice(prefix, baseText.length - suffix);
	const currentMiddle = currentText.slice(prefix, currentText.length - suffix);
	const middle = baseMiddle.length + currentMiddle.length;
	const ends: Span[] = [];
	if (prefix > 0) ends.push({ base: 0, current: 0, length: prefix });
	const tail: Span = {
		base: baseText.length - suffix,
		current: currentText.length - suffix,
		length: suffix
	};
	// A pure insertion or deletion: nothing in the middle is shared.
	if (baseMiddle === '' || currentMiddle === '') {
		return { prefix, suffix, spans: suffix > 0 ? [...ends, tail] : ends, cost: 0 };
	}
	const maxEdits = limits ? limits.maxEdits(middle) : undefined;
	if (maxEdits !== undefined && maxEdits < 1) return { prefix, suffix, spans: null, cost: 0 };
	const parts: Change[] | undefined =
		maxEdits === undefined
			? diffChars(baseMiddle, currentMiddle)
			: diffChars(baseMiddle, currentMiddle, { maxEditLength: maxEdits });
	if (!parts) {
		return { prefix, suffix, spans: null, cost: middle + maxEdits! * maxEdits! };
	}
	const spans = ends;
	let base = prefix;
	let current = prefix;
	let edits = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.added) {
			current += length;
			edits += part.count ?? length;
		} else if (part.removed) {
			base += length;
			edits += part.count ?? length;
		} else {
			spans.push({ base, current, length });
			base += length;
			current += length;
		}
	}
	if (suffix > 0) spans.push(tail);
	return { prefix, suffix, spans, cost: middle + edits * edits };
}

function mapRange(
	spans: Span[],
	start: number,
	end: number
): { start: number; end: number } | null {
	let newStart = -1;
	let newEnd = -1;
	for (const span of spans) {
		// Unchanged text: offsets inside it map by the running shift. The end
		// offset is exclusive, so it may land on this span's far boundary.
		if (start >= span.base && start < span.base + span.length) {
			newStart = span.current + (start - span.base);
		}
		if (end > span.base && end <= span.base + span.length) {
			newEnd = span.current + (end - span.base);
		}
	}
	if (newStart === -1 || newEnd === -1 || newEnd <= newStart) return null;
	return { start: newStart, end: newEnd };
}

function mapPoint(spans: Span[], position: number): number | null {
	for (const span of spans) {
		if (position >= span.base && position <= span.base + span.length) {
			return span.current + (position - span.base);
		}
	}
	return null;
}

// How much work one mapper may do. The character diff runs in the server's
// one thread, so while it runs nobody else is answered. Its cost grows with
// the length of the text that differs (after the shared start and end) and
// with the square of the characters added and removed in it, and a mapper is
// charged both: `middle + edits * edits`, which on a typical server is
// roughly 50 nanoseconds a unit.
export type DiffBudget = {
	// The longest differing stretch, the two versions together, one pair of
	// texts may have for it to be diffed at all.
	maxMiddle: number;
	// The most characters added and removed one diff looks through.
	maxEdits: number;
	// The total one mapper may spend over every pair of texts it compares.
	maxWork: number;
};

// The writer's own pages and the Assistant working for them in the app.
// Generous: about half a second of work at worst for a whole page.
export const WRITER_DIFF_BUDGET: DiffBudget = {
	maxMiddle: 1_000_000,
	maxEdits: 2000,
	maxWork: 10_000_000
};

// Every thread and suggestion anchored to the same scene revision re-anchors
// against the same two texts. A mapper compares each pair of texts once and
// maps every anchor through that one result. Make one per request and hand it
// to everything that re-anchors, so the cost is per revision rather than per
// comment, and the budget is for the whole request.
export type AnchorMapper = {
	range(
		baseText: string,
		currentText: string,
		start: number,
		end: number
	): { start: number; end: number } | null;
	point(baseText: string, currentText: string, position: number): number | null;
	// Whether the budget ran out before these two texts were diffed, so a null
	// from the mapper may mean "not looked for", not "gone".
	gaveUp(baseText: string, currentText: string): boolean;
};

// Past its budget a mapper places only what lies in the start or the end the
// two texts share; anything else is null, and `gaveUp` says so.
export function createAnchorMapper(budget: DiffBudget): AnchorMapper {
	let spent = 0;
	// Nested by base text then current text, so neither key has to be
	// concatenated into a third copy of the scene.
	const cache = new Map<string, Map<string, Comparison>>();
	const compare = (baseText: string, currentText: string): Comparison => {
		let byCurrent = cache.get(baseText);
		if (!byCurrent) {
			byCurrent = new Map();
			cache.set(baseText, byCurrent);
		}
		let found = byCurrent.get(currentText);
		if (!found) {
			found = compareTexts(baseText, currentText, {
				// The most edits this diff may look through so that its cost
				// cannot take the mapper past its budget.
				maxEdits: (middle) =>
					middle > budget.maxMiddle
						? 0
						: Math.min(
								budget.maxEdits,
								Math.floor(Math.sqrt(Math.max(0, budget.maxWork - spent - middle)))
							)
			});
			spent += found.cost;
			byCurrent.set(currentText, found);
		}
		return found;
	};
	return {
		range(baseText, currentText, start, end) {
			if (start < 0 || end > baseText.length || start >= end) return null;
			if (baseText === currentText) return { start, end };
			const found = compare(baseText, currentText);
			if (found.spans) return mapRange(found.spans, start, end);
			if (end <= found.prefix) return { start, end };
			if (start >= baseText.length - found.suffix) {
				const shift = currentText.length - baseText.length;
				return { start: start + shift, end: end + shift };
			}
			return null;
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			const found = compare(baseText, currentText);
			if (found.spans) return mapPoint(found.spans, position);
			if (position <= found.prefix) return position;
			if (position >= baseText.length - found.suffix) {
				return position + currentText.length - baseText.length;
			}
			return null;
		},
		gaveUp(baseText, currentText) {
			return baseText !== currentText && compare(baseText, currentText).spans === null;
		}
	};
}

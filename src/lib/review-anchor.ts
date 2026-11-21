import { diffChars, type Change } from 'diff';

// Re-anchors a review thread's character range after the text changed.
// Comments pin a [start, end) range against the revision they were made on;
// when the author edits, the range is mapped onto the current text by
// diffing the two versions. Both endpoints must land in unchanged text:
// edits elsewhere shift the range, insertions inside it stretch it, and
// deletions inside it shrink it, but if an endpoint's own text is gone the
// anchor is lost and the thread degrades to a whole-scene comment.
export function reanchorRange(
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (start < 0 || end > baseText.length || start >= end) return null;
	if (baseText === currentText) return { start, end };
	return mapRange(diffChars(baseText, currentText), start, end);
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
	return mapPoint(diffChars(baseText, currentText), position);
}

function mapRange(
	parts: Change[],
	start: number,
	end: number
): { start: number; end: number } | null {
	let basePos = 0;
	let currentPos = 0;
	let newStart = -1;
	let newEnd = -1;
	for (const part of parts) {
		const length = part.value.length;
		if (part.added) {
			currentPos += length;
			continue;
		}
		if (part.removed) {
			basePos += length;
			continue;
		}
		// Unchanged text: offsets inside it map by the running shift. The end
		// offset is exclusive, so it may land on this part's far boundary.
		if (start >= basePos && start < basePos + length) {
			newStart = currentPos + (start - basePos);
		}
		if (end > basePos && end <= basePos + length) {
			newEnd = currentPos + (end - basePos);
		}
		basePos += length;
		currentPos += length;
	}
	if (newStart === -1 || newEnd === -1 || newEnd <= newStart) return null;
	return { start: newStart, end: newEnd };
}

function mapPoint(parts: Change[], position: number): number | null {
	let basePos = 0;
	let currentPos = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.added) {
			currentPos += length;
			continue;
		}
		if (part.removed) {
			basePos += length;
			continue;
		}
		if (position >= basePos && position <= basePos + length) {
			return currentPos + (position - basePos);
		}
		basePos += length;
		currentPos += length;
	}
	return null;
}

// Every thread and suggestion anchored to the same scene revision re-anchors
// against the same two texts, and a character diff of a long scene costs
// hundreds of milliseconds. A mapper diffs each pair of texts once and maps
// every anchor through that one result. Make one per request and hand it to
// everything that re-anchors, so the cost is per revision rather than per
// comment.
export type AnchorMapper = {
	range(
		baseText: string,
		currentText: string,
		start: number,
		end: number
	): { start: number; end: number } | null;
	point(baseText: string, currentText: string, position: number): number | null;
	// Only on a bounded mapper: whether these two texts differ by more than
	// it will diff, so a null from it may mean "not looked for", not "gone".
	gaveUp?(baseText: string, currentText: string): boolean;
};

export function createAnchorMapper(): AnchorMapper {
	// Nested by base text then current text, so neither key has to be
	// concatenated into a third copy of the scene.
	const cache = new Map<string, Map<string, Change[]>>();
	const diff = (baseText: string, currentText: string): Change[] => {
		let byCurrent = cache.get(baseText);
		if (!byCurrent) {
			byCurrent = new Map();
			cache.set(baseText, byCurrent);
		}
		let parts = byCurrent.get(currentText);
		if (!parts) {
			parts = diffChars(baseText, currentText);
			byCurrent.set(currentText, parts);
		}
		return parts;
	};
	return {
		range(baseText, currentText, start, end) {
			if (start < 0 || end > baseText.length || start >= end) return null;
			if (baseText === currentText) return { start, end };
			return mapRange(diff(baseText, currentText), start, end);
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			return mapPoint(diff(baseText, currentText), position);
		}
	};
}

// A mapper that never does more than a set amount of work. The character
// diff runs in the caller's thread and its cost grows with the square of what
// changed: twenty thousand rewritten characters hold a server for seconds.
// This one stops the diff once the texts are known to differ by more than
// `maxEdits` characters added and removed. Past that it places what it can
// without a diff: an anchor in the start or the end the two texts share, and
// a range whose text stands exactly once in the current text. Anything else
// is null, and `gaveUp` says the diff was stopped.
export function createBoundedAnchorMapper(maxEdits: number): AnchorMapper {
	type Pair = { prefix: number; suffix: number; parts: Change[] | null };
	const cache = new Map<string, Map<string, Pair>>();
	const compare = (baseText: string, currentText: string): Pair => {
		let byCurrent = cache.get(baseText);
		if (!byCurrent) {
			byCurrent = new Map();
			cache.set(baseText, byCurrent);
		}
		let pair = byCurrent.get(currentText);
		if (!pair) {
			const parts = diffChars(baseText, currentText, { maxEditLength: maxEdits }) ?? null;
			let prefix = 0;
			let suffix = 0;
			if (!parts) {
				const shortest = Math.min(baseText.length, currentText.length);
				while (prefix < shortest && baseText[prefix] === currentText[prefix]) prefix++;
				while (
					suffix < shortest - prefix &&
					baseText[baseText.length - 1 - suffix] === currentText[currentText.length - 1 - suffix]
				) {
					suffix++;
				}
			}
			pair = { prefix, suffix, parts };
			byCurrent.set(currentText, pair);
		}
		return pair;
	};
	// A position in the start or the end the texts share, moved to where it
	// is now; null for one in between.
	const shared = (pair: Pair, baseText: string, currentText: string, position: number) => {
		if (position <= pair.prefix) return position;
		if (position >= baseText.length - pair.suffix) {
			return position + currentText.length - baseText.length;
		}
		return null;
	};
	return {
		range(baseText, currentText, start, end) {
			if (start < 0 || end > baseText.length || start >= end) return null;
			if (baseText === currentText) return { start, end };
			const pair = compare(baseText, currentText);
			if (pair.parts) return mapRange(pair.parts, start, end);
			if (end <= pair.prefix) return { start, end };
			if (start >= baseText.length - pair.suffix) {
				const shift = currentText.length - baseText.length;
				return { start: start + shift, end: end + shift };
			}
			const original = baseText.slice(start, end);
			const at = currentText.indexOf(original);
			if (at === -1 || currentText.indexOf(original, at + 1) !== -1) return null;
			return { start: at, end: at + original.length };
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			const pair = compare(baseText, currentText);
			if (pair.parts) return mapPoint(pair.parts, position);
			return shared(pair, baseText, currentText, position);
		},
		gaveUp(baseText, currentText) {
			return baseText !== currentText && compare(baseText, currentText).parts === null;
		}
	};
}

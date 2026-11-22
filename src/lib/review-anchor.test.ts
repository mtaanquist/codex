import { describe, it, expect, vi } from 'vitest';
import { diffChars } from 'diff';
import {
	createAnchorMapper,
	reanchorPoint,
	reanchorRange,
	WRITER_DIFF_BUDGET,
	type DiffBudget
} from './review-anchor';

// Wrapped so a test can count the diffs a mapper runs.
vi.mock('diff', async (importOriginal) => {
	const actual = await importOriginal<typeof import('diff')>();
	return { ...actual, diffChars: vi.fn(actual.diffChars) };
});

const BASE = 'The quick brown fox jumps over the lazy dog.';
// Anchor "brown fox" = [10, 19).
const START = BASE.indexOf('brown');
const END = START + 'brown fox'.length;

// How anchors were mapped before the shared start and end were set aside: a
// diff of the two whole texts.
type Spans = { base: number; current: number; length: number }[];
function wholeDiff(base: string, current: string): Spans {
	const spans: Spans = [];
	let b = 0;
	let c = 0;
	for (const part of diffChars(base, current)) {
		const length = part.value.length;
		if (part.added) c += length;
		else if (part.removed) b += length;
		else {
			spans.push({ base: b, current: c, length });
			b += length;
			c += length;
		}
	}
	return spans;
}
function wholeDiffRange(spans: Spans, baseLength: number, start: number, end: number) {
	if (start < 0 || end > baseLength || start >= end) return null;
	let newStart = -1;
	let newEnd = -1;
	for (const span of spans) {
		if (start >= span.base && start < span.base + span.length)
			newStart = span.current + start - span.base;
		if (end > span.base && end <= span.base + span.length) newEnd = span.current + end - span.base;
	}
	return newStart === -1 || newEnd === -1 || newEnd <= newStart
		? null
		: { start: newStart, end: newEnd };
}
function wholeDiffPoint(spans: Spans, baseLength: number, position: number) {
	if (position < 0 || position > baseLength) return null;
	for (const span of spans) {
		if (position >= span.base && position <= span.base + span.length)
			return span.current + position - span.base;
	}
	return null;
}

// Every point and range of the base text on which the mapper and a diff of
// the whole texts disagree.
function disagreements(base: string, current: string) {
	const spans =
		base === current ? [{ base: 0, current: 0, length: base.length }] : wholeDiff(base, current);
	const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
	const found: unknown[] = [];
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	for (let start = -1; start <= base.length + 1; start++) {
		const point = mapper.point(base, current, start);
		if (!same(point, wholeDiffPoint(spans, base.length, start)))
			found.push({ base, current, start });
		for (let end = start; end <= base.length + 1; end++) {
			const range = mapper.range(base, current, start, end);
			if (!same(range, wholeDiffRange(spans, base.length, start, end)))
				found.push({ base, current, start, end });
		}
	}
	return found;
}

// A small seeded generator, so a failure can be replayed.
function random(seed: number) {
	let state = seed;
	return (below: number) => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return Math.floor((state / 2147483648) * below);
	};
}

describe('reanchorRange', () => {
	it('returns the range unchanged when the text is unchanged', () => {
		expect(reanchorRange(BASE, BASE, START, END)).toEqual({ start: START, end: END });
	});

	it('shifts the range when text changes before it', () => {
		const current = 'A very ' + BASE;
		const result = reanchorRange(BASE, current, START, END);
		expect(result).toEqual({ start: START + 7, end: END + 7 });
		expect(current.slice(result!.start, result!.end)).toBe('brown fox');
	});

	it('keeps the range in place when text changes after it', () => {
		const current = BASE.replace('lazy dog', 'sleeping cat');
		expect(reanchorRange(BASE, current, START, END)).toEqual({ start: START, end: END });
	});

	it('stretches over an insertion inside the range', () => {
		const current = BASE.replace('brown fox', 'brown furry fox');
		const result = reanchorRange(BASE, current, START, END);
		expect(current.slice(result!.start, result!.end)).toBe('brown furry fox');
	});

	it('shrinks over a deletion inside the range', () => {
		const current = BASE.replace('quick brown fox', 'quick fox');
		// Anchor "quick brown fox".
		const s = BASE.indexOf('quick');
		const e = s + 'quick brown fox'.length;
		const result = reanchorRange(BASE, current, s, e);
		expect(current.slice(result!.start, result!.end)).toBe('quick fox');
	});

	it('loses the anchor when its text is rewritten', () => {
		const current = BASE.replace('brown fox', 'red vixen');
		expect(reanchorRange(BASE, current, START, END)).toBeNull();
	});

	it('loses the anchor when the range is deleted entirely', () => {
		const current = BASE.replace('brown fox ', '');
		expect(reanchorRange(BASE, current, START, END)).toBeNull();
	});

	it('rejects a degenerate or out-of-bounds range', () => {
		expect(reanchorRange(BASE, BASE, 5, 5)).toBeNull();
		expect(reanchorRange(BASE, BASE, -1, 5)).toBeNull();
		expect(reanchorRange(BASE, BASE, 0, BASE.length + 1)).toBeNull();
	});

	it('survives an edit at the very start and end of the text', () => {
		const current = 'Lo! ' + BASE.slice(0, -1) + '!';
		const result = reanchorRange(BASE, current, START, END);
		expect(current.slice(result!.start, result!.end)).toBe('brown fox');
	});
});

describe('reanchorPoint', () => {
	it('maps a position through surrounding edits', () => {
		const pos = BASE.indexOf('fox');
		expect(reanchorPoint(BASE, BASE, pos)).toBe(pos);
		expect(reanchorPoint(BASE, 'Lo! ' + BASE, pos)).toBe(pos + 4);
		expect(reanchorPoint(BASE, BASE.replace('lazy dog', 'cat'), pos)).toBe(pos);
	});

	it('survives at the start and end of the text', () => {
		expect(reanchorPoint(BASE, 'X' + BASE, 0)).not.toBeNull();
		expect(reanchorPoint(BASE, BASE + '!', BASE.length)).toBe(BASE.length);
	});

	it('loses a position whose surrounding text was removed', () => {
		const pos = BASE.indexOf('brown') + 2;
		expect(reanchorPoint(BASE, BASE.replace('brown fox', 'X'), pos)).toBeNull();
	});

	it('rejects out-of-bounds positions', () => {
		expect(reanchorPoint(BASE, BASE, -1)).toBeNull();
		expect(reanchorPoint(BASE, BASE, BASE.length + 1)).toBeNull();
	});
});

describe('createAnchorMapper', () => {
	// The mapper reuses one diff per pair of texts, so what it returns has to
	// stay identical to re-anchoring each anchor on its own.
	const CASES: Array<[string, string]> = [
		[BASE, BASE],
		[BASE, 'A very ' + BASE],
		[BASE, BASE.replace('lazy dog', 'sleeping cat')],
		[BASE, BASE.replace('brown fox', 'brown furry fox')],
		[BASE, BASE.replace('brown fox', 'red vixen')],
		[BASE, BASE.replace('brown fox ', '')]
	];

	it('matches reanchorRange on every offset', () => {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		for (const [base, current] of CASES) {
			for (let start = 0; start < base.length; start++) {
				for (let end = start; end <= base.length + 1; end++) {
					expect(mapper.range(base, current, start, end)).toEqual(
						reanchorRange(base, current, start, end)
					);
				}
			}
		}
	});

	it('matches reanchorPoint on every position', () => {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		for (const [base, current] of CASES) {
			for (let position = -1; position <= base.length + 1; position++) {
				expect(mapper.point(base, current, position)).toEqual(
					reanchorPoint(base, current, position)
				);
			}
		}
	});

	it('keeps separate results for different current texts against one base', () => {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const shifted = 'A very ' + BASE;
		const rewritten = BASE.replace('brown fox', 'red vixen');
		expect(mapper.range(BASE, shifted, START, END)).toEqual({ start: START + 7, end: END + 7 });
		expect(mapper.range(BASE, rewritten, START, END)).toBeNull();
		// Repeating the first pair still maps through its own diff, not the second's.
		expect(mapper.range(BASE, shifted, START, END)).toEqual({ start: START + 7, end: END + 7 });
	});

	it('diffs each pair of texts once however many anchors map through it', () => {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const current = BASE.replace('lazy dog', 'sleeping cat');
		vi.mocked(diffChars).mockClear();
		const first = mapper.range(BASE, current, START, END);
		for (let i = 0; i < 1000; i++) mapper.range(BASE, current, START, END);
		expect(mapper.point(BASE, current, START)).toBe(START);
		expect(mapper.range(BASE, current, START, END)).toEqual(first);
		expect(diffChars).toHaveBeenCalledTimes(1);
	});

	it('diffs only what lies between the start and the end the texts share', () => {
		const long = 'The harbour lay quiet under a low grey sky. '.repeat(2000);
		const current = `${long}A new line. ${long}`;
		vi.mocked(diffChars).mockClear();
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const at = long.length + 10;
		expect(mapper.point(long + long, current, at)).toBe(at + 'A new line. '.length);
		// A pure insertion leaves nothing to diff.
		expect(diffChars).not.toHaveBeenCalled();
		const replaced = `${long}A new line. ${long.slice(5)}`;
		mapper.point(long + long, replaced, at);
		const [[base, now]] = vi.mocked(diffChars).mock.calls;
		expect(base.length + now.length).toBeLessThan(100);
	});
});

// Setting the shared start and end aside must not change where an anchor
// goes. Where the texts have one shortest alignment, the result must be
// exactly that of a diff of the whole texts. Where several are equally short
// (a repeated letter at the edge of a change, say), the two may pick
// different ones, so there the test holds the mapper to what any shortest
// alignment gives.
describe('createAnchorMapper against a diff of the whole texts', () => {
	// Words of lowercase letters that stay, and runs of digits that are all
	// taken out or replaced by capitals, with more capitals put in between:
	// no character that goes can match one that stays or one that comes, so
	// the shortest alignment is the only one.
	function forcedPair(next: (below: number) => number) {
		const words = ['the', 'harbour', 'lay', 'quiet', 'she', 'walked', 'in', 'a', 'of', ' ', '\n\n'];
		const pieces: { text: string; goes: boolean }[] = [];
		const length = 2 + next(30);
		for (let i = 0; i < length; i++) {
			const goes = next(4) === 0;
			pieces.push({
				text: goes
					? String(next(10 ** (1 + next(4))))
					: words[next(words.length)] + (next(2) ? ' ' : ''),
				goes
			});
		}
		// Changes at the very start or end, or none there.
		if (next(3) === 0) pieces.unshift({ text: String(next(1000)), goes: true });
		if (next(3) === 0) pieces.push({ text: String(next(1000)), goes: true });
		const capitals = () => ['', 'X', 'NEW', 'RAINCAME'][next(4)];
		const base = pieces.map((piece) => piece.text).join('');
		const current = pieces
			.map((piece) => (piece.goes ? capitals() : piece.text) + (next(6) === 0 ? capitals() : ''))
			.join('');
		return { base, current };
	}

	it('gives exactly the same anchors where the alignment is forced', () => {
		const next = random(7);
		for (let round = 0; round < 200; round++) {
			const { base, current } = forcedPair(next);
			expect(disagreements(base, current)).toEqual([]);
		}
	});

	it('keeps as much text and only text that is still there, whatever the alignment', () => {
		const next = random(11);
		const letters = ['a', 'b', 'ab', ' '];
		const text = (length: number) =>
			Array.from({ length }, () => letters[next(letters.length)]).join('');
		for (let round = 0; round < 300; round++) {
			const base = text(5 + next(60));
			let current = base;
			for (let edits = 1 + next(3); edits > 0; edits--) {
				const at = next(current.length + 1);
				current = current.slice(0, at) + text(next(6)) + current.slice(at + next(8));
			}
			const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
			const spans = wholeDiff(base, current);
			let kept = 0;
			let keptBefore = 0;
			let shared = 0;
			while (shared < Math.min(base.length, current.length) && base[shared] === current[shared])
				shared++;
			for (let position = 0; position <= base.length; position++) {
				const now = mapper.point(base, current, position);
				if (now !== null) {
					// A position lands next to the same character it stood next to.
					const sameBefore = position > 0 && now > 0 && base[position - 1] === current[now - 1];
					const sameAfter = position < base.length && base[position] === current[now];
					expect(sameBefore || sameAfter || (position === 0 && now === 0)).toBe(true);
				}
				// In the shared start nothing moves, as before.
				if (shared > 0 && position <= shared) {
					expect(now).toBe(position);
					expect(now).toBe(wholeDiffPoint(spans, base.length, position));
				}
				if (position === base.length) break;
				const one = mapper.range(base, current, position, position + 1);
				if (one) {
					kept++;
					expect(current[one.start]).toBe(base[position]);
					expect(one.end - one.start).toBe(1);
				}
				if (wholeDiffRange(spans, base.length, position, position + 1)) keptBefore++;
			}
			// Both keep a longest run of shared characters.
			expect(kept).toBe(keptBefore);
		}
	});

	it('does not split a character written as two code units', () => {
		const cases: Array<[string, string]> = [
			['a\u{1F600}b', 'a\u{1F603}b'],
			['\u{1F600}', '\u{1F603}'],
			['x\u{1F600}', 'y\u{1F600}'],
			['😀z', '🨀z'],
			['ab\u{1F600}cd', 'ab\u{1F600}\u{1F600}cd']
		];
		for (const [base, current] of cases) expect(disagreements(base, current)).toEqual([]);
	});
});

describe('createAnchorMapper with a budget', () => {
	const old = 'The harbour lay quiet under a low grey sky. '.repeat(200);
	const rewritten = 'Rain came in from the west before noon and stayed on. '.repeat(170);
	const SMALL: DiffBudget = { maxMiddle: 100_000, maxEdits: 500, maxWork: 1_000_000 };

	it('places anchors as without one while the change is within it', () => {
		const base = `She held the lantern high.\n\n${old}`;
		const current = `She held the old lantern high.\n\nA new line. ${old}`;
		const bounded = createAnchorMapper(SMALL);
		expect(bounded.range(base, current, 13, 20)).toEqual(reanchorRange(base, current, 13, 20));
		expect(bounded.range(base, current, 100, 140)).toEqual(reanchorRange(base, current, 100, 140));
		expect(bounded.point(base, current, 60)).toBe(reanchorPoint(base, current, 60));
		expect(bounded.gaveUp(base, current)).toBe(false);
		expect(bounded.gaveUp(base, base)).toBe(false);
	});

	it('past its limit, places only what is in the shared start or end', () => {
		const base = `She held the lantern high.\n\n${old}\n\nA heron stood there.\n\nThe gull watched.`;
		const current = `She held the lantern high.\n\n${rewritten}\n\nNo heron today.\n\nThe gull watched.`;
		const bounded = createAnchorMapper(SMALL);
		const began = performance.now();
		expect(bounded.gaveUp(base, current)).toBe(true);
		// In the shared start: where it was.
		expect(bounded.range(base, current, 13, 20)).toEqual({ start: 13, end: 20 });
		expect(bounded.point(base, current, 4)).toBe(4);
		// In the shared end: moved by the change in length.
		const gull = base.indexOf('gull');
		const nowAt = current.indexOf('gull');
		expect(bounded.range(base, current, gull, gull + 4)).toEqual({ start: nowAt, end: nowAt + 4 });
		expect(bounded.point(base, current, gull)).toBe(nowAt);
		// In between, nothing: not even a word that stands once in the new text.
		const heron = base.indexOf('heron');
		expect(current.split('heron')).toHaveLength(2);
		expect(bounded.range(base, current, heron, heron + 5)).toBeNull();
		const quiet = base.indexOf('quiet');
		expect(bounded.range(base, current, quiet, quiet + 5)).toBeNull();
		expect(bounded.point(base, current, quiet)).toBeNull();
		// Straddling the change is not in the shared start or end either.
		expect(bounded.range(base, current, 13, gull + 4)).toBeNull();
		expect(performance.now() - began).toBeLessThan(250);
	});

	it('does not diff a middle longer than it allows', () => {
		const base = `A${old}${old}Z`;
		const current = `B${old}${old}Y`;
		const bounded = createAnchorMapper({ ...SMALL, maxMiddle: 1000 });
		vi.mocked(diffChars).mockClear();
		expect(bounded.gaveUp(base, current)).toBe(true);
		expect(diffChars).not.toHaveBeenCalled();
		// A small change elsewhere is still placed.
		const typo = old.replace('quiet', 'quite');
		expect(bounded.point(old, typo, old.length - 3)).toBe(old.length - 3);
		expect(bounded.gaveUp(old, typo)).toBe(false);
	});

	it('spends its budget over every pair it compares, not each pair alone', () => {
		// Each pair is cheap on its own; many are not.
		const versions = Array.from({ length: 40 }, (_, n) => `${n} ${old} ${n}`);
		const current = `now ${old} now`;
		const budget: DiffBudget = { maxMiddle: 100_000, maxEdits: 500, maxWork: 100_000 };
		const bounded = createAnchorMapper(budget);
		const began = performance.now();
		const placed = versions.filter((version) => !bounded.gaveUp(version, current)).length;
		expect(placed).toBeGreaterThan(0);
		expect(placed).toBeLessThan(versions.length);
		expect(performance.now() - began).toBeLessThan(250);
		// The same pairs on a fresh budget, one at a time, are all placed.
		for (const version of versions) {
			expect(createAnchorMapper(budget).gaveUp(version, current)).toBe(false);
		}
		// A pair already compared costs nothing more.
		const first = versions[0];
		expect(bounded.gaveUp(first, current)).toBe(false);
	});
});

import { describe, it, expect } from 'vitest';
import { diffChars } from 'diff';
import {
	createAnchorMapper,
	placeSuggestion,
	reanchorPoint,
	reanchorRange,
	SAVE_DIFF_BUDGET,
	WRITER_DIFF_BUDGET,
	type DiffBudget
} from './review-anchor';
import {
	join,
	paragraph,
	paragraphStarts,
	phraseIn,
	replaceShe,
	sceneParagraphs,
	seeded
} from '../../tests/prose';

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
// the whole texts disagree. With placedOnly, only a range the mapper places
// somewhere else (not one it leaves unplaced), and only a point it places
// next to neither character it stood between: a point between kept text and
// an insertion may go to either side of the insertion once a stray shared
// run beside it is left out.
function disagreements(base: string, current: string, placedOnly = false) {
	const spans =
		base === current ? [{ base: 0, current: 0, length: base.length }] : wholeDiff(base, current);
	const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
	const found: unknown[] = [];
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const besideSame = (at: number, now: number) =>
		(at > 0 && now > 0 && base[at - 1] === current[now - 1]) ||
		(at < base.length && base[at] === current[now]);
	for (let start = -1; start <= base.length + 1; start++) {
		const point = mapper.point(base, current, start);
		const whole = wholeDiffPoint(spans, base.length, start);
		if (
			placedOnly
				? point !== null && point !== whole && !besideSame(start, point)
				: !same(point, whole)
		)
			found.push({ base, current, start });
		for (let end = start; end <= base.length + 1; end++) {
			const range = mapper.range(base, current, start, end);
			if (
				!(placedOnly && range === null) &&
				!same(range, wholeDiffRange(spans, base.length, start, end))
			)
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

	it('keeps a word whole when a word ending in its first letter is added before it', () => {
		const base = 'She held the lantern high.';
		const current = 'She held the old lantern high, and the lantern shook.';
		const at = base.indexOf('lantern');
		const result = reanchorRange(base, current, at, at + 'lantern'.length);
		expect(result).toEqual({
			start: current.indexOf('lantern'),
			end: current.indexOf('lantern') + 7
		});
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

	it('compares each pair of texts once however many anchors map through it', () => {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const current = BASE.replace('lazy dog', 'sleeping cat');
		const first = mapper.range(BASE, current, START, END);
		const spent = mapper.spent();
		expect(spent).toBeGreaterThan(0);
		for (let i = 0; i < 1000; i++) mapper.range(BASE, current, START, END);
		expect(mapper.point(BASE, current, START)).toBe(START);
		expect(mapper.unchecked(BASE, current, START, END)).toBe(false);
		expect(mapper.range(BASE, current, START, END)).toEqual(first);
		expect(mapper.spent()).toBe(spent);
	});

	it('compares only the paragraphs between the start and the end the texts share', () => {
		const paragraphs = sceneParagraphs(21, 120_000);
		const long = join(paragraphs);
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		// A few words typed into one paragraph cost about what that paragraph
		// holds, not what the scene holds.
		const into = paragraphStarts(paragraphs)[100] + 20;
		const typed = `${long.slice(0, into)}a few new words ${long.slice(into)}`;
		const at = paragraphStarts(paragraphs)[150];
		expect(mapper.point(long, typed, at)).toBe(at + 'a few new words '.length);
		expect(mapper.spent()).toBeLessThan(20 * paragraphs[100].length + 5000);
	});
});

// Comparing paragraph by paragraph must not move an anchor anywhere a diff of
// the whole texts would not. Where the texts have one shortest alignment, an
// anchor the mapper places must be exactly where that diff places it. Where
// several are equally short (a repeated letter at the edge of a change, say),
// the two may pick different ones, so there the test holds the mapper to what
// any shortest alignment gives. In a stretch that changed a lot, the mapper
// leaves out the letters and short words two texts share by chance (see
// withoutStrays), so it may place less than the whole diff, never more.
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

	it('places anchors only where the whole diff does, where the alignment is forced', () => {
		const next = random(7);
		let placed = 0;
		let placedBefore = 0;
		for (let round = 0; round < 200; round++) {
			const { base, current } = forcedPair(next);
			expect(disagreements(base, current, true)).toEqual([]);
			const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
			const spans = base === current ? null : wholeDiff(base, current);
			for (let at = 0; at < base.length; at++) {
				if (mapper.range(base, current, at, at + 1)) placed++;
				if (!spans || wholeDiffRange(spans, base.length, at, at + 1)) placedBefore++;
			}
		}
		// These texts are mostly changes, so what it leaves out as shared by
		// chance is a fair part, but well under half.
		expect(placed).toBeGreaterThan(0.65 * placedBefore);
	});

	it('gives exactly the same anchors where a forced change is small', () => {
		// One change in a longer text: nothing is left out by chance.
		const next = random(17);
		const words = ['the ', 'harbour ', 'lay ', 'quiet ', 'she ', 'walked ', 'in ', '\n\n'];
		for (let round = 0; round < 200; round++) {
			const text = Array.from({ length: 20 + next(20) }, () => words[next(words.length)]);
			const at = next(text.length);
			const base = [...text.slice(0, at), String(next(1000)), ...text.slice(at)].join('');
			const current = [...text.slice(0, at), ['', 'X', 'NEW'][next(3)], ...text.slice(at)].join('');
			expect(disagreements(base, current)).toEqual([]);
		}
	});

	it('keeps as much text and only text that is still there, whatever the alignment', () => {
		const next = random(11);
		const letters = ['a', 'b', 'ab', ' '];
		const text = (length: number) =>
			Array.from({ length }, () => letters[next(letters.length)]).join('');
		let keptAll = 0;
		let keptAllBefore = 0;
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
			// Never more than a longest run of shared characters; less only by
			// what it leaves out by chance.
			expect(kept).toBeLessThanOrEqual(keptBefore);
			keptAll += kept;
			keptAllBefore += keptBefore;
		}
		expect(keptAll).toBeGreaterThan(0.9 * keptAllBefore);
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
	const SMALL: DiffBudget = { perPair: 1_000_000, total: 1_000_000, floor: 0 };

	it('places anchors as without one while the change is within it', () => {
		const base = `She held the lantern high.\n\n${old}`;
		const current = `She held the old lantern high.\n\nA new line. ${old}`;
		const bounded = createAnchorMapper(SMALL);
		expect(bounded.range(base, current, 13, 20)).toEqual(reanchorRange(base, current, 13, 20));
		expect(bounded.range(base, current, 100, 140)).toEqual(reanchorRange(base, current, 100, 140));
		expect(bounded.point(base, current, 60)).toBe(reanchorPoint(base, current, 60));
		expect(bounded.unchecked(base, current, 100, 140)).toBe(false);
		expect(bounded.unchecked(base, base, 100, 140)).toBe(false);
	});

	it('past its limit, leaves what it did not compare unchecked and places the rest', () => {
		const base = `She held the lantern high.\n\n${old}\n\nA heron stood there.\n\nThe gull watched.`;
		const current = `She held the lantern high.\n\n${rewritten}\n\nNo heron today.\n\nThe gull watched.`;
		const bounded = createAnchorMapper({ perPair: 1000, total: 1000, floor: 0 });
		const began = performance.now();
		// In the shared start: where it was.
		expect(bounded.range(base, current, 13, 20)).toEqual({ start: 13, end: 20 });
		expect(bounded.point(base, current, 4)).toBe(4);
		// In the shared end: moved by the change in length.
		const gull = base.indexOf('gull');
		const nowAt = current.indexOf('gull');
		expect(bounded.range(base, current, gull, gull + 4)).toEqual({ start: nowAt, end: nowAt + 4 });
		// In between, nothing, and it says it did not look.
		const heron = base.indexOf('heron');
		expect(bounded.range(base, current, heron, heron + 5)).toBeNull();
		expect(bounded.unchecked(base, current, heron, heron + 5)).toBe(true);
		const quiet = base.indexOf('quiet');
		expect(bounded.point(base, current, quiet)).toBeNull();
		expect(bounded.unchecked(base, current, quiet, quiet)).toBe(true);
		// What it placed is checked.
		expect(bounded.unchecked(base, current, 13, 20)).toBe(false);
		expect(performance.now() - began).toBeLessThan(250);
	});

	it('tells a passage that is gone from one it did not look for', () => {
		const base = 'The kettle was cold.\n\nA heron stood in the reeds.\n\nTobin waited.';
		const current = 'The kettle was cold.\n\nNo bird came that day.\n\nTobin waited.';
		const heron = base.indexOf('heron');
		const full = createAnchorMapper(WRITER_DIFF_BUDGET);
		expect(full.range(base, current, heron, heron + 5)).toBeNull();
		expect(full.unchecked(base, current, heron, heron + 5)).toBe(false);
		const starved = createAnchorMapper({ perPair: 0, total: 0, floor: 0 });
		expect(starved.range(base, current, heron, heron + 5)).toBeNull();
		expect(starved.unchecked(base, current, heron, heron + 5)).toBe(true);
	});

	it('gives up on a stretch that cannot line up without holding up the rest', () => {
		// Two long paragraphs rewritten from scratch, and a word fixed in a
		// short one: the short one is placed whatever the long ones cost.
		const base = `${old}\n\nKeep one.\n\nShe held the lantern high.\n\nKeep two.\n\n${old}`;
		const current = `${rewritten}\n\nKeep one.\n\nShe held the lamp high.\n\nKeep two.\n\n${rewritten}`;
		const mapper = createAnchorMapper(SMALL);
		const began = performance.now();
		const she = base.indexOf('She held');
		expect(mapper.range(base, current, she, she + 8)).toEqual({
			start: current.indexOf('She held'),
			end: current.indexOf('She held') + 8
		});
		expect(mapper.unchecked(base, current, 10, 20)).toBe(true);
		expect(mapper.unchecked(base, current, base.length - 20, base.length - 10)).toBe(true);
		expect(mapper.spent()).toBeLessThanOrEqual(SMALL.perPair + 100_000);
		expect(performance.now() - began).toBeLessThan(250);
	});

	it('spends its budget over every pair it compares, with a floor for each', () => {
		// Each pair is cheap on its own; many are not.
		const versions = Array.from({ length: 40 }, (_, n) => `${n} ${old} ${n}`);
		const current = `now ${old} now`;
		const at = old.length / 2;
		const placed = (budget: DiffBudget) => {
			const mapper = createAnchorMapper(budget);
			const count = versions.filter((version) => mapper.point(version, current, at) !== null);
			return { count: count.length, mapper };
		};
		const { count, mapper } = placed({ perPair: 1_000_000, total: 200_000, floor: 0 });
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(versions.length);
		expect(mapper.unchecked(versions.at(-1)!, current, at, at)).toBe(true);
		// A pair already compared costs nothing more.
		const spent = mapper.spent();
		mapper.point(versions[0], current, at);
		expect(mapper.spent()).toBe(spent);
		// With a floor for each pair, every cheap one is placed.
		expect(placed({ perPair: 1_000_000, total: 200_000, floor: 100_000 }).count).toBe(
			versions.length
		);
	});
});

// Long scenes with the kind of edits a writer makes: the mapper must place
// every anchor whose paragraph was left alone, however much changed around it.
describe('createAnchorMapper on a long scene', () => {
	const exactly = (paragraphs: string[], index: number, at: [number, number]) => {
		const start = paragraphStarts(paragraphs)[index] + at[0];
		return { start, end: start + at[1] - at[0] };
	};

	// One range in every paragraph of `before` that is unchanged in `after`
	// (same index, same text), mapped and compared with where it now is.
	function unchangedMisplaced(before: string[], after: string[]) {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const base = join(before);
		const current = join(after);
		const wrong: number[] = [];
		let checked = 0;
		for (let i = 0; i < before.length; i++) {
			if (before[i] !== after[i]) continue;
			const at = phraseIn(before[i]);
			if (!at) continue;
			checked++;
			const was = exactly(before, i, at);
			const now = mapper.range(base, current, was.start, was.end);
			if (JSON.stringify(now) !== JSON.stringify(exactly(after, i, at))) wrong.push(i);
		}
		return { wrong, checked };
	}

	it('places every anchor in an unchanged paragraph after a word is replaced everywhere', () => {
		const before = sceneParagraphs(1, 120_000);
		const after = before.map(replaceShe);
		const { wrong, checked } = unchangedMisplaced(before, after);
		expect(checked).toBeGreaterThan(20);
		expect(wrong).toEqual([]);
	});

	it('places every anchor in an unchanged paragraph after a tenth of them are rewritten', () => {
		const before = sceneParagraphs(2, 120_000);
		const next = seeded(3);
		const after = before.map((text) => (next(10) === 0 ? paragraph(next) : text));
		const { wrong, checked } = unchangedMisplaced(before, after);
		expect(checked).toBeGreaterThan(100);
		expect(wrong).toEqual([]);
	});

	it('places a hundred suggestions made on a hundred versions that differ only at the ends', () => {
		const middle = sceneParagraphs(4, 120_000);
		const version = (n: number | string) =>
			join([
				`Draft ${n} begins here. ${middle[0]}`,
				...middle.slice(1, -1),
				`${middle.at(-1)} End ${n}.`
			]);
		const current = version('final');
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const wrong: number[] = [];
		for (let n = 0; n < 100; n++) {
			const base = version(n);
			const index = 1 + Math.floor((n * (middle.length - 2)) / 100);
			const at = phraseIn(middle[index]) ?? [0, 4];
			const offset = (text: string) => text.indexOf(middle[index]) + at[0];
			const start = offset(base);
			const now = mapper.range(base, current, start, start + at[1] - at[0]);
			const want = offset(current);
			if (now?.start !== want || now.end !== want + at[1] - at[0]) wrong.push(n);
		}
		expect(wrong).toEqual([]);
	});

	it('finds a range ending a paragraph that moved to the end of the scene', () => {
		const p1 = 'The kettle was cold when she came down.';
		const p2 = 'Snow had come in the night and the yard held the light.';
		const p3 = 'Tobin was already at the door with the cart.';
		const base = [p1, p2, p3].join('\n\n');
		const current = [p1, p3, p2].join('\n\n');
		const start = base.indexOf('light.');
		const now = createAnchorMapper(WRITER_DIFF_BUDGET).range(base, current, start, start + 6);
		expect(now).toEqual({ start: current.indexOf('light.'), end: current.indexOf('light.') + 6 });
	});
});

describe('placeSuggestion', () => {
	const place = (base: string, current: string, start: number, end: number) =>
		placeSuggestion(createAnchorMapper(WRITER_DIFF_BUDGET), base, current, start, end);

	// The writer adds a paragraph above that holds the same word: the edit
	// lands on its own passage or nowhere, never in the new paragraph.
	it('never places an edit in a new paragraph that holds the same words', () => {
		const cases: [string, string, string][] = [
			['He sat by the window. The kettle was cold.', 'Hours passed. He slept badly.\n\n', 'He'],
			[
				'She opened the door and the snow came in.',
				'Snow fell all night and She had not slept.\n\n',
				'She'
			]
		];
		for (const [base, added, word] of cases) {
			const now = place(base, added + base, 0, word.length);
			if (now !== null)
				expect(now).toEqual({ start: added.length, end: added.length + word.length });
		}
	});

	it('still places an edit next to which a word was added', () => {
		expect(place('She walked in.', 'She slowly walked in.', 4, 13)).toEqual({ start: 11, end: 20 });
		const quick = BASE.indexOf('quick');
		expect(place(BASE, BASE.replace('quick', 'very quick'), quick, quick + 5)).toEqual({
			start: quick + 5,
			end: quick + 10
		});
		expect(place(BASE, BASE.replace('brown fox', 'brown fox, quick as ever,'), START, END)).toEqual(
			{ start: START, end: END }
		);
		expect(place(BASE, 'Lo! ' + BASE, START, END)).toEqual({ start: START + 4, end: END + 4 });
	});

	it('refuses a passage with words added inside it', () => {
		expect(place(BASE, BASE.replace('brown fox', 'brown furry fox'), START, END)).toBeNull();
	});

	it('places an insertion point as a point', () => {
		expect(place(BASE, 'Lo! ' + BASE, START, START)).toEqual({ start: START + 4, end: START + 4 });
	});
});

describe('createAnchorMapper ends and findWords (for markers)', () => {
	const p1 = 'The kettle was cold when she came down.';
	const p2 = 'Snow had come in the night and the yard held the light.';
	const p3 = 'Tobin was already at the door with the cart.';

	it('follows a range inside a paragraph that moved, but not one reaching out of it', () => {
		const base = [p1, p2, p3].join('\n\n');
		const current = [p2, p1, p3].join('\n\n');
		const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
		const one = mapper.ends(base, current, base.indexOf('kettle'), base.indexOf('kettle') + 6);
		expect(one && current.slice(one.start, one.end)).toBe('kettle');
		const two = mapper.ends(base, current, base.indexOf('yard'), base.indexOf('yard') + 4);
		expect(two && current.slice(two.start, two.end)).toBe('yard');
		// From the end of the first paragraph into the second.
		expect(mapper.ends(base, current, base.indexOf('down'), base.indexOf('Snow') + 4)).toBeNull();
	});

	it('stretches over words added at the edge of the range', () => {
		const base = 'Alice pays the toll.';
		const current = 'Alice gladly pays the toll.';
		const now = createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, 6, 10);
		expect(now && current.slice(now.start, now.end)).toBe('gladly pays');
	});

	it('finds the words of an unchecked range when they stand once in what that part became', () => {
		const base = [p1, p2, p3].join('\n\n');
		const current = ['A new opening.', p2.replace('night', 'dark'), p3].join('\n\n');
		const starved = createAnchorMapper({ perPair: 0, total: 0, floor: 0 });
		const yard = base.indexOf('the yard');
		expect(starved.ends(base, current, yard, yard + 8)).toBeNull();
		expect(starved.unchecked(base, current, yard, yard)).toBe(true);
		expect(starved.findWords(base, current, yard, yard + 8)).toEqual({
			start: current.indexOf('the yard'),
			end: current.indexOf('the yard') + 8
		});
		// "the" stands more than once: no guess.
		expect(starved.findWords(base, current, yard, yard + 3)).toBeNull();
		// Words that are gone are not found.
		const night = base.indexOf('night');
		expect(starved.findWords(base, current, night, night + 5)).toBeNull();
	});
});

// The mapper against an unbounded diff of the two whole texts, on prose with
// the edits a writer makes. Inside a paragraph that was left alone (same text,
// same order) the mapper must give exactly where those words now are. A diff
// of the whole texts agrees there nearly always, but not always: next to a
// rewritten paragraph it can bind the first letters of the untouched one to
// letters of the rewrite, which puts the anchor in the wrong paragraph.
// Anywhere else, a place the mapper gives must be the exact one, or the one
// the whole diff gives, or hold the same text as before.
describe('createAnchorMapper against a whole diff, on edited prose', () => {
	const EMOJI = ['\u{1F319}', '\u{1F600}'];
	function smallParagraph(next: (below: number) => number) {
		let text = paragraph(next)
			.split(' ')
			.slice(0, 12 + next(30))
			.join(' ');
		if (next(4) === 0) {
			const words = text.split(' ');
			words[next(words.length)] += EMOJI[next(2)];
			text = words.join(' ');
		}
		return text;
	}

	// A paragraph of the edited text: which original paragraph it came from
	// (-1 for a new one), whether its text is untouched, and where each
	// character of the original now is in it (-1 for one that was changed).
	type Paragraph = { text: string; from: number; same: boolean; map: number[] };
	function editedPair(next: (below: number) => number) {
		const original = Array.from({ length: 5 + next(10) }, () => smallParagraph(next));
		let doc: Paragraph[] = original.map((text, from) => ({
			text,
			from,
			same: true,
			map: Array.from({ length: text.length }, (_, i) => i)
		}));
		// Rewrites one paragraph, given where each of its characters goes.
		const change = (p: Paragraph, text: string, goes: (at: number) => number): Paragraph => ({
			...p,
			text,
			same: false,
			map: p.map.map((at) => (at === -1 ? -1 : goes(at)))
		});
		for (let edits = 1 + next(4); edits > 0; edits--) {
			const at = next(doc.length);
			const kind = next(6);
			if (kind === 0) {
				// A typo: a letter struck wrong. A digit, which the prose never
				// holds, so the shortest alignment is the only one (two letters
				// swapped have two, and the whole diff may pick either).
				const text = doc[at].text;
				const i = next(text.length);
				if (/\p{L}/u.test(text[i])) {
					const typo = text.slice(0, i) + String(next(10)) + text.slice(i + 1);
					doc[at] = change(doc[at], typo, (from) => (from === i ? -1 : from));
				}
			} else if (kind === 1) {
				// A word replaced everywhere.
				const word = ['the', 'she', 'her', 'and'][next(4)];
				const pattern = new RegExp(`\\b${word}\\b`, 'g');
				doc = doc.map((p) => {
					const text = p.text.replace(pattern, 'Mara');
					if (text === p.text) return p;
					const goes: number[] = [];
					let shift = 0;
					let last = 0;
					for (const match of p.text.matchAll(pattern)) {
						for (let c = last; c < match.index; c++) goes[c] = c + shift;
						for (let c = match.index; c < match.index + word.length; c++) goes[c] = -1;
						last = match.index + word.length;
						shift += 'Mara'.length - word.length;
					}
					for (let c = last; c < p.text.length; c++) goes[c] = c + shift;
					return change(p, text, (from) => goes[from]);
				});
			} else if (kind === 2) {
				doc[at] = change(doc[at], smallParagraph(next), () => -1);
			} else if (kind === 3 && doc.length > 2) {
				const [moved] = doc.splice(at, 1);
				doc.splice(next(doc.length + 1), 0, { ...moved, same: false });
			} else if (kind === 4) {
				doc.splice(at, 0, { text: smallParagraph(next), from: -1, same: false, map: [] });
			} else if (doc.length > 2) {
				doc.splice(at, 1);
			}
		}
		const base = original.join('\n\n');
		const current = doc.map((p) => p.text).join('\n\n');
		return { original, doc, base, current };
	}

	const splits = (text: string, at: number) =>
		at > 0 &&
		at < text.length &&
		text.charCodeAt(at - 1) >= 0xd800 &&
		text.charCodeAt(at - 1) <= 0xdbff &&
		text.charCodeAt(at) >= 0xdc00 &&
		text.charCodeAt(at) <= 0xdfff;

	it('agrees inside untouched paragraphs, and elsewhere places only what it can stand by', () => {
		const next = seeded(31);
		let untouched = 0;
		let wholeOff = 0;
		for (let round = 0; round < 300; round++) {
			const { original, doc, base, current } = editedPair(next);
			const spans = wholeDiff(base, current);
			const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
			const baseStarts = paragraphStarts(original);
			const currentStarts = paragraphStarts(doc.map((p) => p.text));
			// exact(i, at): whether base character i is now at `at`, where that
			// is known. A blank line between two paragraphs with new ones put in
			// between could be any of the blank lines there, so any will do.
			const known = new Map<number, number>();
			const blank = new Map<number, [number, number]>();
			doc.forEach((p, j) => {
				if (p.from === -1) return;
				p.map.forEach((to, i) => {
					if (to !== -1) known.set(baseStarts[p.from] + i, currentStarts[j] + to);
				});
				if (p.from < original.length - 1 && j < doc.length - 1) {
					const after = baseStarts[p.from] + original[p.from].length;
					const following = doc.findIndex((q, k) => k > j && q.from === p.from + 1);
					const last = following === -1 ? currentStarts[j + 1] : currentStarts[following];
					blank.set(after, [currentStarts[j] + p.text.length, last - 1]);
					blank.set(after + 1, [currentStarts[j] + p.text.length, last - 1]);
				}
			});
			const exact = (i: number, at: number) => {
				const within = blank.get(i);
				if (within) return at >= within[0] && at <= within[1] && current[at] === '\n';
				return known.get(i) === at;
			};
			let lastFrom = -1;
			doc.forEach((p, j) => {
				if (!p.same || p.from < lastFrom) return;
				lastFrom = p.from;
				const length = p.text.length;
				for (let n = 0; n < 4; n++) {
					const a = next(length);
					const b = a + 1 + next(length - a);
					if (splits(p.text, a) || splits(p.text, b)) continue;
					untouched++;
					const start = baseStarts[p.from] + a;
					const want = { start: currentStarts[j] + a, end: currentStarts[j] + b };
					expect({ round, got: mapper.range(base, current, start, start + b - a) }).toEqual({
						round,
						got: want
					});
					const whole = wholeDiffRange(spans, base.length, start, start + b - a);
					if (JSON.stringify(whole) !== JSON.stringify(want)) wholeOff++;
				}
			});
			// Anywhere: what the mapper places is exact, or what the whole diff
			// places, or holds the same text; and never splits a character.
			for (let n = 0; n < 40; n++) {
				const start = next(base.length);
				const end = start + 1 + next(Math.min(40, base.length - start));
				if (splits(base, start) || splits(base, end)) continue;
				const got = mapper.range(base, current, start, end);
				if (got === null) continue;
				expect(splits(current, got.start) || splits(current, got.end)).toBe(false);
				const same = current.slice(got.start, got.end) === base.slice(start, end);
				const isExact = exact(start, got.start) && exact(end - 1, got.end - 1);
				const whole = wholeDiffRange(spans, base.length, start, end);
				if (!same && !isExact) {
					expect({ round, start, end, got }).toEqual({ round, start, end, got: whole });
				}
			}
			for (let n = 0; n < 20; n++) {
				const at = next(base.length + 1);
				if (splits(base, at)) continue;
				const point = mapper.point(base, current, at);
				if (point !== null) expect(splits(current, point)).toBe(false);
			}
		}
		expect(untouched).toBeGreaterThan(1000);
		// The whole diff misplaces a few of them; see above.
		expect(wholeOff).toBeLessThan(untouched / 20);
	});
});

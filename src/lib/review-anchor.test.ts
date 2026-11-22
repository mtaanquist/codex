import { describe, it, expect } from 'vitest';
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
	seeded,
	shortParagraphs
} from '../../tests/prose';
import { wholeTextPoint, wholeTextRange, wholeTextSpans } from '../../tests/main-anchor-oracle';
import { APP_DIFF_BUDGET } from './server/mcp/constants';

const BASE = 'The quick brown fox jumps over the lazy dog.';
// Anchor "brown fox" = [10, 19).
const START = BASE.indexOf('brown');
const END = START + 'brown fox'.length;

const UNBOUNDED: DiffBudget = { perPair: Infinity, total: Infinity, floor: 0 };

// Every point and range of the base text on which the mapper without the
// support rule and main's whole-text diff disagree, or on which the mapper
// with it gives anything but main's result or nothing.
function disagreements(base: string, current: string) {
	const spans = wholeTextSpans(base, current);
	const mapper = createAnchorMapper(UNBOUNDED);
	const loose = createAnchorMapper(UNBOUNDED, false);
	const found: unknown[] = [];
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	for (let start = -1; start <= base.length + 1; start++) {
		const main = wholeTextPoint(spans, base.length, start);
		const point = mapper.point(base, current, start);
		if (!same(loose.point(base, current, start), main) || (point !== null && point !== main))
			found.push({ base, current, start });
		for (let end = start; end <= base.length + 1; end++) {
			const main = wholeTextRange(spans, base.length, start, end);
			const range = mapper.range(base, current, start, end);
			if (!same(loose.range(base, current, start, end), main) || (range && !same(range, main)))
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

const quote = (text: string, at: { start: number; end: number } | null) =>
	at && text.slice(at.start, at.end);

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
	// The mapper reuses one comparison per pair of texts, so what it returns
	// has to stay identical to re-anchoring each anchor on its own.
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
		// Repeating the first pair still maps through its own result.
		expect(mapper.range(BASE, shifted, START, END)).toEqual({ start: START + 7, end: END + 7 });
	});

	it('compares each pair of texts once however many anchors map through it', () => {
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const current = BASE.replace('lazy dog', 'sleeping cat');
		const first = mapper.range(BASE, current, START, END);
		const spent = mapper.spent();
		for (let i = 0; i < 1000; i++) mapper.range(BASE, current, START, END);
		expect(mapper.point(BASE, current, START)).toBe(START);
		expect(mapper.unchecked(BASE, current, START, END)).toBe(false);
		expect(mapper.range(BASE, current, START, END)).toEqual(first);
		expect(mapper.spent()).toBe(spent);
	});

	it('compares only what lies between the start and the end the texts share', () => {
		const paragraphs = sceneParagraphs(21, 120_000);
		const long = join(paragraphs);
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const into = paragraphStarts(paragraphs)[100] + 20;
		const typed = `${long.slice(0, into)}a few new words ${long.slice(into)}`;
		const at = paragraphStarts(paragraphs)[150];
		expect(mapper.point(long, typed, at)).toBe(at + 'a few new words '.length);
		// A pure insertion is set aside by the start and end its sentence
		// shares, so there is nothing to diff.
		expect(mapper.spent()).toBe(0);
	});
});

// Inside a stretch that has to be compared character by character the
// mapper runs main's diff on that stretch, so where the texts have one
// shortest alignment the result must be exactly main's.
describe('createAnchorMapper against main, where the alignment is forced', () => {
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
			// Without the support rule, which refuses runs this short.
			const loose = createAnchorMapper(WRITER_DIFF_BUDGET, false);
			const spans = wholeTextSpans(base, current);
			let kept = 0;
			let keptLoose = 0;
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
				// In the shared start nothing moves, as on main.
				if (shared > 0 && position <= shared) {
					expect(now).toBe(position);
					expect(now).toBe(wholeTextPoint(spans, base.length, position));
				}
				if (position === base.length) break;
				for (const [which, count] of [
					[mapper, () => kept++],
					[loose, () => keptLoose++]
				] as const) {
					const one = which.range(base, current, position, position + 1);
					if (one) {
						count();
						expect(current[one.start]).toBe(base[position]);
						expect(one.end - one.start).toBe(1);
					}
				}
				if (wholeTextRange(spans, base.length, position, position + 1)) keptBefore++;
			}
			// Both keep a longest run of shared characters; the rule only drops.
			expect(keptLoose).toBe(keptBefore);
			expect(kept).toBeLessThanOrEqual(keptLoose);
		}
	});

	it('does not split a character written as two code units', () => {
		const cases: Array<[string, string]> = [
			['a\u{1F600}b', 'a\u{1F603}b'],
			['\u{1F600}', '\u{1F603}'],
			['x\u{1F600}', 'y\u{1F600}'],
			['😀z', '🨀z']
		];
		for (const [base, current] of cases) expect(disagreements(base, current)).toEqual([]);
		// A character put in next to its twin reads as either copy; a range
		// starting at it takes the later one (see Comparison.late), main the
		// earlier. Either way it holds the same text and splits nothing.
		const base = 'ab\u{1F600}cd';
		const current = 'ab\u{1F600}\u{1F600}cd';
		const mapper = createAnchorMapper(UNBOUNDED);
		for (let start = 0; start <= base.length; start++) {
			for (let end = start + 1; end <= base.length; end++) {
				if (start === 3 || end === 3) continue;
				const got = mapper.range(base, current, start, end);
				if (got && base.slice(start, end).length === got.end - got.start)
					expect(current.slice(got.start, got.end)).toBe(base.slice(start, end));
				if (got)
					expect(
						current.codePointAt(got.start)! >= 0xdc00 && current.codePointAt(got.start)! <= 0xdfff
					).toBe(false);
			}
		}
	});
});

describe('createAnchorMapper with a budget', () => {
	const old = 'The harbour lay quiet under a low grey sky. '.repeat(200);
	const rewritten = 'Rain came in from the west before noon and stayed on. '.repeat(170);
	const STARVED: DiffBudget = { perPair: 0, total: 0, floor: 0 };

	it('places anchors as without one while the change is within it', () => {
		const base = `She held the lantern high.\n\n${old}`;
		const current = `She held the old lantern high.\n\nA new line. ${old}`;
		// The two changes fall in one stretch of edit distance 4 + 12.
		const bounded = createAnchorMapper({ perPair: 256, total: 256, floor: 0 });
		expect(bounded.range(base, current, 13, 20)).toEqual(reanchorRange(base, current, 13, 20));
		expect(bounded.range(base, current, 100, 140)).toEqual(reanchorRange(base, current, 100, 140));
		expect(bounded.point(base, current, 60)).toBe(reanchorPoint(base, current, 60));
		expect(bounded.unchecked(base, current, 100, 140)).toBe(false);
		expect(bounded.unchecked(base, base, 100, 140)).toBe(false);
	});

	it('past its limit, leaves what it did not compare unchecked and places the rest', () => {
		const base = `She held the lantern high.\n\n${old}\n\nA heron stood there.\n\nThe gull watched.`;
		const current = `She held the lantern high.\n\n${rewritten}\n\nNo heron today.\n\nThe gull watched.`;
		const bounded = createAnchorMapper(STARVED);
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
		expect(bounded.spent()).toBe(0);
	});

	it('tells a passage that is gone from one it did not look for', () => {
		const base = 'The kettle was cold.\n\nA heron stood in the reeds.\n\nTobin waited.';
		const current = 'The kettle was cold.\n\nNo bird came that day.\n\nTobin waited.';
		const heron = base.indexOf('heron');
		const full = createAnchorMapper(WRITER_DIFF_BUDGET);
		expect(full.range(base, current, heron, heron + 5)).toBeNull();
		expect(full.unchecked(base, current, heron, heron + 5)).toBe(false);
		const starved = createAnchorMapper(STARVED);
		expect(starved.range(base, current, heron, heron + 5)).toBeNull();
		expect(starved.unchecked(base, current, heron, heron + 5)).toBe(true);
	});

	it('gives up on a stretch that cannot line up without holding up the rest', () => {
		// Two long paragraphs rewritten from scratch, and a word fixed in a
		// short one: the short one is placed whatever the long ones cost.
		const tide = 'The tide was out and the boats lay on their sides.';
		const base = `${old}\n\nKeep this one as it is.\n\nShe held the lantern high. ${tide}\n\nKeep two.\n\n${old}`;
		const current = `${rewritten}\n\nKeep this one as it is.\n\nShe held the lamp high. ${tide}\n\nKeep two.\n\n${rewritten}`;
		const mapper = createAnchorMapper({ perPair: 10_000, total: 10_000, floor: 0 });
		const she = base.indexOf('She held');
		expect(mapper.range(base, current, she, she + 8)).toEqual({
			start: current.indexOf('She held'),
			end: current.indexOf('She held') + 8
		});
		expect(mapper.unchecked(base, current, 10, 20)).toBe(true);
		expect(mapper.unchecked(base, current, base.length - 20, base.length - 10)).toBe(true);
		expect(mapper.spent()).toBeLessThanOrEqual(10_000);
	});

	it('spends its budget over every pair it compares, with a floor for each', () => {
		// Each pair needs a costly comparison of its own.
		const versions = Array.from({ length: 40 }, (_, n) => `${n} ${old.slice(n)}${rewritten} ${n}`);
		const current = `now ${old}${old} now`;
		const at = 2;
		const mapper = createAnchorMapper({ perPair: 1_000_000, total: 300_000, floor: 0 });
		for (const version of versions) mapper.point(version, current, at);
		expect(mapper.spent()).toBeLessThanOrEqual(300_000);
		expect(mapper.unchecked(versions.at(-1)!, current, 10, 10)).toBe(true);
		// A pair already compared costs nothing more.
		const spent = mapper.spent();
		mapper.point(versions[0], current, at);
		expect(mapper.spent()).toBe(spent);
		// With a floor for each pair, every cheap one is still placed.
		const cheap = createAnchorMapper({ perPair: 1_000_000, total: 0, floor: 100 });
		const typos = Array.from(
			{ length: 40 },
			(_, n) => `${old.slice(0, n * 50)}x${old.slice(n * 50)}`
		);
		for (const typo of typos) expect(cheap.point(typo, old, typo.length)).toBe(old.length);
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

// Regressions from the review of the levelled comparison. Each input is the
// one the finding gave.
describe('review findings', () => {
	const A = 'The kettle was cold when she came down to the kitchen.';
	const P1 = 'Snow had come in the night and the yard held the light.';
	const P2 = 'Tobin was already at the door with the cart and the mule.';
	const P3 = 'Neither of them spoke of the letter on the table.';
	const C = 'They set out before the bell rang for the morning office.';

	// H1: splitting or joining a paragraph keeps the anchors in the half that
	// moved, for comments and for markers.
	const halves: [string, string, string][] = [
		['split', `${A}\n\n${P1} ${P2}\n\n${C}`, `${A}\n\n${P1}\n\n${P2}\n\n${C}`],
		['join', `${A}\n\n${P1}\n\n${P2}\n\n${C}`, `${A}\n\n${P1} ${P2}\n\n${C}`],
		[
			'split mid-paragraph',
			`${A}\n\n${P1} ${P2} ${P3}\n\n${C}`,
			`${A}\n\n${P1} ${P2}\n\n${P3}\n\n${C}`
		],
		[
			'split inside a sentence',
			`${A}\n\n${P1} ${P2}\n\n${C}`,
			`${A}\n\n${P1} ${P2.replace(' with', '\n\nwith')}\n\n${C}`
		],
		[
			'CRLF and a split',
			`${A}\n\n${P1} ${P2}\n\n${C}`,
			`${A}\r\n\r\n${P1}\r\n\r\n${P2}\r\n\r\n${C}`
		]
	];
	for (const [name, base, current] of halves) {
		it(`H1: keeps an anchor in the half that moved (${name})`, () => {
			for (const words of ['the cart', 'Tobin was', 'the mule.', 'yard held']) {
				const start = base.indexOf(words);
				const want = { start: current.indexOf(words), end: current.indexOf(words) + words.length };
				const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
				expect({ words, got: mapper.range(base, current, start, start + words.length) }).toEqual({
					words,
					got: want
				});
				expect(mapper.unchecked(base, current, start, start + words.length)).toBe(false);
				const ends = createAnchorMapper(SAVE_DIFF_BUDGET).ends(
					base,
					current,
					start,
					start + words.length
				);
				expect({ words, ends }).toEqual({ words, ends: want });
			}
		});
	}

	// M1: of two identical lines, an edit on the first is never placed on the
	// second.
	it('M1: refuses an edit on one of two identical lines once the first was changed', () => {
		const base = 'She waited.\n"No."\n"No."\nHe left.';
		const current = 'She waited.\n"No, never."\n"No."\nHe left then.';
		const start = base.indexOf('"No."');
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		expect(placeSuggestion(mapper, base, current, start, start + 5)).toBeNull();
	});

	// M2: a short reply deleted and the same reply typed elsewhere is not a
	// move of the old one.
	it('M2: does not follow a short line deleted and typed again under another question', () => {
		const base =
			'She asked, "Will you come with me to the harbour?"\n"No."\nHe asked, "Is the road to the north still open?"\n"Not this week."';
		const current =
			'She asked, "Will you come with me to the harbour?"\nHe asked, "Is the road to the north still open?"\n"No."';
		const start = base.indexOf('"No."');
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		expect(placeSuggestion(mapper, base, current, start, start + 5)).toBeNull();
		expect(mapper.range(base, current, start, start + 5)).toBeNull();
		expect(createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, start, start + 5)).toBeNull();
	});

	// L2: a range that starts (or ends) with a line break does not stretch
	// over a paragraph put in at that edge.
	it('L2: a range with a line break at its edge does not take in an inserted paragraph', () => {
		const p1 = 'The kettle was cold when she came down.';
		const p2 = 'Snow had come in the night and the yard held the light.';
		const added = 'Tobin was already at the door with the cart.';
		const base = `${p1}\n\n${p2}`;
		const current = `${p1}\n\n${added}\n\n${p2}`;
		const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
		const opening = mapper.range(base, current, p1.length, p1.length + 6);
		expect(quote(current, opening)).toBe('\n\nSnow');
		const closing = mapper.range(base, current, p1.length - 5, p1.length + 2);
		expect(quote(current, closing)).toBe('down.\n\n');
		const save = createAnchorMapper(SAVE_DIFF_BUDGET);
		expect(quote(current, save.ends(base, current, p1.length, p1.length + 6))).toBe('\n\nSnow');
		expect(quote(current, save.ends(base, current, p1.length - 5, p1.length + 2))).toBe(
			'down.\n\n'
		);
	});

	// H2: a marker whose words were rewritten is never stored in another
	// paragraph that happens to hold the same words.
	it('H2: a rewritten marker is not placed on the same words elsewhere', () => {
		const before = shortParagraphs(41, 1400);
		before[10] = 'She lit the candle and waited by the door for the cart.';
		before[900] = 'Tobin walked out to the shed, lit the lamp and sat down.';
		const next = seeded(42);
		const after = before.map((text) => {
			// One word in every paragraph changed.
			const words = text.split(' ');
			const at = next(words.length);
			words[at] = words[at].replace(/^[a-z]+/i, 'Mara');
			return words.join(' ');
		});
		after[10] = 'Night came on and nobody came up the road to the house.';
		after[900] = 'Tobin walked out to the shed, lit the candle and sat down.';
		const base = join(before);
		const current = join(after);
		expect(base.length).toBeGreaterThan(140_000);
		const start = base.indexOf('lit the candle');
		const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
		const now = mapper.ends(base, current, start, start + 'lit the candle'.length);
		const p10 = paragraphStarts(after)[10];
		if (now) {
			expect(now.start).toBeGreaterThanOrEqual(p10);
			expect(now.end).toBeLessThanOrEqual(p10 + after[10].length);
		}
		expect(mapper.unchecked(base, current, start, start)).toBe(false);
	});

	// H3: one word put into many short paragraphs keeps every marker.
	for (const changed of [450, 520, 1400]) {
		it(`H3: keeps 300 markers with one word put into ${changed} of 1400 paragraphs`, () => {
			const before = shortParagraphs(43, 1400);
			const after = before.map((text, index) =>
				index % Math.ceil(1400 / changed) === 0 || changed === 1400 ? `Then ${text}` : text
			);
			const base = join(before);
			const current = join(after);
			const baseStarts = paragraphStarts(before);
			const currentStarts = paragraphStarts(after);
			const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
			let kept = 0;
			for (let n = 0; n < 300; n++) {
				const index = Math.floor((n * 1400) / 300);
				const length = Math.min(12, before[index].length);
				const start = baseStarts[index] + before[index].length - length;
				const now = mapper.ends(base, current, start, start + length);
				const shift = after[index].length - before[index].length;
				if (now?.start === currentStarts[index] + shift + before[index].length - length) kept++;
			}
			expect(kept).toBe(300);
		});
	}
});

// Regressions from the eighth review. Each input is the one the finding gave.
describe('review findings, round 8', () => {
	const A = 'The kettle was cold when she came down to the kitchen.';
	const N = 'Snow had come in the night and the yard held the light.';
	const B =
		'Tobin had gone out before dawn to see to the mule. The yard was white and the ' +
		'gate stood open where he had left it. He came back with his hands raw and said ' +
		'nothing about the road. She set bread on the table and waited for him to eat ' +
		'before she asked.';
	const He = 'He did not look up from the fire.';
	const C =
		'She asked about the letter twice that morning. Neither of them spoke of the ' +
		'debt that lay on the table between them.';
	const D = 'They set out before the bell rang for the morning office.';
	const D2 = 'Rain fell all the way down the valley road to the mill.';
	// Every range of `length` in base[from, to), mapped by range and by ends.
	function everyRange(base: string, current: string, from: number, to: number, length: number) {
		const range = createAnchorMapper(WRITER_DIFF_BUDGET);
		const ends = createAnchorMapper(SAVE_DIFF_BUDGET);
		const out: { s: number; e: number; got: { start: number; end: number } | null }[] = [];
		for (let s = from; s + length <= to; s++) {
			out.push({ s, e: s + length, got: range.range(base, current, s, s + length) });
			out.push({ s, e: s + length, got: ends.ends(base, current, s, s + length) });
		}
		return out;
	}

	// 1a: B moved down past He and C, C respaced, D rewritten. The heaviest set
	// keeps B and drops He, so the gap after B holds old He, C and D against
	// new D' only.
	it('1a: never puts a marker in C on unrelated text after a move', () => {
		const C2 = C.replace('the letter', 'the  letter');
		expect(B.length).toBeGreaterThan(250);
		const base = [A, N, B, He, C, D].join('\n\n');
		const current = [A, N, He, C2, B, D2].join('\n\n');
		const from = base.indexOf(C);
		const into = current.indexOf(C2);
		for (const { s, e, got } of everyRange(base, current, from, from + C.length, 10)) {
			if (got === null) continue;
			expect({ s, e, inC: got.start >= into && got.end <= into + C2.length }).toEqual({
				s,
				e,
				inC: true
			});
		}
		// The sentence of C left as it was is placed on its own words.
		const debt = base.indexOf('debt that lay');
		const now = createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, debt, debt + 13);
		expect(quote(current, now)).toBe('debt that lay');
		expect(now!.start).toBe(current.indexOf('debt that lay'));
	});

	// 1b: a marker inside a rewritten sentence, with no move.
	it('1b: does not map a range through chance matches in a rewritten sentence', () => {
		const was = 'She walked to the harbour at dawn and waited.';
		const now = 'He ran home through the rain, then slept.';
		const base = [A, was, D].join('\n\n');
		const current = [A, now, D].join('\n\n');
		const at = base.indexOf('walked to the harbour');
		expect(createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, at, at + 21)).toBeNull();
		expect(createAnchorMapper(WRITER_DIFF_BUDGET).range(base, current, at, at + 21)).toBeNull();
		// Nothing of two characters or more in it is placed, save the shared ".".
		const from = base.indexOf(was);
		for (const length of [2, 5, 12]) {
			for (const { s, e, got } of everyRange(base, current, from, from + was.length, length))
				expect({ s, e, got }).toEqual({ s, e, got: null });
		}
		// Main stored the marker on "ran home through".
		const spans = wholeTextSpans(base, current);
		const mainAt = {
			start: wholeTextPoint(spans, base.length, at)!,
			end: wholeTextPoint(spans, base.length, at + 21)!
		};
		expect(quote(current, mainAt)).toBe('ran home through');
	});

	// The support rule must not lose the ordinary edits around a range.
	it('keeps a range through the ordinary edits next to it or inside it', () => {
		const base = 'She held the old lantern high above the water.';
		const words = 'old lantern high';
		const at = base.indexOf(words);
		// The current text, what range gives and what ends (a marker) gives.
		const cases: [string, string | null, string][] = [
			// A typo fixed inside, and next to it.
			['She held the old lantren high above the water.', 'old lantren high', 'old lantren high'],
			['She held teh old lantern high above the water.', words, words],
			// A word put in or taken out next to it.
			['She held the very old lantern high above the water.', words, words],
			['She held old lantern high above the water.', words, words],
			['She held the old lantern high up above the water.', words, words],
			// Its first or last word changed: a range whose own first or last
			// letter is gone is lost, as on main; a marker takes the new word.
			['She held the new lantern high above the water.', null, 'new lantern high'],
			['She held the old lantern low above the water.', null, 'old lantern low']
		];
		for (const [current, range, marker] of cases) {
			const got = quote(current, reanchorRange(base, current, at, at + words.length));
			expect({ current, got }).toEqual({ current, got: range });
			const ends = createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, at, at + words.length);
			expect({ current, got: quote(current, ends) }).toEqual({ current, got: marker });
		}
		const pays = createAnchorMapper(SAVE_DIFF_BUDGET).ends(
			'Alice pays the toll.',
			'Alice gladly pays the toll.',
			6,
			10
		);
		expect(quote('Alice gladly pays the toll.', pays)).toBe('pays');
	});

	// 2: a paragraph moved and respaced: its untouched sentences still map.
	it('2: places the untouched sentences of a paragraph that moved and changed', () => {
		const C2 = C.replace('the letter', 'the  letter');
		const base = [A, B, C, D].join('\n');
		const current = [A, C2, B, D].join('\n');
		const debt = base.indexOf('Neither of them');
		const want = current.indexOf('Neither of them');
		for (const mapper of [
			createAnchorMapper(WRITER_DIFF_BUDGET),
			createAnchorMapper(SAVE_DIFF_BUDGET)
		]) {
			expect(mapper.range(base, current, debt, debt + 15)).toEqual({ start: want, end: want + 15 });
			expect(mapper.ends(base, current, debt, debt + 15)).toEqual({ start: want, end: want + 15 });
			expect(mapper.unchecked(base, current, debt, debt + 15)).toBe(false);
		}
		// B, which did not move in text order, too.
		const tobin = base.indexOf('Tobin had gone');
		expect(quote(current, reanchorRange(base, current, tobin, tobin + 14))).toBe('Tobin had gone');
	});

	// 3: budgets in edit units. The line and sentence passes are not charged,
	// so each cheap pair after the total is used up still gets the floor.
	// Version v + 1 changes the letter just before the anchor made on version
	// v, so placing each anchor takes a character diff of its sentence.
	function placedOnVersions(budget: DiffBudget, size: number, count: number) {
		const paragraphs = sceneParagraphs(61, size);
		const all: string[][] = [paragraphs];
		const anchors: { start: number; end: number; words: string }[] = [];
		for (let v = 0; v < count; v++) {
			const p = (v * 37) % paragraphs.length;
			const at = phraseIn(all[v][p])!;
			const start = paragraphStarts(all[v])[p] + at[0];
			anchors.push({ start, end: start + at[1] - at[0], words: all[v][p].slice(at[0], at[1]) });
			const next = [...all[v]];
			next[p] = `${next[p].slice(0, at[0] - 2)}Q${next[p].slice(at[0] - 1)}`;
			all.push(next);
		}
		const current = join(all[count]);
		const mapper = createAnchorMapper(budget);
		let placed = 0;
		for (let v = 0; v < count; v++) {
			const got = mapper.range(join(all[v]), current, anchors[v].start, anchors[v].end);
			if (got && current.slice(got.start, got.end) === anchors[v].words) placed++;
		}
		return { placed, spent: mapper.spent() };
	}
	it('3: places an edit made on each of 20 versions of a 120k scene on the app budget', () => {
		const first = placedOnVersions(APP_DIFF_BUDGET, 120_000, 20);
		expect(first.placed).toBe(20);
		// The same texts give the same result and the same spend every time.
		expect(placedOnVersions(APP_DIFF_BUDGET, 120_000, 20)).toEqual(first);
	});
	it('3: places an anchor made on each of 200 versions of a 500k scene on the writer budget', () => {
		expect(placedOnVersions(WRITER_DIFF_BUDGET, 500_000, 200).placed).toBe(200);
	}, 120_000);
});

describe('review findings, round 9', () => {
	const before = 'The kettle was cold when she came down to the kitchen.';
	const after = 'They set out before the bell rang for the morning office.';
	const was = 'Mara walked slowly down to the old harbour and waited there for the boat.';
	const mainOf = (base: string, current: string, start: number, end: number) =>
		wholeTextRange(wholeTextSpans(base, current), base.length, start, end);

	// H1: an edit inside a range, with two more in the same sentence.
	it('H1: keeps a range through an edit inside it when its sentence has other edits', () => {
		const cases: [string, string, string][] = [
			[
				'the old harbour',
				'Mara went slowly down to the old grey harbour and waited for the boat.',
				'the old grey harbour'
			],
			[
				'the old harbour',
				'Mara went slowly down to the old harbuor and waited for the boat.',
				'the old harbuor'
			],
			[
				'down to the old harbour',
				'Mara went slowly down to the harbour and waited for the boat.',
				'down to the harbour'
			]
		];
		for (const [words, now, want] of cases) {
			const base = [before, was, after].join('\n\n');
			const current = [before, now, after].join('\n\n');
			const at = base.indexOf(words);
			const end = at + words.length;
			expect(quote(current, mainOf(base, current, at, end))).toBe(want);
			const range = createAnchorMapper(WRITER_DIFF_BUDGET).range(base, current, at, end);
			const ends = createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, at, end);
			expect({ now, range: quote(current, range), ends: quote(current, ends) }).toEqual({
				now,
				range: want,
				ends: want
			});
		}
	});

	// M1: the ends map through two spans, one a sentence that moved; the
	// range must not stretch over the text that now lies between them.
	it('M1: does not stretch a range over the text a moved sentence was carried past', () => {
		const base =
			'The kettle sang on the stove all morning. Mara watched the rain against the window. ' +
			'Then she left.\n\nTobin came home late that evening with the letter. He did not speak at all.';
		const current =
			'The kettle sang on the stove all morning. Then she left.\n\nTobin came home late that ' +
			'evening with the letter. He did not speak at all. Mara watched the rain against the window.';
		const at = base.indexOf('all morning. Mara watched');
		const end = at + 'all morning. Mara watched'.length;
		expect(mainOf(base, current, at, end)).toBeNull();
		for (const mapper of [
			createAnchorMapper(WRITER_DIFF_BUDGET),
			createAnchorMapper(SAVE_DIFF_BUDGET)
		]) {
			expect(mapper.range(base, current, at, end)).toBeNull();
			expect(mapper.ends(base, current, at, end)).toBeNull();
		}
		// Each part on its own is still placed.
		const morning = base.indexOf('all morning.');
		expect(quote(current, reanchorRange(base, current, morning, morning + 12))).toBe(
			'all morning.'
		);
		const mara = base.indexOf('Mara watched');
		expect(quote(current, reanchorRange(base, current, mara, mara + 12))).toBe('Mara watched');
	});

	// Found by the clustered edits and seeds 1 to 60 and 100 to 160 of the
	// property test.
	it('a marker whose first word became one sharing a letter takes the new word', () => {
		// "of" became "long" and kept its "o", a run too short to count.
		const base = 'Under morning table after of his face Esk that. Never or before.';
		const current = 'Under morning table after long his face Esk that. Never or before.';
		const at = base.indexOf('of his face Esk');
		const ends = createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, at, at + 15);
		expect(quote(current, ends)).toBe('long his face Esk');
		// A marker on one word replaced outright, sharing only a chance "r"
		// with it, is detached rather than stored on the new word.
		const was = 'Boat before nearly my turned grey waited your field heavy her sudden!';
		const now = 'Boat before nearly my turned grey waited your field heavy Mara sudden!';
		const her = was.indexOf('her');
		expect(createAnchorMapper(SAVE_DIFF_BUDGET).ends(was, now, her, her + 3)).toBeNull();
	});

	it('does not stretch a range over a paragraph put in before one that starts with the same letters', () => {
		const first = 'The kettle was cold when she came down to the kitchen.';
		const cases: [string, string, string][] = [
			// A new paragraph starting with "D" before "Dark ...".
			[
				[first, 'Dark letter there took no lost a Esk warm heavy wind.'].join('\n\n'),
				[
					first,
					'Door Esk key pulled opened, chair, wind opened nearly.',
					'Dark letter there took no lost a Esk warm heavy rain.'
				].join('\n\n'),
				'Dark letter'
			],
			// A copy of the paragraph before, starting "Li", before "Listened".
			[
				[first, 'Listened here slowly old lost our the sudden only?'].join('\n\n'),
				[first, first, 'Listened here slowly old lost our Mara sudden only?'].join('\n\n'),
				'Listened here'
			]
		];
		for (const [base, current, words] of cases) {
			const at = base.indexOf(words);
			const want = { start: current.indexOf(words), end: current.indexOf(words) + words.length };
			expect(reanchorRange(base, current, at, at + words.length)).toEqual(want);
			expect(
				createAnchorMapper(SAVE_DIFF_BUDGET).ends(base, current, at, at + words.length)
			).toEqual(want);
		}
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

describe('createAnchorMapper ends (for markers)', () => {
	const p1 = 'The kettle was cold when she came down.';
	const p2 = 'Snow had come in the night and the yard held the light.';
	const p3 = 'Tobin was already at the door with the cart.';

	// Nothing follows a paragraph that moved: the larger of the two that
	// changed places keeps its anchors, as on main.
	it('keeps the paragraph a move did not take, and drops a range reaching across', () => {
		const base = [p1, p2, p3].join('\n\n');
		const current = [p2, p1, p3].join('\n\n');
		const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
		const yard = mapper.ends(base, current, base.indexOf('yard'), base.indexOf('yard') + 4);
		expect(quote(current, yard)).toBe('yard');
		expect(mapper.ends(base, current, base.indexOf('down'), base.indexOf('Snow') + 4)).toBeNull();
	});

	// Main stretched a marker over a word typed right before it; it now keeps
	// its own words, as a comment does.
	it('keeps a marker when words are added at its edges, on its own words', () => {
		const base = 'Alice pays the toll.';
		const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
		const before = 'Alice gladly pays the toll.';
		expect(quote(before, mapper.ends(base, before, 6, 10))).toBe('pays');
		const after = 'Alice pays gladly the toll.';
		expect(quote(after, mapper.ends(base, after, 6, 10))).toBe('pays');
		// Letters typed onto its first word are left out, as a word typed
		// before it is.
		const prefixed = 'Alice repays the toll.';
		expect(quote(prefixed, mapper.ends(base, prefixed, 6, 10))).toBe('pays');
		// A change to its own first letter still keeps it, on the changed word.
		const inside = 'Alice Pays the toll.';
		expect(quote(inside, mapper.ends(base, inside, 6, 10))).toBe('Pays');
	});

	it('finishes a stretch past the budget without holding the thread, and only then gives up', async () => {
		const old = 'The harbour lay quiet under a low grey sky. '.repeat(20);
		const base = `${p1}\n\n${old}She lit the quiet candle. ${old}\n\n${p3}`;
		const current = base.replace(/quiet/g, 'still');
		const starved = createAnchorMapper({ perPair: 0, total: 0, floor: 0 });
		const at = base.indexOf('candle');
		expect(starved.ends(base, current, at, at + 6)).toBeNull();
		expect(starved.unchecked(base, current, at, at)).toBe(true);
		await starved.finish(base, current, [at, at + 6], 2000);
		expect(quote(current, starved.ends(base, current, at, at + 6))).toBe('candle');
		expect(starved.unchecked(base, current, at, at)).toBe(false);
		// Past the time it is given, it is left unchecked.
		const rushed = createAnchorMapper({ perPair: 0, total: 0, floor: 0 });
		await rushed.finish(base, current, [at], 0);
		expect(rushed.unchecked(base, current, at, at)).toBe(true);
	});
});

// The mapper against the true position of every character, on generated
// prose with the edits a writer makes. Because each edit is constructed, the
// test knows where every character of the base text went (or that it is
// gone), and so where a range belongs: from where its first character went
// to just past where its last one went.
describe('createAnchorMapper on edited prose, against the true positions', () => {
	const EMOJI = ['\u{1F319}', '\u{1F600}'];
	// A cell is one code unit of the edited text and the base index it came
	// from, or -1 for one that is new. A character deleted and typed again
	// elsewhere is new, with the index of the one it copies as `was`.
	type Cell = { ch: string; from: number; was?: number };
	// By code unit, so the index of a cell is its index in the text.
	const units = (text: string, from: (k: number) => number): Cell[] =>
		Array.from({ length: text.length }, (_, k) => ({ ch: text[k], from: from(k) }));
	const cells = (text: string) => units(text, () => -1);

	function proseCase(next: (below: number) => number) {
		const newline = next(5) === 0 ? '\r\n' : '\n';
		const texts: string[] = [];
		for (let i = 3 + next(7); i > 0; i--) {
			let text = paragraph(next)
				.split(/(?<=[.?!]) /)
				.slice(0, 2 + next(3))
				.join(' ');
			if (next(4) === 0) {
				const words = text.split(' ');
				words[next(words.length)] += EMOJI[next(2)];
				text = words.join(' ');
			}
			texts.push(text);
		}
		// A repeated scene break or reply, as real scenes have.
		if (next(3) === 0) {
			const line = ['***', '"No."'][next(2)];
			texts.splice(next(texts.length + 1), 0, line);
			texts.splice(next(texts.length + 1), 0, line);
		}
		const sep = newline + newline;
		const base = texts.join(sep) + (next(3) === 0 ? newline : '');
		// The base as cells, split into paragraphs, the separators between
		// them, and a tail after the last.
		let at = 0;
		const paras: Cell[][] = [];
		const seps: Cell[][] = [];
		texts.forEach((text, i) => {
			paras.push(units(text, (k) => at + k));
			at += text.length;
			const after = i < texts.length - 1 ? sep : base.slice(at);
			seps.push(units(after, (k) => at + k));
			at += after.length;
		});
		let tail = seps.pop()!;
		const newSep = () =>
			cells(seps.some((s) => s.some((c) => c.ch === '\r')) ? '\r\n\r\n' : '\n\n');
		const insertAt = (k: number, para: Cell[], separator: Cell[]) => {
			if (k < paras.length) {
				paras.splice(k, 0, para);
				seps.splice(k, 0, separator);
			} else {
				seps.push(separator);
				paras.push(para);
			}
		};
		const removeAt = (k: number) => {
			const [para] = paras.splice(k, 1);
			const [separator] = seps.splice(k < seps.length ? k : k - 1, 1);
			return { para, separator };
		};
		const edits: string[] = [];
		// Base characters of paragraphs that moved, were swapped or were moved
		// across, and of paragraphs that were copied (either copy could be
		// called the original).
		const shuffled = new Set<number>();
		const copied = new Set<number>();
		let retyped = false;
		const mark = (set: Set<number>, para: Cell[]) => {
			for (const c of para) if (c.from !== -1) set.add(c.from);
		};
		for (let n = 1 + next(4); n > 0; n--) {
			const k = next(paras.length);
			const kind = next(13);
			edits.push(String(kind));
			const text = paras[k].map((c) => c.ch).join('');
			if (kind === 0) {
				// A typo: a letter struck as a digit.
				const letters = [...text.matchAll(/[a-z]/g)];
				if (letters.length === 0) continue;
				const i = letters[next(letters.length)].index!;
				paras[k][i] = { ch: String(next(10)), from: -1 };
			} else if (kind === 1) {
				// A word replaced everywhere.
				const word = ['the', 'she', 'her', 'and'][next(4)];
				const pattern = new RegExp(`\\b${word}\\b`, 'g');
				for (let p = 0; p < paras.length; p++) {
					const t = paras[p].map((c) => c.ch).join('');
					const out: Cell[] = [];
					let last = 0;
					for (const match of t.matchAll(pattern)) {
						out.push(...paras[p].slice(last, match.index), ...cells('Mara'));
						last = match.index! + word.length;
					}
					out.push(...paras[p].slice(last));
					paras[p] = out;
				}
			} else if (kind === 2) {
				paras[k] = cells(
					paragraph(next)
						.split(/(?<=[.?!]) /)
						.slice(0, 3)
						.join(' ')
				);
			} else if (kind === 3) {
				insertAt(
					next(paras.length + 1),
					cells(
						paragraph(next)
							.split(/(?<=[.?!]) /)
							.slice(0, 2)
							.join(' ')
					),
					newSep()
				);
			} else if (kind === 4 && paras.length > 2) {
				// Deleting a paragraph that was copied leaves the copy reading as
				// the original moved there.
				const { para } = removeAt(k);
				if (para.some((c) => copied.has(c.from))) mark(shuffled, para);
			} else if (kind === 5 && paras.length > 2) {
				const { para, separator } = removeAt(k);
				const to = next(paras.length + 1);
				mark(shuffled, para);
				for (let p = Math.min(k, to); p < Math.max(k, to); p++) mark(shuffled, paras[p]);
				insertAt(to, para, separator);
			} else if (kind === 6 && k + 1 < paras.length) {
				mark(shuffled, paras[k]);
				mark(shuffled, paras[k + 1]);
				[paras[k], paras[k + 1]] = [paras[k + 1], paras[k]];
			} else if (kind === 7) {
				mark(copied, paras[k]);
				const copy = paras[k].map((c) => ({ ch: c.ch, from: -1 }));
				insertAt(next(2) ? k : k + 1, copy, newSep());
			} else if (kind === 8) {
				// A paragraph split at a space, after a sentence or inside one.
				const spaces = [...text.matchAll(next(2) ? /(?<=[.?!]) /g : / /g)];
				if (spaces.length === 0) continue;
				const i = spaces[next(spaces.length)].index!;
				paras.splice(k, 1, paras[k].slice(0, i), paras[k].slice(i + 1));
				seps.splice(k, 0, newSep());
			} else if (kind === 9 && k + 1 < paras.length) {
				paras.splice(k, 2, [...paras[k], ...cells(' '), ...paras[k + 1]]);
				seps.splice(k, 1);
			} else if (kind === 10) {
				// Line endings changed throughout.
				const toCrlf = !seps.concat([tail]).some((s) => s.some((c) => c.ch === '\r'));
				const convert = (run: Cell[]) =>
					toCrlf
						? run.flatMap((c) => (c.ch === '\n' ? [{ ch: '\r', from: -1 }, c] : [c]))
						: run.filter((c) => c.ch !== '\r');
				for (let s = 0; s < seps.length; s++) seps[s] = convert(seps[s]);
				tail = convert(tail);
			} else if (kind === 11) {
				tail = tail.length ? [] : cells('\n');
			} else if (kind === 12 && paras.length > 1) {
				// A sentence deleted and typed again at the end of another
				// paragraph.
				const starts = [0, ...[...text.matchAll(/[.?!] /g)].map((m) => m.index! + 2)];
				if (starts.length < 2) continue;
				const i = next(starts.length);
				const last = i === starts.length - 1;
				const from = last ? starts[i] - 1 : starts[i];
				const to = last ? text.length : starts[i + 1];
				const cut = paras[k].splice(from, to - from);
				const sentence = last ? cut.slice(1) : cut.slice(0, -1);
				mark(shuffled, sentence);
				const into = (k + 1 + next(paras.length - 1)) % paras.length;
				paras[into].push(
					...cells(' '),
					...sentence.map((c) => ({ ch: c.ch, from: -1, was: c.from }))
				);
				retyped = true;
			}
		}
		const doc: Cell[] = [];
		paras.forEach((para, i) => doc.push(...para, ...(i < seps.length ? seps[i] : [])));
		doc.push(...tail);
		const current = doc.map((c) => c.ch).join('');
		const pos = new Array<number>(base.length).fill(-1);
		doc.forEach((c, i) => {
			if (c.from !== -1) pos[c.from] = i;
		});
		const origin = doc.map((c) => (c.from !== -1 ? c.from : (c.was ?? -1)));
		return { base, current, pos, origin, edits, shuffled, copied, retyped };
	}

	// Paragraphs, one of them (not the first or last) edited in a cluster: a
	// range of 2 to 10 words in it, one edit inside it or beside it (a typo, a
	// word added, a word removed) and two or three more in the same sentence or
	// paragraph. Returns every range of 2 to 10 whole words in that paragraph.
	// Not in the prose's vocabulary, so an added word is never a copy of one
	// beside it (which copy is the original would be a guess).
	const ADDED = ['pale', 'faint', 'brisk', 'damp', 'idle', 'stark'];
	function clusterCase(next: (below: number) => number) {
		const texts: string[] = [];
		for (let i = 3 + next(3); i > 0; i--)
			texts.push(
				paragraph(next)
					.split(/(?<=[.?!]) /)
					.slice(0, 2 + next(3))
					.join(' ')
			);
		const k = 1 + next(texts.length - 2);
		const offset = texts.slice(0, k).reduce((n, t) => n + t.length + 2, 0);
		const text = texts[k];
		const words: { start: number; end: number; sentence: number; text: string }[] = [];
		let sentence = 0;
		for (const m of text.matchAll(/\S+/g)) {
			words.push({
				start: offset + m.index!,
				end: offset + m.index! + m[0].length,
				sentence,
				text: m[0].replace(/[,.?!]+$/, '').toLowerCase()
			});
			if (/[.?!]$/.test(m[0])) sentence++;
		}
		const length = Math.min(2 + next(9), words.length - 2);
		const i = next(words.length - length + 1);
		const j = i + length - 1;
		type Op = { kind: number; word: number };
		const ops: Op[] = [];
		// The edit at the range: 0 a typo, 1 a word added after `word`, 2 a
		// word removed.
		const kind = next(3);
		const inside = next(2) === 0;
		if (inside) {
			if (kind === 2 && length >= 3) ops.push({ kind, word: i + 1 + next(length - 2) });
			else if (kind === 0) ops.push({ kind, word: i + next(length) });
			else ops.push({ kind: 1, word: i + next(length - 1) });
		} else {
			const side = i > 0 && (j + 1 >= words.length || next(2) === 0) ? i - 1 : j + 1;
			if (kind === 1) ops.push({ kind, word: side === i - 1 ? i - 1 : j });
			else ops.push({ kind, word: side });
		}
		const used = new Set([i - 1, i, j, j + 1, ...ops.map((o) => o.word)]);
		const near = words.map((w, n) => n).filter((n) => !used.has(n) && (n < i || n > j));
		const sameSentence = near.filter(
			(n) => words[n].sentence >= words[i].sentence && words[n].sentence <= words[j].sentence
		);
		for (let m = 2 + next(2); m > 0; m--) {
			const pool = sameSentence.filter((n) => !used.has(n)).length
				? sameSentence.filter((n) => !used.has(n))
				: near.filter((n) => !used.has(n));
			if (!pool.length) break;
			const word = pool[next(pool.length)];
			used.add(word);
			ops.push({ kind: next(3), word });
		}
		const para = units(text, (n) => offset + n);
		const find = (from: number) => para.findIndex((c) => c.from === from);
		for (const { kind, word } of ops) {
			const { start, end } = words[word];
			const a = find(start);
			const b = find(end - 1);
			if (a === -1 || b === -1) continue;
			if (kind === 0) {
				// A letter inside the word (never its first or last) mistyped.
				const inner: number[] = [];
				for (let n = a + 1; n < b; n++) if (/[a-z]/.test(para[n].ch)) inner.push(n);
				if (!inner.length) continue;
				const at = inner[next(inner.length)];
				const letter = 'abcdefghijklmnopqrstuvwxyz'.replace(para[at].ch, '')[next(25)];
				para[at] = { ch: letter, from: -1 };
			} else if (kind === 1) {
				para.splice(b + 1, 0, ...cells(` ${ADDED[next(ADDED.length)]}`));
			} else if ([word - 1, word + 1].some((n) => words[n] && words[n].text === words[word].text)) {
				// Which of two like words beside each other went is a guess.
				continue;
			} else if (b + 1 < para.length && para[b + 1].ch === ' ') para.splice(a, b - a + 2);
			else if (a > 0 && para[a - 1].ch === ' ') para.splice(a - 1, b - a + 2);
		}
		const doc: Cell[] = [];
		let at = 0;
		texts.forEach((t, n) => {
			if (n > 0) {
				doc.push(...units('\n\n', (m) => at + m));
				at += 2;
			}
			doc.push(...(n === k ? para : units(t, (m) => at + m)));
			at += t.length;
		});
		const base = texts.join('\n\n');
		const current = doc.map((c) => c.ch).join('');
		const pos = new Array<number>(base.length).fill(-1);
		doc.forEach((c, n) => {
			if (c.from !== -1) pos[c.from] = n;
		});
		const ranges: { s: number; e: number; target: boolean }[] = [];
		for (let a = 0; a < words.length; a++)
			for (let b = a + 1; b < Math.min(words.length, a + 10); b++)
				ranges.push({ s: words[a].start, e: words[b].end, target: a === i && b === j });
		return { base, current, pos, ranges, ops: ops.map((o) => `${o.kind}@${o.word}`), inside, i, j };
	}

	const splits = (text: string, at: number) =>
		at > 0 &&
		at < text.length &&
		/[\uD800-\uDBFF]/.test(text[at - 1]) &&
		/[\uDC00-\uDFFF]/.test(text[at]);
	// Whether a sentence starts at `at`: white space before it, and before that
	// the start of the text, a line break or a sentence's end.
	const sentenceStarts = (text: string, at: number) => {
		let k = at - 1;
		if (k >= 0 && !/\s/.test(text[k])) return false;
		while (k >= 0 && /[ \t\r]/.test(text[k])) k--;
		return k < 0 || /[\n.?!]/.test(text[k]);
	};
	const occurrences = (text: string, part: string) => {
		let count = 0;
		for (let at = text.indexOf(part); at !== -1 && count < 2; at = text.indexOf(part, at + 1))
			count++;
		return count;
	};

	// (a) A range whose words are untouched and stand once in each version is
	// placed where they went, or not at all, in every round, moves included.
	// (b) A range inside an untouched line or sentence that stands once in
	// each version and has at least 16 visible characters is always placed,
	// there, wherever that line or sentence now stands. (c) A range main
	// places where it belongs is placed there too, unless only the support
	// rule refuses it (counted as supportCost). (d) No result is out of range,
	// inverted or splits a character. (e) No result shares no text with the
	// range it was mapped from (counted as unrelated, against main's). (f) In
	// a round with no move, no result holds 20 or more visible characters from
	// outside its range beyond where the range truly went; in rounds with a
	// move or a sentence typed again elsewhere, no more results do than on
	// main. (g) With clustered edits, every range of whole words in the edited
	// paragraph that main places where it belongs is placed there, by range
	// and by a marker's rule, with nothing held out; what is not is counted,
	// as lost to the support rule or as a tie (an equally short alignment
	// main happened to share with the truth).
	//
	// Held out, each for a reason the design gives:
	// - Ranges on a paragraph that was copied, from (a) to (c) and (e), and
	//   copied text from (f): either copy can be called the original, and the
	//   mapper takes the one left as it was.
	// - Ranges on a line that stands more than once (a scene break, a short
	//   reply), from (a), (c) and (e), and such lines from (f): such a line is
	//   never paired, so when copies of it are deleted or added, which copy is
	//   kept is a guess.
	// - Rounds that move a paragraph (or delete one that was copied, which
	//   leaves the copy reading as moved), from (c): main's diff of the whole
	//   text keeps some of the text a move left behind and drops some that
	//   stayed, and this follows paired units instead.
	function check(seed: number, rounds: number) {
		const next = seeded(seed);
		const misplaced: unknown[] = [];
		const untouchedLost: unknown[] = [];
		const mainOnly: unknown[] = [];
		const unrelated: unknown[] = [];
		const stretched: unknown[] = [];
		const ties: unknown[] = [];
		const counts = {
			untouched: 0,
			truth: 0,
			movedTruth: 0,
			mainRight: 0,
			supportCost: 0,
			placed: 0,
			mainUnrelated: 0,
			// Results holding 20 or more foreign characters, in rounds with a
			// move and in rounds with a sentence typed again.
			stretchedMoved: 0,
			mainStretchedMoved: 0,
			stretchedRetyped: 0,
			mainStretchedRetyped: 0,
			clusterMainRight: 0,
			clusterSupport: 0
		};
		const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
		type At = { start: number; end: number };
		// How many visible characters of `got` came from base text outside
		// [s, e) (a character typed again counts as the one it copies), and lie
		// outside where the range truly went (text moved into it is part of
		// it). White space is left out, as one space or line break is as good
		// as another, and so is text in `held`.
		const foreign = (
			text: string,
			origin: number[],
			s: number,
			e: number,
			got: At,
			want: At | null,
			held?: (at: number) => boolean
		) => {
			let n = 0;
			for (let k = got.start; k < got.end; k++) {
				if (want && k >= want.start && k < want.end) continue;
				const o = origin[k];
				if (o !== -1 && (o < s || o >= e) && /\S/.test(text[k]) && !held?.(o)) n++;
			}
			return n;
		};
		for (let round = 0; round < rounds; round++) {
			const { base, current, pos, origin, edits, shuffled, copied, retyped } = proseCase(next);
			const moved = shuffled.size > 0;
			const spans = wholeTextSpans(base, current);
			const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
			const loose = createAnchorMapper(WRITER_DIFF_BUDGET, false);
			const save = createAnchorMapper(SAVE_DIFF_BUDGET);
			const truth = (s: number, e: number) =>
				pos[s] !== -1 && pos[e - 1] !== -1 && pos[s] <= pos[e - 1]
					? { start: pos[s], end: pos[e - 1] + 1 }
					: null;
			const untouched = (s: number, e: number) => {
				for (let k = s; k < e; k++) if (pos[k] === -1 || pos[k] !== pos[s] + k - s) return false;
				return true;
			};
			const touches = (set: Set<number>, s: number, e: number) => {
				for (let k = s; k < e; k++) if (set.has(k)) return true;
				return false;
			};
			// Whether each base character is on a line that stands more than once.
			const onRepeated: boolean[] = [];
			const lineCount = new Map<string, number>();
			const allLines = base.split('\n');
			for (const l of allLines) {
				const line = l.replace(/\r$/, '');
				lineCount.set(line, (lineCount.get(line) ?? 0) + 1);
			}
			for (const l of allLines) {
				const line = l.replace(/\r$/, '');
				const twice = line !== '' && lineCount.get(line)! > 1;
				for (let k = 0; k <= l.length; k++) onRepeated.push(twice);
			}
			const repeated = (s: number, e: number) => {
				for (let k = s; k < e; k++) if (onRepeated[k]) return true;
				return false;
			};
			const held = (at: number) => copied.has(at) || onRepeated[at];
			const valid = (got: At | null) =>
				got === null ||
				(got.start >= 0 &&
					got.end <= current.length &&
					got.start < got.end &&
					!splits(current, got.start) &&
					!splits(current, got.end));
			// Whether not one character of base[s, e) (or a copy of one typed
			// again) went into `got`, and it does not read the same either. (The
			// same text can be left by chance where two rewritten sentences
			// share their last letters, "hand." and "found.": that end is shared,
			// so it maps.)
			const sharesNothing = (s: number, e: number, got: At) => {
				if (current.slice(got.start, got.end) === base.slice(s, e)) return false;
				for (let k = got.start; k < got.end; k++) if (origin[k] >= s && origin[k] < e) return false;
				return true;
			};

			// (b) Untouched lines and sentences, not copied, that stand once in
			// each version, have 16 visible characters and are still whole
			// lines or sentences.
			const units = [
				...[...base.matchAll(/[^\r\n]+/g)].map((m) => ({
					start: m.index!,
					end: m.index! + m[0].length,
					line: true
				})),
				...[...base.matchAll(/\S[^\r\n]*?[.?!](?=\s|$)/g)].map((m) => ({
					start: m.index!,
					end: m.index! + m[0].length,
					line: false
				}))
			];
			const kept = units.filter(
				(p) =>
					untouched(p.start, p.end) &&
					!touches(copied, p.start, p.end) &&
					base.slice(p.start, p.end).replace(/\s/g, '').length >= 16 &&
					occurrences(base, base.slice(p.start, p.end)) === 1 &&
					occurrences(current, base.slice(p.start, p.end)) === 1 &&
					(p.line
						? /[\r\n]/.test(current[pos[p.end - 1] + 1] ?? '\n') &&
							(pos[p.start] === 0 || /[\r\n]/.test(current[pos[p.start] - 1]))
						: /\s/.test(current[pos[p.end - 1] + 1] ?? ' ') &&
							sentenceStarts(current, pos[p.start]))
			);
			for (const p of kept) {
				for (let n = 0; n < 2; n++) {
					const s = p.start + next(p.end - p.start);
					const e = s + 1 + next(p.end - s);
					if (splits(base, s) || splits(base, e)) continue;
					counts.untouched++;
					const got = mapper.range(base, current, s, e);
					if (!same(got, truth(s, e)))
						untouchedLost.push({ seed, round, edits, s, e, got, want: truth(s, e) });
				}
			}

			for (let n = 0; n < 60; n++) {
				const s = next(base.length);
				const e = Math.min(base.length, s + 1 + next(60));
				if (splits(base, s) || splits(base, e)) continue;
				const got = mapper.range(base, current, s, e);
				const ends = save.ends(base, current, s, e);
				const point = mapper.point(base, current, s);
				// (d)
				expect({ seed, round, s, e, ok: valid(got) && valid(ends) }).toEqual({
					seed,
					round,
					s,
					e,
					ok: true
				});
				if (point !== null) {
					expect(point >= 0 && point <= current.length && !splits(current, point)).toBe(true);
				}
				if (touches(copied, s, e)) continue;
				const [ms, me] = [
					wholeTextPoint(spans, base.length, s),
					wholeTextPoint(spans, base.length, e)
				];
				const main = wholeTextRange(spans, base.length, s, e);
				const mainEnds = ms !== null && me !== null && ms < me ? { start: ms, end: me } : null;
				// (e), for ranges with any text: one line break between paragraphs
				// is as good as another.
				if (!repeated(s, e) && /\S/.test(base.slice(s, e))) {
					for (const [how, result] of [
						['range', got],
						['ends', ends]
					] as const) {
						if (!result) continue;
						counts.placed++;
						if (sharesNothing(s, e, result))
							unrelated.push({ seed, round, edits, how, s, e, result });
					}
					for (const result of [main, mainEnds])
						if (result && sharesNothing(s, e, result)) counts.mainUnrelated++;
				}
				// Only ranges that start and end on a visible character are held
				// to a true position: a line break or space at an edge could be
				// any of the ones between two paragraphs.
				if (/\s/.test(base[s]) || /\s/.test(base[e - 1])) continue;
				const want = truth(s, e);
				const words = base.slice(s, e);
				// (f)
				if (!repeated(s, e)) {
					const kind = retyped ? 'Retyped' : 'Moved';
					for (const [how, result] of [
						['range', got],
						['ends', ends]
					] as const) {
						const n = result ? foreign(current, origin, s, e, result, want, held) : 0;
						if (n < 20) continue;
						if (moved) counts[`stretched${kind}`]++;
						else stretched.push({ seed, round, edits, how, s, e, words, result, want, n });
					}
					for (const result of [main, mainEnds])
						if (moved && result && foreign(current, origin, s, e, result, want, held) >= 20)
							counts[`mainStretched${kind}`]++;
				}
				// (a)
				if (
					!repeated(s, e) &&
					untouched(s, e) &&
					occurrences(base, words) === 1 &&
					occurrences(current, words) === 1
				) {
					counts[moved ? 'movedTruth' : 'truth']++;
					for (const [how, result] of [
						['range', got],
						['ends', ends]
					] as const) {
						if (result !== null && !same(result, want))
							misplaced.push({ seed, round, edits, how, s, e, words, result, want });
					}
				}
				// (c)
				if (moved || repeated(s, e)) continue;
				if (main !== null && same(main, want)) {
					counts.mainRight++;
					if (same(got, want)) continue;
					if (same(loose.range(base, current, s, e), want)) counts.supportCost++;
					else mainOnly.push({ seed, round, edits, s, e, words, got, want });
				}
			}

			// (g), and (f) for the clustered edits, which move nothing.
			const c = clusterCase(next);
			const cSpans = wholeTextSpans(c.base, c.current);
			const cRange = createAnchorMapper(WRITER_DIFF_BUDGET);
			const cEnds = createAnchorMapper(SAVE_DIFF_BUDGET);
			const cLoose = createAnchorMapper(WRITER_DIFF_BUDGET, false);
			const cLooseEnds = createAnchorMapper(SAVE_DIFF_BUDGET, false);
			const cOrigin = new Array<number>(c.current.length).fill(-1);
			c.pos.forEach((at, b) => {
				if (at !== -1) cOrigin[at] = b;
			});
			for (const { s, e } of c.ranges) {
				const want =
					c.pos[s] !== -1 && c.pos[e - 1] !== -1
						? { start: c.pos[s], end: c.pos[e - 1] + 1 }
						: null;
				const ms = wholeTextPoint(cSpans, c.base.length, s);
				const me = wholeTextPoint(cSpans, c.base.length, e);
				const results = [
					[
						'range',
						cRange.range(c.base, c.current, s, e),
						wholeTextRange(cSpans, c.base.length, s, e),
						cLoose
					],
					[
						'ends',
						cEnds.ends(c.base, c.current, s, e),
						ms !== null && me !== null && ms < me ? { start: ms, end: me } : null,
						cLooseEnds
					]
				] as const;
				for (const [how, result, main, without] of results) {
					const at = { seed, round, ops: c.ops, how, words: c.base.slice(s, e), result, want };
					if (result && foreign(c.current, cOrigin, s, e, result, want) >= 20) stretched.push(at);
					if (want === null || !same(main, want)) continue;
					counts.clusterMainRight++;
					if (same(result, want)) continue;
					const free =
						how === 'range'
							? without.range(c.base, c.current, s, e)
							: without.ends(c.base, c.current, s, e);
					if (same(free, want)) counts.clusterSupport++;
					else ties.push(at);
				}
			}
		}
		return { misplaced, untouchedLost, mainOnly, unrelated, stretched, ties, counts };
	}

	it('places nothing on text it was not made on, keeps untouched text, and keeps what main keeps', () => {
		// ANCHOR_SEED runs another seed.
		const { misplaced, untouchedLost, mainOnly, unrelated, stretched, ties, counts } = check(
			Number(process.env.ANCHOR_SEED ?? 51),
			300
		);
		expect(misplaced).toEqual([]);
		expect(untouchedLost).toEqual([]);
		expect(mainOnly).toEqual([]);
		expect(unrelated).toEqual([]);
		expect(stretched).toEqual([]);
		expect(counts.stretchedMoved).toBeLessThanOrEqual(counts.mainStretchedMoved);
		expect(counts.stretchedRetyped).toBeLessThanOrEqual(counts.mainStretchedRetyped);
		// What clustered edits cost: over seeds 1 to 60 and 100 to 160, the
		// support rule lost 3.5% to 5.1% a seed of the ranges main placed
		// where they belong, and ties at most 0.031% (seed 51: 4.1% and 4).
		expect(counts.clusterSupport).toBeLessThan(0.06 * counts.clusterMainRight);
		expect(ties.length).toBeLessThan(0.0005 * counts.clusterMainRight);
		expect(counts.untouched).toBeGreaterThan(1000);
		expect(counts.truth).toBeGreaterThan(4000);
		expect(counts.movedTruth).toBeGreaterThan(1000);
		expect(counts.clusterMainRight).toBeGreaterThan(100_000);
		// The rounds do reach the cases: main places hundreds of ranges on
		// text that shares nothing with them (seed 51: 330), and some over
		// text from outside them after a move (seed 51: 20).
		expect(counts.mainUnrelated).toBeGreaterThan(100);
		expect(counts.mainStretchedMoved + counts.mainStretchedRetyped).toBeGreaterThan(5);
	}, 60_000);
});

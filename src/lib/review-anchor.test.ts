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

const BASE = 'The quick brown fox jumps over the lazy dog.';
// Anchor "brown fox" = [10, 19).
const START = BASE.indexOf('brown');
const END = START + 'brown fox'.length;

const UNBOUNDED: DiffBudget = { perPair: Infinity, total: Infinity, floor: 0 };

// Every point and range of the base text on which the mapper and main's
// whole-text diff disagree.
function disagreements(base: string, current: string) {
	const spans = wholeTextSpans(base, current);
	const mapper = createAnchorMapper(UNBOUNDED);
	const found: unknown[] = [];
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	for (let start = -1; start <= base.length + 1; start++) {
		if (!same(mapper.point(base, current, start), wholeTextPoint(spans, base.length, start)))
			found.push({ base, current, start });
		for (let end = start; end <= base.length + 1; end++) {
			const range = mapper.range(base, current, start, end);
			if (!same(range, wholeTextRange(spans, base.length, start, end)))
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
		expect(mapper.spent()).toBeLessThan(5);
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
			const spans = wholeTextSpans(base, current);
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
				// In the shared start nothing moves, as on main.
				if (shared > 0 && position <= shared) {
					expect(now).toBe(position);
					expect(now).toBe(wholeTextPoint(spans, base.length, position));
				}
				if (position === base.length) break;
				const one = mapper.range(base, current, position, position + 1);
				if (one) {
					kept++;
					expect(current[one.start]).toBe(base[position]);
					expect(one.end - one.start).toBe(1);
				}
				if (wholeTextRange(spans, base.length, position, position + 1)) keptBefore++;
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
		const bounded = createAnchorMapper({ perPair: 5, total: 5, floor: 0 });
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
		const mapper = createAnchorMapper({ perPair: 20, total: 20, floor: 0 });
		const began = performance.now();
		const she = base.indexOf('She held');
		expect(mapper.range(base, current, she, she + 8)).toEqual({
			start: current.indexOf('She held'),
			end: current.indexOf('She held') + 8
		});
		expect(mapper.unchecked(base, current, 10, 20)).toBe(true);
		expect(mapper.unchecked(base, current, base.length - 20, base.length - 10)).toBe(true);
		expect(performance.now() - began).toBeLessThan(250);
	});

	it('spends its budget over every pair it compares, with a floor for each', () => {
		// Each pair needs a slow comparison of its own.
		const versions = Array.from({ length: 40 }, (_, n) => `${n} ${old.slice(n)}${rewritten} ${n}`);
		const current = `now ${old}${old} now`;
		const at = 2;
		const mapper = createAnchorMapper({ perPair: 1000, total: 30, floor: 0 });
		const began = performance.now();
		for (const version of versions) mapper.point(version, current, at);
		expect(performance.now() - began).toBeLessThan(250);
		expect(mapper.unchecked(versions.at(-1)!, current, 10, 10)).toBe(true);
		// A pair already compared costs nothing more.
		const spent = mapper.spent();
		mapper.point(versions[0], current, at);
		expect(mapper.spent()).toBe(spent);
		// With a floor for each pair, every cheap one is still placed.
		const cheap = createAnchorMapper({ perPair: 1000, total: 0, floor: 2 });
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
		// A change to its own first letters still shrinks it.
		const inside = 'Alice repays the toll.';
		expect(quote(inside, mapper.ends(base, inside, 6, 10))).toBe('repays');
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
	// from, or -1 for one that is new.
	type Cell = { ch: string; from: number };
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
		const mark = (set: Set<number>, para: Cell[]) => {
			for (const c of para) if (c.from !== -1) set.add(c.from);
		};
		for (let n = 1 + next(4); n > 0; n--) {
			const k = next(paras.length);
			const kind = next(12);
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
				removeAt(k);
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
		return { base, current, pos, edits, shuffled, copied };
	}

	const splits = (text: string, at: number) =>
		at > 0 &&
		at < text.length &&
		/[\uD800-\uDBFF]/.test(text[at - 1]) &&
		/[\uDC00-\uDFFF]/.test(text[at]);
	const occurrences = (text: string, part: string) => {
		let count = 0;
		for (let at = text.indexOf(part); at !== -1 && count < 2; at = text.indexOf(part, at + 1))
			count++;
		return count;
	};

	// (a) A range whose words are untouched and stand once in each version is
	// placed where they went, or not at all. (b) A range inside an untouched
	// paragraph whose order against the other untouched ones is unchanged is
	// always placed, there. (c) A range main places where it belongs is
	// placed there too. (d) No result is out of range, inverted or splits a
	// character.
	//
	// Held out, each for a reason the design gives:
	// - Ranges on a paragraph that was copied, from (a) to (c): either copy can
	//   be called the original, and the mapper takes the one left as it was.
	// - Ranges on a line that stands more than once (a scene break, a short
	//   reply), from (c): such a line is never paired, so when copies of it are
	//   deleted or added, which copy is kept is a guess, and the mapper and
	//   main can guess differently.
	// - Rounds that move a paragraph (moved or swapped), from (a) and (c); (b)
	//   and (d) still hold there. Moves are not followed, so the place a
	//   paragraph left is compared by character with whatever changed text
	//   now faces it, and main's diff, which can keep the moved text, places
	//   some ranges there that this does not, and this a few that it should
	//   not. This is a known gap of the design: the counts are returned
	//   (movedMisplaced, against main's) and reported, not asserted.
	// Where (a) fails only because main's own diff misplaces the range the
	// same way inside a gap (the gap is compared exactly as main compares it),
	// the result is counted as inherited, not as misplaced.
	function check(seed: number, rounds: number) {
		const next = seeded(seed);
		const misplaced: unknown[] = [];
		const untouchedLost: unknown[] = [];
		const mainOnly: unknown[] = [];
		const counts = { untouched: 0, truth: 0, inherited: 0, movedTruth: 0, movedMisplaced: 0 };
		const mainCounts = { movedMisplaced: 0 };
		for (let round = 0; round < rounds; round++) {
			const { base, current, pos, edits, shuffled, copied } = proseCase(next);
			const moved = shuffled.size > 0;
			const spans = wholeTextSpans(base, current);
			const mapper = createAnchorMapper(WRITER_DIFF_BUDGET);
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
			const lineAt = (at: number) => {
				const from = Math.max(base.lastIndexOf('\n', at - 1) + 1, 0);
				const to = base.indexOf('\n', at);
				return base.slice(from, to === -1 ? base.length : to).replace(/\r$/, '');
			};
			const repeated = (s: number, e: number) => {
				for (let k = s; k < e; k++) {
					const line = lineAt(k);
					if (line && base.split('\n').filter((l) => l.replace(/\r$/, '') === line).length > 1)
						return true;
				}
				return false;
			};
			const valid = (got: { start: number; end: number } | null) =>
				got === null ||
				(got.start >= 0 &&
					got.end <= current.length &&
					got.start < got.end &&
					!splits(current, got.start) &&
					!splits(current, got.end));
			const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

			// (b) Untouched paragraphs, not copied, whose text stands once in
			// each version and whose order against every other paragraph that
			// kept any of its text is unchanged.
			const lines = [...base.matchAll(/[^\r\n]+/g)].map((m) => ({
				start: m.index!,
				end: m.index! + m[0].length
			}));
			const survivors = lines.map((p) => {
				for (let k = p.start; k < p.end; k++) if (pos[k] !== -1) return { at: k, to: pos[k] };
				return null;
			});
			// The truth does not know where a copy went, only the original. So
			// when the original was then deleted, or a move may have put the
			// copy on the other side of another paragraph, order is unknown.
			const orderKnown =
				(!moved || copied.size === 0) &&
				lines.every((p, i) => survivors[i] !== null || !touches(copied, p.start, p.end));
			const inOrder = lines.filter(
				(p, i) =>
					orderKnown &&
					untouched(p.start, p.end) &&
					!touches(copied, p.start, p.end) &&
					occurrences(base, base.slice(p.start, p.end)) === 1 &&
					occurrences(current, base.slice(p.start, p.end)) === 1 &&
					/[\r\n]/.test(current[pos[p.end - 1] + 1] ?? '\n') &&
					(pos[p.start] === 0 || /[\r\n]/.test(current[pos[p.start] - 1])) &&
					survivors.every((q, j) => j === i || q === null || q.at < p.start === q.to < pos[p.start])
			);
			for (const p of inOrder) {
				for (let n = 0; n < 3; n++) {
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
				// Only ranges that start and end on a visible character are held
				// to a true position: a line break or space at an edge could be
				// any of the ones between two paragraphs.
				if (/\s/.test(base[s]) || /\s/.test(base[e - 1])) continue;
				if (touches(copied, s, e)) continue;
				const want = truth(s, e);
				const words = base.slice(s, e);
				// (a)
				if (
					untouched(s, e) &&
					occurrences(base, words) === 1 &&
					occurrences(current, words) === 1
				) {
					const [ms, me] = [
						wholeTextPoint(spans, base.length, s),
						wholeTextPoint(spans, base.length, e)
					];
					const results = [
						['range', got, wholeTextRange(spans, base.length, s, e)],
						['ends', ends, ms !== null && me !== null && ms < me ? { start: ms, end: me } : null]
					] as const;
					if (moved) {
						counts.movedTruth++;
						for (const [, result, main] of results) {
							if (result !== null && !same(result, want)) counts.movedMisplaced++;
							if (main !== null && !same(main, want)) mainCounts.movedMisplaced++;
						}
						continue;
					}
					counts.truth++;
					for (const [how, result, main] of results) {
						if (result === null || same(result, want)) continue;
						if (same(result, main)) counts.inherited++;
						else misplaced.push({ seed, round, edits, how, s, e, words, result, want });
					}
				}
				// (c)
				if (moved || repeated(s, e)) continue;
				const main = wholeTextRange(spans, base.length, s, e);
				if (main !== null && same(main, want) && !same(got, want))
					mainOnly.push({ seed, round, edits, s, e, words, got, want });
			}
		}
		return { misplaced, untouchedLost, mainOnly, counts, mainCounts };
	}

	it('places nothing on text it was not made on, keeps untouched text, and keeps what main keeps', () => {
		// ANCHOR_SEED runs another seed.
		const { misplaced, untouchedLost, mainOnly, counts, mainCounts } = check(
			Number(process.env.ANCHOR_SEED ?? 51),
			300
		);
		expect(misplaced).toEqual([]);
		expect(untouchedLost).toEqual([]);
		expect(mainOnly).toEqual([]);
		expect(counts.untouched).toBeGreaterThan(1000);
		expect(counts.truth).toBeGreaterThan(5000);
		// Moves: fewer misplaced than main (seed 51: 28 against 66).
		expect(counts.movedMisplaced).toBeLessThan(mainCounts.movedMisplaced);
	});
});

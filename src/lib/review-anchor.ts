import { diffChars, type ChangeObject } from 'diff';

// Re-anchors review threads, suggestions and to-do markers after the text
// changed. An anchor pins a [start, end) range (or a point) against the text
// it was made on; when the writer edits, it is mapped onto the current text
// by comparing the two versions. Both ends must land in unchanged text:
// edits elsewhere shift the range, insertions inside it stretch it, and
// deletions inside it shrink it, but if an end's own text is gone the anchor
// is lost.
//
// Main compared the two whole texts with one character diff, which is right
// but can hold the server's one thread for seconds. Here that diff only runs
// on the stretches that changed, found like this:
// 1. Lines that stand exactly once in each text, are the same in both and are
//    long enough that a chance match is implausible (see MIN_ANCHOR) are
//    paired, keeping the set with the most text that is in the same order in
//    both. They map as they are. A line that is repeated ("***", a reply like
//    "No.") is never paired, so it cannot be bound to the wrong copy; a short
//    line is never paired, so a reply deleted in one place and typed in
//    another is not taken for a move.
// 2. Between two paired lines is a gap. In each gap the same is done with
//    sentences, so a paragraph that was edited keeps its untouched sentences
//    and a paragraph split or joined keeps both halves.
// 3. Each gap left is compared with main's character diff (the diff package,
//    as main calls it), after setting aside what its two sides share at the
//    start, under the budget. A gap whose diff runs past the budget is
//    "unchecked": an anchor in it was not looked for, which is not the same
//    as lost (what its two sides share at the end still maps).
// Nothing else pairs text. Of a paragraph that moved and the paragraphs it
// moved across, the side with more text keeps its anchors and the other is
// compared by character with whatever now faces it, which main's diff of
// the whole text sometimes matched to the moved text and sometimes not.

// A stretch of text both versions share: where it starts in each, and its
// length.
type Span = { base: number; current: number; length: number };
// A stretch that changed and was not compared, in each version.
type Gap = { base: number; baseEnd: number; current: number; currentEnd: number };

type Comparison = {
	// Sorted by base and in the same order in current, not overlapping.
	spans: Span[];
	// Where the text at an edge of an insertion or deletion reads equally on
	// either side of it ("a\n\n" + "b" against "a\n\nnew\n\n" + "b"), spans
	// holds the earlier reading, as main's diff does, and late the later one.
	// A range's start takes the later reading when it can, so that a range
	// beginning at a line break does not take in a paragraph put in before
	// it; its end takes the earlier one, so that one ending at a line break
	// does not take in a paragraph put in after it.
	late: Span[];
	gaps: Gap[];
};

// Milliseconds of comparing. The server compares in its one thread, so this
// is what the comparison may hold everyone else up for.
export type DiffBudget = {
	// The most one pair of texts may take.
	perPair: number;
	// The most one mapper may take over every pair it compares.
	total: number;
	// What any one pair may take even once the total is used up, so a cheap
	// comparison late on a page is not starved by costly ones before it.
	floor: number;
};

// The writer's own pages, accept, and the Assistant working for them. A page
// compares its pairs through prepare, which lets the server answer others
// between pairs, so the longest the thread is held is about one pair.
export const WRITER_DIFF_BUDGET: DiffBudget = { perPair: 50, total: 500, floor: 2 };

// The marker remap on save: one pair, compared in the save's transaction
// while it holds the scene's row. A gap holding a marker that this does not
// finish is then finished by finish(), which does not hold the thread.
export const SAVE_DIFF_BUDGET: DiffBudget = { perPair: 50, total: 50, floor: 0 };

// The most finish() may take on save, in milliseconds of wall time. The save
// holds the scene's row meanwhile (other saves of that scene wait, well
// inside the 30 s statement timeout), so it is kept to a few seconds.
export const SAVE_FINISH_MS = 3000;

// A line or sentence is paired only if it has at least this many characters
// that are not white space: about three or four words of prose. Two such
// units that are the same, stand once in each text and lie in the same order
// as everything else paired are the same words; a shorter one ("No.", "I
// know.") can stand once in each by chance after the writer deleted it in
// one place and typed it in another.
const MIN_ANCHOR = 16;

// How long prepare runs before it lets the server answer others.
const PREPARE_SLICE_MS = 20;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
// Whether `at` falls between the two halves of a character.
const splitsPair = (text: string, at: number) =>
	at > 0 &&
	at < text.length &&
	isHighSurrogate(text.charCodeAt(at - 1)) &&
	isLowSurrogate(text.charCodeAt(at));
const isSpace = (code: number) =>
	code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x2028 || code === 0x2029;

// What the two sides of a gap share at the start and at the end, each found
// on its own (so the two may overlap), and never cutting a character in two.
const CHUNK = 256;
function sharedEnds(base: string, current: string, gap: Gap) {
	const shortest = Math.min(gap.baseEnd - gap.base, gap.currentEnd - gap.current);
	const b = gap.base;
	const c = gap.current;
	let prefix = 0;
	// In chunks first, which the engine compares far faster than one
	// character at a time.
	while (
		prefix + CHUNK <= shortest &&
		base.slice(b + prefix, b + prefix + CHUNK) === current.slice(c + prefix, c + prefix + CHUNK)
	)
		prefix += CHUNK;
	while (prefix < shortest && base.charCodeAt(b + prefix) === current.charCodeAt(c + prefix))
		prefix++;
	while (prefix > 0 && (splitsPair(base, b + prefix) || splitsPair(current, c + prefix))) prefix--;
	const be = gap.baseEnd;
	const ce = gap.currentEnd;
	let suffix = 0;
	while (
		suffix + CHUNK <= shortest &&
		base.slice(be - suffix - CHUNK, be - suffix) === current.slice(ce - suffix - CHUNK, ce - suffix)
	)
		suffix += CHUNK;
	while (
		suffix < shortest &&
		base.charCodeAt(be - 1 - suffix) === current.charCodeAt(ce - 1 - suffix)
	)
		suffix++;
	while (suffix > 0 && (splitsPair(base, be - suffix) || splitsPair(current, ce - suffix)))
		suffix--;
	return { prefix, suffix, shortest };
}

// A line or sentence: where its text starts and ends with the white space
// around it left out, and that text.
type Unit = { start: number; end: number; key: string };

function unit(text: string, from: number, to: number, units: Unit[]) {
	while (from < to && isSpace(text.charCodeAt(from))) from++;
	while (to > from && isSpace(text.charCodeAt(to - 1))) to--;
	let visible = 0;
	for (let i = from; i < to && visible < MIN_ANCHOR; i++)
		if (!isSpace(text.charCodeAt(i))) visible++;
	if (visible >= MIN_ANCHOR) units.push({ start: from, end: to, key: text.slice(from, to) });
}

// The lines of text[from, to) long enough to pair.
function lines(text: string, from: number, to: number): Unit[] {
	const units: Unit[] = [];
	let at = from;
	while (at < to) {
		let end = text.indexOf('\n', at);
		if (end === -1 || end > to) end = to;
		unit(text, at, end, units);
		at = end + 1;
	}
	return units;
}

// The sentences of text[from, to) long enough to pair. A sentence ends after
// a run of . ! ? (and any closing quotes or brackets) followed by white
// space, or at a line break.
// With the ellipsis and the closing curly quotes as escapes.
const ENDS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']']);
function sentences(text: string, from: number, to: number): Unit[] {
	const units: Unit[] = [];
	let start = from;
	for (let at = from; at < to; at++) {
		const ch = text[at];
		if (ch === '\n') {
			unit(text, start, at, units);
			start = at + 1;
		} else if (ENDS.has(ch)) {
			let end = at + 1;
			while (end < to && (ENDS.has(text[end]) || CLOSERS.has(text[end]))) end++;
			if (end === to || isSpace(text.charCodeAt(end))) {
				unit(text, start, end, units);
				start = end;
			}
			at = end - 1;
		}
	}
	unit(text, start, to, units);
	return units;
}

// The units that stand once on each side and are the same, as pairs in the
// same order on both sides: of all such sets, the one with the most text.
function pairUnits(a: Unit[], b: Unit[]): [Unit, Unit][] {
	const once = (units: Unit[]) => {
		const seen = new Map<string, Unit | null>();
		for (const u of units) seen.set(u.key, seen.has(u.key) ? null : u);
		return seen;
	};
	const inB = once(b);
	const pairs: [Unit, Unit][] = [];
	for (const [key, u] of once(a)) {
		const v = inB.get(key);
		if (u && v) pairs.push([u, v]);
	}
	if (pairs.length < 2) return pairs;
	pairs.sort((x, y) => x[0].start - y[0].start);
	// Heaviest increasing run of the b positions, with a tree of prefix
	// maxima over the b order.
	const rank = new Map<number, number>();
	[...pairs].sort((x, y) => x[1].start - y[1].start).forEach((p, i) => rank.set(p[1].start, i + 1));
	const size = pairs.length;
	const treeBest = new Float64Array(size + 1);
	const treeAt = new Int32Array(size + 1).fill(-1);
	const total = new Float64Array(size);
	const previous = new Int32Array(size);
	let bestEnd = 0;
	for (let i = 0; i < size; i++) {
		const r = rank.get(pairs[i][1].start)!;
		let best = 0;
		let from = -1;
		for (let k = r - 1; k > 0; k -= k & -k) {
			if (treeBest[k] > best) {
				best = treeBest[k];
				from = treeAt[k];
			}
		}
		total[i] = best + pairs[i][0].key.length;
		previous[i] = from;
		for (let k = r; k <= size; k += k & -k) {
			if (total[i] > treeBest[k]) {
				treeBest[k] = total[i];
				treeAt[k] = i;
			}
		}
		if (total[i] > total[bestEnd]) bestEnd = i;
	}
	const kept: [Unit, Unit][] = [];
	for (let i = bestEnd; i !== -1; i = previous[i]) kept.push(pairs[i]);
	return kept.reverse();
}

// The spans a diff of base[gap] against current[gap] gives.
function partSpans(parts: ChangeObject<string>[], gap: Gap): Span[] {
	const spans: Span[] = [];
	let b = gap.base;
	let c = gap.current;
	for (const part of parts) {
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

class Comparer {
	spans: Span[] = [];
	late: Span[] = [];
	gaps: Gap[] = [];
	// Gaps still to be compared by character.
	private pending: { inner: Gap; suffix: number }[] = [];
	private base: string;
	private current: string;

	constructor(base: string, current: string) {
		this.base = base;
		this.current = current;
	}

	// Sets aside what the two sides of a gap share at the start, and returns
	// what is left to compare by character, if both sides of it hold text,
	// with the length the two share at the end. The shared end is not set
	// aside before the diff: main's diff does not, and where an insertion
	// next to it reads two ways (".", then "\n\nNew." put after it), setting it
	// aside would pick the other reading. It is kept only if the diff fails.
	private trim(gap: Gap): { inner: Gap; suffix: number } | null {
		const { prefix, suffix, shortest } = sharedEnds(this.base, this.current, gap);
		const head = (length: number, into: Span[]) => {
			if (length > 0) into.push({ base: gap.base, current: gap.current, length });
		};
		const tail = (length: number, into: Span[]) => {
			if (length > 0)
				into.push({ base: gap.baseEnd - length, current: gap.currentEnd - length, length });
		};
		if (prefix + suffix <= shortest) {
			head(prefix, this.spans);
			const inner = { ...gap, base: gap.base + prefix, current: gap.current + prefix };
			if (inner.baseEnd - inner.base === suffix || inner.currentEnd - inner.current === suffix) {
				tail(suffix, this.spans);
				return null;
			}
			return { inner, suffix };
		}
		// The shorter side is shared whole, and reads two ways: its start with
		// the start of the longer and the rest with its end, or its end with the
		// end of the longer and the rest with its start.
		const cuts = (headLength: number, tailLength: number) =>
			splitsPair(this.base, gap.base + headLength) ||
			splitsPair(this.current, gap.current + headLength) ||
			splitsPair(this.base, gap.baseEnd - tailLength) ||
			splitsPair(this.current, gap.currentEnd - tailLength);
		head(prefix, this.spans);
		if (!cuts(prefix, shortest - prefix)) tail(shortest - prefix, this.spans);
		if (!cuts(shortest - suffix, suffix)) {
			head(shortest - suffix, this.late);
			tail(suffix, this.late);
		}
		return null;
	}

	// Pairs units of `split` in gap, and hands each stretch between them to
	// `then`.
	private pair(gap: Gap, split: typeof lines, then: (gap: Gap) => void) {
		const pairs = pairUnits(
			split(this.base, gap.base, gap.baseEnd),
			split(this.current, gap.current, gap.currentEnd)
		);
		let b = gap.base;
		let c = gap.current;
		for (let i = 0; i <= pairs.length; i++) {
			const [u, v] = pairs[i] ?? [];
			const be = u ? u.start : gap.baseEnd;
			const ce = v ? v.start : gap.currentEnd;
			if (be > b && ce > c) then({ base: b, baseEnd: be, current: c, currentEnd: ce });
			if (!u || !v) break;
			this.spans.push({ base: u.start, current: v.start, length: u.end - u.start });
			b = u.end;
			c = v.end;
		}
	}

	run(allowance: number) {
		const began = performance.now();
		const whole = {
			base: 0,
			baseEnd: this.base.length,
			current: 0,
			currentEnd: this.current.length
		};
		this.pair(whole, lines, (lineGap) =>
			this.pair(lineGap, sentences, (gap) => {
				const inner = this.trim(gap);
				if (inner) this.pending.push(inner);
			})
		);
		// Smallest first, so one that cannot finish does not use up what the
		// others need.
		const size = (gap: Gap) => gap.baseEnd - gap.base + gap.currentEnd - gap.current;
		this.pending.sort((x, y) => size(x.inner) - size(y.inner));
		for (const { inner, suffix } of this.pending) {
			const left = () => allowance - (performance.now() - began);
			const [a, b] = texts(this.base, this.current, inner);
			const parts = left() > 0 ? diffChars(a, b, { timeout: left() }) : undefined;
			if (parts) {
				this.spans.push(...partSpans(parts, inner));
				continue;
			}
			// Unchecked: what the two sides share at the end still maps.
			if (suffix > 0) {
				this.spans.push({
					base: inner.baseEnd - suffix,
					current: inner.currentEnd - suffix,
					length: suffix
				});
			}
			this.gaps.push({
				...inner,
				baseEnd: inner.baseEnd - suffix,
				currentEnd: inner.currentEnd - suffix
			});
		}
	}
}

const texts = (base: string, current: string, gap: Gap): [string, string] => [
	base.slice(gap.base, gap.baseEnd),
	current.slice(gap.current, gap.currentEnd)
];

// Sorted by base, with spans that touch in both texts joined.
function tidy(spans: Span[]): Span[] {
	spans.sort((x, y) => x.base - y.base);
	const out: Span[] = [];
	for (const span of spans) {
		const last = out.at(-1);
		if (
			last &&
			last.base + last.length === span.base &&
			last.current + last.length === span.current
		)
			out[out.length - 1] = { ...last, length: last.length + span.length };
		else out.push(span);
	}
	return out;
}

function compareTexts(base: string, current: string, allowance: number): Comparison {
	if (base === current) {
		return {
			spans: base ? [{ base: 0, current: 0, length: base.length }] : [],
			late: [],
			gaps: []
		};
	}
	const comparer = new Comparer(base, current);
	comparer.run(allowance);
	return {
		spans: tidy(comparer.spans),
		late: tidy(comparer.late),
		gaps: comparer.gaps
	};
}

// The span holding a range's start ([base, base + length)), or its end
// ((base, base + length]), or a point ([base, base + length], the earlier
// span winning where two meet, as on main); -1 if none.
function spanAt(spans: Span[], position: number, edge: 'start' | 'end' | 'point'): number {
	let low = 0;
	let high = spans.length - 1;
	let last = -1;
	// The last span starting at or before `position` (before it, for an end).
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (edge === 'end' ? spans[mid].base < position : spans[mid].base <= position) {
			last = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	if (last === -1) return -1;
	const endOf = (s: Span) => s.base + s.length;
	if (edge === 'start') return position < endOf(spans[last]) ? last : -1;
	if (edge === 'end') return position <= endOf(spans[last]) ? last : -1;
	if (last > 0 && endOf(spans[last - 1]) === position) return last - 1;
	return position <= endOf(spans[last]) ? last : -1;
}

function mapIn(spans: Span[], position: number, edge: 'start' | 'end' | 'point'): number | null {
	const at = spanAt(spans, position, edge);
	return at === -1 ? null : spans[at].current + position - spans[at].base;
}

// A range's two ends, as main maps them, except that the start moves to the
// later reading when there is one further on that still leaves a range.
function mapEnds(
	found: Comparison,
	start: number,
	end: number,
	edges: ['start', 'end'] | ['point', 'point']
) {
	const to = mapIn(found.spans, end, edges[1]);
	const from = mapIn(found.spans, start, edges[0]);
	if (to === null || from === null) return null;
	const late = found.late.length ? mapIn(found.late, start, edges[0]) : null;
	if (late !== null && late > from && late < to) return { start: late, end: to };
	return from < to ? { start: from, end: to } : null;
}

function inGap(found: Comparison, position: number, edge: 'start' | 'end' | 'point'): boolean {
	return found.gaps.some((gap) =>
		edge === 'start'
			? position >= gap.base && position < gap.baseEnd
			: edge === 'end'
				? position > gap.base && position <= gap.baseEnd
				: position >= gap.base && position <= gap.baseEnd
	);
}

// Every thread and suggestion anchored to the same scene revision re-anchors
// against the same two texts. A mapper compares each pair of texts once and
// maps every anchor through that one result. Make one per request and hand it
// to everything that re-anchors, so the cost is per revision rather than per
// anchor, and the budget is for the whole request.
export type AnchorMapper = {
	range(
		baseText: string,
		currentText: string,
		start: number,
		end: number
	): { start: number; end: number } | null;
	point(baseText: string, currentText: string, position: number): number | null;
	// Each end of a range mapped as a point, so an edit right at an edge
	// stretches or shrinks it instead of losing it (a marker's rule). Null if
	// either end is gone or the range is left empty.
	ends(
		baseText: string,
		currentText: string,
		start: number,
		end: number
	): { start: number; end: number } | null;
	// Whether an anchor that range, point or ends could not place lies in a
	// gap that was not compared (it would have cost too much), so the null
	// means "not looked for", not "gone". start === end is a point.
	unchecked(baseText: string, currentText: string, start: number, end: number): boolean;
	// Compares every pair not yet compared, letting the server answer others
	// every PREPARE_SLICE_MS. Call it before mapping many pairs in one go.
	prepare(pairs: Iterable<[string, string]>): Promise<void>;
	// Compares the unchecked gaps of a pair that hold any of `positions`
	// without holding the thread (the diff package's own asynchronous mode,
	// which yields after every step), for up to `ms` of wall time. A gap it
	// does not finish in that time stays unchecked.
	finish(baseText: string, currentText: string, positions: number[], ms: number): Promise<void>;
	// The milliseconds spent comparing so far.
	spent(): number;
};

export function createAnchorMapper(budget: DiffBudget): AnchorMapper {
	let spent = 0;
	// Nested by base text then current text, so neither key has to be
	// concatenated into a third copy of the scene.
	const cache = new Map<string, Map<string, Comparison>>();
	const cached = (baseText: string, currentText: string) => cache.get(baseText)?.get(currentText);
	const compare = (baseText: string, currentText: string): Comparison => {
		let found = cached(baseText, currentText);
		if (!found) {
			const began = performance.now();
			const allowance = Math.max(budget.floor, Math.min(budget.perPair, budget.total - spent));
			found = compareTexts(baseText, currentText, allowance);
			spent += performance.now() - began;
			let byCurrent = cache.get(baseText);
			if (!byCurrent) cache.set(baseText, (byCurrent = new Map()));
			byCurrent.set(currentText, found);
		}
		return found;
	};
	const valid = (baseText: string, start: number, end: number) =>
		start >= 0 && end <= baseText.length && start <= end;
	return {
		range(baseText, currentText, start, end) {
			if (start < 0 || end > baseText.length || start >= end) return null;
			if (baseText === currentText) return { start, end };
			return mapEnds(compare(baseText, currentText), start, end, ['start', 'end']);
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			return mapIn(compare(baseText, currentText).spans, position, 'point');
		},
		ends(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || start === end) return null;
			if (baseText === currentText) return { start, end };
			return mapEnds(compare(baseText, currentText), start, end, ['point', 'point']);
		},
		unchecked(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || baseText === currentText) return false;
			const found = compare(baseText, currentText);
			if (start === end) {
				return mapIn(found.spans, start, 'point') === null && inGap(found, start, 'point');
			}
			return (
				(mapIn(found.spans, start, 'start') === null && inGap(found, start, 'start')) ||
				(mapIn(found.spans, end, 'end') === null && inGap(found, end, 'end'))
			);
		},
		async prepare(pairs) {
			let since = performance.now();
			for (const [baseText, currentText] of pairs) {
				if (baseText === currentText || cached(baseText, currentText)) continue;
				if (performance.now() - since >= PREPARE_SLICE_MS) {
					await new Promise((resolve) => setImmediate(resolve));
					since = performance.now();
				}
				compare(baseText, currentText);
			}
		},
		async finish(baseText, currentText, positions, ms) {
			if (baseText === currentText) return;
			const found = compare(baseText, currentText);
			const deadline = Date.now() + ms;
			const wanted = found.gaps.filter((gap) =>
				positions.some((at) => at >= gap.base && at <= gap.baseEnd)
			);
			for (const gap of wanted) {
				const timeout = deadline - Date.now();
				if (timeout <= 0) break;
				const parts = await new Promise<ChangeObject<string>[] | undefined>((resolve) =>
					diffChars(
						baseText.slice(gap.base, gap.baseEnd),
						currentText.slice(gap.current, gap.currentEnd),
						{ timeout, callback: resolve }
					)
				);
				if (!parts) continue;
				found.spans = tidy([...found.spans, ...partSpans(parts, gap)]);
				found.gaps = found.gaps.filter((other) => other !== gap);
			}
		},
		spent: () => spent
	};
}

// Mapping without a budget. For tests and the plain mapping function
// listThreads accepts; the server maps through a mapper with a budget.
const UNBOUNDED: DiffBudget = { perPair: Infinity, total: Infinity, floor: 0 };
export function reanchorRange(
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	return createAnchorMapper(UNBOUNDED).range(baseText, currentText, start, end);
}
export function reanchorPoint(
	baseText: string,
	currentText: string,
	position: number
): number | null {
	return createAnchorMapper(UNBOUNDED).point(baseText, currentText, position);
}

// Where a suggestion's range now is. Unlike a comment's, a suggestion
// replaces its range wholesale, so the range must still hold exactly the text
// it was proposed against: an edit inside it (which range tolerates by
// stretching or shrinking) would be silently overwritten on accept. A
// mapping can also stretch over an insertion just outside the range ("She
// walked in." -> "She slowly walked in." maps "walked in" to "wly walked
// in"), so the original is accepted where it starts at the mapped start or
// ends at the mapped end, and nowhere else: a search inside the stretched
// range could find the same words in a sentence the writer just added. A
// pure insertion point maps as a point.
export function placeSuggestion(
	mapper: AnchorMapper,
	baseText: string,
	currentText: string,
	start: number,
	end: number
): { start: number; end: number } | null {
	if (start === end) {
		const point = mapper.point(baseText, currentText, start);
		return point === null ? null : { start: point, end: point };
	}
	const range = mapper.range(baseText, currentText, start, end);
	if (!range) return null;
	const original = baseText.slice(start, end);
	if (currentText.slice(range.start, range.end) === original) return range;
	const length = original.length;
	if (range.end - range.start < length) return null;
	const atStart = currentText.startsWith(original, range.start);
	const atEnd = currentText.slice(range.end - length, range.end) === original;
	// Both would be a guess between two places.
	if (atStart === atEnd) return null;
	return atStart
		? { start: range.start, end: range.start + length }
		: { start: range.end - length, end: range.end };
}

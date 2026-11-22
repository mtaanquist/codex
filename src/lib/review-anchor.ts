// Re-anchors review threads, suggestions and to-do markers after the text
// changed. An anchor pins a [start, end) range (or a point) against the text
// it was made on; when the writer edits, it is mapped onto the current text
// by comparing the two versions. Both ends must land in unchanged text:
// edits elsewhere shift the range, insertions inside it stretch it, and
// deletions inside it shrink it, but if an end's own text is gone the anchor
// is lost.
//
// The comparison works down from paragraphs to words to characters, so an
// ordinary large edit (a word replaced everywhere, a tenth of the paragraphs
// rewritten) costs about what reading the scene costs, and a range inside a
// paragraph the writer left alone is always placed:
// 1. The start and the end the texts share are set aside, cut back to whole
//    lines.
// 2. The lines in between are compared as wholes (a line is a paragraph in
//    prose). A line that stands once among the removed lines and once among
//    the added ones counts as moved.
// 3. Each stretch of changed lines is compared on its own: lines are paired
//    from either end while they stay alike (as after a word replaced
//    everywhere), lines left over that are nearly the same are paired a few
//    ahead, and the rest is compared by characters, or when that is too
//    costly by words and then by characters inside each changed run. Short
//    runs shared by chance in rewritten text are set aside.
// Every comparison has a cap on its work, so the server's one thread cannot
// be held. A stretch whose comparison hit its cap was not looked at: an
// anchor in it is "unchecked", which is not the same as lost.

// A stretch of text both versions share: where it starts in each, and its
// length. A moved one is out of order with the rest.
type Span = { base: number; current: number; length: number; moved?: true };
// A stretch that changed and was not compared, in each version.
type Gap = { base: number; baseEnd: number; current: number; currentEnd: number };

type Comparison = { spans: Span[]; gaps: Gap[] };

// Work is counted in steps of 2 to 3 nanoseconds on a typical server (see
// the measurements in the history notes): splitting text into tokens, and
// the comparison proper.
export type DiffBudget = {
	// The most one pair of texts may cost.
	perPair: number;
	// The most one mapper may spend over every pair it compares.
	total: number;
	// What any one pair may spend even once the total is used up, so that a
	// cheap comparison late on a page is not starved by costly ones before
	// it. The most a mapper can spend is total + pairs * floor.
	floor: number;
};

// The writer's own pages, and the Assistant working for them: about 300 ms
// for a page at most, and 75 ms for any one pair, which is more than a scene
// of 120,000 characters with nothing in common takes.
export const WRITER_DIFF_BUDGET: DiffBudget = {
	perPair: 30_000_000,
	total: 120_000_000,
	floor: 1_000_000
};

// Saving the writer's own text, which markers follow: one pair, compared as
// far as the caps inside the comparison allow (lineCap, charCap, wordCap).
// They grow with the size of what changed, so it always finishes, and a
// stretch past them is left unchecked rather than called gone.
export const SAVE_DIFF_BUDGET: DiffBudget = { perPair: Infinity, total: Infinity, floor: 0 };

// What a token costs to make, per character, and a round of the comparison
// per diagonal looked at and per pair of tokens compared along one.
const LINE_STEPS_PER_CHAR = 1.25;
const STEPS_PER_LINE = 30;
const SHARED_STEPS_PER_CHAR = 0.01;
const WORD_STEPS_PER_CHAR = 10;
const CHAR_STEPS_PER_CHAR = 1.25;
const STEPS_PER_DIAGONAL = 6;
const STEPS_PER_MATCH = 1;
const STEPS_PER_COMPARISON = 1000;

// Caps on one comparison of token lists, so that a stretch that cannot line
// up gives up early and leaves the rest of the pair to the stretches that
// can. Each is so much per token plus a fixed allowance: lines and words get
// enough for about a thousand edits, characters for about a hundred and fifty.
const lineCap = (tokens: number) => 4 * tokens + 3_000_000;
const wordCap = (tokens: number) => 4 * tokens + 3_000_000;
const charCap = (tokens: number) => 2 * tokens + 60_000;

// Two stretches are alike (one is an edit of the other, not a rewrite) when
// at least half of the shorter lies in shared runs this long, which unrelated
// prose almost never has.
const ALIKE_RUN = 8;
// Lines left over after pairing from either end are paired when nearly the
// same (this share of the longer in long runs), looking this many ahead.
const NEAR = 0.8;
const LOOK_AHEAD = 3;
function isAlike(spans: Span[], baseLength: number, currentLength: number): boolean {
	let long = 0;
	for (const span of spans) if (span.length >= ALIKE_RUN) long += span.length;
	return 2 * long >= Math.min(baseLength, currentLength);
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isNewline = (code: number) => code === 10 || code === 13;

// The work a comparison may still do, shared by everything in one pair.
class Meter {
	spent = 0;
	limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	left(): number {
		return this.limit - this.spent;
	}
	charge(steps: number): void {
		this.spent += steps;
	}
}

// Tokens of one stretch of text: what each is (equal numbers for equal
// text), and where each starts, with one more entry for where the last ends.
type Tokens = { ids: Int32Array; offsets: Int32Array; count: number };

// Shortest edit script between two token lists (Myers, 1986), as the runs
// they share: [aIndex, bIndex, length] flattened. Null when it would take
// more than `cap` steps; whatever it did is charged either way.
function shortestEdit(a: Int32Array, b: Int32Array, cap: number, meter: Meter): number[] | null {
	const runs: number[] = [];
	let n = a.length;
	let m = b.length;
	let head = 0;
	while (head < n && head < m && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail++;
	let steps = STEPS_PER_COMPARISON + (head + tail) * STEPS_PER_MATCH;
	if (head > 0) runs.push(0, 0, head);
	const finish = () => {
		if (tail > 0) runs.push(n + head, m + head, tail);
		return runs;
	};
	n -= head + tail;
	m -= head + tail;
	if (n === 0 || m === 0) {
		meter.charge(steps);
		return finish();
	}
	// The furthest point reached on each diagonal k of each round d, round
	// after round in one array: round d holds d + 1 entries, k = -d, -d + 2,
	// ..., d at index (k + d) / 2, and starts at d(d + 1) / 2.
	let far = new Int32Array(1024);
	for (let d = 0; d <= n + m; d++) {
		steps += (d + 1) * STEPS_PER_DIAGONAL;
		if (steps > cap) {
			meter.charge(steps);
			return null;
		}
		const round = (d * (d + 1)) / 2;
		const prev = ((d - 1) * d) / 2;
		if (round + d + 1 > far.length) {
			const grown = new Int32Array(Math.max(far.length * 2, round + d + 1));
			grown.set(far);
			far = grown;
		}
		for (let i = 0; i <= d; i++) {
			const k = 2 * i - d;
			// From the diagonal above (an insertion) or the one below (a deletion).
			let x =
				d === 0
					? 0
					: i === 0 || (i !== d && far[prev + i - 1] < far[prev + i])
						? far[prev + i]
						: far[prev + i - 1] + 1;
			let y = x - k;
			const from = x;
			while (x < n && y < m && a[head + x] === b[head + y]) {
				x++;
				y++;
			}
			steps += (x - from) * STEPS_PER_MATCH;
			far[round + i] = x;
			if (x >= n && y >= m) {
				meter.charge(steps);
				// Walk back from the end through the furthest points of each
				// round, collecting the diagonal runs.
				const found: number[] = [];
				let cx = n;
				let cy = m;
				for (let back = d; back > 0; back--) {
					const before = ((back - 1) * back) / 2;
					const kk = cx - cy;
					const at = (kk + back) / 2;
					const down = at === 0 || (at !== back && far[before + at - 1] < far[before + at]);
					const prevX = down ? far[before + at] : far[before + at - 1];
					const startX = down ? prevX : prevX + 1;
					if (cx > startX) found.push(head + startX, head + startX - kk, cx - startX);
					cx = prevX;
					cy = prevX - (down ? kk + 1 : kk - 1);
				}
				if (cx > 0) found.push(head, head, cx);
				for (let r = found.length - 3; r >= 0; r -= 3) {
					runs.push(found[r], found[r + 1], found[r + 2]);
				}
				return finish();
			}
			if (steps > cap) {
				meter.charge(steps);
				return null;
			}
		}
	}
	meter.charge(steps);
	return finish();
}

// Lines of text[from, to): each is its content and the line breaks after
// it. Ids are of the content alone, so a paragraph that moved to or from the
// very end (and so gained or lost its breaks) still matches.
type Lines = Tokens & { contentEnds: Int32Array };
function splitLines(
	text: string,
	from: number,
	to: number,
	ids: Map<string, number>,
	meter: Meter
): Lines {
	const starts: number[] = [];
	const contentEnds: number[] = [];
	const values: number[] = [];
	let at = from;
	while (at < to) {
		let end = text.indexOf('\n', at);
		if (end === -1 || end > to) end = to;
		let contentEnd = end;
		while (contentEnd > at && isNewline(text.charCodeAt(contentEnd - 1))) contentEnd--;
		let next = end;
		while (next < to && isNewline(text.charCodeAt(next))) next++;
		const content = text.slice(at, contentEnd);
		let id = ids.get(content);
		if (id === undefined) {
			id = ids.size;
			ids.set(content, id);
		}
		starts.push(at);
		contentEnds.push(contentEnd);
		values.push(id);
		at = next;
	}
	starts.push(to);
	meter.charge((to - from) * LINE_STEPS_PER_CHAR + values.length * STEPS_PER_LINE);
	return {
		ids: Int32Array.from(values),
		offsets: Int32Array.from(starts),
		contentEnds: Int32Array.from(contentEnds),
		count: values.length
	};
}

// Runs of letters and digits, runs of white space, and each other character.
const WORDISH = /[\p{L}\p{N}\p{M}]/u;
const SPACE = /\s/u;
function wordKind(text: string, at: number): number {
	const code = text.charCodeAt(at);
	if (code < 128) {
		if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57)) {
			return 0;
		}
		return code === 32 || (code >= 9 && code <= 13) ? 1 : 2;
	}
	const character = String.fromCodePoint(text.codePointAt(at)!);
	return WORDISH.test(character) ? 0 : SPACE.test(character) ? 1 : 2;
}
const charLength = (text: string, at: number) =>
	isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1)) ? 2 : 1;
function splitWords(
	text: string,
	from: number,
	to: number,
	ids: Map<string, number>,
	meter: Meter
): Tokens {
	const values: number[] = [];
	const starts: number[] = [];
	for (let at = from; at < to;) {
		const kind = wordKind(text, at);
		let end = at + charLength(text, at);
		if (kind !== 2) {
			while (end < to && wordKind(text, end) === kind) end += charLength(text, end);
		}
		const word = text.slice(at, end);
		let id = ids.get(word);
		if (id === undefined) {
			id = ids.size;
			ids.set(word, id);
		}
		values.push(id);
		starts.push(at);
		at = end;
	}
	starts.push(to);
	meter.charge((to - from) * WORD_STEPS_PER_CHAR);
	return { ids: Int32Array.from(values), offsets: Int32Array.from(starts), count: values.length };
}

// One token per character, a surrogate pair being one character, so no
// shared run can cut one in two.
function splitChars(text: string, from: number, to: number, meter: Meter): Tokens {
	const values = new Int32Array(to - from);
	const starts = new Int32Array(to - from + 1);
	let count = 0;
	for (let at = from; at < to;) {
		const code = text.charCodeAt(at);
		const pair = isHighSurrogate(code) && at + 1 < to && isLowSurrogate(text.charCodeAt(at + 1));
		values[count] = pair ? text.codePointAt(at)! : code;
		starts[count++] = at;
		at += pair ? 2 : 1;
	}
	starts[count] = to;
	meter.charge((to - from) * CHAR_STEPS_PER_CHAR);
	return { ids: values.subarray(0, count), offsets: starts.subarray(0, count + 1), count };
}

// The length of the start and of the end two texts share, found by plain
// comparison (in chunks first, which the engine compares far faster than one
// character at a time). Neither may cut a surrogate pair in two.
const CHUNK = 256;
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

const atLineStart = (text: string, at: number) => at === 0 || isNewline(text.charCodeAt(at - 1));

// Compares two texts within `meter`'s limit.
function compareTexts(base: string, current: string, meter: Meter): Comparison {
	const spans: Span[] = [];
	const gaps: Gap[] = [];
	if (base === current) {
		if (base.length > 0) spans.push({ base: 0, current: 0, length: base.length });
		return { spans, gaps };
	}
	let { prefix, suffix } = sharedEnds(base, current);
	meter.charge((prefix + suffix) * SHARED_STEPS_PER_CHAR);
	// Cut both back to whole lines, so the lines in between are compared as
	// wholes: otherwise a paragraph's last character could be bound to
	// another paragraph that ends the same way.
	while (prefix > 0 && !isNewline(base.charCodeAt(prefix - 1))) prefix--;
	if (
		suffix > 0 &&
		!(atLineStart(base, base.length - suffix) && atLineStart(current, current.length - suffix))
	) {
		const from = base.length - suffix;
		const breakAt = base.indexOf('\n', from);
		let start = breakAt === -1 ? base.length : breakAt;
		while (start < base.length && isNewline(base.charCodeAt(start))) start++;
		suffix = base.length - start;
	}
	if (prefix > 0) spans.push({ base: 0, current: 0, length: prefix });
	const baseEnd = base.length - suffix;
	const currentEnd = current.length - suffix;
	if (suffix > 0) spans.push({ base: baseEnd, current: currentEnd, length: suffix });
	if (baseEnd > prefix && currentEnd > prefix) {
		new Comparer(base, current, meter, spans, gaps).lines(prefix, baseEnd, prefix, currentEnd);
	}
	spans.sort((x, y) => x.base - y.base);
	gaps.sort((x, y) => x.base - y.base);
	return { spans, gaps };
}

// Shared runs of tokens as spans of text.
function runSpans(a: Tokens, b: Tokens, runs: number[]): Span[] {
	const spans: Span[] = [];
	for (let r = 0; r < runs.length; r += 3) {
		const start = a.offsets[runs[r]];
		spans.push({
			base: start,
			current: b.offsets[runs[r + 1]],
			length: a.offsets[runs[r] + runs[r + 2]] - start
		});
	}
	return spans;
}

// Two texts share letters and short words by chance, and an anchor bound to
// those would point at text that has nothing to do with it. So of the shared
// runs of a changed stretch, a short one (under KEEP_RUN characters) no
// longer than the change on either side of it is set aside; and when the
// stretch is not alike at all (a paragraph rewritten), every short one is.
// Runs at the edges of the stretch join text outside it that is shared, and
// stay.
const KEEP_RUN = 16;
function withoutStrays(spans: Span[], bs: number, be: number, cs: number, ce: number): Span[] {
	if (!isAlike(spans, be - bs, ce - cs)) {
		return spans.filter(
			(span) =>
				span.length >= KEEP_RUN ||
				(span.base === bs && span.current === cs) ||
				(span.base + span.length === be && span.current + span.length === ce)
		);
	}
	let kept = spans;
	for (let dropped = true; dropped;) {
		dropped = false;
		const next: Span[] = [];
		for (let k = 0; k < kept.length; k++) {
			const span = kept[k];
			const before = next.at(-1) ?? kept[k - 1];
			const after = kept[k + 1];
			const left = Math.max(
				span.base - (before ? before.base + before.length : bs),
				span.current - (before ? before.current + before.length : cs)
			);
			const right = Math.max(
				(after ? after.base : be) - span.base - span.length,
				(after ? after.current : ce) - span.current - span.length
			);
			// One at a time: the next run is judged against what is left.
			if (
				!dropped &&
				left > 0 &&
				right > 0 &&
				span.length < KEEP_RUN &&
				span.length <= left &&
				span.length <= right
			) {
				dropped = true;
				continue;
			}
			next.push(span);
		}
		kept = next;
	}
	return kept;
}

// A shortest edit can bind a letter to the wrong copy: "the lantern" ->
// "the old lantern" may keep the "l" of "old" and insert "d l". Where a run
// sits next to text added (or removed) on one side only, and that text ends
// (or starts) with the run's own text, the run joins its neighbour instead.
// Runs at the edges of the stretch join text outside it, and stay.
function slid(
	spans: Span[],
	base: string,
	current: string,
	bs: number,
	cs: number,
	be: number,
	ce: number
): Span[] {
	const out = spans.slice();
	const text = (from: string, at: number, length: number) => from.slice(at, at + length);
	for (let k = 0; k + 1 < out.length;) {
		const [s1, s2] = [out[k], out[k + 1]];
		const baseGap = s2.base - s1.base - s1.length;
		const currentGap = s2.current - s1.current - s1.length;
		// The side with text in the gap, and the one without.
		const [gapText, gap, s1At, s2At] =
			baseGap === 0 && currentGap > 0
				? [current, currentGap, s1.current, s2.current]
				: currentGap === 0 && baseGap > 0
					? [base, baseGap, s1.base, s2.base]
					: [null, 0, 0, 0];
		const own = (span: Span) => text(base, span.base, span.length);
		const intoNext =
			gapText !== null &&
			!(s1.base === bs && s1.current === cs) &&
			s1.length <= gap &&
			text(gapText, s2At - s1.length, s1.length) === own(s1);
		const intoPrevious =
			gapText !== null &&
			!(s2.base + s2.length === be && s2.current + s2.length === ce) &&
			s2.length <= gap &&
			text(gapText, s1At + s1.length, s2.length) === own(s2);
		if (intoNext && (!intoPrevious || s1.length <= s2.length)) {
			out.splice(k, 2, {
				base: s1.base + (baseGap === 0 ? 0 : baseGap),
				current: s1.current + (currentGap === 0 ? 0 : currentGap),
				length: s1.length + s2.length
			});
			if (k > 0) k--;
		} else if (intoPrevious) {
			out.splice(k, 2, { base: s1.base, current: s1.current, length: s1.length + s2.length });
			if (k > 0) k--;
		} else k++;
	}
	return out;
}

// One line that is in only one of the texts, for finding moved lines.
type LoneLine = { id: number; start: number; end: number };

class Comparer {
	private lineIds = new Map<string, number>();
	private wordIds = new Map<string, number>();
	private baseLone: LoneLine[] = [];
	private currentLone: LoneLine[] = [];
	private unsplit = false;

	private base: string;
	private current: string;
	private meter: Meter;
	private spans: Span[];
	private gaps: Gap[];

	constructor(base: string, current: string, meter: Meter, spans: Span[], gaps: Gap[]) {
		this.base = base;
		this.current = current;
		this.meter = meter;
		this.spans = spans;
		this.gaps = gaps;
	}

	private gap(bs: number, be: number, cs: number, ce: number) {
		this.gaps.push({ base: bs, baseEnd: be, current: cs, currentEnd: ce });
	}

	// The lines of the middle as wholes; then each stretch between lines that
	// match, smallest first, so a stretch that cannot line up does not use up
	// what the others need.
	lines(bs: number, be: number, cs: number, ce: number) {
		if (!this.affords(be - bs + ce - cs, LINE_STEPS_PER_CHAR)) return this.gap(bs, be, cs, ce);
		const a = splitLines(this.base, bs, be, this.lineIds, this.meter);
		const b = splitLines(this.current, cs, ce, this.lineIds, this.meter);
		const runs = shortestEdit(
			a.ids,
			b.ids,
			Math.min(lineCap(a.count + b.count), this.meter.left()),
			this.meter
		);
		if (!runs) return this.gap(bs, be, cs, ce);
		const matched: Span[] = [];
		for (let r = 0; r < runs.length; r += 3) {
			for (let t = 0; t < runs[r + 2]; t++) {
				const i = runs[r] + t;
				const j = runs[r + 1] + t;
				// The content, and as much of the line breaks after it as both have.
				let length = a.contentEnds[i] - a.offsets[i];
				const baseBreaks = a.offsets[i + 1] - a.contentEnds[i];
				const currentBreaks = b.offsets[j + 1] - b.contentEnds[j];
				for (let n = 0; n < Math.min(baseBreaks, currentBreaks); n++) {
					if (
						this.base.charCodeAt(a.contentEnds[i] + n) !==
						this.current.charCodeAt(b.contentEnds[j] + n)
					)
						break;
					length++;
				}
				if (length > 0) matched.push({ base: a.offsets[i], current: b.offsets[j], length });
			}
		}
		this.spans.push(...matched);
		const stretches: [number, number, number, number][] = [];
		let base = bs;
		let current = cs;
		for (const span of [...matched, { base: be, current: ce, length: 0 }]) {
			if (span.base > base || span.current > current) {
				stretches.push([base, span.base, current, span.current]);
			}
			base = span.base + span.length;
			current = span.current + span.length;
		}
		stretches.sort((x, y) => x[1] - x[0] + x[3] - x[2] - (y[1] - y[0] + y[3] - y[2]));
		for (const [sb, se, sc, sce] of stretches) this.stretch(sb, se, sc, sce);
		this.moved();
	}

	// A stretch of lines that changed between two that did not.
	private stretch(bs: number, be: number, cs: number, ce: number) {
		const pure = bs === be || cs === ce;
		if (!this.affords(be - bs + ce - cs, LINE_STEPS_PER_CHAR)) {
			// Its lines are unknown, so no line elsewhere can be told to stand once.
			this.unsplit = true;
			if (!pure) this.gap(bs, be, cs, ce);
			return;
		}
		const a = splitLines(this.base, bs, be, this.lineIds, this.meter);
		const b = splitLines(this.current, cs, ce, this.lineIds, this.meter);
		for (let i = 0; i < a.count; i++) {
			this.baseLone.push({ id: a.ids[i], start: a.offsets[i], end: a.contentEnds[i] });
		}
		for (let j = 0; j < b.count; j++) {
			this.currentLone.push({ id: b.ids[j], start: b.offsets[j], end: b.contentEnds[j] });
		}
		if (pure) return;
		let i = 0;
		let j = 0;
		let iEnd = a.count;
		let jEnd = b.count;
		if (a.count > 1 || b.count > 1) {
			// Pair lines from either end while they stay alike.
			while (i < iEnd && j < jEnd) {
				if (!this.alike(a.offsets[i], a.offsets[i + 1], b.offsets[j], b.offsets[j + 1])) break;
				i++;
				j++;
			}
			while (i < iEnd && j < jEnd) {
				if (!this.alike(a.offsets[iEnd - 1], a.offsets[iEnd], b.offsets[jEnd - 1], b.offsets[jEnd]))
					break;
				iEnd--;
				jEnd--;
			}
		}
		// What is left: lines that are nearly the same are paired wherever they
		// sit, looking a few lines ahead, and the rest compared between them.
		let pi = i;
		let pj = j;
		const between = (toI: number, toJ: number) => {
			const [rb, rbe, rc, rce] = [a.offsets[pi], a.offsets[toI], b.offsets[pj], b.offsets[toJ]];
			if (rb < rbe && rc < rce) this.region(rb, rbe, rc, rce);
		};
		if (iEnd - i > 1 || jEnd - j > 1) {
			for (let ii = i; ii < iEnd; ii++) {
				for (let jj = pj; jj < Math.min(jEnd, pj + LOOK_AHEAD); jj++) {
					if (!this.near(a.offsets[ii], a.offsets[ii + 1], b.offsets[jj], b.offsets[jj + 1]))
						continue;
					between(ii, jj);
					pi = ii + 1;
					pj = jj + 1;
					break;
				}
			}
		}
		between(iEnd, jEnd);
	}

	// Pairs two lines that are nearly the same: much the same length, and
	// most of the longer in long shared runs (a typo, a word replaced).
	private near(bs: number, be: number, cs: number, ce: number): boolean {
		const [shorter, longer] = [Math.min(be - bs, ce - cs), Math.max(be - bs, ce - cs)];
		if (shorter < NEAR * longer) return false;
		const spans = this.charSpans(bs, be, cs, ce);
		if (!spans) return false;
		let long = 0;
		for (const span of spans) if (span.length >= ALIKE_RUN) long += span.length;
		if (long < NEAR * longer) return false;
		this.spans.push(...spans);
		return true;
	}

	// Compares a pair of lines by character, keeping the result if they are
	// alike (see ALIKE_RUN).
	private alike(bs: number, be: number, cs: number, ce: number): boolean {
		const spans = this.charSpans(bs, be, cs, ce);
		if (!spans || !isAlike(spans, be - bs, ce - cs)) return false;
		this.spans.push(...spans);
		return true;
	}

	// A changed stretch, by character, or when that is too costly by word and
	// then by character inside each changed run of words.
	private region(bs: number, be: number, cs: number, ce: number) {
		if (this.chars(bs, be, cs, ce)) return;
		if (!this.affords(be - bs + ce - cs, WORD_STEPS_PER_CHAR)) return this.gap(bs, be, cs, ce);
		const a = splitWords(this.base, bs, be, this.wordIds, this.meter);
		const b = splitWords(this.current, cs, ce, this.wordIds, this.meter);
		const runs = shortestEdit(
			a.ids,
			b.ids,
			Math.min(wordCap(a.count + b.count), this.meter.left()),
			this.meter
		);
		if (!runs) return this.gap(bs, be, cs, ce);
		const shared = withoutStrays(runSpans(a, b, runs), bs, be, cs, ce);
		this.spans.push(...shared);
		// The words in between are compared by character. Past the cap they
		// count as changed: the words were compared, and what they share by
		// character would only be set aside as strays.
		let base = bs;
		let current = cs;
		for (const span of [...shared, { base: be, current: ce, length: 0 }]) {
			if (span.base > base && span.current > current)
				this.chars(base, span.base, current, span.current);
			base = span.base + span.length;
			current = span.current + span.length;
		}
	}

	private chars(bs: number, be: number, cs: number, ce: number): boolean {
		const spans = this.charSpans(bs, be, cs, ce);
		if (spans) this.spans.push(...spans);
		return spans !== null;
	}

	// The shared runs of two stretches by character; null past the caps. The
	// start and the end they share are found by plain comparison first, as
	// the comparison proper would find them, only far faster.
	private charSpans(bs: number, be: number, cs: number, ce: number): Span[] | null {
		const { prefix, suffix } = sharedEnds(this.base.slice(bs, be), this.current.slice(cs, ce));
		this.meter.charge((prefix + suffix) * SHARED_STEPS_PER_CHAR);
		const spans: Span[] = [];
		if (prefix > 0) spans.push({ base: bs, current: cs, length: prefix });
		const [ib, ibe, ic, ice] = [bs + prefix, be - suffix, cs + prefix, ce - suffix];
		if (ib < ibe && ic < ice) {
			if (!this.affords(ibe - ib + ice - ic, CHAR_STEPS_PER_CHAR)) return null;
			const a = splitChars(this.base, ib, ibe, this.meter);
			const b = splitChars(this.current, ic, ice, this.meter);
			const runs = shortestEdit(
				a.ids,
				b.ids,
				Math.min(charCap(a.count + b.count), this.meter.left()),
				this.meter
			);
			if (!runs) return null;
			spans.push(...runSpans(a, b, runs));
		}
		if (suffix > 0) spans.push({ base: be - suffix, current: ce - suffix, length: suffix });
		return withoutStrays(slid(spans, this.base, this.current, bs, cs, be, ce), bs, be, cs, ce);
	}

	// Whether splitting this much text into tokens fits in what is left.
	private affords(chars: number, perChar: number): boolean {
		return this.meter.left() >= chars * perChar;
	}

	// A line that is removed in one place and added in another, and stands
	// once among the changed lines on each side, moved. Whatever a stretch's
	// own comparison bound to either copy gives way to the move.
	private moved() {
		if (this.unsplit) return;
		const count = (lines: LoneLine[]) => {
			const seen = new Map<number, LoneLine | null>();
			for (const line of lines) seen.set(line.id, seen.has(line.id) ? null : line);
			return seen;
		};
		const removed = count(this.baseLone);
		const added = count(this.currentLone);
		const moves: Span[] = [];
		for (const [id, from] of removed) {
			const to = added.get(id);
			if (!from || !to) continue;
			if (!this.base.slice(from.start, from.end).trim()) continue;
			moves.push({
				base: from.start,
				current: to.start,
				length: from.end - from.start,
				moved: true
			});
		}
		if (moves.length === 0) return;
		this.meter.charge(this.spans.length * moves.length * 0.1);
		const overlaps = (span: Span) =>
			moves.some(
				(move) =>
					(span.base < move.base + move.length && span.base + span.length > move.base) ||
					(span.current < move.current + move.length && span.current + span.length > move.current)
			);
		const kept = this.spans.filter((span) => !overlaps(span));
		this.spans.length = 0;
		this.spans.push(...kept, ...moves);
	}
}

// The span holding a range's start ([base, base + length)), or its end
// ((base, base + length]), or a point ([base, base + length], the earlier
// span winning where two meet); -1 if none. Spans are sorted by base and do
// not overlap.
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
	const span = spans[last];
	const endOf = (s: Span) => s.base + s.length;
	if (edge === 'start') return position < endOf(span) ? last : -1;
	if (edge === 'end') return position <= endOf(span) ? last : -1;
	if (last > 0 && endOf(spans[last - 1]) === position) return last - 1;
	return position <= endOf(span) ? last : -1;
}

const shift = (span: Span, position: number) => span.current + position - span.base;

function mapRange(found: Comparison, start: number, end: number) {
	const s = spanAt(found.spans, start, 'start');
	const e = spanAt(found.spans, end, 'end');
	if (s === -1 || e === -1) return null;
	const [first, last] = [found.spans[s], found.spans[e]];
	// A moved line takes a range only if the range lies within it.
	if ((first.moved || last.moved) && s !== e) return null;
	const range = { start: shift(first, start), end: shift(last, end) };
	return range.end > range.start ? range : null;
}

function mapPoint(found: Comparison, position: number) {
	const at = spanAt(found.spans, position, 'point');
	return at === -1 ? null : shift(found.spans[at], position);
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
	// Whether an anchor that range, point or ends could not place lies in text
	// that was not compared (the comparison would have cost too much), so the
	// null means "not looked for", not "gone". start === end is a point.
	unchecked(baseText: string, currentText: string, start: number, end: number): boolean;
	// For an unchecked anchor: where its exact words stand in the part of the
	// current text that the unchecked part became, if they stand there once.
	findWords(
		baseText: string,
		currentText: string,
		start: number,
		end: number
	): { start: number; end: number } | null;
	// The work spent so far, in the steps of DiffBudget.
	spent(): number;
};

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
			const meter = new Meter(
				Math.max(budget.floor, Math.min(budget.perPair, budget.total - spent))
			);
			found = compareTexts(baseText, currentText, meter);
			spent += meter.spent;
			byCurrent.set(currentText, found);
		}
		return found;
	};
	const valid = (baseText: string, start: number, end: number) =>
		start >= 0 && end <= baseText.length && start <= end;
	const mapper: AnchorMapper = {
		range(baseText, currentText, start, end) {
			if (start < 0 || end > baseText.length || start >= end) return null;
			if (baseText === currentText) return { start, end };
			return mapRange(compare(baseText, currentText), start, end);
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			return mapPoint(compare(baseText, currentText), position);
		},
		ends(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || start === end) return null;
			if (baseText === currentText) return { start, end };
			const found = compare(baseText, currentText);
			const s = spanAt(found.spans, start, 'point');
			const e = spanAt(found.spans, end, 'point');
			if (s === -1 || e === -1) return null;
			if ((found.spans[s].moved || found.spans[e].moved) && s !== e) return null;
			const range = { start: shift(found.spans[s], start), end: shift(found.spans[e], end) };
			return range.end > range.start ? range : null;
		},
		unchecked(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || baseText === currentText) return false;
			const found = compare(baseText, currentText);
			if (start === end) return mapPoint(found, start) === null && inGap(found, start, 'point');
			return (
				(spanAt(found.spans, start, 'start') === -1 && inGap(found, start, 'start')) ||
				(spanAt(found.spans, end, 'end') === -1 && inGap(found, end, 'end'))
			);
		},
		findWords(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || start === end) return null;
			const found = compare(baseText, currentText);
			// Between where the compared text before and after the anchor now is.
			let from = 0;
			let to = currentText.length;
			for (const span of found.spans) {
				if (span.moved) continue;
				if (span.base <= start) from = shift(span, Math.min(start, span.base + span.length));
				if (span.base + span.length >= end) {
					to = shift(span, Math.max(end, span.base));
					break;
				}
			}
			const words = baseText.slice(start, end);
			const at = currentText.indexOf(words, from);
			if (at === -1 || at + words.length > to) return null;
			const again = currentText.indexOf(words, at + 1);
			if (again !== -1 && again + words.length <= to) return null;
			return { start: at, end: at + words.length };
		},
		spent: () => spent
	};
	return mapper;
}

// Mapping without a budget (the caps inside one comparison still apply). For
// tests; the server maps through a mapper with a budget.
const UNBOUNDED: DiffBudget = SAVE_DIFF_BUDGET;
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

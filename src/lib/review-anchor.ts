import { diffChars, type ChangeObject } from 'diff';

// Re-anchors review threads, suggestions and to-do markers after the text
// changed. An anchor pins a [start, end) range (or a point) against the text
// it was made on; when the writer edits, it is mapped onto the current text
// by comparing the two versions. Both ends must land in unchanged text:
// edits elsewhere shift the range, insertions inside it stretch it, and
// deletions inside it shrink it, but if an end's own text is gone the anchor
// is lost.
//
// Main compared the two whole texts with one character diff, which can hold
// the server's one thread for seconds. Here:
// 1. Every line, and every sentence not inside such a line, that is the same
//    in both texts, stands exactly once in each whole text and has at least
//    MIN_ANCHOR visible characters maps to its copy, wherever that now
//    stands. A repeated line ("***", a reply like "No.") or a short one is
//    never paired, so it cannot be bound to the wrong copy.
// 2. Of the paired lines, the set with the most text that is in the same
//    order in both splits the texts into gaps; inside each gap the same is
//    done with its paired sentences. Paired units that are out of order
//    (moved) are cut out of the gaps.
// 3. What is left of each gap is compared with main's character diff (the
//    diff package, as main calls it), after setting aside the start its two
//    sides share, under the budget. A gap whose diff runs past the budget is
//    "unchecked": an anchor in it was not looked for, which is not the same
//    as lost (what its two sides share at the end still maps).
// 4. An end mapped through that diff counts only where it rests on shared
//    text that cannot be chance (see SUPPORT); otherwise the anchor is lost.

// A stretch of text both versions share: where it starts in each, and its
// length. Firm when it is a paired unit or the start or end two sides of a
// gap share; otherwise it is a run the character diff kept.
type Span = { base: number; current: number; length: number; firm: boolean };

// One side of a gap with the paired units inside it cut out, as one string,
// and where each of its pieces lies in the text.
type Side = { text: string; real: number[]; at: number[] };

// Where in the base text a stretch lies whose character diff did not finish.
type Gap = { base: number; baseEnd: number };

type Comparison = {
	// Sorted by base, not overlapping in base. Paired units that moved are in
	// a different order in current.
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

// Character diff work, in edit units: a diff of edit distance D costs about
// D * D units (measured on prose, 55 to 65 ns a unit past D = 400, plus
// about 3 ms per 40,000 characters compared). Counted in units rather than
// time, so the same texts give the same result however busy the server is.
// Only the character diff is counted; the line and sentence passes cost
// about 1 ms per 10,000 characters and are not.
export type DiffBudget = {
	// The most one pair of texts may spend.
	perPair: number;
	// The most one mapper may spend over every pair it compares.
	total: number;
	// What any one pair may spend even once the total is used up, so a cheap
	// comparison late on a page is not starved by costly ones before it.
	floor: number;
};

// The writer's own pages, accept, and the Assistant working for them: up to
// D = 1000 a pair (about 55 ms), 10,000,000 units a mapper (about 0.6 s),
// D = 200 a pair after that (about 2.5 ms). A page compares its pairs
// through prepare, which lets the server answer others between pairs.
export const WRITER_DIFF_BUDGET: DiffBudget = {
	perPair: 1_000_000,
	total: 10_000_000,
	floor: 40_000
};

// The marker remap on save: one pair, D = 2500, compared in the save's
// transaction while it holds the scene's row. Enough for a rewritten
// paragraph of about 2,100 characters beside a marked sentence that also
// changed. Measured on prose: about 0.25 s for D = 2300, and about 0.35 s to
// give up at D = 2500 when the texts have nothing in common. A marker in a
// stretch past it loses its anchor.
export const SAVE_DIFF_BUDGET: DiffBudget = { perPair: 6_250_000, total: 6_250_000, floor: 0 };

// A line or sentence is paired only if it has at least this many characters
// that are not white space: about three or four words of prose. A shorter
// one ("No.", "I know.") can stand once in each text by chance after the
// writer deleted it in one place and typed it in another.
const MIN_ANCHOR = 16;

// An end mapped through a run the character diff kept counts only if that
// run holds at least this many characters. Two unrelated sentences of prose
// share runs of a word and its spaces by chance (" silence ", nine
// characters). In the property test over seeds 1 to 60 and 100 to 160, 10
// let 19 results land on text sharing nothing with their range and 12 let
// 4 (main: 50,573); 15 let none but loses nearly half as many again of
// the ranges main places correctly. With 12 the cost falls where an end
// lies in the few letters between two edits. On the test's generated prose,
// a range with an edit inside it and two or three more nearby is lost 5 to
// 9% of the time (main: 0.3%), any range in such a paragraph about 4%, and
// edits spread over the scene cost 0.03%. On natural prose (the review's
// measurement) the first is 2.2 to 2.8% (main lower), and of all ranges in
// an edited paragraph 0.44% of comments and 0.39% of markers are lost.
const SUPPORT = 12;

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

// What two strings share at the start and at the end, each found on its own
// (so the two may overlap), and never cutting a character in two.
const CHUNK = 256;
function sharedEnds(a: string, b: string) {
	const shortest = Math.min(a.length, b.length);
	let prefix = 0;
	// In chunks first, which the engine compares far faster than one
	// character at a time.
	while (
		prefix + CHUNK <= shortest &&
		a.slice(prefix, prefix + CHUNK) === b.slice(prefix, prefix + CHUNK)
	)
		prefix += CHUNK;
	while (prefix < shortest && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
	while (prefix > 0 && (splitsPair(a, prefix) || splitsPair(b, prefix))) prefix--;
	const ae = a.length;
	const be = b.length;
	let suffix = 0;
	while (
		suffix + CHUNK <= shortest &&
		a.slice(ae - suffix - CHUNK, ae - suffix) === b.slice(be - suffix - CHUNK, be - suffix)
	)
		suffix += CHUNK;
	while (suffix < shortest && a.charCodeAt(ae - 1 - suffix) === b.charCodeAt(be - 1 - suffix))
		suffix++;
	while (suffix > 0 && (splitsPair(a, ae - suffix) || splitsPair(b, be - suffix))) suffix--;
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

// The lines of a text long enough to pair.
function lines(text: string): Unit[] {
	const units: Unit[] = [];
	let at = 0;
	while (at < text.length) {
		let end = text.indexOf('\n', at);
		if (end === -1) end = text.length;
		unit(text, at, end, units);
		at = end + 1;
	}
	return units;
}

// The sentences of a text long enough to pair. A sentence ends after a run
// of . ! ? (and any closing quotes or brackets) followed by white space, or
// at a line break.
// With the ellipsis and the closing curly quotes as escapes.
const ENDS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']']);
function sentences(text: string): Unit[] {
	const units: Unit[] = [];
	const to = text.length;
	let start = 0;
	for (let at = 0; at < to; at++) {
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

// The units that are the same and stand once in each list, sorted by where
// they stand in a.
function uniquePairs(a: Unit[], b: Unit[]): [Unit, Unit][] {
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
	return pairs.sort((x, y) => x[0].start - y[0].start);
}

// Of pairs sorted by a, the ones in the same order in b with the most text.
function inOrder(pairs: [Unit, Unit][]): [Unit, Unit][] {
	if (pairs.length < 2) return pairs;
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

// The last unit of a sorted list that starts at or before `at`, by index.
function lastAtOrBefore(units: Unit[], at: number): number {
	let low = 0;
	let high = units.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (units[mid].start <= at) {
			found = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return found;
}
const within = (units: Unit[], u: Unit) => {
	const i = lastAtOrBefore(units, u.start);
	return i !== -1 && u.end <= units[i].end;
};

// text[from, to) with the units in `holes` (sorted, not overlapping) that lie
// inside it cut out.
function cut(text: string, from: number, to: number, holes: Unit[]): Side {
	const side: Side = { text: '', real: [], at: [] };
	const parts: string[] = [];
	let length = 0;
	const piece = (s: number, e: number) => {
		if (e <= s) return;
		side.real.push(s);
		side.at.push(length);
		parts.push(text.slice(s, e));
		length += e - s;
	};
	let at = from;
	let i = lastAtOrBefore(holes, from);
	if (i === -1 || holes[i].start < from) i++;
	for (; i < holes.length && holes[i].start < to; i++) {
		if (holes[i].end > to) break;
		piece(at, holes[i].start);
		at = holes[i].end;
	}
	piece(at, to);
	side.text = parts.join('');
	return side;
}

// The piece of a side holding cut offset r (as a start, or as an end).
function pieceOf(side: Side, r: number, asEnd: boolean): number {
	let low = 0;
	let high = side.at.length - 1;
	let found = 0;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (asEnd ? side.at[mid] < r : side.at[mid] <= r) {
			found = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return found;
}
const realOf = (side: Side, r: number, asEnd = false) => {
	const k = pieceOf(side, r, asEnd);
	return side.real[k] + r - side.at[k];
};
const pieceEnd = (side: Side, k: number) =>
	k + 1 < side.at.length ? side.at[k + 1] : side.text.length;

// Spans for a run the two cut strings share, split where a cut lies inside it
// on either side.
function emit(
	into: Span[],
	sides: [Side, Side],
	a: number,
	b: number,
	length: number,
	firm: boolean
) {
	const [A, B] = sides;
	while (length > 0) {
		const ka = pieceOf(A, a, false);
		const kb = pieceOf(B, b, false);
		const n = Math.min(length, pieceEnd(A, ka) - a, pieceEnd(B, kb) - b);
		into.push({
			base: A.real[ka] + a - A.at[ka],
			current: B.real[kb] + b - B.at[kb],
			length: n,
			firm
		});
		a += n;
		b += n;
		length -= n;
	}
}

// Spans from a diff of A.text[a, ...) against B.text[a, ...), where the two
// share A.text[0, a) (the start set aside before the diff), which is emitted
// here as firm. A run the diff kept at the very end of both is the end the
// two share, so firm too.
function diffSpans(into: Span[], diff: ChangeObject<string>[], sides: [Side, Side], a: number) {
	const settled = settle([
		{ value: sides[0].text.slice(0, a), added: false, removed: false },
		...slide(diff)
	]);
	a = settled[0].value.length;
	let b = a;
	if (a > 0) emit(into, sides, 0, 0, a, true);
	const parts = settled.slice(1);
	parts.forEach((part, i) => {
		const length = part.value.length;
		if (part.added) b += length;
		else if (part.removed) a += length;
		else {
			emit(into, sides, a, b, length, i === parts.length - 1);
			a += length;
			b += length;
		}
	});
}

// The same diff with each lone insertion or deletion slid along the text it
// repeats, where that joins the kept runs on either side of it into one
// (the shift step of diff-match-patch's cleanupMerge). The cost is the same;
// only which of the equally short alignments is kept changes: "the lantern"
// against "the old lantern" keeps "lantern" whole instead of the "l" of
// "old" and then "antern".
type Part = { value: string; added: boolean; removed: boolean };
function slide(parts: ChangeObject<string>[]): Part[] {
	let out: Part[] = parts.map((p) => ({ value: p.value, added: !!p.added, removed: !!p.removed }));
	const kept = (p: Part | undefined) => p !== undefined && !p.added && !p.removed;
	for (let changed = true; changed;) {
		changed = false;
		for (let i = 1; i + 1 < out.length; i++) {
			const [before, edit, after] = [out[i - 1], out[i], out[i + 1]];
			if (!kept(before) || kept(edit) || !kept(after)) continue;
			if (edit.value.endsWith(before.value)) {
				edit.value = before.value + edit.value.slice(0, -before.value.length);
				after.value = before.value + after.value;
				out.splice(i - 1, 1);
				changed = true;
			} else if (edit.value.startsWith(after.value)) {
				before.value += after.value;
				edit.value = edit.value.slice(after.value.length) + after.value;
				out.splice(i + 1, 1);
				changed = true;
			}
		}
		// Join neighbours of the same kind the shifts brought together.
		const joined: Part[] = [];
		for (const p of out) {
			const last = joined.at(-1);
			if (last && last.added === p.added && last.removed === p.removed) last.value += p.value;
			else joined.push(p);
		}
		out = joined;
	}
	return out;
}

// How good a place the point between `one` and `two` is for an edit to
// start or end, as diff-match-patch's cleanupSemanticLossless scores it: 6 at
// either end, 5 at a blank line, 4 at a line break, 3 after a sentence, 2 at
// white space, 1 at other punctuation, 0 inside a word.
function boundary(one: string, two: string): number {
	if (!one || !two) return 6;
	const c1 = one[one.length - 1];
	const c2 = two[0];
	const other1 = !/[\p{L}\p{N}]/u.test(c1);
	const other2 = !/[\p{L}\p{N}]/u.test(c2);
	const space1 = other1 && /\s/.test(c1);
	const space2 = other2 && /\s/.test(c2);
	const break1 = space1 && /[\r\n]/.test(c1);
	const break2 = space2 && /[\r\n]/.test(c2);
	if ((break1 && /\n\r?\n$/.test(one)) || (break2 && /^\r?\n\r?\n/.test(two))) return 5;
	if (break1 || break2) return 4;
	if (other1 && !space1 && space2) return 3;
	if (space1 || space2) return 2;
	if (other1 || other2) return 1;
	return 0;
}

// How far an edit may be moved, and how far the strings are compared to see
// how far it can be: a few words either way finds the line break or space
// it moves to, and keeps the cost small however long the runs are.
const SETTLE_REACH = 1024;
const commonSuffix = (x: string, y: string) => {
	let n = 0;
	while (
		n < SETTLE_REACH &&
		n < x.length &&
		n < y.length &&
		x[x.length - 1 - n] === y[y.length - 1 - n]
	)
		n++;
	return n;
};
const commonPrefix = (x: string, y: string) => {
	let n = 0;
	while (n < SETTLE_REACH && n < x.length && n < y.length && x[n] === y[n]) n++;
	return n;
};

// The same diff with each lone insertion or deletion between two kept runs
// moved along the text it repeats to the best place to start and end
// (cleanupSemanticLossless), staying where it is unless another is better.
// The cost and what is kept do not change, only which of equally short
// alignments is kept: a paragraph put in before one that starts with the
// same letter ("Door ..." before "Dark ...") is put in at the line break, not
// after the "D". parts[0] is the start the two share, which gives up its end
// to the edit only where that puts the edit at a line break (elsewhere what
// it maps stays as on main); every other kept run keeps at least one
// character.
function settle(parts: Part[]): Part[] {
	const kept = (p: Part) => !p.added && !p.removed;
	// Scored on a few characters each side of each point, which is all
	// boundary looks at, so no long run is copied.
	const W = 4;
	const last = (text: string, to: number) => text.slice(Math.max(0, to - W), to);
	for (let i = 1; i + 1 < parts.length; i++) {
		const [before, edit, after] = [parts[i - 1], parts[i], parts[i + 1]];
		if (!kept(before) || kept(edit) || !kept(after)) continue;
		const b = before.value;
		const e = edit.value;
		const a = after.value;
		const left = Math.min(commonSuffix(b, e), b.length - (i === 1 ? 0 : 1));
		const right = Math.min(commonPrefix(e, a), a.length - 1);
		// Moved by k, the edit is b[b.length + k, ...) + e[0, e.length + k) for
		// k < 0 and e[k, ...) + a[0, k) for k > 0. Returns the few characters
		// before it, at its start, at its end, and after it.
		const around = (k: number): [string, string, string, string] => {
			if (k <= 0) {
				const j = -k;
				return [
					last(b, b.length - j),
					(b.slice(b.length - j, b.length - j + W) + e.slice(0, Math.min(W, e.length - j))).slice(
						0,
						W
					),
					(b.slice(Math.max(b.length - j, b.length - W)) + last(e, e.length - j)).slice(-W),
					(e.slice(e.length - j, e.length - j + W) + a.slice(0, W)).slice(0, W)
				];
			}
			return [
				(last(b, b.length) + last(e, k)).slice(-W),
				(e.slice(k, k + W) + a.slice(0, Math.min(W, k))).slice(0, W),
				(e.slice(Math.max(k, e.length - W)) + last(a, k)).slice(-W),
				a.slice(k, k + W)
			];
		};
		const score = ([b2, e2Start, e2End, a2]: [string, string, string, string]) =>
			boundary(b2, e2Start) + boundary(e2End, a2);
		const whole = ([b2, e2Start, e2End, a2]: [string, string, string, string]) =>
			!splitsPair(b2 + e2Start, b2.length) && !splitsPair(e2End + a2, e2End.length);
		let best = score(around(0));
		let shift = 0;
		for (let j = 1; j <= Math.max(left, right); j++) {
			for (const k of [-j, j]) {
				if (k < 0 ? -k > left : k > right) continue;
				const at = around(k);
				if (!whole(at)) continue;
				if (i === 1 && k < 0 && (at[0] === '' || boundary(at[0], at[1]) < 4)) continue;
				const value = score(at);
				if (value > best) {
					best = value;
					shift = k;
				}
			}
		}
		if (shift < 0) {
			before.value = b.slice(0, shift);
			edit.value = b.slice(shift) + e.slice(0, shift);
			after.value = e.slice(shift) + a;
		} else if (shift > 0) {
			before.value = b + e.slice(0, shift);
			edit.value = e.slice(shift) + a.slice(0, shift);
			after.value = a.slice(shift);
		}
	}
	return parts;
}

const editLength = (parts: ChangeObject<string>[]) =>
	parts.reduce((sum, part) => sum + (part.added || part.removed ? part.value.length : 0), 0);

// A gap queued for the character diff: its sides, the length `a` they share
// at the start and `suffix` at the end.
type Pending = { sides: [Side, Side]; a: number; suffix: number };

class Comparer {
	spans: Span[] = [];
	late: Span[] = [];
	gaps: Gap[] = [];
	used = 0;
	private pending: Pending[] = [];
	private holes: [Unit[], Unit[]] = [[], []];
	private base: string;
	private current: string;

	constructor(base: string, current: string) {
		this.base = base;
		this.current = current;
	}

	// Sets aside what the two sides of a gap share at the start, and queues
	// what is left for the character diff, with the length the two share at
	// the end. The shared end is not set aside before the diff: main's diff
	// does not, and where an insertion next to it reads two ways (".", then
	// "\n\nNew." put after it), setting it aside would pick the other
	// reading. It is kept only if the diff fails.
	private gap(base: number, baseEnd: number, current: number, currentEnd: number) {
		const sides: [Side, Side] = [
			cut(this.base, base, baseEnd, this.holes[0]),
			cut(this.current, current, currentEnd, this.holes[1])
		];
		const [A, B] = sides;
		if (!A.text || !B.text) return;
		const { prefix, suffix, shortest } = sharedEnds(A.text, B.text);
		const head = (length: number, into: Span[]) => {
			if (length > 0) emit(into, sides, 0, 0, length, true);
		};
		const tail = (length: number, into: Span[]) => {
			if (length > 0)
				emit(into, sides, A.text.length - length, B.text.length - length, length, true);
		};
		if (prefix + suffix <= shortest) {
			if (A.text.length - prefix === suffix || B.text.length - prefix === suffix) {
				head(prefix, this.spans);
				tail(suffix, this.spans);
				return;
			}
			// The shared start is emitted with the diff (or as it is if the diff
			// fails), which may give an edit its last few characters.
			this.pending.push({ sides, a: prefix, suffix });
			return;
		}
		// The shorter side is shared whole, and reads two ways: its start with
		// the start of the longer and the rest with its end, or its end with the
		// end of the longer and the rest with its start.
		const cuts = (headLength: number, tailLength: number) =>
			splitsPair(A.text, headLength) ||
			splitsPair(B.text, headLength) ||
			splitsPair(A.text, A.text.length - tailLength) ||
			splitsPair(B.text, B.text.length - tailLength);
		head(prefix, this.spans);
		if (!cuts(prefix, shortest - prefix)) tail(shortest - prefix, this.spans);
		if (!cuts(shortest - suffix, suffix)) {
			head(shortest - suffix, this.late);
			tail(suffix, this.late);
		}
	}

	// Hands each stretch between pairs (in order on both sides) to `then`.
	private between(
		pairs: [Unit, Unit][],
		from: [number, number],
		to: [number, number],
		then: (b: number, be: number, c: number, ce: number) => void
	) {
		let [b, c] = from;
		for (let i = 0; i <= pairs.length; i++) {
			const [u, v] = pairs[i] ?? [];
			const be = u ? u.start : to[0];
			const ce = v ? v.start : to[1];
			if (be > b && ce > c) then(b, be, c, ce);
			if (!u || !v) break;
			b = u.end;
			c = v.end;
		}
	}

	run(allowance: number) {
		const { base, current } = this;
		const linePairs = uniquePairs(lines(base), lines(current));
		const pairedLines: [Unit[], Unit[]] = [
			linePairs.map((p) => p[0]),
			[...linePairs.map((p) => p[1])].sort((x, y) => x.start - y.start)
		];
		// Sentences stand once in the whole text, counted with those inside
		// paired lines; a sentence inside a paired line maps with its line.
		const sentencePairs = uniquePairs(sentences(base), sentences(current)).filter(
			([u, v]) => !within(pairedLines[0], u) && !within(pairedLines[1], v)
		);
		const identity = [...linePairs, ...sentencePairs];
		for (const [u, v] of identity)
			this.spans.push({ base: u.start, current: v.start, length: u.end - u.start, firm: true });
		this.holes = [
			identity.map((p) => p[0]).sort((x, y) => x.start - y.start),
			identity.map((p) => p[1]).sort((x, y) => x.start - y.start)
		];

		// Line gaps, and the paired sentences lying inside each on both sides.
		const lineGaps: [number, number, number, number][] = [];
		this.between(inOrder(linePairs), [0, 0], [base.length, current.length], (...g) =>
			lineGaps.push(g)
		);
		const inside: [Unit, Unit][][] = lineGaps.map(() => []);
		let g = 0;
		for (const pair of sentencePairs) {
			while (g < lineGaps.length && lineGaps[g][1] <= pair[0].start) g++;
			if (g === lineGaps.length) break;
			const [b, be, c, ce] = lineGaps[g];
			if (pair[0].start >= b && pair[0].end <= be && pair[1].start >= c && pair[1].end <= ce)
				inside[g].push(pair);
		}
		lineGaps.forEach(([b, be, c, ce], i) =>
			this.between(inOrder(inside[i]), [b, c], [be, ce], (...sub) => this.gap(...sub))
		);

		// Smallest first, so one that cannot finish does not use up what the
		// others need.
		const size = (p: Pending) => p.sides[0].text.length + p.sides[1].text.length - 2 * p.a;
		this.pending.sort((x, y) => size(x) - size(y));
		for (const { sides, a, suffix } of this.pending) {
			const [A, B] = sides;
			const most = Math.floor(Math.sqrt(Math.max(0, allowance - this.used)));
			const parts =
				most < 1
					? undefined
					: Number.isFinite(most)
						? diffChars(A.text.slice(a), B.text.slice(a), { maxEditLength: most })
						: diffChars(A.text.slice(a), B.text.slice(a));
			if (parts) {
				const d = editLength(parts);
				this.used += d * d;
				diffSpans(this.spans, parts, sides, a);
				continue;
			}
			if (most >= 1 && Number.isFinite(most)) this.used += most * most;
			if (a > 0) emit(this.spans, sides, 0, 0, a, true);
			// Unchecked: what the two sides share at the start and end still maps.
			if (suffix > 0)
				emit(this.spans, sides, A.text.length - suffix, B.text.length - suffix, suffix, true);
			this.gaps.push({ base: realOf(A, a), baseEnd: realOf(A, A.text.length - suffix, true) });
		}
	}
}

// Sorted by base, with spans that touch in both texts (and are both firm or
// both not) joined.
function tidy(spans: Span[]): Span[] {
	spans.sort((x, y) => x.base - y.base);
	const out: Span[] = [];
	for (const span of spans) {
		const last = out.at(-1);
		if (
			last &&
			last.firm === span.firm &&
			last.base + last.length === span.base &&
			last.current + last.length === span.current
		)
			out[out.length - 1] = { ...last, length: last.length + span.length };
		else out.push(span);
	}
	return out;
}

function compareTexts(
	base: string,
	current: string,
	allowance: number
): { found: Comparison; used: number } {
	const comparer = new Comparer(base, current);
	comparer.run(allowance);
	return {
		found: { spans: tidy(comparer.spans), late: tidy(comparer.late), gaps: comparer.gaps },
		used: comparer.used
	};
}

// The span holding a range's start ([base, base + length)), or its end
// ((base, base + length]), or a point ([base, base + length], the earlier
// span winning where two meet, as on main); null if none.
function spanAt(spans: Span[], position: number, edge: 'start' | 'end' | 'point'): Span | null {
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
	if (last === -1) return null;
	const endOf = (s: Span) => s.base + s.length;
	if (edge === 'start') return position < endOf(spans[last]) ? spans[last] : null;
	if (edge === 'end') return position <= endOf(spans[last]) ? spans[last] : null;
	if (last > 0 && endOf(spans[last - 1]) === position) return spans[last - 1];
	return position <= endOf(spans[last]) ? spans[last] : null;
}

const through = (span: Span, position: number) => span.current + position - span.base;

// A range's two ends. Each end must lie in a span that is firm or holds
// SUPPORT characters; an end in any other span is lost. A start the early
// reading does not hold may take the later one. With `loose` (a marker's
// rule), an end whose own character is in no span at all may instead rest on
// the span just outside it, if that span is firm or holds SUPPORT
// characters, so an edit right at an edge stretches or shrinks the range
// instead of losing it. An end whose character is in a span too short to
// count is lost, not rested outside: resting it would let the range grow
// over text typed beyond it. The start moves to the later reading when
// there is one further on that still leaves a range.
function mapEnds(found: Comparison, start: number, end: number, loose: boolean, support: boolean) {
	const firm = (span: Span) => !support || span.firm || span.length >= SUPPORT;
	let from: number | null = null;
	let outside = 0;
	const first = spanAt(found.spans, start, 'start');
	const late = found.late.length ? spanAt(found.late, start, 'start') : null;
	if (first) {
		if (firm(first)) from = through(first, start);
	} else if (late) from = through(late, start);
	else if (loose) {
		const before = spanAt(found.spans, start, 'end');
		if (before && before.base + before.length === start && firm(before)) {
			from = through(before, start);
			outside++;
		}
	}
	let to: number | null = null;
	const last = spanAt(found.spans, end, 'end');
	if (last) {
		if (firm(last)) to = through(last, end);
	} else if (loose) {
		const after = spanAt(found.spans, end, 'start');
		if (after && after.base === end && firm(after)) {
			to = through(after, end);
			outside++;
		}
	}
	if (to === null || from === null) return null;
	// Both ends resting outside the range: some of its own text must be left,
	// in a span that would hold an end (a chance letter or two does not).
	if (outside === 2) {
		let low = 0;
		let high = found.spans.length - 1;
		let before = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (found.spans[mid].base < end) {
				before = mid;
				low = mid + 1;
			} else high = mid - 1;
		}
		let left = false;
		for (let i = before; i >= 0 && found.spans[i].base + found.spans[i].length > start; i--)
			if (firm(found.spans[i])) left = true;
		if (!left) return null;
	}
	const later = late ? through(late, start) : null;
	if (later !== null && later > from && later < to) from = later;
	if (from >= to) return null;
	// A moved unit can put shared text from outside the range between the two
	// ends; a range stretched over it would hold text it was not made on. So
	// every span starting in [from, to) must start inside the range. (One
	// starting at `from` counts: a start resting on the span before it, or on
	// the later reading, does not make it the start's own.)
	const byCurrent = inCurrentOrder(found.spans);
	let low = 0;
	let high = byCurrent.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (byCurrent[mid].current < from) low = mid + 1;
		else high = mid;
	}
	for (let i = low; i < byCurrent.length && byCurrent[i].current < to; i++) {
		const span = byCurrent[i];
		if (span.base < start || span.base >= end) return null;
	}
	return { start: from, end: to };
}

// found.spans sorted by where each starts in current, kept per spans array.
const currentOrder = new WeakMap<Span[], Span[]>();
function inCurrentOrder(spans: Span[]): Span[] {
	let sorted = currentOrder.get(spans);
	if (!sorted) {
		sorted = [...spans].sort((x, y) => x.current - y.current);
		currentOrder.set(spans, sorted);
	}
	return sorted;
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
	// A point maps through the span it lies in (the earlier where two meet,
	// as on main), which must be firm or hold SUPPORT characters.
	point(baseText: string, currentText: string, position: number): number | null;
	// A range by a marker's rule: an end whose own character is gone may rest
	// on the shared text just outside it, so an edit right at an edge
	// stretches or shrinks the range instead of losing it. Null if either end
	// is gone or the range is left empty.
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
	// between pairs. Call it before mapping many pairs in one go.
	prepare(pairs: Iterable<[string, string]>): Promise<void>;
	// The edit units spent so far.
	spent(): number;
};

// `support` false maps without the SUPPORT rule, as main does; only the tests
// use it, to measure what the rule costs.
export function createAnchorMapper(budget: DiffBudget, support = true): AnchorMapper {
	let spent = 0;
	// Nested by base text then current text, so neither key has to be
	// concatenated into a third copy of the scene.
	const cache = new Map<string, Map<string, Comparison>>();
	const cached = (baseText: string, currentText: string) => cache.get(baseText)?.get(currentText);
	const compare = (baseText: string, currentText: string): Comparison => {
		let found = cached(baseText, currentText);
		if (!found) {
			const allowance = Math.max(budget.floor, Math.min(budget.perPair, budget.total - spent));
			const result = compareTexts(baseText, currentText, allowance);
			found = result.found;
			spent += result.used;
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
			return mapEnds(compare(baseText, currentText), start, end, false, support);
		},
		point(baseText, currentText, position) {
			if (position < 0 || position > baseText.length) return null;
			if (baseText === currentText) return position;
			const span = spanAt(compare(baseText, currentText).spans, position, 'point');
			if (!span || (support && !span.firm && span.length < SUPPORT)) return null;
			return through(span, position);
		},
		ends(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || start === end) return null;
			if (baseText === currentText) return { start, end };
			return mapEnds(compare(baseText, currentText), start, end, true, support);
		},
		unchecked(baseText, currentText, start, end) {
			if (!valid(baseText, start, end) || baseText === currentText) return false;
			const found = compare(baseText, currentText);
			if (start === end) {
				return spanAt(found.spans, start, 'point') === null && inGap(found, start, 'point');
			}
			return (
				(spanAt(found.spans, start, 'start') === null && inGap(found, start, 'start')) ||
				(spanAt(found.spans, end, 'end') === null && inGap(found, end, 'end'))
			);
		},
		async prepare(pairs) {
			let first = true;
			for (const [baseText, currentText] of pairs) {
				if (baseText === currentText || cached(baseText, currentText)) continue;
				if (!first) await new Promise((resolve) => setImmediate(resolve));
				first = false;
				compare(baseText, currentText);
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

import { diffChars } from 'diff';

// The anchor mapper as it is on main: one character diff of the two whole
// texts, with no budget. Kept here only as the oracle the property tests
// compare src/lib/review-anchor.ts against; the server never uses it.

type Spans = { base: number; current: number; length: number }[];

export function wholeTextSpans(base: string, current: string): Spans {
	if (base === current) return [{ base: 0, current: 0, length: base.length }];
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

export function wholeTextRange(spans: Spans, baseLength: number, start: number, end: number) {
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

export function wholeTextPoint(spans: Spans, baseLength: number, position: number) {
	if (position < 0 || position > baseLength) return null;
	for (const span of spans) {
		if (position >= span.base && position <= span.base + span.length)
			return span.current + position - span.base;
	}
	return null;
}

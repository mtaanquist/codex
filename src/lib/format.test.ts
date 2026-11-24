import { describe, it, expect } from 'vitest';
import {
	pluralSuffix,
	formatNumber,
	compactCount,
	formatLongDate,
	formatDate,
	formatDateTime,
	formatTime,
	narrowWeekday,
	relativeShort,
	dayKey,
	spentPhrase,
	capContinueAdvice,
	capStopPhrase,
	formatBytes
} from './format';

// Local-time dates, so the output does not depend on the runner's timezone.
const june11 = new Date(2026, 5, 11, 9, 41);

describe('fixed display locale', () => {
	it('formats timestamps day first with a 24-hour clock', () => {
		expect(formatDateTime(june11)).toBe('11 Jun 2026, 09:41');
	});

	it('formats short dates day first', () => {
		expect(formatDate(june11)).toBe('11 Jun 2026');
	});

	it('formats the time of day', () => {
		expect(formatTime(june11)).toBe('09:41');
	});

	it('names the weekday of a calendar day by one letter', () => {
		expect(narrowWeekday('2026-06-11')).toBe('T');
		expect(narrowWeekday('2026-06-14')).toBe('S');
	});

	it('falls back to the short date after a week', () => {
		expect(relativeShort(june11)).toBe('11 Jun 2026');
	});

	it('measures against the given now, so server and browser can agree', () => {
		const at = (minutes: number) => june11.getTime() + minutes * 60_000;
		expect(relativeShort(june11, undefined, at(0.5))).toBe('just now');
		expect(relativeShort(june11, undefined, at(5))).toBe('5m');
		expect(relativeShort(june11, undefined, at(3 * 60))).toBe('3h');
		expect(relativeShort(june11, undefined, at(2 * 24 * 60))).toBe('2d');
	});
});

// One instant, 23:30 UTC on 11 June: already 12 June in Auckland, still
// 11 June in New York. A server and a browser in different zones must agree
// when both are given the author's zone (#766).
const lateUtc = new Date(Date.UTC(2026, 5, 11, 23, 30));

describe('author timezone', () => {
	it('formats in the given zone, wherever the code runs', () => {
		expect(formatDateTime(lateUtc, 'UTC')).toBe('11 Jun 2026, 23:30');
		expect(formatDateTime(lateUtc, 'Pacific/Auckland')).toBe('12 Jun 2026, 11:30');
		expect(formatTime(lateUtc, 'America/New_York')).toBe('19:30');
		expect(formatDate(lateUtc, 'Pacific/Auckland')).toBe('12 Jun 2026');
		expect(formatLongDate(lateUtc, 'Pacific/Auckland')).toBe('12 June 2026');
	});

	it('keys a calendar day in the given zone', () => {
		expect(dayKey(lateUtc, 'UTC')).toBe('2026-06-11');
		expect(dayKey(lateUtc, 'Pacific/Auckland')).toBe('2026-06-12');
		expect(dayKey(lateUtc, 'America/New_York')).toBe('2026-06-11');
	});
});

describe('formatLongDate', () => {
	it('writes the day, the full month and the year', () => {
		expect(formatLongDate(new Date(2026, 5, 11))).toBe('11 June 2026');
	});
});

describe('pluralSuffix', () => {
	it('is empty for exactly one', () => {
		expect(pluralSuffix(1)).toBe('');
	});

	it('is "s" for zero and for many', () => {
		expect(pluralSuffix(0)).toBe('s');
		expect(pluralSuffix(2)).toBe('s');
		expect(pluralSuffix(42)).toBe('s');
	});
});

describe('formatNumber', () => {
	it('groups thousands', () => {
		expect(formatNumber(1234)).toBe('1,234');
		expect(formatNumber(1234567)).toBe('1,234,567');
	});

	it('leaves small numbers ungrouped', () => {
		expect(formatNumber(0)).toBe('0');
		expect(formatNumber(999)).toBe('999');
	});
});

describe('compactCount', () => {
	it('is empty for non-positive counts', () => {
		expect(compactCount(0)).toBe('');
		expect(compactCount(-5)).toBe('');
	});

	it('shows the raw count below a thousand', () => {
		expect(compactCount(1)).toBe('1');
		expect(compactCount(999)).toBe('999');
	});

	it('shows one decimal of thousands at and above a thousand', () => {
		expect(compactCount(1000)).toBe('1.0k');
		expect(compactCount(1234)).toBe('1.2k');
		expect(compactCount(12000)).toBe('12.0k');
	});
});

describe('spentPhrase', () => {
	it('says about, and marks a figure that includes estimates', () => {
		expect(spentPhrase(1.2)).toBe('about $1.20');
		expect(spentPhrase(1.2, true)).toBe('about $1.20 (estimated)');
		expect(spentPhrase(0.01234, false, 4)).toBe('about $0.0123');
	});
});

describe('capContinueAdvice', () => {
	it('offers a rerun when the job spent something', () => {
		expect(capContinueAdvice(1.5, 'run the review again')).toBe(
			'Raise the cap in settings or run the review again to continue.'
		);
	});

	it('asks for a higher cap first when the job was held before it spent anything', () => {
		expect(capContinueAdvice(0, 'run the review again')).toBe(
			'Raise the cap in settings, then run the review again.'
		);
		expect(capContinueAdvice(0)).toBe('Raise the cap in settings, then run it again.');
	});
});

describe('capStopPhrase', () => {
	it('says the job stopped before the cap, not at it', () => {
		expect(capStopPhrase(1.7)).toBe(
			'before the next request could take it past your spend cap, having spent about $1.70'
		);
		expect(capStopPhrase(1.7, true)).toMatch(/about \$1\.70 \(estimated\)$/);
	});
});

describe('formatBytes', () => {
	it('picks the largest unit that keeps the number under 1024', () => {
		expect(formatBytes(1)).toBe('1 byte');
		expect(formatBytes(512)).toBe('512 bytes');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
	});

	it('moves up a unit when rounding reaches 1024', () => {
		expect(formatBytes(1024 * 1024 - 1)).toBe('1 MB');
		expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1 GB');
		expect(formatBytes(1024 * 1023.9)).toBe('1023.9 KB');
	});
});

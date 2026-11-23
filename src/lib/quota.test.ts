import { describe, it, expect } from 'vitest';
import {
	imageLimit,
	limitPhrase,
	MAX_IMAGE_BYTES,
	MEGABYTE,
	NO_LIMITS,
	parseLimit,
	parseLimitInput,
	quotaMessage
} from './quota';
import { formatBytes } from './format';

describe('parseLimit', () => {
	it('takes whole numbers of zero or more', () => {
		expect(parseLimit(0)).toBe(0);
		expect(parseLimit(25)).toBe(25);
	});

	it('reads anything else as no limit', () => {
		for (const value of [null, undefined, -1, 1.5, '3', true, {}, Number.NaN]) {
			expect(parseLimit(value)).toBeNull();
		}
	});
});

describe('parseLimitInput', () => {
	it('reads blank as no limit', () => {
		expect(parseLimitInput('  ', 100)).toBeNull();
	});

	it('takes a whole number up to the maximum', () => {
		expect(parseLimitInput(' 7 ', 100)).toBe(7);
		expect(parseLimitInput('0', 100)).toBe(0);
		expect(parseLimitInput('100', 100)).toBe(100);
	});

	it('refuses anything else', () => {
		for (const text of ['-1', '1.5', 'ten', '101', '1e3']) {
			expect(parseLimitInput(text, 100)).toBeUndefined();
		}
	});
});

describe('imageLimit', () => {
	it('is the ceiling unless the plan sets a lower size', () => {
		expect(imageLimit(NO_LIMITS)).toBe(MAX_IMAGE_BYTES);
		expect(imageLimit({ ...NO_LIMITS, max_image_bytes: 2 * MEGABYTE })).toBe(2 * MEGABYTE);
		expect(imageLimit({ ...NO_LIMITS, max_image_bytes: 50 * MEGABYTE })).toBe(MAX_IMAGE_BYTES);
	});
});

describe('quota wording', () => {
	it('names the limit with the right noun', () => {
		expect(limitPhrase('max_universes', 1)).toBe('1 universe');
		expect(limitPhrase('max_stories', 12)).toBe('12 stories');
		expect(limitPhrase('storage_bytes', 50 * MEGABYTE)).toBe('50 MB');
		expect(limitPhrase('max_image_bytes', 2 * MEGABYTE)).toBe('2 MB');
	});

	it('tells the writer which limit they hit and who to ask', () => {
		const create = quotaMessage('max_stories', 3);
		expect(create).toContain('limit of 3 stories');
		expect(create).toContain('ask the admin');
		expect(quotaMessage('max_universes', 2, 'restore')).toMatch(/^Restoring this/);
		expect(quotaMessage('storage_bytes', MEGABYTE)).toContain('1 MB of uploaded images');
		expect(quotaMessage('max_image_bytes', 2 * MEGABYTE)).toContain('limit of 2 MB per image');
	});

	it('keeps to plain ASCII', () => {
		for (const text of [
			quotaMessage('max_universes', 2),
			quotaMessage('storage_bytes', 9),
			quotaMessage('max_image_bytes', MEGABYTE)
		]) {
			expect(text).toMatch(/^[\x20-\x7e]+$/);
		}
	});
});

describe('formatBytes', () => {
	it('steps through binary units to one decimal', () => {
		expect(formatBytes(1)).toBe('1 byte');
		expect(formatBytes(512)).toBe('512 bytes');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(10 * MEGABYTE)).toBe('10 MB');
		expect(formatBytes(3 * 1024 * MEGABYTE + 400 * MEGABYTE)).toBe('3.4 GB');
	});
});

import { describe, it, expect } from 'vitest';
import { lfOffset, showsText, storedOffset, toLf } from './line-endings';

describe('toLf', () => {
	it('turns Windows and old Mac line breaks into newlines', () => {
		expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
		expect(toLf('no breaks')).toBe('no breaks');
	});
});

describe('showsText', () => {
	it('matches a stored body the editor shows, whatever its line breaks', () => {
		expect(showsText('a\nb', 'a\r\nb')).toBe(true);
		expect(showsText('a\nb', 'a\nb')).toBe(true);
		expect(showsText('a\nb', 'a\r\nc')).toBe(false);
	});
});

describe('lfOffset', () => {
	it('keeps an offset on the same character once the breaks are normalised', () => {
		const text = 'one\r\ntwo\r\n\r\nthree';
		for (const word of ['one', 'two', 'three']) {
			expect(
				toLf(text)
					.slice(lfOffset(text, text.indexOf(word)))
					.startsWith(word)
			).toBe(true);
		}
		expect(lfOffset(text, text.length)).toBe(toLf(text).length);
	});

	it('puts an offset between \\r and \\n on the newline', () => {
		expect(lfOffset('a\r\nb', 2)).toBe(1);
		expect(toLf('a\r\nb')[1]).toBe('\n');
	});
});

describe('storedOffset', () => {
	it('undoes lfOffset for every offset in the text as shown', () => {
		const text = 'one\r\ntwo\r\n\r\nthree\rfour';
		const shown = toLf(text);
		for (let lf = 0; lf <= shown.length; lf++) {
			const at = storedOffset(text, lf);
			expect(lfOffset(text, at)).toBe(lf);
			expect(toLf(text.slice(at))).toBe(shown.slice(lf));
		}
	});
});

import { describe, it, expect } from 'vitest';
import { chunkHash, chunkScene } from './chunks';

describe('chunkScene', () => {
	it('has no passages for blank text', () => {
		expect(chunkScene('')).toEqual([]);
		expect(chunkScene('  \n\n \t\n')).toEqual([]);
	});

	it('packs short paragraphs into one passage', () => {
		expect(chunkScene('First.\n\nSecond.\r\n\r\nThird.')).toEqual(['First.\n\nSecond.\n\nThird.']);
	});

	it('starts a new passage when the next paragraph would not fit', () => {
		const a = 'a'.repeat(30);
		const b = 'b'.repeat(30);
		const c = 'c'.repeat(30);
		expect(chunkScene(`${a}\n\n${b}\n\n${c}`, 64)).toEqual([`${a}\n\n${b}`, c]);
	});

	it('cuts a long paragraph between sentences', () => {
		const sentence = 'The tide came in fast.';
		const paragraph = Array(6).fill(sentence).join(' ');
		const passages = chunkScene(paragraph, 50);
		expect(passages.every((p) => p.length <= 50)).toBe(true);
		expect(passages.join(' ')).toBe(paragraph);
		expect(passages[0]).toBe(`${sentence} ${sentence}`);
	});

	it('cuts a sentence with no end at a space, and a word with no space at the limit', () => {
		const words = Array(20).fill('word').join(' ');
		const passages = chunkScene(words, 22);
		expect(passages.every((p) => p.length <= 22)).toBe(true);
		expect(passages.join(' ')).toBe(words);
		expect(chunkScene('x'.repeat(50), 20)).toEqual([
			'x'.repeat(20),
			'x'.repeat(20),
			'x'.repeat(10)
		]);
	});

	it('leaves the passages before an edit as they were', () => {
		const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} `.repeat(20).trim());
		const before = chunkScene(paragraphs.join('\n\n'));
		const after = chunkScene([...paragraphs, 'A new ending.'].join('\n\n'));
		expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
	});
});

describe('chunkHash', () => {
	it('is stable and tells texts apart', () => {
		expect(chunkHash('a')).toBe(chunkHash('a'));
		expect(chunkHash('a')).not.toBe(chunkHash('b'));
		expect(chunkHash('a')).toMatch(/^[0-9a-f]{64}$/);
	});
});

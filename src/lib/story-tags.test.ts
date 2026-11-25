import { describe, expect, it } from 'vitest';
import { cleanTagName, splitTags, tagSlug } from './story-tags';

describe('tags', () => {
	it('gives spaces, hyphens and underscores one slug', () => {
		expect(tagSlug('Found Family')).toBe('found-family');
		expect(tagSlug('found-family')).toBe('found-family');
		expect(tagSlug(' found__family ')).toBe('found-family');
		expect(tagSlug('Ålfar Saga')).toBe('ålfar-saga');
		expect(tagSlug('---')).toBe('');
	});

	it('cleans a typed tag and refuses long or odd ones', () => {
		expect(cleanTagName('  Found   Family ')).toEqual({ ok: true, name: 'Found Family' });
		expect(cleanTagName('   ')).toMatchObject({ ok: false, empty: true });
		expect(cleanTagName("Ka'ruk's Rest")).toEqual({ ok: true, name: "Ka'ruk's Rest" });
		expect(cleanTagName('x'.repeat(51)).ok).toBe(false);
		expect(cleanTagName('<script>').ok).toBe(false);
		expect(cleanTagName('   ').ok).toBe(false);
		expect(cleanTagName('---').ok).toBe(false);
	});

	it('splits on commas and new lines', () => {
		expect(splitTags('a, b\nc,, ,d')).toEqual(['a', 'b', 'c', 'd']);
	});

	it('keeps an existing tag with a comma whole when picked from the suggestions', () => {
		const suggestions = ['Smith, John', 'Found Family'];
		expect(splitTags(' Smith, John ', suggestions)).toEqual(['Smith, John']);
		expect(splitTags('Smith, John, Found Family', suggestions)).toEqual([
			'Smith',
			'John',
			'Found Family'
		]);
	});
});

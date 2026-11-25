import { describe, expect, it } from 'vitest';
import { cleanTagName, savedLabels, splitTags, tagSlug } from './story-tags';

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

	it('keys the saved labels by content, so a refresh with the same labels changes nothing', () => {
		const view = () => ({
			genres: [{ id: 'g1', name: 'Fantasy' }],
			fandoms: [
				{ id: 'f1', name: 'Discworld' },
				{ id: 'f2', name: 'Earthsea', inherited: true as const }
			],
			tags: [{ id: 't1', name: 'Found Family' }]
		});
		const saved = savedLabels(view());
		expect(saved).toEqual({ genres: ['g1'], fandoms: ['Discworld'], tags: ['Found Family'] });
		// A later data refresh (another section's autosave) hands over a new
		// object with the same labels; the key must not change.
		expect(JSON.stringify(savedLabels(view()))).toBe(JSON.stringify(saved));
		const changed = view();
		changed.tags.push({ id: 't2', name: 'Slow Burn' });
		expect(JSON.stringify(savedLabels(changed))).not.toBe(JSON.stringify(saved));
		expect(savedLabels(null)).toEqual({ genres: [], fandoms: [], tags: [] });
	});
});

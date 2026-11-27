import { describe, expect, it } from 'vitest';
import { passageSnippet } from './search-meaning.ts';

describe('passageSnippet', () => {
	it('folds white space and keeps a short passage whole', () => {
		expect(passageSnippet('  The sea.\n\nThe  fire.  ')).toBe('The sea. The fire.');
	});

	it('cuts a long passage at a word', () => {
		const long = 'word '.repeat(100);
		const snippet = passageSnippet(long);
		expect(snippet.endsWith('word...')).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(323);
	});
});

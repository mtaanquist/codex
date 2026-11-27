import { describe, it, expect } from 'vitest';
import { embeddingsReady, normaliseEmbeddings } from './config';

describe('normaliseEmbeddings', () => {
	it('is off and empty for an account that never set it up', () => {
		expect(normaliseEmbeddings(undefined)).toEqual({
			enabled: false,
			provider: 'custom',
			endpoint: '',
			apiKeyEnc: null,
			model: '',
			pricePerToken: undefined,
			dimensions: undefined
		});
	});

	it('keeps a free price but drops a negative one and a bad size', () => {
		expect(normaliseEmbeddings({ pricePerToken: 0, dimensions: 768 })).toMatchObject({
			pricePerToken: 0,
			dimensions: 768
		});
		expect(normaliseEmbeddings({ pricePerToken: -1, dimensions: 1.5 })).toMatchObject({
			pricePerToken: undefined,
			dimensions: undefined
		});
	});
});

describe('embeddingsReady', () => {
	const set = normaliseEmbeddings({ enabled: true, endpoint: 'http://local/v1', model: 'm' });

	it('runs only when switched on, set up, and the Assistant is on', () => {
		expect(embeddingsReady(true, set)).toBe(true);
		// The Assistant's kill switch stops embeddings too.
		expect(embeddingsReady(false, set)).toBe(false);
		expect(embeddingsReady(true, { ...set, enabled: false })).toBe(false);
		expect(embeddingsReady(true, { ...set, endpoint: '' })).toBe(false);
		expect(embeddingsReady(true, { ...set, model: '' })).toBe(false);
	});
});

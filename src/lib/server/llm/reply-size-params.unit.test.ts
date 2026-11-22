import { describe, expect, it } from 'vitest';
import { withoutReplySizeParams } from './gateway.ts';

describe('withoutReplySizeParams', () => {
	it('leaves out reply limits at any depth and reply counts in option groups', () => {
		expect(
			withoutReplySizeParams({
				max_tokens: 10,
				n: 2,
				temperature: 0.3,
				options: { num_predict: 5, n: 3, top_k: 4 },
				metadata: { n: 1, deep: { maxTokens: 9 } }
			})
		).toEqual({ temperature: 0.3, options: { top_k: 4 }, metadata: { n: 1 } });
	});

	it('leaves out candidateCount at the top level and in Gemini generation config', () => {
		expect(
			withoutReplySizeParams({
				candidateCount: 3,
				generationConfig: { candidateCount: 2, maxOutputTokens: 9, temperature: 0.5 },
				generation_config: { candidate_count: 2, top_p: 0.9 }
			})
		).toEqual({
			generationConfig: { temperature: 0.5 },
			generation_config: { top_p: 0.9 }
		});
	});

	it('keeps property names inside a reply schema', () => {
		const schema = {
			type: 'object',
			properties: { max_tokens: { type: 'number' }, n: { type: 'number' } }
		};
		expect(
			withoutReplySizeParams({
				format: schema,
				text: { format: { type: 'json_schema', schema } },
				response_format: { type: 'json_schema', json_schema: { schema } },
				generationConfig: { responseSchema: schema, response_schema: schema }
			})
		).toEqual({
			format: schema,
			text: { format: { type: 'json_schema', schema } },
			response_format: { type: 'json_schema', json_schema: { schema } },
			generationConfig: { responseSchema: schema, response_schema: schema }
		});
	});

	it('drops a group it emptied but keeps one the writer left empty', () => {
		expect(withoutReplySizeParams({ options: { num_predict: 5 }, extra_body: {} })).toEqual({
			extra_body: {}
		});
		expect(withoutReplySizeParams({ max_tokens: 5 })).toBeUndefined();
		expect(withoutReplySizeParams(undefined)).toBeUndefined();
	});
});

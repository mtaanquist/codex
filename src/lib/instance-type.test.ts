import { describe, expect, it } from 'vitest';
import { parseInstanceType } from './instance-type';

describe('parseInstanceType', () => {
	it('reads a saved type', () => {
		expect(parseInstanceType({ type: 'service' })).toBe('service');
		expect(parseInstanceType({ type: 'personal' })).toBe('personal');
	});

	it('defaults to personal when missing or unknown', () => {
		expect(parseInstanceType(null)).toBe('personal');
		expect(parseInstanceType({})).toBe('personal');
		expect(parseInstanceType({ type: 'managed' })).toBe('personal');
		expect(parseInstanceType('service')).toBe('personal');
	});
});

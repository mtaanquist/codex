import { describe, expect, it } from 'vitest';
import { newSaveSource, parseSaveOrder, supersededSave } from './save-order';

describe('save order', () => {
	it('names each copy apart, in a form the server takes', () => {
		const a = newSaveSource();
		expect(a).not.toBe(newSaveSource());
		expect(parseSaveOrder({ source: a, seq: 1 })).toEqual({ source: a, seq: 1 });
	});

	it('takes no order as none, and refuses a malformed one', () => {
		expect(parseSaveOrder(undefined)).toBeNull();
		for (const bad of [
			'x',
			{ source: 'short', seq: 1 },
			{ source: 'abcdefgh!', seq: 1 },
			{ source: 'abcdefghij', seq: 0 },
			{ source: 'abcdefghij', seq: 1.5 },
			{ source: 'abcdefghij', seq: 2 ** 31 },
			{ source: 'abcdefghij', seq: '2' }
		]) {
			expect(parseSaveOrder(bad)).toBe('invalid');
		}
	});

	it('drops only an older save from the copy that saved last', () => {
		const stored = { saveSource: 'copy-aaaa', saveSeq: 5 };
		expect(supersededSave(stored, { source: 'copy-aaaa', seq: 4 })).toBe(true);
		expect(supersededSave(stored, { source: 'copy-aaaa', seq: 5 })).toBe(true);
		expect(supersededSave(stored, { source: 'copy-aaaa', seq: 6 })).toBe(false);
		// Another copy is checked by the text it saved from instead.
		expect(supersededSave(stored, { source: 'copy-bbbb', seq: 1 })).toBe(false);
		expect(supersededSave(stored, null)).toBe(false);
		expect(supersededSave({ saveSource: null, saveSeq: null }, { source: 'x', seq: 1 })).toBe(
			false
		);
	});
});

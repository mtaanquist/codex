import { describe, expect, it } from 'vitest';
import { explainPgvectorError, outOfOrderMigrations, readJournal } from './migrate';

describe('outOfOrderMigrations', () => {
	it('finds nothing wrong with the committed journal', () => {
		expect(outOfOrderMigrations(readJournal('drizzle'))).toEqual([]);
	});

	it('flags an entry that does not sort after the one before it', () => {
		expect(
			outOfOrderMigrations([
				{ tag: '0000_a', when: 100 },
				{ tag: '0001_b', when: 300 },
				{ tag: '0002_c', when: 200 },
				{ tag: '0003_d', when: 200 }
			])
		).toEqual(['0002_c', '0003_d']);
	});
});

describe('explainPgvectorError', () => {
	it('gives directions when the role may not create pgvector', () => {
		const pgError = Object.assign(new Error('permission denied to create extension "vector"'), {
			code: '42501'
		});
		const wrapped = explainPgvectorError(
			Object.assign(new Error('Failed query'), { cause: pgError })
		);
		expect((wrapped as Error).message).toMatch(/as a superuser, run CREATE EXTENSION vector/);
	});

	it('passes other errors through', () => {
		const other = Object.assign(new Error('permission denied for table users'), { code: '42501' });
		expect(explainPgvectorError(other)).toBe(other);
	});
});

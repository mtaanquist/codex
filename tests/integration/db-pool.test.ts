import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { createPool } from '../../src/lib/server/db/pool';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// The pool the app and the worker share. A connection the database ends while
// it is checked out must fail the query that was using it and nothing more.

let pool: pg.Pool;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = createPool(TEST_DATABASE_URL);
});

afterAll(async () => {
	await pool.end();
});

describe('a connection the database ends while it is in use', () => {
	it('fails that work and leaves the process and the pool standing', async () => {
		const client = await pool.connect();
		let failure: unknown;
		try {
			await client.query('begin');
			await client.query('set local transaction_timeout = 100');
			// Postgres ends the session here, while the client is checked out
			// and idle. With nothing listening, that is an uncaught error.
			await new Promise((resolve) => setTimeout(resolve, 500));
			await client.query('select 1');
		} catch (err) {
			failure = err;
		} finally {
			client.release(true);
		}
		expect(failure).toBeInstanceOf(Error);
		expect((await pool.query('select 1 as n')).rows).toEqual([{ n: 1 }]);
	});

	it('does the same when an administrator ends the session', async () => {
		const client = await pool.connect();
		let failure: unknown;
		try {
			const { rows } = await client.query('select pg_backend_pid() as pid');
			await pool.query('select pg_terminate_backend($1)', [rows[0].pid]);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await client.query('select 1');
		} catch (err) {
			failure = err;
		} finally {
			client.release(true);
		}
		expect(failure).toBeInstanceOf(Error);
		expect((await pool.query('select 1 as n')).rows).toEqual([{ n: 1 }]);
	});
});

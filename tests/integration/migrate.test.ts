import { beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
	CANCEL_ON_MIGRATE_APP_NAME,
	hasPgvector,
	readJournal,
	runMigrations
} from '../../src/lib/server/db/migrate';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// A database of its own, emptied before the run, so concurrent first-time
// migration starts from nothing. Emptying the schemas is much cheaper than
// dropping and recreating the database, which forces a checkpoint.
const url = new URL(TEST_DATABASE_URL);
url.pathname = `${url.pathname}_migrate`;
const MIGRATE_DATABASE_URL = url.toString();

async function query(text: string) {
	const client = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
	await client.connect();
	try {
		return await client.query(text);
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	await ensureTestDatabase(MIGRATE_DATABASE_URL);
	await query(
		'drop schema if exists drizzle cascade; drop schema public cascade; create schema public'
	);
}, 30_000);

describe('runMigrations', () => {
	it('applies each migration once when several processes start together', async () => {
		await Promise.all([
			runMigrations(MIGRATE_DATABASE_URL),
			runMigrations(MIGRATE_DATABASE_URL),
			runMigrations(MIGRATE_DATABASE_URL)
		]);

		const { rows } = await query('select count(*)::int as n from drizzle.__drizzle_migrations');
		expect(rows[0].n).toBe(readJournal('drizzle').length);
	}, 30_000);

	it('installs pgvector, which the database image provides', async () => {
		const client = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
		await client.connect();
		try {
			expect(await hasPgvector(client)).toBe(true);
		} finally {
			await client.end();
		}
		const { rows } = await query(`select extname from pg_extension where extname = 'vector'`);
		expect(rows).toHaveLength(1);
	});
});

describe('runMigrations during a long read', () => {
	// The shipped migrations plus one that alters users, which waits behind
	// any read holding a lock on it.
	function folderWithAlter(): string {
		const folder = mkdtempSync(join(tmpdir(), 'codex-migrate-'));
		cpSync('drizzle', folder, { recursive: true });
		const journalPath = join(folder, 'meta', '_journal.json');
		const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
		const last = journal.entries[journal.entries.length - 1];
		const tag = '9999_cancel_probe';
		journal.entries.push({ ...last, idx: last.idx + 1, tag, when: last.when + 1 });
		writeFileSync(journalPath, JSON.stringify(journal));
		writeFileSync(
			join(folder, `${tag}.sql`),
			'ALTER TABLE "users" ADD COLUMN "cancel_probe" integer;'
		);
		return folder;
	}

	// A sweep-style read: it names itself as the sweep does and holds a lock
	// on users until cancelled.
	async function longRead() {
		const client = new pg.Client({
			connectionString: MIGRATE_DATABASE_URL,
			application_name: CANCEL_ON_MIGRATE_APP_NAME
		});
		await client.connect();
		const done = (async () => {
			await client.query('begin read only');
			await client.query('select count(*) from users');
			await client.query('select pg_sleep(20)');
		})();
		done.catch(() => {});
		// Wait until the lock is held.
		for (let i = 0; i < 50; i++) {
			const { rows } = await query(
				`select count(*)::int as n from pg_stat_activity
				where application_name = '${CANCEL_ON_MIGRATE_APP_NAME}' and query like '%pg_sleep%'`
			);
			if (rows[0].n > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const end = async () => {
			await query(
				`select pg_cancel_backend(pid) from pg_stat_activity
				where application_name = '${CANCEL_ON_MIGRATE_APP_NAME}'`
			);
			await client.end().catch(() => {});
		};
		return { done, end };
	}

	it('cancels it before applying, and leaves it alone when nothing is pending', async () => {
		const folder = folderWithAlter();
		const first = await longRead();
		try {
			await runMigrations(MIGRATE_DATABASE_URL, folder);
			await expect(first.done).rejects.toThrow(/cancel/);
		} finally {
			await first.end();
		}
		const { rows } = await query(
			`select count(*)::int as n from information_schema.columns
			where table_name = 'users' and column_name = 'cancel_probe'`
		);
		expect(rows[0].n).toBe(1);

		const second = await longRead();
		try {
			await runMigrations(MIGRATE_DATABASE_URL, folder);
			const settled = await Promise.race([
				second.done.then(
					() => 'finished',
					() => 'cancelled'
				),
				new Promise((resolve) => setTimeout(() => resolve('running'), 200))
			]);
			expect(settled).toBe('running');
		} finally {
			await second.end();
		}
	}, 30_000);
});

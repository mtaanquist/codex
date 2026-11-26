import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Imported by scripts/migrate.ts under plain Node, so relative imports only.

type JournalEntry = { tag: string; when: number };

// Drizzle applies only migrations whose `when` is newer than the last applied
// one, so an entry that does not sort after its predecessor (a branch generated
// before another one merged) would be skipped without a word in production.
export function outOfOrderMigrations(entries: JournalEntry[]): string[] {
	const bad: string[] = [];
	for (let i = 1; i < entries.length; i++) {
		if (entries[i].when <= entries[i - 1].when) bad.push(entries[i].tag);
	}
	return bad;
}

export function readJournal(migrationsFolder: string): JournalEntry[] {
	const raw = readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
	return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

// The application_name a long read sets for its transaction (the unused image
// sweep's, see unused-assets.ts). Such a read holds a lock on every table it
// reads for hours; a migration's ALTER TABLE would queue behind it and every
// later query on that table behind the ALTER. The migrator cancels these
// reads before applying anything; they are read-only and retried next night.
export const CANCEL_ON_MIGRATE_APP_NAME = 'codex-unused-asset-sweep';

// The advisory lock each of those reads holds shared for its transaction
// (see longRead in unused-assets.ts). The migrator takes it exclusively before
// applying anything, so no read starts while the migrations run.
export const SWEEP_LOCK_SQL = `hashtext('codex:unused-asset-sweep')`;

// Whether the journal holds a migration newer than the last one applied,
// by the same `when` comparison drizzle makes.
async function hasPendingMigrations(client: pg.Client, entries: JournalEntry[]): Promise<boolean> {
	if (entries.length === 0) return false;
	const { rows } = await client.query<{ exists: boolean }>(
		`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`
	);
	if (!rows[0].exists) return true;
	const last = await client.query<{ when: string | null }>(
		`select max(created_at)::text as when from drizzle.__drizzle_migrations`
	);
	const applied = last.rows[0].when === null ? -Infinity : Number(last.rows[0].when);
	return entries[entries.length - 1].when > applied;
}

// The sweep's reads this role may signal. The name is checked in the same
// statement as the cancel, so a pooled connection that has since moved on to
// other work is not cancelled.
const LONG_READS = `from pg_stat_activity
	where application_name = $1 and datname = current_database() and pid <> pg_backend_pid()
		and (pg_has_role(usesysid, 'USAGE') or pg_has_role('pg_signal_backend', 'USAGE'))`;

/** Cancels the long reads that would hold up a migration; returns how many. */
export async function cancelLongReads(client: pg.ClientBase): Promise<number> {
	return (await cancelReads(client)).length;
}

// The pids of the reads cancelled.
async function cancelReads(client: pg.ClientBase): Promise<number[]> {
	const cancelledPids = (rows: { pid: number; cancelled: boolean }[]) =>
		rows.filter((row) => row.cancelled).map((row) => row.pid);
	try {
		const { rows } = await client.query<{ pid: number; cancelled: boolean }>(
			`select pid, pg_cancel_backend(pid) as cancelled ${LONG_READS}`,
			[CANCEL_ON_MIGRATE_APP_NAME]
		);
		return cancelledPids(rows);
	} catch {
		// pg_cancel_backend raises an error, rather than returning false, for a
		// backend this role still may not signal (a superuser's), which fails the
		// whole statement. Cancel one at a time instead, logging and passing over
		// a refusal: the migration then waits for that read to end instead of not
		// starting at all.
	}
	const { rows } = await client.query<{ pid: number }>(`select pid ${LONG_READS}`, [
		CANCEL_ON_MIGRATE_APP_NAME
	]);
	const cancelled: number[] = [];
	for (const { pid } of rows) {
		try {
			const result = await client.query<{ pid: number; cancelled: boolean }>(
				`select pid, pg_cancel_backend(pid) as cancelled ${LONG_READS} and pid = $2`,
				[CANCEL_ON_MIGRATE_APP_NAME, pid]
			);
			cancelled.push(...cancelledPids(result.rows));
		} catch (error) {
			console.warn(
				`Could not cancel long-running read ${pid}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	return cancelled;
}

/**
 * Cancels the long reads and takes the sweep lock for this session, so none
 * starts again until the session ends; returns how many reads were cancelled.
 * A cancel that lands between a read's statements is lost, and that read then
 * still holds the lock, so it cancels again until the lock comes free. A read
 * cancelled twice (its rollback had not reached the server yet) counts once.
 * After about five seconds (a read this role may not cancel) it waits for the
 * lock.
 */
export async function holdOffLongReads(client: pg.ClientBase): Promise<number> {
	// Once whatever the lock says, so a named read that holds no lock goes too.
	const cancelled = new Set(await cancelReads(client));
	for (let attempt = 0; attempt < 100; attempt++) {
		const { rows } = await client.query<{ locked: boolean }>(
			`select pg_try_advisory_lock(${SWEEP_LOCK_SQL}) as locked`
		);
		if (rows[0].locked) return cancelled.size;
		for (const pid of await cancelReads(client)) cancelled.add(pid);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await client.query(`select pg_advisory_lock(${SWEEP_LOCK_SQL})`);
	return cancelled.size;
}

export const PGVECTOR_MISSING_MESSAGE =
	'The database has no pgvector extension, which Codex needs from version 4.0.0. ' +
	'Switch the database image to pgvector/pgvector:0.8.7-pg18-trixie (or install pgvector ' +
	'on your own PostgreSQL 18 server) and start Codex again. See "Updating" in docs/SELF-HOSTING.md.';

/** Whether pgvector is installed in this database or can be installed. */
export async function hasPgvector(client: pg.ClientBase): Promise<boolean> {
	const { rows } = await client.query<{ ok: boolean }>(
		`select exists (select 1 from pg_available_extensions where name = 'vector') as ok`
	);
	return rows[0].ok;
}

// pgvector is not a trusted extension, so a role that is not a superuser
// passes the availability check yet fails to create it.
export function explainPgvectorError(error: unknown): unknown {
	const cause = (error as { cause?: unknown })?.cause ?? error;
	const { code, message } = (cause ?? {}) as { code?: string; message?: string };
	if (code === '42501' && message?.includes('"vector"')) {
		return new Error(
			'The database user may not create the pgvector extension. Connect to the Codex database as a ' +
				'superuser, run CREATE EXTENSION vector; and start Codex again. See "Updating" in docs/SELF-HOSTING.md.',
			{ cause: error }
		);
	}
	// Any other refusal to create it, such as a managed service's allow-list.
	if (message && /extension "vector"|vector\.control/.test(message)) {
		return new Error(
			`The database could not create the pgvector extension (${message}). Install or allow ` +
				'pgvector on the database server, or ask your provider to, and start Codex again. See ' +
				'"Updating" in docs/SELF-HOSTING.md.',
			{ cause: error }
		);
	}
	return error;
}

// Applies pending migrations while holding a session advisory lock, so the app
// and worker (or several replicas) starting together apply each migration once:
// drizzle reads the last applied row outside its transaction and takes no lock.
export async function runMigrations(
	connectionString: string,
	migrationsFolder = 'drizzle',
	// A seam for the test of a server without pgvector.
	checks: { hasPgvector: (client: pg.ClientBase) => Promise<boolean> } = { hasPgvector }
) {
	const entries = readJournal(migrationsFolder);
	const bad = outOfOrderMigrations(entries);
	if (bad.length > 0) {
		throw new Error(
			`Migrations out of order in the journal (their "when" is not after the previous entry): ${bad.join(', ')}. Regenerate them so they sort last.`
		);
	}
	const client = new pg.Client({ connectionString });
	// A migration's warnings (such as 0131 skipping a table it may not
	// reindex) reach the log rather than only the database server's.
	client.on('notice', (notice) => {
		// SQLSTATE class 01 is a warning; the severity text is translated.
		if (notice.code?.startsWith('01')) console.warn(`Migration warning: ${notice.message}`);
	});
	await client.connect();
	try {
		await client.query(`select pg_advisory_lock(hashtext('codex:migrations'))`);
		if (await hasPendingMigrations(client, entries)) {
			// Checked first so a server without it stops with directions instead
			// of postgres's bare "extension is not available".
			if (!(await checks.hasPgvector(client))) throw new Error(PGVECTOR_MISSING_MESSAGE);
			const cancelled = await holdOffLongReads(client);
			if (cancelled > 0) {
				console.log(`Cancelled ${cancelled} long-running read(s) so the migrations can run.`);
			}
		}
		await migrate(drizzle(client), { migrationsFolder }).catch((error: unknown) => {
			throw explainPgvectorError(error);
		});
	} finally {
		// Ending the session releases the lock, also when migrate threw.
		await client.end();
	}
}

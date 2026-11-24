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
	const count = (rows: { cancelled: boolean }[]) => rows.filter((row) => row.cancelled).length;
	try {
		const { rows } = await client.query<{ cancelled: boolean }>(
			`select pg_cancel_backend(pid) as cancelled ${LONG_READS}`,
			[CANCEL_ON_MIGRATE_APP_NAME]
		);
		return count(rows);
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
	let cancelled = 0;
	for (const { pid } of rows) {
		try {
			const result = await client.query<{ cancelled: boolean }>(
				`select pg_cancel_backend(pid) as cancelled ${LONG_READS} and pid = $2`,
				[CANCEL_ON_MIGRATE_APP_NAME, pid]
			);
			cancelled += count(result.rows);
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
 * starts again until the session ends; returns how many were cancelled. A
 * cancel that lands between a read's statements is lost, and that read then
 * still holds the lock, so it cancels again until the lock comes free. After
 * about five seconds (a read this role may not cancel) it waits for the lock.
 */
export async function holdOffLongReads(client: pg.ClientBase): Promise<number> {
	// Once whatever the lock says, so a named read that holds no lock goes too.
	let cancelled = await cancelLongReads(client);
	for (let attempt = 0; attempt < 100; attempt++) {
		const { rows } = await client.query<{ locked: boolean }>(
			`select pg_try_advisory_lock(${SWEEP_LOCK_SQL}) as locked`
		);
		if (rows[0].locked) return cancelled;
		cancelled += await cancelLongReads(client);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await client.query(`select pg_advisory_lock(${SWEEP_LOCK_SQL})`);
	return cancelled;
}

// Applies pending migrations while holding a session advisory lock, so the app
// and worker (or several replicas) starting together apply each migration once:
// drizzle reads the last applied row outside its transaction and takes no lock.
export async function runMigrations(connectionString: string, migrationsFolder = 'drizzle') {
	const entries = readJournal(migrationsFolder);
	const bad = outOfOrderMigrations(entries);
	if (bad.length > 0) {
		throw new Error(
			`Migrations out of order in the journal (their "when" is not after the previous entry): ${bad.join(', ')}. Regenerate them so they sort last.`
		);
	}
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await client.query(`select pg_advisory_lock(hashtext('codex:migrations'))`);
		if (await hasPendingMigrations(client, entries)) {
			const cancelled = await holdOffLongReads(client);
			if (cancelled > 0) {
				console.log(`Cancelled ${cancelled} long-running read(s) so the migrations can run.`);
			}
		}
		await migrate(drizzle(client), { migrationsFolder });
	} finally {
		// Ending the session releases the lock, also when migrate threw.
		await client.end();
	}
}

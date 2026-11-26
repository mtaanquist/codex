-- pgvector is required from v4.0.0. The shipped database image moves from
-- postgres:18-alpine (musl) to pgvector/pgvector (Debian, glibc). A data
-- volume created under musl sorts text differently from glibc, so its text
-- indexes are out of order once opened by the new image: lookups miss rows
-- and unique indexes stop catching duplicates. Such a database records no
-- collation version (musl has none) while the running server reports one,
-- which is how it is told apart here; its indexes are rebuilt before
-- anything else writes. A database created under glibc skips this.
DO $$
DECLARE
	t record;
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_database
		WHERE datname = current_database()
			AND datlocprovider = 'c'
			AND datcollversion IS NULL
			AND pg_database_collation_actual_version(oid) IS NOT NULL
	) THEN
		FOR t IN
			SELECT DISTINCT i.indrelid::regclass AS rel
			FROM pg_index i
			JOIN pg_class c ON c.oid = i.indrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
				AND c.relkind IN ('r', 'm')
				AND pg_has_role(c.relowner, 'USAGE')
		LOOP
			EXECUTE format('REINDEX TABLE %s', t.rel);
		END LOOP;
	END IF;
END $$;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;

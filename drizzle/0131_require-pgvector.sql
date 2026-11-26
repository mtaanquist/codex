-- pgvector is required from v4.0.0. First, so a server without it (or a role
-- that may not create it) fails before the reindex below.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
-- The shipped database image moves from postgres:18-alpine (musl) to
-- pgvector/pgvector (Debian, glibc). A data volume created under musl sorts
-- text differently from glibc, so its text indexes are out of order once
-- opened by the new image: lookups miss rows and unique indexes stop catching
-- duplicates. Such a database records no collation version (musl has none)
-- while the running server reports one, which is how it is told apart here.
-- An ICU database whose library version changed with the image is caught the
-- same way. Its indexes are rebuilt before anything else writes; a database
-- created under glibc skips this.
DO $$
DECLARE
	t record;
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_database
		WHERE datname = current_database()
			AND (
				(datlocprovider = 'c' AND datcollversion IS NULL
					AND pg_database_collation_actual_version(oid) IS NOT NULL)
				OR (datlocprovider = 'i'
					AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid))
			)
	) THEN
		FOR t IN
			SELECT DISTINCT i.indrelid::regclass AS rel, pg_has_role(c.relowner, 'USAGE') AS owned
			FROM pg_index i
			JOIN pg_class c ON c.oid = i.indrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
				AND c.relkind IN ('r', 'm')
				AND c.relpersistence <> 't'
		LOOP
			IF NOT t.owned THEN
				RAISE WARNING 'Not rebuilding the indexes of %, which another role owns. Run REINDEX TABLE % as its owner.', t.rel, t.rel;
				CONTINUE;
			END IF;
			BEGIN
				EXECUTE format('REINDEX TABLE %s', t.rel);
			EXCEPTION WHEN unique_violation THEN
				RAISE EXCEPTION 'Rebuilding the indexes of % found duplicate rows, likely written while the new database image ran an older version of Codex. Restore the backup taken before the update (see "Updating to 4.0.0" in docs/SELF-HOSTING.md). If that fails the same way, the rows differ only in letter case and one of each pair must be removed by hand.', t.rel
					USING DETAIL = SQLERRM;
			END;
		END LOOP;
		-- Records the version where Postgres allows it, so it warns on a later
		-- change by itself. From no recorded version (musl) it refuses.
		BEGIN
			EXECUTE format('ALTER DATABASE %I REFRESH COLLATION VERSION', current_database());
		EXCEPTION WHEN OTHERS THEN
			NULL;
		END;
	END IF;
END $$;

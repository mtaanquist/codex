-- Any committed write that stores an image's id clears that image's unused
-- mark (assets.unreferenced_since), so one put back into use between two runs
-- of the unused-image sweep starts its 30 days over. The row is read whole, the
-- way the sweep reads every column, so a column added later is covered too.
-- Every table but assets carries it; a table created later needs its own
-- CREATE TRIGGER (unused-assets.test.ts fails until it has one).
CREATE FUNCTION "clear_asset_marks"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "assets" SET "unreferenced_since" = NULL
	WHERE "unreferenced_since" IS NOT NULL
		AND "id" IN (
			SELECT lower(m[1])::uuid
			FROM regexp_matches(to_jsonb(NEW)::text, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'gi') AS m
		);
	RETURN NULL;
END
$$;--> statement-breakpoint
DO $$
DECLARE
	t record;
BEGIN
	FOR t IN
		SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
			AND c.relkind IN ('r', 'p')
			AND NOT c.relispartition
			AND c.relname <> 'assets'
	LOOP
		EXECUTE format(
			'CREATE TRIGGER "clear_asset_marks" AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "clear_asset_marks"()',
			t.relname
		);
	END LOOP;
END
$$;

#!/bin/sh
# Migration 0131 rebuilds the indexes of a database created under the old
# Alpine (musl) image once the Debian (glibc) pgvector image opens it. CI
# otherwise only creates databases under glibc, so this runs that path: a
# volume made and migrated under the old image (see LAST_BEFORE_REINDEX), seeded with text and
# citext unique indexes, then opened by the new image and migrated to head.
# Every btree index must then pass amcheck.
# Run from the repository root after npm ci. Needs Docker.
set -eu

OLD_IMAGE=postgres:18.6-alpine3.24
# Must match compose.yaml and the services in ci.yml.
NEW_IMAGE=pgvector/pgvector:0.8.7-pg18-trixie
# The last migration of the previous release, so the migrations between it
# and the reindex run under the new image on out-of-order indexes, as they do
# for a real upgrade from 3.x. Never past the one before 0131: the old image
# has no pgvector, so it cannot run 0131 once the previous release has it.
LAST_BEFORE_REINDEX=$(node -p "
const release = require('./tests/integration/upgrade/previous-release.json').migrations - 1;
const entries = require('./drizzle/meta/_journal.json').entries;
const reindex = entries.find((entry) => entry.tag.startsWith('0131_')).idx - 1;
Math.min(release, reindex)
")
PORT=55432
URL="postgres://codex:codex@localhost:$PORT/codex"
VOLUME=codex-collation-upgrade
NAME=codex-collation-upgrade

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

start() {
  docker run -d --name "$NAME" -p "$PORT:5432" -v "$VOLUME:/var/lib/postgresql" \
    -e POSTGRES_USER=codex -e POSTGRES_PASSWORD=codex -e POSTGRES_DB=codex "$1" >/dev/null
  # pg_isready answers during the image's first-run init; wait for a query.
  for attempt in $(seq 1 60); do
    if docker exec "$NAME" psql -U codex -d codex -tAc 'select 1' >/dev/null 2>&1; then
      sleep 2
      docker exec "$NAME" psql -U codex -d codex -tAc 'select 1' >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  echo "$1 did not start"
  docker logs "$NAME"
  exit 1
}

sql() {
  docker exec -i "$NAME" psql -U codex -d codex -v ON_ERROR_STOP=1 -tA "$@"
}

# The btree indexes amcheck finds out of order, as a count.
broken_indexes() {
  sql <<'SQL'
create extension if not exists amcheck;
do $$
declare
  i regclass;
  broken int := 0;
begin
  for i in
    select c.oid::regclass from pg_index x
    join pg_class c on c.oid = x.indexrelid
    join pg_am a on a.oid = c.relam
    join pg_namespace n on n.oid = c.relnamespace
    where a.amname = 'btree' and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
  loop
    begin
      perform bt_index_check(i, true);
    exception when others then
      raise notice 'broken: % (%)', i, sqlerrm;
      broken := broken + 1;
    end;
  end loop;
  perform set_config('ci.broken', broken::text, false);
end $$;
select current_setting('ci.broken');
SQL
}

# A volume made and migrated under the old image, seeded, and stopped.
prepare_old() {
echo "Old image: migrate to $LAST_BEFORE_REINDEX and seed"
start "$OLD_IMAGE"
folder=$(mktemp -d)
cp -r drizzle/. "$folder"
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const path = '$folder/meta/_journal.json';
const journal = JSON.parse(readFileSync(path, 'utf8'));
journal.entries = journal.entries.filter((entry) => entry.idx <= $LAST_BEFORE_REINDEX);
writeFileSync(path, JSON.stringify(journal));
// Plain drizzle: the app's migrator refuses a database with no pgvector.
const { default: pg } = await import('pg');
const { drizzle } = await import('drizzle-orm/node-postgres');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const pool = new pg.Pool({ connectionString: '$URL' });
await migrate(drizzle(pool), { migrationsFolder: '$folder' });
await pool.end();
"
rm -rf "$folder"
# Mixed case, punctuation and accents, which musl and glibc order differently.
sql <<'SQL'
create table ci_collation (id serial primary key, t text not null unique, c citext not null unique);
insert into ci_collation (t, c)
select p || md5(n::text) || upper(substr(md5((n + 7)::text), 1, 6)),
       upper(substr(md5(n::text), 1, 3)) || q || md5(n::text)
from generate_series(1, 5000) n,
  lateral (select (array['a', 'B', '-', '_', ' ', 'e', 'F', chr(233), 'Z', '.'])[1 + n % 10] p,
                  (array['-', ' ', '_', 'x', 'Y', '.'])[1 + n % 6] q) s;
insert into users (email, display_name, password_hash, role)
select (array['a', 'B', '-', 'z', chr(201)])[1 + n % 5] || 'writer' || n || '@example.com',
       'Writer ' || n, 'x', 'user'
from generate_series(1, 500) n;
SQL
docker stop "$NAME" >/dev/null
docker rm "$NAME" >/dev/null

}

prepare_old
echo "New image: the indexes must be out of order before the migration"
start "$NEW_IMAGE"
before=$(broken_indexes | tail -1)
echo "broken before: $before"
# If this stops finding any, the test no longer exercises the reindex.
[ "$before" -gt 0 ]

echo "New image: migrate to head"
DATABASE_URL="$URL" node scripts/migrate.ts
after=$(broken_indexes | tail -1)
echo "broken after: $after"
[ "$after" -eq 0 ]

# Rows that differ only in what glibc and musl order differently can be
# written twice while an older Codex runs on the new image, through an index
# that no longer finds the first. The rebuild must then stop with directions
# and apply nothing. The index is switched off for the insert, which writes
# such a duplicate without depending on where the broken index looks.
echo "Duplicates: the migration must stop and apply nothing"
cleanup
prepare_old
start "$NEW_IMAGE"
applied_before=$(sql -c 'select count(*) from drizzle.__drizzle_migrations')
sql <<'SQL'
update pg_index set indisready = false, indisvalid = false where indexrelid = 'ci_collation_t_key'::regclass;
insert into ci_collation (t, c) select t, c || '-copy' from ci_collation order by id limit 1;
update pg_index set indisready = true, indisvalid = true where indexrelid = 'ci_collation_t_key'::regclass;
SQL
if DATABASE_URL="$URL" node scripts/migrate.ts > migrate.log 2>&1; then
  echo "the migration did not stop on duplicate rows"
  cat migrate.log
  exit 1
fi
grep -q 'found duplicate rows' migrate.log || { cat migrate.log; exit 1; }
applied_after=$(sql -c 'select count(*) from drizzle.__drizzle_migrations')
[ "$applied_before" -eq "$applied_after" ]
rm -f migrate.log

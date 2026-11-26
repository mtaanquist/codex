# Self-hosting Codex

This guide is for operators running their own Codex instance. The README has
the quickstart; this goes deeper on configuration, the reverse proxy, email,
storage, backups and restore, monitoring, and updates.

Codex is one Docker image run as three long-lived parts plus your database:

- **app**: serves the web app on port 3000. Sign-in, editing, publishing,
  uploads, and the admin panel.
- **worker**: runs background jobs. Mention indexing, outgoing email,
  publishing exports, scheduled backups, and the account and universe purges.
  Nothing in the app sends email or takes a backup directly; the worker does.
- **db**: PostgreSQL 18 with the pgvector extension. Holds everything.
- Optional: **caddy** for TLS, and **rustfs** as a local S3 bucket for testing.

Run both the app and the worker. Without the worker, mentions never index (the
Reference panel stays empty), no email is sent, and no backups are taken.

## Requirements

- A host with Docker and Docker Compose.
- A PostgreSQL 18 database with the pgvector extension available (the
  bundled `db` service, or your own). Managed databases usually offer it as
  the `vector` extension.
- A public hostname and a TLS certificate for any real deployment, served by
  the bundled Caddy or a reverse proxy of your own.
- Optional but recommended: an S3-compatible bucket for off-site backups, and
  a separate one for uploaded images.

## First run

From a clean host:

```bash
git clone https://github.com/mtaanquist/Codex.git
cd Codex
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, ORIGIN, and APP_SECRET at minimum.
docker compose up -d
```

The app and worker containers apply pending database migrations on every start
(one at a time, so each migration runs once), so there is no separate migration
step. Watch for it to come up:

```bash
docker compose logs -f app   # wait for "Migrations applied." then the server
```

Then create the first admin (see below) and sign in at your `ORIGIN`.

The repository's `compose.yaml` builds the image from source and wires up every
optional service. To run released images instead of building, use the minimal
compose file in the README, which pulls `ghcr.io/mtaanquist/codex`.

### Create the first admin

New accounts wait behind an approval gate, so the first one is made from the
command line. With the stack running:

```bash
docker compose exec -it app node scripts/seed-admin.ts you@example.com "Your Name"
```

You are asked for a password, which is not echoed. For unattended provisioning,
pass it as `ADMIN_PASSWORD` in the environment instead. This account is
pre-verified and pre-approved, signs in immediately, and approves everyone who
signs up after. Once any admin exists the command refuses; manage further
admins from the admin panel.

## Environment variables

Two things read `.env`: the dev tooling, and Docker Compose for variable
substitution in `compose.yaml`. The app and worker receive the values Compose
passes through. Settings saved in the admin panel (SMTP, asset storage, backup
storage) win over the matching environment variables, which act as the initial
seed.

### Core

| Variable            | Required         | Default                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | yes              | dev local db            | PostgreSQL connection string. The bundled stack builds it from `POSTGRES_PASSWORD`.                                                                                                                                                                                                                                                                                                                                 |
| `POSTGRES_PASSWORD` | yes (bundled db) | `codex`                 | Database password for the bundled `db` service. Set something strong.                                                                                                                                                                                                                                                                                                                                               |
| `ORIGIN`            | yes (prod)       | `http://localhost:3000` | The public URL, scheme and any non-standard port included. Form posts that do not match it are rejected, and emailed links use it. The app and worker will not start without it (the bundled compose file sets the default for both). The app takes its address from `ORIGIN` alone: adapter-node's `PROTOCOL_HEADER`, `HOST_HEADER` and `PORT_HEADER` are set by the image's `server.js` and cannot be overridden. |
| `APP_SECRET`        | recommended      | unset                   | Encrypts secrets at rest (SMTP password, two-factor secrets) and signs two-factor and passkey challenges. Keep it stable; changing it makes stored secrets unreadable and breaks two-factor until re-enrolled. Without it, two-factor and passkeys are unavailable and the panel cannot store an SMTP password.                                                                                                     |
| `APP_PORT`          | no               | `3000`                  | Host port the app publishes. The container always listens on 3000.                                                                                                                                                                                                                                                                                                                                                  |
| `APP_BIND`          | no               | `127.0.0.1`             | Host address the app port is published on. Loopback lets only a proxy on the same host reach it. Change it only for a proxy on another machine, to an address that proxy alone can reach.                                                                                                                                                                                                                           |
| `BODY_SIZE_LIMIT`   | no               | `15M`                   | Upload cap for the Node adapter. Images are capped at 10 MB regardless.                                                                                                                                                                                                                                                                                                                                             |

### Reverse proxy

| Variable         | Default           | Notes                                                                                                                                                                                            |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADDRESS_HEADER` | `x-forwarded-for` | Header to read the client address from, for rate limiting. Only safe when clients cannot reach the app except through the proxy. Set empty if no proxy is in front, so a client cannot spoof it. |
| `XFF_DEPTH`      | `1`               | Number of proxies in front of the app. With one proxy, the default is correct.                                                                                                                   |

### Email (SMTP)

| Variable        | Default                      | Notes                                                                 |
| --------------- | ---------------------------- | --------------------------------------------------------------------- |
| `SMTP_HOST`     | unset                        | With nothing set, email is written to the worker log instead of sent. |
| `SMTP_PORT`     | `587`                        | `465` for implicit TLS, `587` for STARTTLS.                           |
| `SMTP_SECURE`   | `false`                      | `true` for port 465.                                                  |
| `SMTP_USER`     | empty                        | SMTP username.                                                        |
| `SMTP_PASSWORD` | unset                        | Stored encrypted when set from the admin panel.                       |
| `SMTP_FROM`     | `Codex <no-reply@localhost>` | The From header.                                                      |

### Image storage (assets)

Uploaded images go to an S3-compatible bucket and are served back through the
app. Off until the endpoint, bucket, and both keys are set, here or in the
admin panel's Usage and storage section. **Use a different bucket from the
backups** (see the warning below).

| Variable                     | Default        | Notes                                                |
| ---------------------------- | -------------- | ---------------------------------------------------- |
| `ASSET_S3_ENDPOINT`          | unset          | Include the scheme. Empty disables uploads entirely. |
| `ASSET_S3_REGION`            | `auto`         |                                                      |
| `ASSET_S3_BUCKET`            | unset          | Required when the endpoint is set.                   |
| `ASSET_S3_PREFIX`            | `codex-assets` | Key prefix inside the bucket.                        |
| `ASSET_S3_ACCESS_KEY_ID`     | unset          | Required when the endpoint is set.                   |
| `ASSET_S3_SECRET_ACCESS_KEY` | unset          | Required when the endpoint is set.                   |

### Off-site backups

Scheduled database dumps to any S3-compatible bucket. Off until the endpoint,
bucket, and both keys are set. The schedule and retention are below; the bucket
details can also be set in the admin panel's Backups section.

| Variable                      | Default         | Notes                                      |
| ----------------------------- | --------------- | ------------------------------------------ |
| `BACKUP_S3_ENDPOINT`          | unset           | Include the scheme.                        |
| `BACKUP_S3_REGION`            | `auto`          |                                            |
| `BACKUP_S3_BUCKET`            | unset           | Required when the endpoint is set.         |
| `BACKUP_S3_PREFIX`            | `codex-backups` | Key prefix inside the bucket.              |
| `BACKUP_S3_ACCESS_KEY_ID`     | unset           | Required when the endpoint is set.         |
| `BACKUP_S3_SECRET_ACCESS_KEY` | unset           | Required when the endpoint is set.         |
| `BACKUP_CRON`                 | `0 * * * *`     | Schedule in UTC. Environment only.         |
| `BACKUP_KEEP_RECENT_HOURS`    | `48`            | Keep every dump from the last N hours.     |
| `BACKUP_KEEP_DAYS`            | `30`            | Then keep the newest per day, back N days. |

### Optional bundled services

| Variable            | Default               | Notes                                                                                   |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`  | empty                 | `caddy` runs the bundled TLS proxy; `rustfs` runs a local bucket. Combine with a comma. |
| `SITE_ADDRESS`      | `:80`                 | Caddy: a bare domain obtains TLS; `:80` serves plain HTTP.                              |
| `HTTP_PORT`         | `80`                  | Caddy HTTP port.                                                                        |
| `HTTPS_PORT`        | `443`                 | Caddy HTTPS port.                                                                       |
| `RUSTFS_ACCESS_KEY` | `codex-rustfs`        | Credentials for the bundled RustFS; it creates the two buckets on first start.          |
| `RUSTFS_SECRET_KEY` | `codex-rustfs-secret` |                                                                                         |

> **Keep assets and backups in separate buckets.** A restore writes the whole
> database back, including the rows that point at uploaded images. If the
> backup and asset buckets were the same, a restore could overwrite or prune
> your images. Use distinct buckets (or at least distinct prefixes on
> different lifecycle rules), and never point both at the same bundled RustFS in
> production. The bundled RustFS keeps data on the same host, so it is for
> testing, not disaster recovery; use an external provider (S3, B2, R2) for a
> real deployment.

## Reverse proxy and TLS

Codex serves plain HTTP on port 3000 and expects TLS to be terminated in front
of it. Set `ORIGIN` to the exact public URL the browser sees (scheme, host, and
any non-standard port). A mismatch rejects every form submission, so this is the
first thing to check if sign-in or saving fails with a 403.

Behind any proxy, set `ADDRESS_HEADER` to the header carrying the client
address (`x-forwarded-for` by default) and `XFF_DEPTH` to the number of proxies.
Without it, every request looks like it comes from the proxy, and the per-address
sign-in rate limit collapses into one shared counter that enough failed
attempts can trip for everyone at once.

Trusting that header is only safe when the proxy is the one thing that can
reach the app. Anyone who can connect to the app port directly can send their
own `X-Forwarded-For` and get a fresh address on every request, which slips
past the per-address limits on sign-in, sign-up, and password reset. The
bundled `compose.yaml` publishes the app port on `127.0.0.1` only (`APP_BIND`),
so a proxy on the same host reaches it and nothing else does; the bundled Caddy
and a Traefik on the same Docker network reach the app over that network
instead. If the proxy runs on another machine, set `APP_BIND` to an address only
it can reach, or firewall the port. If you run the app with no proxy at all,
set `APP_BIND=0.0.0.0` and `ADDRESS_HEADER` empty.

The app sets its own security headers (`Content-Security-Policy`,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`), so the proxy
does not need to add them. When `ORIGIN` starts with `https://` it also sends
`Strict-Transport-Security` for one year, after which browsers refuse plain
HTTP for that host.

### Bundled Caddy

Set `COMPOSE_PROFILES=caddy` and `SITE_ADDRESS` to your domain. Caddy obtains
and renews a certificate automatically and forwards to the app. Its config is
the whole `Caddyfile`:

```
{$SITE_ADDRESS}

reverse_proxy app:3000
```

Remember to set `ORIGIN=https://your.domain` to match.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name codex.example.com;
    ssl_certificate     /etc/letsencrypt/live/codex.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codex.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

With `ORIGIN=https://codex.example.com`, the default `ADDRESS_HEADER` and
`XFF_DEPTH=1` are correct.

### Traefik (labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.codex.rule=Host(`codex.example.com`)
  - traefik.http.routers.codex.entrypoints=websecure
  - traefik.http.routers.codex.tls.certresolver=letsencrypt
  - traefik.http.services.codex.loadbalancer.server.port=3000
```

Traefik forwards `X-Forwarded-For` by default. Keep `ADDRESS_HEADER=x-forwarded-for`
and set `ORIGIN` to the HTTPS URL.

## Connected apps (MCP)

An account holder can connect an AI app to their account from Account,
Connected apps. Codex is the OAuth authorization server and serves an MCP
endpoint at `/api/mcp`; there is nothing to install or configure for it. It is
on by default and can be turned off for the whole instance in the admin panel,
after which these routes answer 404.

What a deployment needs for it to work:

- **claude.ai and Claude Desktop need the instance reachable over public
  HTTPS.** Both connect to a custom connector from Anthropic's servers, not
  from the user's machine, so an instance on `localhost`, on a private
  network, or behind a VPN cannot be reached by them. The same holds for any
  other app that connects from its vendor's servers. A tool that runs on the
  same machine or network as Codex can connect to a private instance.
- `ORIGIN` must be the public URL. The discovery documents, the consent page
  and the address shown to the user are all built from it.
- The proxy must pass these paths through to the app unchanged, with the
  `Authorization` header: `/api/mcp`, `/oauth/*` and `/.well-known/oauth-*`.
  The bundled Caddy and the nginx and Traefik examples below already do.
- Requests to `/api/mcp` are short and each gets a complete answer; no
  long-lived connection or sticky routing is needed.

## Email

With no SMTP configured, the worker writes the body of every message it would
send to its log, which is enough to grab a verification or reset link during
setup. For real use, set the `SMTP_*` variables, or fill in the admin panel's
Email relay section and send yourself a test message from there. The panel
stores the password encrypted (this needs `APP_SECRET`), and its settings win
over the environment seed.

## Backups and restore

With the `BACKUP_S3_*` variables set, the worker dumps the database on the
`BACKUP_CRON` schedule (hourly by default, in UTC). A dump that is identical to
the last one is not re-uploaded. Retention is tiered: every dump from the last
`BACKUP_KEEP_RECENT_HOURS` hours, then the newest per day back `BACKUP_KEEP_DAYS`
days. The admin sees recent runs and a "Back up now" button on the library page.

To take one immediately from the command line:

```bash
docker compose exec app node scripts/run-backup.ts
```

### Restore drill

Practice this before you need it. The restore replaces the current database, so
take a fresh dump first if there is anything live worth keeping.

1. Stop the app and worker so nothing writes during the restore:

   ```bash
   docker compose stop app worker
   ```

2. Restore the newest dump (or pass a specific object key instead of `latest`):

   ```bash
   docker compose run --rm app node scripts/restore-backup.ts latest
   ```

   This downloads the dump from the bucket, then replaces the application
   data in `DATABASE_URL` with it in one transaction: if anything fails, the
   database is left as it was. Tables from a newer version of Codex than the
   dump are removed too, so the app's migrations bring the schema up to date
   on the next start. The backup
   history on the admin page starts empty after a restore, and the next
   backup uploads in full. The database user in `DATABASE_URL` must own the
   tables in the `public` schema and may create objects in it (the bundled
   Postgres does both); on a managed database where it may not, the restore
   stops with a "must be owner of" or "permission denied for schema public"
   error and changes nothing. A dump from 4.0.0 or later also needs the pgvector extension: when
   you restore into a new, empty database as a user that is not a superuser,
   connect to it as a superuser and run `CREATE EXTENSION vector;` first.

3. Bring the stack back:

   ```bash
   docker compose up -d
   ```

The dump excludes the job-queue tables, so any jobs that were pending at dump
time are not restored; the worker simply carries on with new ones.

Uploaded images live in the asset bucket, not the database, and **the backups
do not copy them**. Replacing or clearing a cover, avatar or badge, taking an
image out of the text, and deleting a story or universe for good delete no
image at once. A worker job at 03:00 UTC each night deletes the images that
nothing has used for 30 days and that were uploaded more than 30 days ago.
Each deletion is logged as `assets.unused_deleted` with the image row, except
its original filename. The worker removes a stored file only once it is older
than the oldest kept backup: one day longer than `BACKUP_KEEP_DAYS` or
`BACKUP_KEEP_RECENT_HOURS`, whichever reaches further back, or one day when
backups are off. Restoring any kept dump therefore still finds every image it
points at. Files freed by the nightly job wait 30 days more on top of that, so
an image deleted by mistake can be put back by inserting its logged row again
with any filename; run **Admin > Usage & storage > Recount images** afterwards
so the account's storage total counts it. If you switch backups off later, the
dumps already in the bucket stay there but the wait drops to one day, so
images deleted after that are missing if you restore one of those older dumps.
If the asset bucket itself is lost, though, the images are gone: turn on
versioning or replication for that bucket at your storage provider, or copy it
somewhere else on a schedule. The bundled RustFS bucket lives in a Docker
volume on the same host, so back that volume up too. Deleting an account
removes its images straight away, without the wait, including the files of
images and editions it had already deleted that are still waiting; their log
lines keep the image ids and the account id, so keep log retention short if
that matters to you.

Images count toward the storage limit of the account's plan until they are
deleted. Plans and their limits (universes, stories, image storage, and the
size of one image) are set in **Admin > Plans** and assigned per account in
**Admin > Usage & storage**; the default plan has no limits.

## Health checks and monitoring

`GET /healthz` is public and runs a `select 1`. It returns `200` with
`{"status":"ok"}` when the database is reachable and `503` with
`{"status":"error"}` when it is not, or when the check takes longer than 3
seconds. Point an uptime monitor or an orchestrator liveness and readiness
probe at it.

The README example and `compose.yaml` give the app service a healthcheck that
calls `/healthz` every 30 seconds, so `docker compose ps` shows the app as
`healthy` or `unhealthy`, and the bundled Caddy waits for a healthy app before
it starts. If you use your own compose file, copy the app's `healthcheck`
block into it. The worker has no web port, so it has no healthcheck. Docker
Compose does not restart a container just because it is unhealthy; use an
orchestrator or a watchdog if you want that.

If the database restarts, the app and worker log a `db.pool_error` line and
reconnect on their own. A single database query that runs longer than 30
seconds in the app (5 minutes in the worker) is cancelled and that request or
job fails instead of holding a connection.

The worker logs one line per job to stdout; collect those if you want
visibility into indexing, email, exports, and backups. A failed backup is
logged there and shown in the admin panel's run history.

## Updating

Updating from 3.x to 4.0.0? Follow "Updating to 4.0.0" below first.

Change the image tag (or pull `latest`) and run `docker compose up -d`. Pending
migrations apply when the app or worker container starts. Migrations are
forward-only, so take a backup before updating if you are not running the
scheduled ones; with
`BACKUP_S3_*` set the worker already keeps hourly dumps, and
`node scripts/restore-backup.ts latest` brings the newest one back.

After updating to the release that adds plans and storage limits, run
**Admin > Usage & storage > Recount images** once if anyone uploaded images
while the update was rolling out, so each account's storage total includes
them. The same release builds new indexes on the image table and on the badge
columns of characters, places and lore entries (migrations 0110 and 0111) with
a plain `CREATE INDEX`, so writes to those tables wait while the indexes are
built; on a large database, update at a quiet time.

The nightly unused-image job (03:00 UTC) reads every table in the database,
one table at a time. On a large database a single table's read can take a
while (it is cut off after 2 hours 24 minutes), and while it runs Postgres
cannot clean out rows deleted since it began, so tables can grow a little
until the next vacuum. An update that changes the database cancels the job if
it is running, and the job runs again the next night.

If you used the bundled `minio` profile: it is now `rustfs`, with
`RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` in place of `MINIO_ROOT_USER` and
`MINIO_ROOT_PASSWORD`. RustFS starts with empty buckets in a new volume, so copy
your objects across before switching, or uploaded images will not load:

1. Pull the new version, set `COMPOSE_PROFILES=rustfs`, and start only the new
   bucket with `docker compose up -d rustfs rustfs-init`. The old MinIO
   container keeps running beside it.
2. Copy both buckets over the compose network (replace `codex_default` with
   your project's network, shown by `docker network ls`):

   ```
   docker run --rm --network codex_default \
     -e RCLONE_CONFIG_OLD_TYPE=s3 -e RCLONE_CONFIG_OLD_PROVIDER=Minio \
     -e RCLONE_CONFIG_OLD_ENDPOINT=http://minio:9000 \
     -e RCLONE_CONFIG_OLD_ACCESS_KEY_ID=codex-minio \
     -e RCLONE_CONFIG_OLD_SECRET_ACCESS_KEY=codex-minio-secret \
     -e RCLONE_CONFIG_NEW_TYPE=s3 -e RCLONE_CONFIG_NEW_PROVIDER=Other \
     -e RCLONE_CONFIG_NEW_ENDPOINT=http://rustfs:9000 \
     -e RCLONE_CONFIG_NEW_ACCESS_KEY_ID=codex-rustfs \
     -e RCLONE_CONFIG_NEW_SECRET_ACCESS_KEY=codex-rustfs-secret \
     rclone/rclone sync old:codex-assets new:codex-assets
   ```

   Run it again with `codex-backups` in place of `codex-assets`, and use your
   own credentials if you changed the defaults.

3. Point `ASSET_S3_ENDPOINT` and `BACKUP_S3_ENDPOINT` at `http://rustfs:9000`
   with the new keys, in `.env` or the admin panel, then run
   `docker compose up -d --remove-orphans` to stop MinIO.
4. Once images load, remove the old volume with
   `docker volume rm codex_minio-data`.

### Updating to 4.0.0: change the database image first

From 4.0.0, Codex needs the pgvector extension in its database. The bundled
`db` service now uses `pgvector/pgvector:0.8.7-pg18-trixie` instead of
`postgres:18.6-alpine3.24`. Change the database image before you start the new
version of the app, or the app and worker stop with a message saying pgvector
is missing (nothing is changed when that happens).

Before you start, check which locale the database was created with:

```bash
docker compose exec db psql -U codex -d codex -tAc "SELECT datcollate FROM pg_database WHERE datname = 'codex';"
```

The new image has only the `en_US.utf8`, `C` and `C.UTF-8` locales. If the
answer is anything else, the new image cannot open the database: build your
own image from `pgvector/pgvector:0.8.7-pg18-trixie` that adds that locale
(the image's documentation shows how, under "Locale Customization") and use
it in step 3 instead.

1. Stop Codex, including the database: `docker compose stop`.
2. Copy the database volume to a file, so you can go back. With the bundled
   compose file the volume is `codex_db-data` (`docker volume ls` lists it):

   ```bash
   docker run --rm -v codex_db-data:/data -v "$PWD":/backup postgres:18.6-alpine3.24 \
     tar -C /data -czf /backup/codex-db-before-4.0.tgz .
   ```

3. In your compose file, set the `db` service's image to
   `pgvector/pgvector:0.8.7-pg18-trixie` and, in the same edit, the Codex
   image tag to 4.0.0 or later. Keep the same volume; the data carries over.
   Do not run an older Codex against the new database image, even briefly:
   until 4.0.0 has rebuilt the indexes, it can write rows the indexes miss.
   If you build Codex from source, `git pull` (or checking out the 4.0.0
   tag) makes both changes, so do it only now, after step 2.
4. Run `docker compose pull` and then `docker compose up -d`. If you build
   Codex from source, run `docker compose up -d --build` instead.

The first start of the new database image takes over the data files, and the
first start of the new version rebuilds the database's indexes if the data
was created by the old image, because the new image sorts text slightly
differently. Both run once and take a while on a large database. Watch
`docker compose logs -f app` and wait for "Migrations applied." after
"Applying migrations."; do not restart the app meanwhile, as that starts the
rebuild over. If `docker compose up -d`
reports `db` or `app` as unhealthy meanwhile, run it again once they are done.

To go back to the earlier version, put the copy from step 2 back. Everything
written since the update is lost.

1. Stop Codex: `docker compose stop`.
2. Replace the volume's contents with the copy:

   ```bash
   docker run --rm -v codex_db-data:/data -v "$PWD":/backup postgres:18.6-alpine3.24 \
     sh -c 'find /data -mindepth 1 -delete && tar -C /data -xzpf /backup/codex-db-before-4.0.tgz'
   ```

3. Set the `db` image and the Codex image tag back to what they were, and run
   `docker compose up -d`. If you build Codex from source, check out the
   release you had before and run `docker compose up -d --build`.

Switching the image back without the copy leaves the indexes out of order.
Keep the `-trixie` tag of the database image pinned: a new Debian release can
change the sort order again, and Postgres does not warn about it for a
database first created by the old image. If you move to another Debian base,
stop the app and worker first, start only the new database, rebuild the
indexes, then bring the stack back:

```bash
docker compose stop app worker
docker compose up -d db
docker compose exec db psql -U codex -d codex -c 'REINDEX DATABASE codex;'
docker compose up -d
```

For a database first created by the new image, also run
`ALTER DATABASE codex REFRESH COLLATION VERSION;` the same way, so Postgres
stops warning about the change. A database first created by the old image
refuses that command; leave it out there.

If you run your own PostgreSQL 18 server, install pgvector on it (the
`postgresql-18-pgvector` package on Debian and Ubuntu) before updating. Only
a superuser can create the extension, so if the database user in
`DATABASE_URL` is not one, connect to the Codex database as a superuser and
run `CREATE EXTENSION vector;` first.

## Scaling and replicas

Run a single app replica and a single worker. Two pieces of state are
per-process today:

- **Rate limiting** is held in memory, so each app replica would keep its own
  counters and the limits would not hold across them.
- **The worker's scheduled jobs** (backups, purges, the reconcile sweep) would
  run once per worker instance, so more than one worker means duplicate runs.

Scale the app vertically (a bigger host) rather than horizontally for now. A
shared rate-limit store is a prerequisite for multiple app replicas and is not
in place yet.

## Troubleshooting

- **Form submissions rejected (403), sign-in or saving fails.** `ORIGIN` does
  not match the URL the browser uses. Set it to the exact public URL, scheme
  and port included.
- **Sign-in rate limit seems global, or locks everyone out.** A proxy is in
  front but `ADDRESS_HEADER` is unset or wrong, so every request shares the
  proxy's address. Set it (`x-forwarded-for` for most proxies) and `XFF_DEPTH`.
- **The app port does not answer from another machine.** It is published on
  `127.0.0.1` only. Point a proxy on the same host at it, or see
  `APP_BIND` under Reverse proxy and TLS.
- **An AI app cannot connect, or says the server cannot be reached.** The app
  connects from its vendor's servers, so the instance must answer on a public
  HTTPS address and `ORIGIN` must be that address. Open
  `<ORIGIN>/.well-known/oauth-protected-resource/api/mcp` from outside your
  network; it should return a small JSON document. A 404 there means connected
  apps are turned off in the admin panel.
- **No emails arrive.** SMTP is not configured; check the worker log for the
  message body, then set the `SMTP_*` variables or the admin Email relay
  section and send a test.
- **Image upload is missing from the UI.** Asset storage is not configured. Set
  the `ASSET_S3_*` variables or the admin Usage and storage section.
- **Two-factor or passkeys unavailable, or SMTP password will not save.**
  `APP_SECRET` is unset. Set a long random value and keep it stable.
- **A worker feature (email, backups, exports, mentions) does nothing.** The
  worker may be down. Check `docker compose ps` and the worker log.
- **The unused-image job fails with "could not resize shared memory
  segment".** Docker gives the Postgres container 64 MB of shared memory by
  default, too little for the job's large reads on a big database. The bundled
  `compose.yaml` sets `shm_size: 1g` on the `db` service; if you use your own
  compose file, add the same line there.

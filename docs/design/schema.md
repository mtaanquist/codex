# Codex - data model

A self-hosted, web-based writing tool. Markdown is the authoring syntax; content is stored in Postgres. This document captures the current data model decisions.

LLM integration (the Assistant, see `assistant.md`) shipped after v1 as Phase 9. The v1 schema reserved a few columns for it - `users.llm_config`, `stories.llm_config`, `lore_entries.activation_mode` - so it landed without migrating live data. Those columns are called out inline below.

## Hierarchy

```
universe
  |-- story (one or more)
  |     `-- chapter (organisational)
  |           `-- scene (atomic writing unit)
  `-- characters, places, lore entries
        (universe-scoped; surfaced per story by reference)
```

- **Universe**: owns shared worldbuilding. Every story belongs to one, even standalones (implicitly created on first story).
- **Story**: a novel, novella, short story, serial, etc. Form-agnostic.
- **Chapter**: an organisational container with a title and optional summary. Holds scenes.
- **Scene**: the atomic unit of writing. Owns the prose. Can be orphaned (no chapter) during drafting.

## Stack

- **Database**: Postgres
- **Content format**: Markdown in `text` columns (rendered on display/export)
- **Search**: `tsvector` for full-text, `pg_trgm` for fuzzy name matching
- **Vectors**: the `vector` extension (pgvector), required from v4.0.0 and created by migration 0131; the search index (`scene_chunks`, migration 0135) stores its vectors in it. It was required at v4.0.0 so the database image change, and the index rebuild that comes with it, happen once at a major version rather than in the release that first stores vectors
- **Case-insensitive handles**: `citext` for the public profile handle (requires the `citext` extension)
- **Squishy fields**: `jsonb` with GIN indexes where queried

---

## Core tables

### Users and access

```sql
users (
  id                  uuid primary key,
  email               text unique not null,
  display_name        text not null,
  handle              citext unique,        -- public profile slug ('@handle'); null until a public profile is claimed
  bio_md              text,                 -- short bio shown on the public profile shelf
  profile_public      boolean not null default false,  -- whether the '@handle' shelf is listed publicly
  public_archive_enabled boolean not null default false,  -- admin grants this before a user may publish public pages
  hidden_from_browse  boolean not null default false,  -- keeps all their stories and their name off Browse
  password_hash       text not null,
  role                text not null,        -- 'admin' | 'moderator' | 'user'
  llm_config          jsonb not null default '{}',  -- Assistant config; '{}' until configured
  preferences         jsonb not null default '{}',  -- theme, content width, autocomplete mode, entity underline toggle, library view, etc.
  plan_id             uuid references plans(id),    -- null falls back to the default plan; see Plans and entitlements
  storage_used_bytes  bigint not null default 0,    -- bytes of uploaded files (sum of the account's assets.byte_size); checked against storage_bytes
  created_at          timestamptz not null,
  email_verified_at   timestamptz,          -- null until the email-confirm link is clicked
  approved_at         timestamptz,          -- null until admin approves
  signup_note         text,                 -- the sign-up form's "What are you working on?", for the approval list
  last_login_at       timestamptz           -- updated on successful sign-in; useful for stale-account cleanup
)
```

Sign-in succeeds only when **both** `email_verified_at` and `approved_at` are non-null. The two gates exist for different reasons: email verification confirms the address is real and reachable; approval is the operator's call about who gets to use the instance. Either may be skipped in a self-hosted single-user setup by setting both columns on the admin row at seed time.

**Plans and entitlements.** What a user is allowed to do (quotas, access to a public archive, and so on) is expressed through a plan and its entitlements, modelled below. Every user is on a plan, and the default plan grants everything, which is the right setting for self-host. What is deliberately not here yet is billing: there is no payment processing and no subscription state. Assigning a plan is an admin action for now, and a future subscription layer can set `plan_id` without disturbing anything else. The `storage_used_bytes` counter holds the bytes of the account's uploaded files and is kept in step with every asset insert and delete (see Plans and entitlements).

### Sessions and credentials

Authentication is session-cookie based, with the session row stored server-side so it can be listed and revoked. A daily worker job deletes sessions once they expire, and revoked ones 30 days after revocation. Email verification and password reset use single-use tokens, stored only as hashes. Two extra factors are modelled from the start: time-based one-time passwords (TOTP) and passkeys (WebAuthn).

```sql
sessions (
  id            uuid primary key,        -- opaque id; the cookie carries this (or a hash of it)
  user_id       uuid references users(id) not null,
  created_at    timestamptz not null,
  last_seen_at  timestamptz not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,             -- set on sign-out or 'log out everywhere'
  user_agent    text,
  ip            inet
)

auth_tokens (
  id            uuid primary key,
  user_id       uuid references users(id) not null,
  kind          text not null,           -- 'email_verify' | 'password_reset'
  token_hash    text not null,           -- only the hash is stored; the row is reserved with a throwaway hash and armed with the emailed token by the worker at send time
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null
)

user_totp (
  user_id       uuid primary key references users(id),
  secret        text not null,           -- encrypted at rest
  confirmed_at  timestamptz,             -- null until the first code is verified
  created_at    timestamptz not null
)

webauthn_credentials (
  id            uuid primary key,
  user_id       uuid references users(id) not null,
  credential_id text unique not null,    -- base64url of the raw credential id
  public_key    text not null,
  sign_count    bigint not null default 0,
  transports    text[],
  name          text,                    -- user label, e.g. 'phone' or 'security key'
  created_at    timestamptz not null,
  last_used_at  timestamptz
)
```

Outside apps connect through OAuth (see Access for outside apps in `design.md`). `users.mcp_enabled` (default false) is the account switch. Codes and tokens are stored only as hashes; permissions live on the grant, so a change to a grant applies to tokens already issued.

```sql
oauth_clients (
  id            uuid primary key,
  client_id     text unique not null,    -- a generated id (self-registered) or the https URL of the client's metadata document
  kind          text not null,           -- 'dcr' | 'cimd' | 'personal' (stands for one personal access token; client_name is the token's name)
  client_name   text not null,           -- what the app calls itself
  host          text not null,           -- what was checked: the host of the client_id URL, or of the first redirect address
  redirect_uris text[] not null,         -- https, or http on this computer only
  created_at    timestamptz not null,
  fetched_at    timestamptz              -- cimd: when the document was last read (re-read after a day)
)

oauth_grants (
  id            uuid primary key,
  user_id       uuid references users(id) on delete cascade not null,
  client_id     uuid references oauth_clients(id) on delete cascade not null,
  permissions   text[] not null,         -- 'read' | 'suggest' | 'apply'
  redirect_host text,                    -- self-registered clients: the host the last code was sent to; null means the client's host stands
  created_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz              -- one live grant per (user, client): unique where revoked_at is null
)

oauth_codes (
  id             uuid primary key,
  code_hash      text unique not null,
  user_id        uuid references users(id) on delete cascade not null,
  client_id      uuid references oauth_clients(id) on delete cascade not null,
  permissions    text[] not null,
  redirect_uri   text not null,
  code_challenge text not null,          -- PKCE, S256
  expires_at     timestamptz not null,   -- one minute
  used_at        timestamptz,            -- single use; a second use revokes family_id
  family_id      uuid,                   -- the token family the code was exchanged for
  created_at     timestamptz not null
)

api_tokens (
  id            uuid primary key,
  user_id       uuid references users(id) on delete cascade not null,
  grant_id      uuid references oauth_grants(id) on delete cascade,
  kind          text not null,           -- 'access' (1 hour) | 'refresh' (30 days, replaced on each use) | 'personal' (30, 90 or 365 days, no refresh)
  token_hash    text unique not null,
  family_id     uuid not null,           -- every token descended from one code exchange
  expires_at    timestamptz not null,
  used_at       timestamptz,             -- refresh: set when it is exchanged; using it again revokes the family
  revoked_at    timestamptz,
  created_at    timestamptz not null
)
```

The daily session clean-up also deletes expired tokens, spent codes, clients that no writer connected within 24 hours of registering, and clients whose grants have all been revoked for 30 days. Deleting a client deletes its grants.

A personal access token is one `api_tokens` row of kind `personal` under a grant of its own, on an `oauth_clients` row of kind `personal` that carries the name the writer gave it (`client_id` is `personal:<uuid>`, `host` is the fixed text `personal token`, no redirect addresses). That makes it a connection like any other: the grant holds its permissions and last-used time, revoking the grant ends it, and notes left with it are attributed and counted by client the way an app's are. The OAuth routes never resolve a `personal` client. When the token row expires and is cleaned up, the clean-up revokes its grant.

### Plans and entitlements

A plan is a named bundle of entitlements. Entitlements are key/value rows, so a new limit or capability can be added without a schema change. Migration 0107 created both tables and seeds a single default plan (key `default`) with no entitlement rows, which grants everything; an admin can add more plans and pick the default. A partial unique index keeps one default at a time.

```sql
plans (
  id            uuid primary key,
  key           text unique not null,    -- 'default', 'free', 'supporter', ...
  name          text not null,
  description   text,
  is_default    boolean not null default false,  -- assigned to new users when none is set
  sort_order    int not null default 0,
  created_at    timestamptz not null
)

entitlements (
  id            uuid primary key,
  plan_id       uuid references plans(id) not null,
  key           text not null,           -- 'max_universes', 'max_stories', 'storage_bytes', 'max_image_bytes', 'public_archive', ...
  value         jsonb not null,          -- a number, a boolean, or null for unlimited
  created_at    timestamptz not null,
  unique (plan_id, key)
)
```

Four keys are enforced (`quotas.ts`, the keys in `src/lib/quota.ts`); any other key is stored and ignored, and a missing row or a null value means no limit:

- `max_universes` and `max_stories` count live rows only: a universe or story in the trash does not count, and a story counts only while its universe is live. The standalone-stories universe never counts as a universe. Every create path checks inside its own transaction under a per-account advisory lock (taken only when a limit applies), so creates at once cannot both take the last place: the library and plan-board creates, a story from a saved draft, and a story import (also checked before its images are stored, and named on the preview; the import writes everything first and takes the lock only at the end of its transaction, with the story row already in, so other creates do not wait out the import). Restoring from the trash is checked like a create; restoring a universe counts the live stories it brings back, and restoring a story locks its universe row shared first (after the account row), so a universe going to the trash at the same time is waited for rather than counted live.
- `storage_bytes` is checked against `users.storage_used_bytes`, the bytes of uploaded files (images, covers, avatars, badges; text and generated export files do not count). `createAsset` checks once before storing the file, then, in the same transaction as the asset row, locks the account row, reads its use and the plan's limit under that lock, and adds the bytes only if they fit (`reserveStorage`), so two uploads at once take turns and cannot both pass; deleting an asset and the unused-image sweep take their bytes back off. Purging a universe deletes none of its images: it sets their `universe_id` to null and `unreferenced_since` to now (over any earlier mark, which may be stale, so the full 30 days always follow the purge), with no reference read under its locks, and the sweep frees each once due. The purge finds them through the partial index on `assets.universe_id` (migration 0111); `assets.owner_id` is indexed too, for the recount and account deletion. Replacing or clearing a cover, avatar or badge deletes nothing: the old image waits for the sweep and counts until then. The upload that replaces one passes a slot (the row and column the image goes into: `users.avatar_asset_id`, `stories.cover_asset_id`, or an entity's `badge_asset_id`) to `createAsset`, which locks the account row and then that row, reads the image the column holds, takes that image's bytes off in the check (not the counter), and points the column at the new image, all in the transaction that inserts the asset row. So a writer at the limit can swap and `storage_used_bytes` reads above the limit until the sweep frees the old one; two swaps at once take turns, each counting the image it actually replaces, so the overage is bounded by one image. Removing an image and then uploading another counts nothing as freed. A trashed universe's or story's images count until the purge. The sweep (`sweepUnusedAssets` in `unused-assets.ts`, worker queue `sweep-unused-assets`, nightly over every account and queued by nothing else; its long reads go a table at a time, each in its own read-only transaction, so no snapshot is held for the whole scan, with `statement_timeout` raised to the job's six-hour expiry divided by 2.5 (2 h 24 min per table), since the worker pool caps a statement at five minutes; a failed run is not retried (`retryLimit` 0), the next night's starts over, and its `assets.unused_sweep_failed` log line says how many images and bytes it freed before failing) reads every column that could hold an asset id once (every uuid column, and the text of every other non-numeric column, found through `pg_catalog`). It deletes in two phases: an image whose id appears nowhere but its own row gets `assets.unreferenced_since` set (migration 0109), one found in use again gets it cleared, any committed insert or update that stores its id clears it too (the `clear_asset_marks` row trigger on every table but `assets`, migration 0112: it reads the new row whole as text, the way the sweep reads columns, and nulls the mark by primary key, a no-op for unmarked images; a table created later needs its own `CREATE TRIGGER` in its migration, the sweep deletes nothing while any table lacks it, and `unused-assets.test.ts` fails; the one gap left is a write committed while a run's full read is going, before that run marks, which neither sees, so if the id is taken out again before the next run the 30 days count from that mark, at most a day after the last use; reading the tables one after another can also miss a reference that moves between two tables mid-scan, but the write that moved it cleared any mark, so such an image is at worst marked by that run and cleared by the next), and only an image marked for 30 days and uploaded more than 30 days ago is deleted. Before deleting, it reads every one of those columns again once for all the due ids, outside any lock, then, a chunk of 100 per transaction, takes the account and asset row locks (skipping held ones) only to check the rows are still there and still marked long enough, and deletes them in the transaction that gives the bytes back. Their objects are queued in `pending_object_deletions` 30 days later than usual, so a wrongly freed image can be put back by hand from the logged row (`assets.unused_deleted`, written as each chunk commits; it leaves out the original filename, which any name can stand in for). Every queued object carries the account it belonged to (`pending_object_deletions.owner_id`, nullable, no foreign key, migration 0113; null on rows queued before it), and `purgeAccount` deletes that account's queue rows in its transaction and removes their objects with its other keys after the commit, so a deleted account's freed files do not wait out the delay. The badge columns of `characters`, `places` and `lore_entries` have partial indexes on the non-null values (migration 0110) for the foreign-key check on each delete. A chunk whose delete hits a foreign key (a badge or publish saved after the second read) is rolled back and its images are tried again one per transaction: the ones nothing points at go, and one a foreign key still refuses is kept, its mark cleared, and a warning (`assets.unused_delete_skipped`) logged. Each read names itself for the migrator (`application_name`) and holds the advisory lock `codex:unused-asset-sweep` shared; before applying migrations, the migrator cancels the running reads and takes that lock for its session, so no read starts again until the migrations are done (a run that finds it taken fails). A publish whose link to an image fails its foreign key (the image deleted at that moment) is refused with a message asking the writer to publish again. Accepted limit: any row naming an image's id keeps it, whoever wrote that row, so another user who pastes `/assets/<id>` into their own prose keeps the owner's image counted against the owner's storage. The check is not narrowed by owner, since a narrower check could delete an image someone still shows. Migration 0107 backfilled the counter from the asset rows, and the admin Usage page can recount it, 200 accounts per request with the page posting the next batch until all are done (`recountStorageBatch` in `plans.ts`, each account through `recountStorageUsed`).
- `max_image_bytes` is the largest single upload the plan allows. `MAX_IMAGE_BYTES` (10 MB, in `src/lib/quota.ts`) is the ceiling for every plan: a plan can only set a lower value, and a missing row or a higher value means the ceiling. `createAsset` checks it before the file is stored, so every upload path (inline images, covers, avatars, badges, and the images in a story import) is held to it; an image over it is refused as `over_limit` (403) with a message naming the limit. A story import's preview lists the images it will skip for it. Admin > Plans takes it in MB to one decimal place, from 0.1 to the ceiling; the form also posts the stored byte value, and a field left as shown keeps that value exactly rather than the rounded one.

`public_archive` is not wired: publishing stays gated by the per-account `users.public_archive_enabled` switch. Billing is not part of this.

### Universe and story

```sql
universes (
  id              uuid primary key,
  owner_id        uuid references users(id) not null,
  name            text not null,
  description_md  text,
  fandom_id       uuid references tags on delete set null, -- a fandom from the curated list; its stories carry it
  deleted_at      timestamptz,      -- set while in the trash; null means live
  created_at      timestamptz not null,
  updated_at      timestamptz not null
)

stories (
  id                  uuid primary key,
  universe_id         uuid references universes(id) not null,
  owner_id            uuid references users(id) not null,
  title               text not null,
  author              text,
  brief               text,
  description_md      text,
  position_in_series  int,              -- null if standalone or unordered
  visibility          text not null default 'private',  -- 'private' | 'unlisted' | 'public'
  is_adult            boolean not null default false,   -- author-flagged adult content; readers avoid it by default
  listed_in_browse    boolean not null default false,   -- the author's choice to show it on Browse; cleared when it leaves public
  browse_blocked_at   timestamptz,                      -- a moderator removed it from Browse; the author cannot list it again until cleared
  browse_blocked_reason text,                           -- a report reason key (#lib/report-reasons)
  browse_blocked_by   uuid references users on delete set null,
  browse_allowed_at   timestamptz,                      -- the last time a moderator allowed it back into Browse; kept when it is removed again
  browse_allowed_by   uuid references users on delete set null,
  cover_asset_id      uuid references assets(id),       -- null renders a default cover from title and author
  cover_color         text,                             -- palette token tinting the default cover; random on insert, null on rows from before it
  llm_config          jsonb not null default '{}',  -- Assistant config; '{}' until configured
  deleted_at          timestamptz,      -- set while in the trash; null means live
  created_at          timestamptz not null,
  updated_at          timestamptz not null
)
```

**Universe and story trash.** Deleting a universe or a story only stamps its `deleted_at`. Every listing and by-id lookup treats a trashed row, and everything under it, as gone: the library, search, the Assistant, exports, and review links. A trashed story's published edition also leaves the public page; a trashed universe's editions stay up, frozen, until the purge. The library lists trashed universes and stories (a story only while its universe is live) with Restore and Delete forever. After 30 days the worker purges the row for good with the same hard delete that "Delete forever" runs; purging a universe takes all its stories, trashed or not. Only live rows reserve a slug (the owner-slug unique indexes are partial on `deleted_at is null`), so a trashed universe's or story's name and URL can be reused at once. A restore that finds its slug taken by a live row comes back under a fresh one, as on a rename; ids keep working either way. A live story inside a trashed universe still holds its slug until the universe is restored or purged (#827).

`llm_config` on both `users` and `stories` holds the **Assistant's configuration** (`src/lib/server/llm/config.ts`). The per-user column holds the endpoint, the encrypted key, the master switch, budget, and model-per-role mappings, plus the writer's embeddings model under an `embeddings` key (`src/lib/server/llm/embeddings/config.ts`); the per-story column holds overrides merged at request time, which can only subtract (mute, or pick a different model). Both stay `{}` until the writer configures the Assistant. They were reserved on the tables in v1 so the feature landed without migrating live data.

### Chapters and scenes

```sql
chapters (
  id            uuid primary key,
  story_id      uuid references stories(id) not null,
  position      int not null,
  title         text,
  role          text,                              -- front or back matter: 'dedication' | 'foreword' | 'prologue' | 'epilogue' | 'afterword' | 'acknowledgements' | 'authors_note'; null for a regular chapter
  summary_md    text,
  summary_generated_at timestamptz,                -- set when the Assistant wrote summary_md; null for the writer's own
  summary_input text,                               -- fingerprint of the request the Assistant wrote it from
  metadata      jsonb not null default '{}',
  updated_at    timestamptz not null
)

scenes (
  id                    uuid primary key,
  story_id              uuid references stories(id) not null,
  chapter_id            uuid references chapters(id),   -- nullable: orphan scenes allowed
  position_in_chapter   int,                             -- null when orphan
  global_position       int not null,                    -- order across all scenes in story; drives continuous scroll view
  title                 text,
  body_md               text not null default '',
  pov_character_id      uuid references characters(id),
  location_id           uuid references places(id),
  story_time            text,                            -- freeform: "Day 3 afternoon"
  characters_present    uuid[],                          -- references characters.id, GIN indexed
  status                text not null,                   -- 'outline' | 'draft' | 'revised' | 'final'
  summary_md            text,                            -- one-line what happens; shown in sidebar
  word_count            int not null default 0,          -- updated on save
  metadata              jsonb not null default '{}',
  updated_at            timestamptz not null
)
```

Key points:

- `body_md` lives on scenes, not chapters. Chapters are organisational only.
- `role` marks a chapter as front or back matter (#849). Only chapters with no role are numbered ("Chapter 3" is the third regular chapter); an untitled role chapter shows its role name (`chapter-role.ts`). A role never moves a chapter: the writer's order stands. It rides `chapter.md` (`role:`), saved drafts and published editions, where an edition from before roles simply has none.
- `chapter_id` is nullable to support drafting scenes before they have a chapter home.
- `global_position` enables chronological views, continuous-scroll (Scrivenings-style) rendering, and reordering across chapter boundaries.
- `characters_present` is a UUID array rather than a join table. Cheap, GIN-indexed, easy to query.

---

## Worldbuilding entities

Characters, places, and lore entries belong to the universe, not to a story. Identity lives in exactly one place. A story does not own its own copies; it surfaces the universe entities relevant to it, which is answered by declared membership and by mentions (see below). Per-story differences are layered on through the overlay notes, not by forking the entity. Because every entity is universe-level, a relationship can link any two of them, and a story view simply filters which entities and relationships it shows.

### Characters and places (first-class)

Characters and places are first-class tables with their own distinct fields. They are not foldable into the user-defined entity category system, because characters have aliases (used for mention detection and POV assignment) and places have location references, neither of which fits the generic lore shape.

```sql
characters (
  id                      uuid primary key,
  universe_id             uuid references universes(id) not null,
  owner_id                uuid references users(id) not null,
  name                    text not null,
  aliases                 text[] not null default '{}',  -- nicknames, variants; used for mention detection
  summary_md              text,                          -- one or two lines; shown in hover popovers
  body_md                 text not null default '',
  auto_detect_mentions    boolean not null default true, -- set false for common-word names ("Will", "Art")
  metadata                jsonb not null default '{}',
  arc_summary_md          text,                          -- the Assistant's arc across the stories; never the writer's
  arc_summary_at          timestamptz,                   -- when it was written
  arc_summary_input       text,                          -- fingerprint of the request it was written from
  arc_summary_stories     uuid[],                        -- the stories it read; plain ids, so a deleted one is found missing
  imported_from           jsonb,                         -- reserved jsonb; unused (SillyTavern/lorebook import dropped from the roadmap)
  created_at              timestamptz not null,
  updated_at              timestamptz not null
)

places (
  id                      uuid primary key,
  universe_id             uuid references universes(id) not null,
  owner_id                uuid references users(id) not null,
  name                    text not null,
  summary_md              text,
  body_md                 text not null default '',
  auto_detect_mentions    boolean not null default true,
  metadata                jsonb not null default '{}',
  created_at              timestamptz not null,
  updated_at              timestamptz not null
)
```

### User-defined entity categories

Everything that isn't a character or place is a lore entry, but the category it belongs to is user-defined. New universes are seeded with a single "Lore" category; users can rename it, delete it, and add as many more as they need ("Magical spells", "Technologies", "Factions", "Ships", etc).

```sql
entity_categories (
  id            uuid primary key,
  universe_id   uuid references universes(id) not null,
  owner_id      uuid references users(id) not null,
  name          text not null,        -- "Lore", "Magical spells", "Technologies" etc
  color         text,                 -- hex or token; used for sidebar dots and mention underlines
  sort_order    int not null,
  created_at    timestamptz not null
)

lore_entries (
  id                      uuid primary key,
  universe_id             uuid references universes(id) not null,
  owner_id                uuid references users(id) not null,
  category_id             uuid references entity_categories(id) not null,
  title                   text not null,
  summary_md              text,
  body_md                 text not null default '',
  keywords                text[] not null default '{}',  -- in-editor search, mention detection, and (eventually) LLM context injection
  activation_mode         text not null default 'keyword',  -- 'always' | 'keyword' | 'manual'
  auto_detect_mentions    boolean not null default true,
  metadata                jsonb not null default '{}',
  created_at              timestamptz not null,
  updated_at              timestamptz not null
)
```

`keywords` earns its keep in v1: it powers in-editor search/filtering of lore and feeds the mention-detection pass on save. `activation_mode` drives the **Assistant's lore injection** (`src/lib/server/llm/context/sources.ts`), mirroring SillyTavern's lorebook semantics: `keyword` entries are injected into the Assistant's context only when a keyword appears in the text in scope; `always` entries are always injected; `manual` entries are never injected automatically. It was reserved in v1, and defaulting to `keyword` meant existing rows behaved reasonably when the feature landed.

### Per-story context for universe entities

Characters, places, and lore entries evolve between stories. The core record is canonical; per-story notes layer on top.

```sql
character_story_notes (
  id              uuid primary key,
  character_id    uuid references characters(id) not null,
  story_id        uuid references stories(id) not null,
  notes_md        text not null default '',
  metadata        jsonb not null default '{}',
  updated_at      timestamptz not null,
  unique (character_id, story_id)
)

place_story_notes (
  id              uuid primary key,
  place_id        uuid references places(id) not null,
  story_id        uuid references stories(id) not null,
  notes_md        text not null default '',
  metadata        jsonb not null default '{}',
  updated_at      timestamptz not null,
  unique (place_id, story_id)
)

lore_story_notes (
  id              uuid primary key,
  lore_entry_id   uuid references lore_entries(id) not null,
  story_id        uuid references stories(id) not null,
  notes_md        text not null default '',
  metadata        jsonb not null default '{}',
  updated_at      timestamptz not null,
  unique (lore_entry_id, story_id)
)
```

Identity is universe-scoped; context is story-scoped. The entity editor merges base and story-specific notes into one view.

### Declared story membership

Mention detection in scenes drives most "appears in story N" inference automatically. Users can also declare membership manually before any scenes are written.

```sql
character_story_memberships (
  character_id    uuid references characters(id) not null,
  story_id        uuid references stories(id) not null,
  declared_at     timestamptz not null,
  primary key (character_id, story_id)
)

place_story_memberships (
  place_id        uuid references places(id) not null,
  story_id        uuid references stories(id) not null,
  declared_at     timestamptz not null,
  primary key (place_id, story_id)
)
```

Membership is the explicit "this universe entity belongs to this story" signal; mentions are the derived one. The app writes a membership row when you create an entity while working in a story, or when you add an existing universe entity to a story, and you can remove one. "Does character X appear in story Y?" is answered by declared membership OR presence in `entity_mentions` for a scene in Y. The story-level Plan view is exactly this set: the universe entities that are members of, or mentioned in, the story.

---

## Entity relationships

Explicit, user-declared relations between entities - character-to-character (parent, sibling, rival, ally, mentor, serves), character-to-place (born in, raised in, lives in, rules, exiled from), and place-to-place (part of). Distinct from `entity_mentions`, which are implicit co-occurrences derived from prose. Relationships are data the user enters; mentions are data the system discovers.

```sql
relation_types (
  id                uuid primary key,
  universe_id       uuid references universes(id),   -- null for built-ins, set for user-added
  key               text not null,                   -- 'parent_of', 'lives_in', etc.
  forward_label     text not null,                   -- "parent of"
  reverse_label     text,                            -- "child of" (null when bidirectional)
  bidirectional     boolean not null default false,  -- true for sibling, friend, rival, etc.
  from_type         text not null,                   -- 'character' | 'place' | 'lore_entry'
  to_type           text not null,
  category          text,                            -- 'family' | 'social' | 'geography' (for UI grouping)
  sort_order        int,
  created_at        timestamptz not null,
  unique (universe_id, key)
)

entity_relationships (
  id              uuid primary key,
  universe_id     uuid references universes(id) not null,
  owner_id        uuid references users(id) not null,
  from_type       text not null,
  from_id         uuid not null,
  to_type         text not null,
  to_id           uuid not null,
  relation_type   uuid references relation_types(id) not null,
  story_id        uuid references stories(id),   -- null = universe-wide
  notes_md        text,
  created_at      timestamptz not null,
  updated_at      timestamptz not null
)

-- indexes on (from_type, from_id), (to_type, to_id), and (universe_id, story_id) for scope queries
```

Key points:

- **Direction.** Directional relations store one row; the UI renders the inverse on the target entity's page using the `reverse_label`. Symmetric relations (sibling, friend, rival) have `bidirectional = true`, store one row, and render with the same `forward_label` on both ends.
- **Built-in vs custom.** A seed migration populates `relation_types` with `universe_id = null` for a standard library (parent_of, sibling_of, spouse_of, friend_of, rival_of, enemy_of, ally_of, mentor_of, serves, born_in, raised_in, lives_in, rules, exiled_from, part_of). Universes can add their own with `universe_id` set - "apprentice of," "sworn sword of," "forged by," whatever the universe needs. This mirrors how entity categories work.
- **Story scope.** The `story_id` column lets a relationship be scoped to a specific book - "Alice and Bram are reconciled" in book two even though they're rivals at the universe level. Story-scoped rows supersede universe-wide rows where both exist, on the story's pages; the universe's page always shows the universe-wide truth.
- **No end-dating yet.** Relationships are either true (row exists) or not (row doesn't). Temporal relationships ("Alice and Bram were rivals until year 1472") can be handled via the notes field in v1, and potentially promoted to first-class time bounds later.

The UI never lets users enter free-form relation labels. The relation type itself is always picked from the defined set (built-in or custom); free-form context goes in the `notes_md` field. This preserves the ability to filter, graph, and inverse-render.

---

## Outline (retired)

Retired in v2.26.0 (migration 0039 drops `outline_nodes` and its revisions). Scene status and the Notes view cover planning now. The schema below is kept as a record of the original design.

Tree structure, independent of chapter/scene organisation. The outline can precede or diverge from the drafted structure.

```sql
outline_nodes (
  id                  uuid primary key,
  story_id            uuid references stories(id) not null,
  parent_id           uuid references outline_nodes(id),
  position            int not null,
  title               text not null,
  body_md             text,
  linked_scene_id     uuid references scenes(id),
  linked_chapter_id   uuid references chapters(id),
  metadata            jsonb not null default '{}',
  updated_at          timestamptz not null
)
```

---

## Notes

Freeform writer notes, scoped by whichever foreign key is populated. A note with only `universe_id` set is universe-wide; one with `story_id` set is story-specific; one with `scene_id` set is attached to that scene. All four foreign keys are nullable - the populated ones define the scope.

```sql
notes (
  id            uuid primary key,
  owner_id      uuid references users(id) not null,
  universe_id   uuid references universes(id),
  story_id      uuid references stories(id),
  chapter_id    uuid references chapters(id),
  scene_id      uuid references scenes(id),
  title         text,
  body_md       text not null default '',
  pinned        boolean not null default false,
  created_at    timestamptz not null,
  updated_at    timestamptz not null
)
```

The Notes sidebar tab filters by current context (e.g. showing scene-level and story-level notes when a scene is open) with an option to broaden the view to universe-wide.

These are distinct from the review comments below. Notes are writer-facing and freeform; review comments are reviewer-facing, position-anchored, threaded, and resolvable.

---

## TODO markers

A writer can flag a spot to return to, either by selecting text and marking it or by writing a line that begins `TODO:`. Markers show inline in the editor and collect in a per-story list. The plain-text form survives export because it is just text; the structured row below adds the checkable state and the highlight.

```sql
scene_markers (
  id            uuid primary key,
  scene_id      uuid references scenes(id) not null,
  owner_id      uuid references users(id) not null,
  kind          text not null default 'todo',  -- 'todo' | 'note' | 'flag'
  anchor_start  int,
  anchor_end    int,
  body_md       text,                          -- optional note on the marker
  resolved_at   timestamptz,
  created_at    timestamptz not null,
  updated_at    timestamptz not null
)
```

---

## Review and collaboration

An author can invite a guest to review a single story. The guest may already be a Codex user or not; either way they are not forced to create an account. Access is by magic link, scoped to that one story, comment and suggest only, never the rest of the owner's data. Review is async, in the spirit of tracked changes and threaded comments in a word processor. Shipped in Phase 6: comments first (v2.8.0), then suggested edits (v2.9.0).

```sql
review_invitations (
  id            uuid primary key,
  story_id      uuid references stories(id) not null,
  created_by    uuid references users(id) not null,   -- the author
  token_hash    text not null,             -- the magic link; only the hash is stored
  email         text,                      -- optional, who it was sent to
  can_suggest   boolean not null default true,  -- false = comments only
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null
)

reviewers (
  id             uuid primary key,
  invitation_id  uuid references review_invitations(id) not null,
  user_id        uuid references users(id),  -- set if the guest is a signed-in user; null for a non-user guest
  display_name   text not null,              -- captured for non-users
  email          text,
  created_at     timestamptz not null,
  last_seen_at   timestamptz
)

review_threads (
  id                  uuid primary key,
  story_id            uuid references stories(id) not null,
  scene_id            uuid references scenes(id) not null,
  anchor_start        int,                   -- character range in body_md; null for a whole-scene comment
  anchor_end          int,
  base_revision_id    uuid references revisions(id),  -- the text the anchor was placed against
  resolved_at         timestamptz,
  resolved_by_user_id uuid references users(id),
  created_at          timestamptz not null
)

review_comments (
  id                 uuid primary key,
  thread_id          uuid references review_threads(id) not null,
  author_user_id     uuid references users(id),      -- the owner, or a signed-in commenter
  author_reviewer_id uuid references reviewers(id),  -- an invited reviewer
  body_md            text not null,
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  client_id          uuid references oauth_clients(id) on delete set null,  -- an outside app as author (#1175)
  client_name        text,                   -- the app's name, copied when the note was staged
  client_host        text                    -- its checked host, copied too; set means "an app wrote this"
  -- one author: author_user_id, author_reviewer_id, the Assistant (the assistant flag), or an app (client_host)
)

review_suggestions (
  id                 uuid primary key,
  story_id           uuid references stories(id) not null,
  scene_id           uuid references scenes(id) not null,
  reviewer_id        uuid references reviewers(id) not null,
  base_revision_id   uuid references revisions(id) not null,  -- the text the suggestion was made against
  range_start        int not null,
  range_end          int not null,           -- == range_start for a pure insertion
  replacement        text not null default '', -- '' for a pure deletion
  status             text not null default 'pending',  -- 'pending' | 'accepted' | 'rejected'
  pattern_thread_id  uuid references review_threads(id) on delete set null,  -- the Assistant pattern note this edit fixes
  decided_by_user_id uuid references users(id),
  decided_at         timestamptz,
  revised_at         timestamptz,            -- when its author last revised the replacement; an app revises once per writer reply
  created_at         timestamptz not null,
  client_id          uuid references oauth_clients(id) on delete set null,  -- as on review_comments
  client_name        text,
  client_host        text
)
```

Key points:

- **Notes from an outside app.** An app the owner connected stages comments and suggestions under its own name, not the Assistant's. The name and host are copied onto the row, so the note still says who left it after the client row is pruned (which only sets `client_id` null). `client_id` is what the app's own rules key on: a repeat of its own note is dropped, it revises only its own pending suggestion, and its waiting notes per scene are counted against a ceiling.

- **No direct guest writes.** A reviewer never edits `body_md`. Their changes are `review_suggestions` the author accepts or rejects one at a time, which is what makes them attributable and reversible.
- **Attribution across users and guests.** Every comment and suggestion points at the person who made it (a `reviewers` row, or a user for the owner), so the author can always see which edits came from whom.
- **Async anchoring.** Comments and suggestions are pinned to a `base_revision_id`. When the author opens the review, anything whose offsets no longer fit the current text is re-anchored by diffing the base against the current revision, and anything that cannot be placed is flagged rather than applied. This works because no two people edit at the same time.
- **Guests are personal data.** Reviewer rows and their contributions fall under the cascade and erasure rules; revoking an invitation or deleting the story removes them.

This supersedes the single-row annotation placeholder that earlier drafts reserved for a reviewer role.

### Proposals from the Assistant and connected apps

Two things a program may propose that are not notes on a scene. Both wait in the universe's settings under Suggestions until the owner decides (`src/lib/server/proposals.ts`).

```sql
entity_proposals (
  id             uuid primary key,
  owner_id       uuid not null references users(id) on delete cascade,
  universe_id    uuid not null references universes(id) on delete cascade,
  kind           text not null,             -- 'character' | 'place' | 'lore'
  name           text not null,
  description_md text,                      -- becomes the entry's summary on accept
  seen_in        text,                      -- where in the text, in the suggester's words
  assistant      boolean not null default false,
  client_id      uuid references oauth_clients(id) on delete set null,
  from_name      text,                      -- the app's label, copied when staged
  status         text not null default 'pending',  -- 'pending' | 'accepted' | 'dismissed'
  entity_id      uuid,                      -- the entry an accept created
  decided_at     timestamptz,
  created_at     timestamptz not null
)

scene_split_proposals (
  id          uuid primary key,
  owner_id    uuid not null references users(id) on delete cascade,
  story_id    uuid not null references stories(id) on delete cascade,
  scene_id    uuid not null references scenes(id) on delete cascade,
  before      text not null,                -- the exact words the new scene would open with
  rationale   text not null default '',
  client_id   uuid references oauth_clients(id) on delete set null,
  from_name   text,
  status      text not null default 'pending',  -- 'pending' | 'confirmed' | 'dismissed'
  decided_at  timestamptz,
  created_at  timestamptz not null
)
```

Partial unique indexes hold the rules that two calls sent together could otherwise both pass (migration 0100): one pending `entity_proposals` row for `(universe_id, lower(name))`, and one pending `scene_split_proposals` row for `(scene_id, client_id, md5(before))`; the passage is hashed because it can be longer than an index entry. `review_suggestions` has the same for an app's follow-ups: one row for `(follows_suggestion_id, client_id)` where both are set. Both proposal tables are indexed on `client_id`, and `scene_split_proposals` on `scene_id`, for the foreign-key checks on delete.

Key points:

- **Nothing is created by staging.** An accepted entity proposal inserts the character, place or lore entry the way the app does for the owner; a confirmed split runs the normal scene split after locating `before` in the story as it then stands.
- **A dismissed entity name stays dismissed.** Dismissed rows are kept so the same name is not suggested again in that universe.
- **Only apps store split proposals.** The in-app Assistant's split proposal is a card in its chat and has no row.

---

## Revisions (version history)

One polymorphic table covers history for every entity type with editable prose. Powers the VS Code-style timeline view.

```sql
revisions (
  id            uuid primary key,
  entity_type   text not null,   -- 'scene' | 'character' | 'place' | 'lore_entry' | 'chapter' | 'note'
  entity_id     uuid not null,
  body_md       text not null,
  word_count    integer,         -- of body_md, stored at write time; null on old rows
  reason        text,            -- 'autosave' | 'checkpoint' | 'restore' | 'suggestion'
  created_at    timestamptz not null
)

-- index on (entity_type, entity_id, created_at desc) for timeline queries
```

Inserted on debounced save; autosaves within two minutes coalesce into one row. `word_count` lets Insights read a day's words without re-counting bodies. Later optimisation: snapshot every N revisions, store diffs between snapshots. Don't bother until the table grows large.

---

## Saved drafts

A saved draft is a private, named copy of a whole story at one moment (see `design.md`, Saved drafts). It is a self-contained snapshot, not a pointer into `revisions`, so it survives anything that later happens to the live rows or their history.

```sql
story_drafts (
  id          uuid primary key,
  story_id    uuid references stories(id) not null,
  owner_id    uuid references users(id) not null,
  label       text not null,        -- the writer's name for it, e.g. 'First draft'
  note_md     text,                 -- optional note
  content     jsonb not null,       -- the frozen story; shape in src/lib/drafts.ts
  word_count  integer not null,
  created_at  timestamptz not null
)

-- index on (story_id, created_at desc)
```

- **Content.** The story's title, pen name, description and cover; chapters and scenes (text, summary, status, story time); the story's notes; and the universe's characters, places, and lore with aliases or keywords, category name, details, this story's notes on them, and whether they were declared in the story, plus the universe's relationships and this story's own. Ids are the live ids at save time, used to compare and restore a scene and to tie notes and relationships together inside the draft; none of them is a foreign key.
- **Immutable.** Only `label` and `note_md` change after insert. Saving reads everything in one repeatable-read transaction.
- **Lifecycle.** Deleted with the story. `publications.source_draft_id` records a draft an edition was published from, set to null when the draft is deleted.

---

## Mentions index

Rebuilt on every debounced save. Powers "find usages" and "appears in" for characters, places, and lore entries. Also drives the CodeMirror mention decoration plugin.

```sql
entity_mentions (
  id                  uuid primary key,
  source_type         text not null,   -- 'scene' | 'note' etc
  source_id           uuid not null,
  target_type         text not null,   -- 'character' | 'place' | 'lore_entry'
  target_id           uuid not null,
  position            int not null,    -- character offset in body_md
  surrounding_text    text not null    -- snippet for preview
)

-- index on (target_type, target_id) for "find usages"
-- index on (source_type, source_id) for "in this scene"
```

When a scene's `body_md` changes: delete existing rows for that source, then insert fresh ones based on name, alias, and keyword matching. Combined with full-text search on `body_md` columns, this gives both exact-entity and fuzzy in-text search.

## Search index (embeddings)

The writer's own stories in a universe, embedded with their embeddings model for search by meaning (#1785, `src/lib/server/llm/embeddings/scene-index.ts`). Derived data only: the scene's markdown stays the source and nothing here is exported.

```sql
embedding_indexes (
  user_id       uuid references users on delete cascade,
  universe_id   uuid references universes on delete cascade,
  model         text,          -- the model the last full index finished with
  completed_at  timestamptz,   -- null until a full index reaches the end
  created_at    timestamptz,
  primary key (user_id, universe_id)
)

scene_chunks (
  scene_id          uuid references scenes on delete cascade,
  chunk_index       int,
  content           text,        -- the passage as embedded
  content_hash      text,        -- sha256 of content
  model             text,
  dimensions        int,
  embedding         vector,      -- no fixed size; models differ
  scene_updated_at  timestamptz, -- the scene's updated_at when it was read
  created_at        timestamptz,
  primary key (scene_id, chunk_index)
)
```

A row in `embedding_indexes` is the writer turning the index on for a universe. A scene is current when its passages carry the current model and its present `updated_at`. While `completed_at` is set and `model` is the writer's current model, a save queues the story's upkeep and a five-minute sweep catches anything missed, taking each writer's longest-waiting story before anyone's second. Upkeep that would be large, reaches the spend cap, or fails in a way a retry would repeat (a refused key, a rejected request) clears `completed_at`, handing the universe back to the writer; a different model waits for the writer to index again. There is no vector index: every search runs inside one writer's universe or story, which is small enough to compare exactly, and pgvector's approximate indexes need one fixed vector size where writers' models differ. The rows go with the scene through the foreign key, so scene, story, universe and account deletion need no extra step.

---

## Assets and images

Codex stores uploaded images so a universe stays self-contained and travels with its export. Image bytes live in a storage backend (local disk for self-host, S3-compatible object storage for the hosted service, behind one small abstraction); only metadata lives in Postgres. Prose references an image by a stable app-served path, which the exporter rewrites to a file inside the markdown archive.

```sql
assets (
  id            uuid primary key,
  owner_id      uuid references users(id) not null,
  universe_id   uuid references universes(id),   -- scope; null for account-level images such as an avatar
  kind          text not null,                   -- 'cover' | 'inline' | 'avatar' | ...
  filename      text not null,
  content_type  text not null,
  byte_size     bigint not null,
  storage_key   text not null,                   -- path or key in the storage backend
  width         int,
  height        int,
  created_at    timestamptz not null,
  unreferenced_since timestamptz                 -- when the unused-image sweep first found nothing using it, or when its universe was purged; cleared by the next sweep that finds it in use, or by any write that stores its id (trigger clear_asset_marks, migration 0112)
)
-- indexes (migration 0111): assets_universe_idx on (universe_id) where universe_id is not null, for the universe purge's unlink; assets_owner_idx on (owner_id)
```

- **Covers.** `stories.cover_asset_id` points at a cover image. When it is null, the app renders a default cover from the title, tinted in `stories.cover_color` (a category palette token picked at random when the story is made and changeable in story settings; older rows without one get a stable pick from the story id), so every book on a shelf has one.
- **Inline images.** The markdown editor inserts an uploaded image as a normal markdown image whose URL is an app-served asset path (for example `/assets/{id}`). Pasting an external image URL is also allowed, but only uploaded assets are stored, exported, and guaranteed not to rot.
- **Export.** A markdown export writes referenced assets into an `assets/` folder in the zip and rewrites the links, keeping the archive self-contained and Obsidian-friendly.

---

## Public reading pages

A writer can publish finished work to a public reading page (see `design.md`). Publishing freezes the current prose into a read-only edition stored separately from the live tables, so the reader path never reads draft content and never joins back to the editing tables.

```sql
publications (
  id              uuid primary key,
  story_id        uuid references stories(id) not null,
  owner_id        uuid references users(id) not null,
  handle          text not null,         -- denormalised from users.handle for the reader path
  title           text not null,
  author          text,
  description_md  text,
  is_adult        boolean not null default false,  -- carried from stories.is_adult; lets the reader site filter
  content_warnings text[] not null default '{}', -- names of the story's warning tags at publish, frozen
  content_warning_ids uuid[] not null default '{}', -- the same warnings' tag ids, frozen; empty on editions from before #1596, which match by name
  content         jsonb not null,        -- frozen chapters and scenes for this edition
  version_label   text,                  -- optional, e.g. 'Edition 2'
  source_draft_id uuid references story_drafts(id) on delete set null,  -- the saved draft it came from, if any
  is_current      boolean not null default true,
  removed_at      timestamptz,           -- set by a takedown (admin or moderator) or an account deletion; hides the edition without deleting the source
  removed_by      uuid references users on delete set null, -- who took it down
  removed_reason  text,                  -- a REPORT_REASONS key (#lib/report-reasons), shown to the author
  taken_down_at   timestamptz,           -- when the takedown happened (removed_at keeps an earlier account-deletion hide); cleared by a restore, null on takedowns before 0133
  hidden_by_account_deletion boolean not null default false, -- set when the author schedules deletion; a restore then leaves the edition down
  restored_at     timestamptz,           -- the last time a moderator restored it after a takedown; kept through a later takedown
  restored_by     uuid references users on delete set null,
  published_at    timestamptz not null
)

-- index on (handle) for profile lookups
-- index on (story_id, is_current) for the current edition of a story

tags (
  id              uuid primary key,
  kind            text not null,         -- 'tag' (typed by authors) | 'fandom' | 'genre' | 'warning' (curated lists)
  name            text not null,         -- shown as first typed; admins and moderators can rename
  slug            text not null,         -- lowercase, spaces/hyphens/underscores as one separator; unique per kind
  merged_into_id  uuid references tags on delete set null, -- reads follow it to the surviving tag
  removed_at      timestamptz,           -- hidden everywhere, and cannot be typed again
  removed_by      uuid references users on delete set null,
  created_at      timestamptz not null
)

story_tags (
  story_id        uuid references stories on delete cascade,
  tag_id          uuid references tags on delete cascade,
  primary key (story_id, tag_id)
)

publication_reports (
  id              uuid primary key,
  publication_id  uuid references publications on delete cascade not null,
  reason          text not null,         -- a REPORT_REASONS key
  comment         text,                  -- optional, up to 500 characters
  created_at      timestamptz not null,
  resolved_at     timestamptz,           -- null while open
  resolved_by     uuid references users on delete set null,
  resolution      text                   -- 'taken_down' | 'removed_from_browse' | 'dismissed'
)

-- partial index on (created_at) where resolved_at is null, for the queue
```

Key points:

- **Snapshot, not live.** Each publish writes a new `publications` row capturing the prose at that moment, and clears `is_current` on the previous edition. Readers see the current edition; the live `scenes` and worldbuilding tables are never exposed.
- **Prose only.** `content` holds the story's chapters and scenes. Characters, places, and lore are not included in v1.
- **Visibility.** `stories.visibility` decides whether a story is private, reachable only by direct link (unlisted), or listed on the author's public shelf (public).
- **Adult content.** `is_adult` is carried from the story so the reader site can keep adult work out of default listings and behind a confirmation. It marks content, it does not ban it.
- **Addresses.** A public story is read at `/@handle/<stories.slug>`, any readable one at `/@handle/<story id>`, and a universe with a listed story at `/@handle/universes/<universes.slug>`.
- **Old slugs.** `slug_history (owner_id, kind 'story' | 'universe', slug, story_id, universe_id, created_at)`, unique on `(owner_id, kind, slug)`, with a check that `kind` is one of the two (migration 0114), records each slug a rename moved off: always for a universe, and for a story once it has been published. The public pages redirect an old slug (308) to the current one while the target is readable at its slug, and `uniqueSlug` treats the rows as taken, so no other story (or universe) of the account picks one up; a rename (or a restore) back to its own old slug removes that row. A save locks the row first and compares the name it holds now, so a form that read an older name cannot leave the slug behind; a rename or a restore then takes a per-account advisory lock (`slugs:<owner id>`), so two at once cannot lose a slug. A trashed story's current slug is not reserved: the trash frees it, as before. Purging the target sets its id to null and keeps the reservation; deleting the account deletes the rows. Not authored content: left out of exports and imports.
- **Reports.** `publication_reports` holds readers' reports about an edition. Nothing about the reporter is stored. Not authored content: not exported, and deleted with the edition.

---

## Multi-tenancy

- The application is single-operator and multi-user, on one shared instance and database (the GitHub model; see `design.md`). `owner_id` is the isolation boundary: it separates one user's private data from another's on the same instance, so every read or write of private content must be scoped to the signed-in owner. Published `/@handle` editions are the only content that crosses between users. (The earlier instance-per-customer "fleet" idea was dropped on 2026-06-04; there is no instance- or database-level tenant boundary.)
- Every user-owned table has an `owner_id`.
- All queries filter by owner at the universe level, with cascading access through stories, scenes, and entities.
- Guest review access (see Review and collaboration) is granted per story through an invitation rather than by sharing ownership. Authorization checks are intentionally kept in one service layer, so adding that access later is a small, contained change.
- Admin approval is a flag on the `users` table. The approval workflow can be managed via direct SQL for a long time before needing a UI.

---

## Export

Not a storage concern, but noted for portability. A story or universe should be exportable as a zip of markdown files with YAML front matter (chapters/, scenes/, characters/, etc), matching an Obsidian-compatible structure. EPUB export via Pandoc or a Node EPUB library. Postgres is the running format, optimised for the app; export produces the portable artefact on demand.

### Account export and deletion

A user can export everything they own (every universe, story, scene, entity, note, and uploaded asset) as a single archive. Deletion is a hard delete, not a soft flag, to satisfy GDPR erasure: removing a user removes every row they own, cascading from universes down through stories, scenes, chapters, entities, relationships, notes, mentions, revisions, publications, and assets, and also removes their uploaded files from the storage backend. On the hosted service, deletion additionally purges any synced editions and assets from the central reader store, so nothing survives in the public archive. Foreign keys are defined with `on delete cascade` along ownership paths so a single delete is complete and leaves no orphans.

---

## Open questions

- How aggressive should autosave revisioning be? Every debounce save is probably too much over long sessions. Every N seconds of idle, plus on-blur and on-navigation, is likely right.
- Should revisions be per-entity or per-save-batch? If saving a scene triggers a mentions rebuild, those are logically one edit. A batch ID on the revision row would group them.
- Whether plotlines/arcs eventually become first-class entities (a join table on scenes) or stay in `metadata` jsonb.
- Scene-at-a-time vs continuous-scroll as the default writing mode. `global_position` supports both; it's a rendering decision, not a schema one.
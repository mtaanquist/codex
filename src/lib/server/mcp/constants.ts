// Lifetimes and limits for external access, in one place so they are easy to
// change together.

import type { DiffBudget } from '../../review-anchor.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The path of the MCP endpoint; with the site origin in front it is also the
// resource the tokens are issued for.
export const MCP_PATH = '/api/mcp';

export const CODE_TTL_MS = MINUTE;
export const ACCESS_TOKEN_TTL_MS = HOUR;
// Sliding: each refresh issues a new refresh token with a fresh lifetime.
export const REFRESH_TOKEN_TTL_MS = 30 * DAY;

// A personal access token: how long it may live, and the choice offered
// first. It has no refresh token, so this is its whole life.
export const PERSONAL_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export const PERSONAL_TOKEN_DEFAULT_DAYS = 90;
export const MAX_PERSONAL_TOKENS = 20;
export const MAX_PERSONAL_TOKEN_NAME = 60;
// Shown in place of an app's web address wherever the token is named. Not a
// possible host name, so no registered app can pass for one.
export const PERSONAL_TOKEN_HOST = 'personal token';

// The grant's last-used stamp is refreshed at most this often.
export const LAST_USED_REFRESH_MS = 5 * MINUTE;

// A cached client metadata document is fetched again after this long.
export const CLIENT_DOCUMENT_TTL_MS = DAY;
export const CLIENT_DOCUMENT_MAX_BYTES = 64 * 1024;
export const CLIENT_DOCUMENT_TIMEOUT_MS = 5000;

// Clean-up windows (see purgeExternalAccess).
export const UNUSED_CLIENT_RETENTION = '24 hours';
export const REVOKED_CLIENT_RETENTION = '30 days';
export const SPENT_CODE_RETENTION = '1 day';

export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME = 120;
export const MAX_URI_LENGTH = 2000;

// Registrations one address may make per hour.
export const REGISTER_PER_HOUR = 30;
// Token and revoke requests one address may make per minute.
export const TOKEN_PER_MINUTE = 120;

// Tool calls one connected app may make per minute, and one writer across all
// their apps, so connecting several does not multiply the first number.
export const READ_CALLS_PER_MINUTE = 120;
export const READ_CALLS_PER_MINUTE_PER_USER = 240;
// The same for calls that stage something for the writer to decide on.
export const STAGING_CALLS_PER_MINUTE = 30;
export const STAGING_CALLS_PER_MINUTE_PER_USER = 60;
// The most notes (pending suggestions and open comments) one app may have
// waiting on one scene. One pattern note can carry 40 edits, so this leaves
// room for two or three passes before the writer has to decide on some.
export const MAX_NOTES_WAITING_PER_SCENE = 100;
// The most undecided drafts from apps a universe holds at once. A draft is a
// whole scene for the writer to read, so the number is small.
export const MAX_APP_DRAFTS_WAITING = 20;
// One writer's staging calls run one at a time, whichever of their apps and
// universes they are for. This many may wait behind the one that is running;
// a call past that is told to try again.
export const MAX_STAGING_CALLS_WAITING = 8;
// Staging calls that may run at once in the whole process, each holding one
// connection. The rest wait their turn in memory. With the reading calls
// below, outside apps hold at most half of the pool of ten; the rest is for
// the writers' own pages and saves.
export const MAX_STAGING_TRANSACTIONS = 2;
// Reading calls one writer may have running at once, over all their apps,
// and in the whole process. Each holds one connection at a time.
export const MAX_READ_CALLS_PER_WRITER = 2;
export const MAX_READ_CALLS_RUNNING = 3;
// Reading calls of one writer that may wait for a place, and for how long. A
// call past either is told to try again.
export const MAX_READ_CALLS_WAITING = 20;
export const READ_WAIT_TIMEOUT_MS = 10_000;
// The longest a staging call waits for its turn before it is told to try
// again.
export const STAGING_WAIT_TIMEOUT_MS = 20_000;
// The longest a staging call waits inside the database for any one lock (the
// writer's save of the same scene, say) before it gives up.
export const STAGING_LOCK_TIMEOUT_MS = 2000;
// The longest a staging call's transaction may last. Postgres ends it past
// this, so nothing a call holds can outlast it.
export const STAGING_TRANSACTION_TIMEOUT_MS = 30_000;
// How much comparing of texts one call may do to work out where an edit now
// sits in a scene that changed since (see DiffBudget). The comparison holds
// the server's one thread, so this is what one call may cost the others. In
// edit units (see DiffBudget): 400,000 a call (edit distance 630, about
// 25 ms of character diff), and 4,000 (edit distance 63, under 1 ms) for each
// further version of the scene an edit was made on once that is used up.
// The line and sentence passes before the diff are not counted: one
// comparison of a scene at the 2,000,000 character cap holds the thread for
// 100 to 230 ms, and about 300 ms after the whole draft was replaced.
// Past it an edit in a part of the scene that was not compared is reported
// as possibly no longer applying (get_review_note) or not found (a follow-up
// edit).
export const APP_DIFF_BUDGET: DiffBudget = { perPair: 400_000, total: 400_000, floor: 4_000 };
// Every request to the endpoint, of any kind, per writer per minute.
export const REQUESTS_PER_MINUTE = 600;
// Requests with a token that resolves to no one, per address per minute. Past
// this the address is refused before any lookup. A client whose token expired
// fetches a new one from the token endpoint, which allows the same number.
export const FAILED_BEARER_PER_MINUTE = TOKEN_PER_MINUTE;

// Clients cut a tool result off at about 150,000 characters, so results stay
// under that with room for the JSON around a scene's text.
export const TOOL_RESULT_MAX_CHARS = 140_000;
export const SCENE_BODY_MAX_CHARS = 120_000;

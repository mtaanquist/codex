import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { publicOrigin } from '#lib/server/origin';
import { rateLimit, slidingRateLimit } from '#lib/server/rate-limit';
import { GRANTABLE_PERMISSIONS, scopeFromPermissions } from '#lib/mcp-access';
import { FAILED_BEARER_PER_MINUTE, REQUESTS_PER_MINUTE } from '#lib/server/mcp/constants';
import { notFound } from '#lib/server/mcp/http';
import { protectedResourceUrl } from '#lib/server/mcp/metadata';
import { knownBearer, resolveBearer } from '#lib/server/mcp/oauth';
import { serveMcp } from '#lib/server/mcp/server';
import { mcpInstanceEnabled } from '#lib/server/mcp/settings';

// The MCP endpoint: the address a writer gives an outside app. The only
// credential it takes is a bearer token from the OAuth server here; the hook
// never reads the session cookie for this path, so a signed-in browser cannot
// be made to drive it.

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
	});
}

// RFC 6750 with the pointer a client follows to find the OAuth server
// (RFC 9728). Says the same for a missing, unknown, expired or revoked token.
function unauthorized(origin: string, hadToken: boolean): Response {
	const challenge = [
		`Bearer resource_metadata="${protectedResourceUrl(origin)}"`,
		`scope="${scopeFromPermissions(GRANTABLE_PERMISSIONS)}"`,
		...(hadToken ? ['error="invalid_token"'] : [])
	].join(', ');
	return json(
		401,
		{ error: hadToken ? 'invalid_token' : 'unauthorized' },
		{ 'www-authenticate': challenge }
	);
}

function tooManyRequests(retryAfterSeconds: number): Response {
	return json(429, { error: 'too_many_requests' }, { 'retry-after': String(retryAfterSeconds) });
}

function bearerToken(request: Request): string {
	const match = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
	return match?.[1] ?? '';
}

const handle: RequestHandler = async ({ request, url, getClientAddress }) => {
	if (!(await mcpInstanceEnabled(db))) return notFound();
	const origin = publicOrigin(url);

	// A program that is not a browser sends no Origin. A browser always does,
	// and a page on another site has no business calling this endpoint.
	const requestOrigin = request.headers.get('origin');
	if (requestOrigin !== null && requestOrigin !== origin) {
		return json(403, { error: 'forbidden_origin' });
	}

	const token = bearerToken(request);
	const identity = await resolveBearer(db, token);
	if (!identity) {
		// Guessed tokens are limited per address, but only after the lookup:
		// hosted apps share addresses, so a valid token must never be refused by
		// this, and a known one that expired or was revoked always gets the 401
		// that tells its client to refresh or sign in again.
		if (token && !(await knownBearer(db, token))) {
			const key = `mcp:bad-token:${getClientAddress()}`;
			const failures = rateLimit(key, FAILED_BEARER_PER_MINUTE, 60 * 1000);
			if (!failures.allowed) return tooManyRequests(failures.retryAfterSeconds);
		}
		return unauthorized(origin, token !== '');
	}

	const limit = slidingRateLimit(`mcp:requests:${identity.userId}`, REQUESTS_PER_MINUTE, 60 * 1000);
	if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

	return serveMcp(request, { db, identity, origin });
};

// One function for every method: the protocol layer answers 405 for the ones
// a stateless server has no use for, but only to a caller with a valid token.
export const GET = handle;
export const POST = handle;
export const DELETE = handle;

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db';
import { publicOrigin } from '#lib/server/origin';
import { peekRateLimit, rateLimit, slidingRateLimit } from '#lib/server/rate-limit';
import { GRANTABLE_PERMISSIONS, scopeFromPermissions } from '#lib/mcp-access';
import { FAILED_BEARER_PER_MINUTE, REQUESTS_PER_MINUTE } from '#lib/server/mcp/constants';
import { notFound } from '#lib/server/mcp/http';
import { protectedResourceUrl } from '#lib/server/mcp/metadata';
import { resolveBearer } from '#lib/server/mcp/oauth';
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
	// An address that keeps sending tokens that resolve to no one is refused
	// before anything touches the database. Only failures count, so many
	// writers' apps behind one address are not limited by their good calls.
	const failuresKey = `mcp:bad-token:${getClientAddress()}`;
	const shut = peekRateLimit(failuresKey, FAILED_BEARER_PER_MINUTE);
	if (!shut.allowed) return tooManyRequests(shut.retryAfterSeconds);

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
		if (token) rateLimit(failuresKey, FAILED_BEARER_PER_MINUTE, 60 * 1000);
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

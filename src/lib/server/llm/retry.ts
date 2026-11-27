import { EgressDeniedError, EgressTimeoutError } from './egress.ts';
import { EndpointReplyError } from './providers/types.ts';

// A local endpoint reloading a model, or a blip on the way to a hosted one,
// fails one request and is fine on the next. Two short retries cover that
// without keeping a caller waiting when the endpoint is really down.
export const RETRY_DELAYS_MS = [250, 1000];

// Transient means "the same request might work in a moment": a thrown
// transport error (socket reset, DNS, connection refused), or a 429/5xx the
// adapters report as `Endpoint returned <status>: ...`. A 4xx other than 429 is
// the request's own fault, an egress denial is policy, and an abort was asked
// for; none of those improve on a second try. Nor does an endpoint that already
// sat silent for the whole idle timeout, or one that answered with something
// other than a reply (see EndpointReplyError).
export function isTransientFailure(err: unknown): boolean {
	if (err instanceof EgressDeniedError) return false;
	if (err instanceof EgressTimeoutError) return false;
	if (err instanceof EndpointReplyError) return false;
	if (!(err instanceof Error)) return false;
	if (err.name === 'AbortError') return false;
	// A 200 whose body is not JSON fails the same way every time; retrying it
	// only bills the endpoint twice for the same broken reply.
	if (err instanceof SyntaxError) return false;
	const reported = /^Endpoint returned (\d{3})/.exec(err.message);
	if (reported) {
		const status = Number(reported[1]);
		return status === 429 || (status >= 500 && status < 600);
	}
	return true;
}

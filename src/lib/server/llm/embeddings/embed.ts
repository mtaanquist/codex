import type { Database } from '../../auth.ts';
import { logEvent } from '../../log.ts';
import { ceilingTokens } from '../context/budgets.ts';
import { egressHttpRequest, egressPolicy } from '../egress.ts';
import { isTransientFailure, RETRY_DELAYS_MS } from '../retry.ts';
import { SpendCapError, type SpendMeter } from '../spend.ts';
import { recordAssistantUsage } from '../usage.ts';
import { EndpointReplyError, type HttpRequest, type TokenUsage } from '../providers/types.ts';
import {
	embeddingsSettings,
	resolveEmbeddings,
	saveEmbeddingsDimensions,
	storyMuted,
	type ResolvedEmbeddings
} from './config.ts';
import { openaiEmbeddings, type EmbeddingResponse, type EmbeddingsProvider } from './openai.ts';

// The one entry point for turning text into vectors with the writer's own
// embeddings model. Every request goes through the egress guard, logs a usage
// row (role 'embeddings'), and, given a spend meter, is held back if it could
// take the run past the account's spend cap.

// Refused before anything is sent: embeddings are off, not set up, or the
// Assistant's kill switch is engaged. A retry is refused the same way, so a
// job should end on it rather than retry.
export class EmbeddingsDisabledError extends Error {
	constructor() {
		super('Embeddings are turned off or not set up on this account.');
		this.name = 'EmbeddingsDisabledError';
	}
}

// Texts per request. Well inside every supported server's limit (OpenAI takes
// 2,048 inputs, Voyage 1,000), and small enough that one failed request does
// not waste much.
export const EMBED_BATCH_SIZE = 64;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type EmbedOptions = {
	// A background run's spend meter (see jobSpendMeter). Each request is
	// recorded on it, and one that could pass the cap is not sent.
	meter?: SpendMeter;
	// The story the texts come from: required for a story's text, since a
	// story the writer muted for the Assistant is refused. Also logged with
	// the usage row.
	storyId?: string;
	signal?: AbortSignal;
};

// Test seam: production passes none.
export type EmbedDeps = {
	provider?: EmbeddingsProvider;
	http?: HttpRequest;
	sleep?: (ms: number) => Promise<void>;
};

export type EmbedResult = {
	// The model that produced the vectors, and how many numbers each holds.
	// Vectors from a different model or size are not comparable with these.
	model: string;
	dimensions: number;
	// One vector per input text, in order.
	vectors: number[][];
};

function connection(config: ResolvedEmbeddings) {
	return { endpoint: config.endpoint, apiKey: config.apiKey };
}

async function embedBatch(
	db: Database,
	userId: string,
	config: ResolvedEmbeddings,
	input: string[],
	opts: EmbedOptions,
	provider: EmbeddingsProvider,
	http: HttpRequest,
	sleep: (ms: number) => Promise<void>
): Promise<number[][]> {
	const meter = opts.meter;
	const ceiling: TokenUsage = {
		promptTokens: input.reduce((sum, text) => sum + ceilingTokens(text), 0),
		completionTokens: 0
	};
	// Only the request is retried: once it succeeded it is never sent again,
	// whatever happens to the bookkeeping after it.
	let reply: EmbeddingResponse;
	for (let attempt = 0; ; attempt += 1) {
		if (meter?.wouldPassCap(config.model, ceiling, config.price)) {
			meter.hold(meter.exceedsCap(config.model, ceiling, config.price));
			throw new SpendCapError();
		}
		try {
			reply = await provider.embed(
				{ model: config.model, input },
				connection(config),
				http,
				opts.signal
			);
			break;
		} catch (err) {
			if (attempt >= RETRY_DELAYS_MS.length || opts.signal?.aborted || !isTransientFailure(err)) {
				throw err;
			}
			logEvent('warn', 'embeddings.retry', {
				userId,
				model: config.model,
				attempt: attempt + 1,
				error: err instanceof Error ? err.message : 'request failed'
			});
			await sleep(RETRY_DELAYS_MS[attempt]);
		}
	}
	meter?.record(config.model, reply.usage, config.price);
	await recordAssistantUsage(db, {
		userId,
		storyId: opts.storyId,
		role: 'embeddings',
		provider: config.provider,
		model: config.model,
		usage: reply.usage,
		price: config.price
	});
	return reply.vectors;
}

// Embed texts with the writer's embeddings model. Throws EmbeddingsDisabledError
// when embeddings may not run (or opts.storyId is muted), SpendCapError when the next request could pass
// the meter's cap (requests already made stay recorded), and the endpoint's or
// the egress guard's own error otherwise. Empty texts are refused: every
// server rejects them.
export async function embed(
	db: Database,
	userId: string,
	texts: string[],
	opts: EmbedOptions = {},
	deps: EmbedDeps = {}
): Promise<EmbedResult> {
	if (!(await embeddingsSettings(db, userId)).ready) throw new EmbeddingsDisabledError();
	if (opts.storyId && (await storyMuted(db, opts.storyId))) throw new EmbeddingsDisabledError();
	const config = await resolveEmbeddings(db, userId);
	if (texts.some((text) => !text.trim())) throw new Error('Cannot embed an empty text.');
	const provider = deps.provider ?? openaiEmbeddings;
	const http = deps.http ?? egressHttpRequest(await egressPolicy(db));
	const sleep = deps.sleep ?? realSleep;

	const vectors: number[][] = [];
	for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
		const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
		vectors.push(...(await embedBatch(db, userId, config, batch, opts, provider, http, sleep)));
	}
	const dimensions = vectors[0]?.length ?? config.dimensions ?? 0;
	if (vectors.some((vector) => vector.length !== dimensions)) {
		throw new EndpointReplyError('The endpoint returned embeddings of different sizes.');
	}
	return { model: config.model, dimensions, vectors };
}

export type TestEmbeddingsResult = { ok: true; dimensions: number } | { ok: false; reason: string };

// Embed one short text with the saved settings and report the vector size,
// storing it with the config. Works before embeddings are switched on, since
// the writer is mid-setup. Like the Assistant's test, it is not logged.
export async function testEmbeddings(
	db: Database,
	userId: string,
	deps: EmbedDeps = {}
): Promise<TestEmbeddingsResult> {
	try {
		// Inside the try: a key saved under another APP_SECRET fails to decrypt.
		const config = await resolveEmbeddings(db, userId);
		if (!config.endpoint) return { ok: false, reason: 'Enter a base URL first.' };
		if (!config.model) return { ok: false, reason: 'Enter a model name first.' };
		const provider = deps.provider ?? openaiEmbeddings;
		const http = deps.http ?? egressHttpRequest(await egressPolicy(db));
		const reply = await provider.embed(
			{ model: config.model, input: ['This is a connection test.'] },
			connection(config),
			http
		);
		const dimensions = reply.vectors[0].length;
		await saveEmbeddingsDimensions(db, userId, config, dimensions);
		return { ok: true, dimensions };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'Could not reach the endpoint.'
		};
	}
}

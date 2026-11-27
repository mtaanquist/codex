import { baseV1 } from '../providers/openai.ts';
import {
	EndpointReplyError,
	type Connection,
	type HttpRequest,
	type TokenUsage
} from '../providers/types.ts';

// The one embeddings adapter. It speaks POST /v1/embeddings, the shape OpenAI
// defined and Voyage AI, Ollama, LM Studio and LocalAI also serve: a body of
// { model, input: string[] }, answered with { data: [{ embedding, index }],
// usage }. Only the fields every one of them accepts are sent, so no
// encoding_format (Voyage spells its values differently) and no dimensions.

export type EmbeddingRequest = { model: string; input: string[] };

export type EmbeddingResponse = {
	// One vector per input, in input order.
	vectors: number[][];
	// The tokens the endpoint billed, when it reported them. Embeddings bill
	// input only, so completionTokens is always 0.
	usage?: TokenUsage;
};

export interface EmbeddingsProvider {
	// Throws on a transport error, a non-2xx response (as "Endpoint returned
	// <status>: ...", which the retry rule reads), or a reply that is not one
	// vector per input (EndpointReplyError).
	embed(
		req: EmbeddingRequest,
		conn: Connection,
		http: HttpRequest,
		signal?: AbortSignal
	): Promise<EmbeddingResponse>;
}

// Accepts the same base URLs the Assistant does, plus a full embeddings URL.
export function embeddingsUrl(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, '');
	const base = trimmed.endsWith('/embeddings')
		? trimmed.slice(0, trimmed.length - '/embeddings'.length)
		: baseV1(trimmed);
	return `${base}/embeddings`;
}

function truncate(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

// OpenAI, Ollama and LM Studio report prompt_tokens; Voyage reports only
// total_tokens, which for an embedding is the same figure.
function parseUsage(raw: unknown): TokenUsage | undefined {
	const usage = raw as { prompt_tokens?: unknown; total_tokens?: unknown } | undefined;
	const tokens = Number(usage?.prompt_tokens ?? usage?.total_tokens);
	if (!Number.isFinite(tokens) || tokens < 0) return undefined;
	return { promptTokens: tokens, completionTokens: 0 };
}

const NOT_VECTORS =
	'The endpoint did not answer with embeddings. Check the base URL and the model.';

export function parseEmbeddingReply(text: string, expected: number): EmbeddingResponse {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new EndpointReplyError(`${NOT_VECTORS} It replied: ${truncate(text)}`);
	}
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) throw new EndpointReplyError(NOT_VECTORS);
	if (data.length !== expected) {
		throw new EndpointReplyError(
			`The endpoint returned ${data.length} embeddings for ${expected} texts.`
		);
	}
	const items = data.map((item, position) => {
		const { embedding, index } = (item ?? {}) as { embedding?: unknown; index?: unknown };
		if (
			!Array.isArray(embedding) ||
			embedding.length === 0 ||
			!embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
		) {
			throw new EndpointReplyError(NOT_VECTORS);
		}
		return { vector: embedding as number[], index: typeof index === 'number' ? index : position };
	});
	// The spec allows the list in any order; index says which input each is for.
	items.sort((a, b) => a.index - b.index);
	if (items.some((item, position) => item.index !== position)) {
		throw new EndpointReplyError(NOT_VECTORS);
	}
	const size = items[0]?.vector.length;
	if (items.some((item) => item.vector.length !== size)) {
		throw new EndpointReplyError('The endpoint returned embeddings of different sizes.');
	}
	const usage = parseUsage((body as { usage?: unknown }).usage);
	return { vectors: items.map((item) => item.vector), ...(usage ? { usage } : {}) };
}

export const openaiEmbeddings: EmbeddingsProvider = {
	async embed(req, conn, http, signal) {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		// A local server needs no key; only send one when set.
		if (conn.apiKey) headers['authorization'] = `Bearer ${conn.apiKey}`;
		const res = await http(embeddingsUrl(conn.endpoint), {
			method: 'POST',
			headers,
			body: JSON.stringify({ model: req.model, input: req.input }),
			signal
		});
		const text = await res.text();
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(text)}`);
		}
		return parseEmbeddingReply(text, req.input.length);
	}
};

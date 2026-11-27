import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { egressHttpRequest } from '../egress';
import { EndpointReplyError } from '../providers/types';
import { isTransientFailure } from '../retry';
import { embeddingsUrl, openaiEmbeddings, parseEmbeddingReply } from './openai';

// The adapter against a fake embeddings server on loopback, through the real
// egress transport (with the open policy, since loopback is private).

type Seen = { url: string; headers: IncomingMessage['headers']; body: unknown };
let server: Server;
let base: string;
let seen: Seen[] = [];
let reply: (body: { input: string[] }) => { status: number; body: string };

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const body = raw ? JSON.parse(raw) : {};
			seen.push({ url: req.url ?? '', headers: req.headers, body });
			const out = reply(body);
			res.writeHead(out.status, { 'content-type': 'application/json' });
			res.end(out.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.closeAllConnections();
	server.close();
});

beforeEach(() => {
	seen = [];
});

const http = () => egressHttpRequest({ policy: 'open', allowlist: [] });

function vectors(input: string[], size = 3) {
	return input.map((_, i) => Array.from({ length: size }, (_, j) => i + j / 10));
}

describe('embeddingsUrl', () => {
	it('accepts a bare host, a /v1 base, or the full embeddings URL', () => {
		expect(embeddingsUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/embeddings');
		expect(embeddingsUrl('https://api.openai.com/v1/')).toBe(
			'https://api.openai.com/v1/embeddings'
		);
		expect(embeddingsUrl('https://api.voyageai.com/v1/embeddings')).toBe(
			'https://api.voyageai.com/v1/embeddings'
		);
	});
});

describe('openaiEmbeddings against a fake server', () => {
	it('sends the model and texts with the key, and reads OpenAI-style vectors and usage', async () => {
		reply = ({ input }) => ({
			status: 200,
			body: JSON.stringify({
				object: 'list',
				data: vectors(input).map((embedding, index) => ({ object: 'embedding', embedding, index })),
				model: 'text-embedding-3-small',
				usage: { prompt_tokens: 7, total_tokens: 7 }
			})
		});
		const result = await openaiEmbeddings.embed(
			{ model: 'text-embedding-3-small', input: ['one', 'two'] },
			{ endpoint: `${base}/v1`, apiKey: 'sk-test' },
			http()
		);
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe('/v1/embeddings');
		expect(seen[0].headers.authorization).toBe('Bearer sk-test');
		// Only the fields every supported server accepts.
		expect(seen[0].body).toEqual({ model: 'text-embedding-3-small', input: ['one', 'two'] });
		expect(result.vectors).toEqual([
			[0, 0.1, 0.2],
			[1, 1.1, 1.2]
		]);
		expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 0 });
	});

	it('sends no key to a server that needs none', async () => {
		reply = ({ input }) => ({
			status: 200,
			body: JSON.stringify({ data: vectors(input).map((embedding) => ({ embedding })) })
		});
		const result = await openaiEmbeddings.embed(
			{ model: 'nomic-embed-text', input: ['one'] },
			{ endpoint: base, apiKey: '' },
			http()
		);
		expect(seen[0].headers.authorization).toBeUndefined();
		expect(result.vectors).toHaveLength(1);
		// No usage block: nothing reported, rather than a count of zero.
		expect(result.usage).toBeUndefined();
	});

	it("reads Voyage's total_tokens when there is no prompt_tokens", async () => {
		reply = ({ input }) => ({
			status: 200,
			body: JSON.stringify({
				object: 'list',
				data: vectors(input).map((embedding, index) => ({ object: 'embedding', embedding, index })),
				model: 'voyage-3.5',
				usage: { total_tokens: 12 }
			})
		});
		const result = await openaiEmbeddings.embed(
			{ model: 'voyage-3.5', input: ['a'] },
			{ endpoint: `${base}/v1`, apiKey: 'pa-test' },
			http()
		);
		expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 0 });
	});

	it('reports a non-2xx as the status the retry rule reads', async () => {
		reply = () => ({ status: 503, body: '{"error":"loading model"}' });
		const err = await openaiEmbeddings
			.embed({ model: 'm', input: ['a'] }, { endpoint: base, apiKey: '' }, http())
			.catch((e: unknown) => e);
		expect((err as Error).message).toMatch(/^Endpoint returned 503: /);
		expect(isTransientFailure(err)).toBe(true);
	});

	it('refuses a page that is not JSON, without a retry', async () => {
		reply = () => ({ status: 200, body: '<html>Sign in to the wifi</html>' });
		const err = await openaiEmbeddings
			.embed({ model: 'm', input: ['a'] }, { endpoint: base, apiKey: '' }, http())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(EndpointReplyError);
		expect(isTransientFailure(err)).toBe(false);
	});
});

describe('parseEmbeddingReply', () => {
	it('puts vectors back in input order by index', () => {
		const text = JSON.stringify({
			data: [
				{ embedding: [2, 2], index: 1 },
				{ embedding: [1, 1], index: 0 }
			]
		});
		expect(parseEmbeddingReply(text, 2).vectors).toEqual([
			[1, 1],
			[2, 2]
		]);
	});

	it('refuses too few vectors, mixed sizes, and vectors it cannot read', () => {
		const one = JSON.stringify({ data: [{ embedding: [1, 2] }] });
		expect(() => parseEmbeddingReply(one, 2)).toThrow(/1 embeddings for 2 texts/);
		const mixed = JSON.stringify({ data: [{ embedding: [1, 2] }, { embedding: [1] }] });
		expect(() => parseEmbeddingReply(mixed, 2)).toThrow(/different sizes/);
		const encoded = JSON.stringify({ data: [{ embedding: 'AAAAAA==' }] });
		expect(() => parseEmbeddingReply(encoded, 1)).toThrow(EndpointReplyError);
		const duplicate = JSON.stringify({
			data: [
				{ embedding: [1], index: 0 },
				{ embedding: [2], index: 0 }
			]
		});
		expect(() => parseEmbeddingReply(duplicate, 2)).toThrow(EndpointReplyError);
	});
});

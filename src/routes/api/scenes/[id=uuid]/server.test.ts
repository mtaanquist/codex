import { describe, it, expect, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { MAX_BASE_HASHES } from '#lib/scene-saver';
import { textHash } from '#lib/text-hash';

// Only the request checks are under test; the scene lookup and save are stubbed.
vi.mock('#lib/server/db', () => ({ db: {} }));
vi.mock('#lib/server/scene-access', () => ({ ownedScene: async () => ({ id: 'scene' }) }));
vi.mock('#lib/server/jobs', () => ({ queueSceneMentions: async () => {} }));
vi.mock('#lib/server/write-guard', () => ({ rateLimitWrites: () => {} }));
vi.mock('#lib/server/scene-save', () => ({
	saveSceneBody: async () => ({ ok: true, bodyChanged: false, wordCount: 1 })
}));
vi.mock('#lib/server/scene-status', () => ({ setSceneStatus: async () => true }));

const { PUT } = await import('./+server');

async function statusFor(
	baseHashes: string[],
	fields: { bodyMd?: string; title?: string; order?: unknown } = {}
): Promise<number> {
	const body = JSON.stringify({ bodyMd: 'Words.', baseHashes, ...fields });
	const event = {
		params: { id: 'scene' },
		locals: { user: { id: 'user' } },
		request: new Request('http://localhost/api/scenes/scene', { method: 'PUT', body })
	};
	try {
		return ((await PUT(event as never)) as Response).status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

const hashes = (n: number) => Array.from({ length: n }, (_, i) => textHash(`text ${i}`));

describe('scene save fingerprints', () => {
	it('accepts as many fingerprints as the editor may send', async () => {
		expect(await statusFor(hashes(MAX_BASE_HASHES))).toBe(200);
	});

	it('refuses more than that', async () => {
		expect(await statusFor(hashes(MAX_BASE_HASHES + 1))).toBe(400);
	});

	it('refuses one no editor could have sent', async () => {
		expect(await statusFor(['not a fingerprint'])).toBe(400);
		expect(await statusFor([textHash('a'), 'x'.repeat(32)])).toBe(400);
	});
});

describe('scene save order', () => {
	it('takes a numbered save, or none, and refuses a malformed number', async () => {
		expect(await statusFor(hashes(1), { order: { source: 'editor-copy-1', seq: 3 } })).toBe(200);
		expect(await statusFor(hashes(1))).toBe(200);
		expect(await statusFor(hashes(1), { order: { source: 'editor-copy-1', seq: -1 } })).toBe(400);
		expect(await statusFor(hashes(1), { order: 'late' })).toBe(400);
	});
});

describe('scene save text', () => {
	// Postgres text cannot hold one; the save is refused before the query.
	it('refuses a null character in the body or the title', async () => {
		expect(await statusFor(hashes(1), { bodyMd: 'Wor\u0000ds.' })).toBe(400);
		expect(await statusFor(hashes(1), { title: 'Ti\u0000tle' })).toBe(400);
	});
});

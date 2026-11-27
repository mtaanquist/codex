import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../auth.ts';
import { users } from '../../db/schema.ts';
import { decryptSecret, encryptSecret, secretsAvailable } from '../../crypto.ts';
import type { TokenPrice } from '../../../assistant-cost.ts';
import {
	embeddingPreset,
	normaliseEmbeddingProviderId,
	type EmbeddingProviderId
} from './presets.ts';

// The writer's embeddings model, kept under the `embeddings` key of
// users.llm_config beside the Assistant's own settings. It has its own
// endpoint and key, because the Assistant's provider may have no embeddings
// endpoint at all (Claude does not). It is off by default, and it never runs
// while the Assistant's kill switch is engaged: the switch promises that
// nothing is sent to a model.

export type StoredEmbeddingsConfig = {
	enabled: boolean;
	provider: EmbeddingProviderId;
	endpoint: string;
	apiKeyEnc: string | null;
	model: string;
	// USD per token sent. Absent means no known price, so the spend cap cannot
	// meter it; 0 is a free model, such as one on the writer's own machine.
	pricePerToken?: number;
	// How many numbers each vector holds, as the last Test connection found
	// for this endpoint and model. Cleared when either changes.
	dimensions?: number;
};

function normalisePrice(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function normaliseDimensions(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

export function normaliseEmbeddings(raw: unknown): StoredEmbeddingsConfig {
	const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	return {
		enabled: value.enabled === true,
		provider: normaliseEmbeddingProviderId(value.provider),
		endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : '',
		apiKeyEnc: typeof value.apiKeyEnc === 'string' && value.apiKeyEnc ? value.apiKeyEnc : null,
		model: typeof value.model === 'string' ? value.model.trim() : '',
		pricePerToken: normalisePrice(value.pricePerToken),
		dimensions: normaliseDimensions(value.dimensions)
	};
}

// Whether embeddings may run: switched on, set up, and the Assistant's kill
// switch not engaged. Pure, so the truth table is easy to pin down.
export function embeddingsReady(
	assistantEnabled: boolean,
	config: StoredEmbeddingsConfig
): boolean {
	return assistantEnabled && config.enabled && !!config.endpoint && !!config.model;
}

async function readRow(
	db: Database,
	userId: string
): Promise<{ assistantEnabled: boolean; config: StoredEmbeddingsConfig }> {
	const [row] = await db
		.select({ llmConfig: users.llmConfig })
		.from(users)
		.where(eq(users.id, userId));
	const raw = (row?.llmConfig ?? {}) as { enabled?: unknown; embeddings?: unknown };
	return { assistantEnabled: raw.enabled === true, config: normaliseEmbeddings(raw.embeddings) };
}

// A key-free view for the account page.
export type EmbeddingsView = Omit<StoredEmbeddingsConfig, 'apiKeyEnc'> & {
	hasKey: boolean;
	ready: boolean;
};

export async function embeddingsView(db: Database, userId: string): Promise<EmbeddingsView> {
	const { assistantEnabled, config } = await readRow(db, userId);
	const { apiKeyEnc, ...rest } = config;
	return { ...rest, hasKey: apiKeyEnc !== null, ready: embeddingsReady(assistantEnabled, config) };
}

// What a request runs with. The key is plaintext here and must not leave the
// server.
export type ResolvedEmbeddings = {
	ready: boolean;
	provider: EmbeddingProviderId;
	endpoint: string;
	apiKey: string;
	model: string;
	// The price as the usage log and the spend meter take it; undefined when
	// the writer has entered none.
	price?: TokenPrice;
	dimensions?: number;
};

export async function resolveEmbeddings(db: Database, userId: string): Promise<ResolvedEmbeddings> {
	const { assistantEnabled, config } = await readRow(db, userId);
	return {
		ready: embeddingsReady(assistantEnabled, config),
		provider: config.provider,
		endpoint: config.endpoint,
		apiKey: config.apiKeyEnc ? decryptSecret(config.apiKeyEnc) : '',
		model: config.model,
		price:
			config.pricePerToken === undefined
				? undefined
				: { prompt: config.pricePerToken, completion: 0 },
		dimensions: config.dimensions
	};
}

export type SaveEmbeddingsInput = {
	enabled: boolean;
	// Absent keeps the stored provider.
	provider?: EmbeddingProviderId;
	endpoint: string;
	// Blank keeps the stored key.
	apiKey: string;
	model: string;
	// USD per token. Absent keeps the stored price; null clears it.
	pricePerToken?: number | null;
};

// priceCleared says the save dropped a price the writer had typed, because the
// model or the server changed, so the page can ask for it again.
export type SaveEmbeddingsResult =
	{ ok: true; priceCleared?: true } | { ok: false; reason: string };

function urlPart(endpoint: string, part: 'origin' | 'hostname'): string {
	try {
		return new URL(endpoint)[part];
	} catch {
		return endpoint;
	}
}

export async function saveEmbeddingsConfig(
	db: Database,
	userId: string,
	input: SaveEmbeddingsInput
): Promise<SaveEmbeddingsResult> {
	const { config: existing } = await readRow(db, userId);
	const provider =
		input.provider === undefined ? existing.provider : normaliseEmbeddingProviderId(input.provider);
	const preset = embeddingPreset(provider);
	const endpoint = preset ? preset.baseUrl : input.endpoint.trim();
	if (endpoint) {
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			return { ok: false, reason: 'Enter a valid endpoint URL.' };
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return { ok: false, reason: 'The endpoint must be an http or https URL.' };
		}
	}
	const model = input.model.trim();

	// The Assistant's rules: a key never follows a switch to another provider
	// or another custom server, since it would be sent somewhere new, and a
	// typed price belongs to the server and the model it was looked up for.
	const providerChanged = provider !== existing.provider;
	const hadEndpoint = !preset && !!existing.endpoint;
	const connectionChanged =
		providerChanged ||
		(hadEndpoint && urlPart(endpoint, 'origin') !== urlPart(existing.endpoint, 'origin'));
	const serverChanged =
		providerChanged ||
		(hadEndpoint && urlPart(endpoint, 'hostname') !== urlPart(existing.endpoint, 'hostname'));
	const modelChanged = !!existing.model && model !== existing.model;

	let apiKeyEnc = connectionChanged ? null : existing.apiKeyEnc;
	if (input.apiKey) {
		if (!secretsAvailable()) {
			return { ok: false, reason: 'Set APP_SECRET on the server before storing an API key.' };
		}
		apiKeyEnc = encryptSecret(input.apiKey);
	}

	const sent =
		input.pricePerToken === undefined
			? existing.pricePerToken
			: (normalisePrice(input.pricePerToken) ?? undefined);
	// A price the form only carried over (unchanged) is dropped on a switch; one
	// typed in the same save is kept.
	const dropPrice =
		(serverChanged || modelChanged) &&
		existing.pricePerToken !== undefined &&
		sent === existing.pricePerToken;
	const pricePerToken = dropPrice ? undefined : sent;
	const dimensions =
		providerChanged || endpoint !== existing.endpoint || model !== existing.model
			? undefined
			: existing.dimensions;

	const value: StoredEmbeddingsConfig = {
		enabled: input.enabled,
		provider,
		endpoint,
		apiKeyEnc,
		model,
		...(pricePerToken === undefined ? {} : { pricePerToken }),
		...(dimensions === undefined ? {} : { dimensions })
	};
	// The whole embeddings object is replaced; the Assistant's keys beside it
	// are left alone by the merge.
	await db
		.update(users)
		.set({
			llmConfig: sql`${users.llmConfig} || ${JSON.stringify({ embeddings: value })}::jsonb`
		})
		.where(eq(users.id, userId));
	return dropPrice ? { ok: true, priceCleared: true } : { ok: true };
}

// Store the vector size a test found, only if the endpoint and model are still
// the ones tested: a save that landed meanwhile has its own size to find.
export async function saveEmbeddingsDimensions(
	db: Database,
	userId: string,
	tested: { endpoint: string; model: string },
	dimensions: number
): Promise<void> {
	await db
		.update(users)
		.set({
			llmConfig: sql`jsonb_set(${users.llmConfig}, '{embeddings,dimensions}', to_jsonb(${dimensions}::int))`
		})
		.where(
			and(
				eq(users.id, userId),
				sql`${users.llmConfig} -> 'embeddings' ->> 'endpoint' = ${tested.endpoint}`,
				sql`${users.llmConfig} -> 'embeddings' ->> 'model' = ${tested.model}`
			)
		);
}

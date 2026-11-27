// The writer's embeddings model: the setting, the adapter, and embed(). See
// ./embed.ts for the entry point the indexing job calls.
export {
	embed,
	testEmbeddings,
	EmbeddingsDisabledError,
	EMBED_BATCH_SIZE,
	type EmbedOptions,
	type EmbedResult,
	type EmbedDeps,
	type TestEmbeddingsResult
} from './embed.ts';
export {
	embeddingsReady,
	embeddingsSettings,
	embeddingsView,
	resolveEmbeddings,
	EmbeddingsKeyError,
	saveEmbeddingsConfig,
	type EmbeddingsSettings,
	type EmbeddingsView,
	type ResolvedEmbeddings,
	type SaveEmbeddingsInput
} from './config.ts';
export { EMBEDDING_PRESETS, type EmbeddingProviderId } from './presets.ts';
export type { EmbeddingsProvider, EmbeddingRequest, EmbeddingResponse } from './openai.ts';

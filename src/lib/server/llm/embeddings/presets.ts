// The embeddings providers the account page offers. Every one speaks the
// OpenAI-compatible /v1/embeddings shape (see ./openai.ts); 'custom' is any
// other server that does, such as Ollama, LM Studio or LocalAI. Pure data, safe
// to hand to the page load.

export const EMBEDDING_PROVIDER_IDS = ['custom', 'openai', 'voyage'] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDER_IDS)[number];

export function normaliseEmbeddingProviderId(raw: unknown): EmbeddingProviderId {
	return EMBEDDING_PROVIDER_IDS.includes(raw as EmbeddingProviderId)
		? (raw as EmbeddingProviderId)
		: 'custom';
}

export type EmbeddingPreset = {
	id: Exclude<EmbeddingProviderId, 'custom'>;
	label: string;
	// The endpoint stored when this preset is chosen; the form's URL field is
	// ignored for presets, as for the Assistant's.
	baseUrl: string;
	keyHint: string;
	docsUrl: string;
	// Shown as the model box's placeholder and named in the help article.
	suggestedModel: string;
};

export const EMBEDDING_PRESETS: EmbeddingPreset[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		keyHint: 'sk-...',
		docsUrl: 'https://platform.openai.com/api-keys',
		suggestedModel: 'text-embedding-3-small'
	},
	{
		id: 'voyage',
		label: 'Voyage AI',
		baseUrl: 'https://api.voyageai.com/v1',
		keyHint: 'pa-...',
		docsUrl: 'https://dashboard.voyageai.com/',
		suggestedModel: 'voyage-3.5'
	}
];

export function embeddingPreset(id: EmbeddingProviderId): EmbeddingPreset | undefined {
	return EMBEDDING_PRESETS.find((preset) => preset.id === id);
}

import { formatBytes, formatNumber } from './format.ts';

// The plan entitlements Codex enforces. Any other key on a plan is stored but
// has no effect. A missing row, or a null value, means no limit.
export const QUOTA_KEYS = ['max_universes', 'max_stories', 'storage_bytes'] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
export type Limits = Record<QuotaKey, number | null>;

export const NO_LIMITS: Limits = { max_universes: null, max_stories: null, storage_bytes: null };

export const MEGABYTE = 1024 * 1024;

/** A stored entitlement value as a limit: a whole number of zero or more, or
 * null (no limit) for anything else. */
export function parseLimit(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** An admin's typed limit: blank is no limit, otherwise a whole number from 0
 * to max. Undefined when the text is neither. */
export function parseLimitInput(text: string, max: number): number | null | undefined {
	const trimmed = text.trim();
	if (trimmed === '') return null;
	if (!/^\d+$/.test(trimmed)) return undefined;
	const n = Number(trimmed);
	return n <= max ? n : undefined;
}

const NOUNS: Record<Exclude<QuotaKey, 'storage_bytes'>, [string, string]> = {
	max_universes: ['universe', 'universes'],
	max_stories: ['story', 'stories']
};

/** "3 universes", "1 story", "50 MB": a limit as the writer reads it. */
export function limitPhrase(key: QuotaKey, limit: number): string {
	if (key === 'storage_bytes') return formatBytes(limit);
	const [one, many] = NOUNS[key];
	return `${formatNumber(limit)} ${limit === 1 ? one : many}`;
}

/** What a writer sees when a create, restore, or upload would pass a limit. */
export function quotaMessage(
	key: QuotaKey,
	limit: number,
	action: 'create' | 'restore' = 'create'
): string {
	const ask = 'ask the admin of this site to raise your limit.';
	const phrase = limitPhrase(key, limit);
	if (key === 'storage_bytes') {
		return `This image would take you past your account's limit of ${phrase} of uploaded images. To upload more, ${ask}`;
	}
	if (action === 'restore') {
		return `Restoring this would take you past your account's limit of ${phrase}. To restore it, ${ask}`;
	}
	return `You have reached your account's limit of ${phrase}. To make more, ${ask}`;
}

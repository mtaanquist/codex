// Whether this Codex is one person's install or a public service. It only
// changes the signed-out landing page. Shared with the browser, like
// #lib/signup-mode.ts; the setting is read and written in settings.ts.
export const INSTANCE_TYPES = ['personal', 'service'] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];

export function parseInstanceType(value: unknown): InstanceType {
	const type = (value as { type?: unknown } | null | undefined)?.type;
	return INSTANCE_TYPES.includes(type as InstanceType) ? (type as InstanceType) : 'personal';
}

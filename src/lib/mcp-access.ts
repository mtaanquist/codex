// What an outside app may be allowed to do with a writer's account. Shared by
// the consent page, the Account page and the server.

export const MCP_PERMISSIONS = ['read', 'suggest', 'apply'] as const;
export type McpPermission = (typeof MCP_PERMISSIONS)[number];

// The permissions a writer can hand out.
export const GRANTABLE_PERMISSIONS: readonly McpPermission[] = ['read', 'suggest', 'apply'];

// Never ticked for the writer, whatever an app asks for: accepting edits
// outside Codex is only allowed when the writer chose it themselves.
export const OFF_BY_DEFAULT: readonly McpPermission[] = ['apply'];

// Every grant includes this one: an app that cannot read has nothing to do.
export const BASE_PERMISSION: McpPermission = 'read';

export const PERMISSION_TEXT: Record<McpPermission, { label: string; description: string }> = {
	read: {
		label: 'Read your writing',
		description:
			'Read your universes, stories, scenes and entries. Stories where you have turned the Assistant off stay hidden.'
	},
	suggest: {
		label: 'Leave suggestions and comments',
		description:
			'Add suggested edits, comments, suggested entries, scene split proposals and scene drafts for you to accept or turn down. It cannot change your text.'
	},
	apply: {
		label: 'Let you accept its suggestions in the app',
		description:
			'Show a card in the app where you can accept, reword or skip the edits of its notes, without opening Codex. Only you can accept an edit there, by pressing a button on the card.'
	}
};

// The known permissions among the given values, in the one canonical order.
export function parsePermissions(values: readonly string[]): McpPermission[] {
	return MCP_PERMISSIONS.filter((permission) => values.includes(permission));
}

// A scope string as OAuth carries it: names separated by spaces.
export function permissionsFromScope(scope: string | null | undefined): McpPermission[] {
	return parsePermissions((scope ?? '').split(/\s+/).filter(Boolean));
}

export function scopeFromPermissions(permissions: readonly string[]): string {
	return parsePermissions(permissions).join(' ');
}

// How an app is named wherever one is shown. The name is what the app calls
// itself and proves nothing. The host is where its answer is sent (a client
// that registered itself: its one remote host, or this computer if it
// registered a local address; the consent page names the one in use) or
// where its metadata document lives, so the two always appear together. The
// host says where the writer's permission goes, not who runs the app.
export function clientDisplayName(client: { clientName: string; host: string }): string {
	const name = client.clientName.trim();
	if (!name || name.toLowerCase() === client.host.toLowerCase()) return client.host;
	return `${name} (${client.host})`;
}

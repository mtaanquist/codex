import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import type { Database } from '../auth.ts';
import { logEvent } from '../log.ts';
import type { BearerIdentity } from './oauth.ts';
import { buildMcpPrompt, mcpPrompts, type McpPrompt } from './prompts.ts';
import { workLanguage } from '../language.ts';
import { workPreferences } from '../assistant-preferences.ts';
import { callMcpTool, mcpTools } from './tools.ts';
import { PASS_CARD_HTML, PASS_CARD_MIME, PASS_CARD_URI } from './pass-card.ts';

// The MCP protocol side of the endpoint, on the official SDK. Stateless: a
// server is built for each request from the connection the route resolved,
// and holds nothing afterwards, so there is no session to keep or to steal.

const INSTRUCTIONS =
	"Codex holds a writer's fiction: universes, the stories in them, their chapters and scenes, and entries for characters, places and lore. Start with list_universes, then pass a universe id to the other tools. You cannot change, delete or publish anything. If you were allowed to suggest, your edits and comments wait in the writer's review, and the writer accepts or rejects each one there. list_review_notes and get_review_note show what the writer decided and what they answered; reply_in_thread answers them. The prompts carry the instructions for the writer's usual work, such as a review, a copyedit, a continuity review, a pattern pass, a draft or a recap.";

type Connection = { db: Database; identity: BearerIdentity; origin: string };

// A tool's argument schema is the same for every request, and compiling its
// validator is the costly part of building a server, so it is done once.
const schemas = new Map<string, ReturnType<typeof fromJsonSchema<Record<string, unknown>>>>();
function schemaFor(name: string, inputSchema: Record<string, unknown>) {
	let schema = schemas.get(name);
	if (!schema) {
		schema = fromJsonSchema<Record<string, unknown>>(inputSchema);
		schemas.set(name, schema);
	}
	return schema;
}

// A prompt's arguments are all text; the prompt checks each one itself.
function promptSchema(prompt: McpPrompt) {
	return schemaFor(`prompt:${prompt.name}`, {
		type: 'object',
		properties: Object.fromEntries(
			prompt.arguments.map((argument) => [
				argument.name,
				{ type: 'string', description: argument.description }
			])
		),
		required: prompt.arguments.filter((argument) => argument.required).map((a) => a.name)
	});
}

function buildServer(connection: Connection): McpServer {
	const server = new McpServer({ name: 'codex', version: '1' }, { instructions: INSTRUCTIONS });
	const tools = mcpTools(connection.identity.permissions);
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: schemaFor(tool.name, tool.inputSchema),
				annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
				// MCP Apps: the card the client shows for the tool, and who may call
				// it. 'ui/resourceUri' is the older spelling some clients still read.
				...(tool.ui ? { _meta: { ui: tool.ui, 'ui/resourceUri': tool.ui.resourceUri } } : {})
			},
			async (args) => {
				const result = await callMcpTool(
					connection.db,
					connection.identity,
					tool.name,
					args,
					connection.origin
				);
				return {
					content: [{ type: 'text', text: result.text }],
					isError: result.isError,
					...(result.structured ? { structuredContent: result.structured } : {}),
					...(result.meta ? { _meta: result.meta } : {})
				};
			}
		);
	}
	// The guided pass card, for a connection that may be shown it. It is the
	// same page for everyone and holds no data: the pass comes with the tool
	// result.
	if (tools.some((tool) => tool.ui)) {
		server.registerResource(
			'guided-pass',
			PASS_CARD_URI,
			{
				title: 'Guided pass',
				description: 'A card for working through the edits of a pattern note.',
				mimeType: PASS_CARD_MIME,
				_meta: { ui: { prefersBorder: true } }
			},
			async () => ({
				contents: [
					{
						uri: PASS_CARD_URI,
						mimeType: PASS_CARD_MIME,
						text: PASS_CARD_HTML,
						_meta: { ui: { prefersBorder: true } }
					}
				]
			})
		);
	}
	const { identity } = connection;
	for (const prompt of mcpPrompts(identity.permissions)) {
		server.registerPrompt(
			prompt.name,
			{ title: prompt.title, description: prompt.description, argsSchema: promptSchema(prompt) },
			async (args) => {
				logEvent('info', 'mcp.prompt', {
					userId: identity.userId,
					grantId: identity.grantId,
					client: identity.client.host,
					prompt: prompt.name
				});
				const text = buildMcpPrompt(prompt.name, args, {
					permissions: identity.permissions,
					language: await workLanguage(connection.db, identity.userId, args),
					preferences: await workPreferences(connection.db, identity.userId, args)
				});
				return { messages: [{ role: 'user', content: { type: 'text', text } }] };
			}
		);
	}
	return server;
}

// One handler for the process. The route passes the resolved connection with
// each request; the SDK hands it to the factory untouched and never reads a
// credential itself.
const handler = createMcpHandler(
	(context) => buildServer(context.authInfo!.extra!.connection as Connection),
	{
		onerror: (error) => logEvent('warn', 'mcp.protocol_error', { message: error.message }),
		// Nothing here publishes change events, so a stream that waits for them
		// would only stay open, past the end of the token that opened it.
		maxSubscriptions: 0
	}
);

export function serveMcp(request: Request, connection: Connection): Promise<Response> {
	return handler.fetch(request, {
		authInfo: {
			// The SDK's shape wants these; the tools use the connection only.
			token: '',
			clientId: connection.identity.client.id,
			scopes: connection.identity.permissions,
			extra: { connection }
		}
	});
}

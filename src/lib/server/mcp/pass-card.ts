import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isUuid } from '../../slug.ts';
import { paragraphWindow } from '../../paragraphs.ts';
import { patternEdits, patternName } from '../../review-ui.ts';
import { createAnchorMapper } from '../../review-anchor.ts';
import type { Database } from '../auth.ts';
import { signToken, verifyToken } from '../crypto.ts';
import {
	chapters,
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories
} from '../db/schema.ts';
import { queueSceneMentions } from '../jobs.ts';
import { decideSuggestion, isOwnNote, listSuggestions, type MachineAuthor } from '../review.ts';
import { storyAssistantOn } from '../universe-scope.ts';
import { logEvent } from '../log.ts';
import {
	APP_DIFF_BUDGET,
	STAGING_LOCK_TIMEOUT_MS,
	STAGING_TRANSACTION_TIMEOUT_MS
} from './constants.ts';
import { stagingKey } from './call-gate.ts';

// Postgres: a lock was not available within lock_timeout.
const LOCK_NOT_AVAILABLE = '55P03';
import type { BearerIdentity } from './oauth.ts';
import cardHtml from './pass-card.html?raw';

// The guided pass over one of an app's pattern notes, shown as a card inside
// the app itself (MCP Apps). The card is a small page the client loads from
// PASS_CARD_URI; it gets the pass from open_guided_pass and accepts an edit
// with decide_suggestion.
//
// Both tools are offered over MCP only, and only to a connection the writer
// gave the apply permission: they are the listed exceptions to "one toolbox
// for both" (see assistant.md). They are not in the Assistant's registry, so
// no model run inside Codex can be handed decide_suggestion. The client hides
// decide_suggestion from its model and lets only the card call it; that is
// the real guard. Codex cannot see who pressed what, so the call must also
// carry the card key that came with the pass in the result's _meta, which
// the reference client passes to the card. Whether a client keeps _meta from
// its model is not promised, so the key narrows the risk and does not close it.

export const PASS_CARD_URI = 'ui://codex/guided-pass.html';
export const PASS_CARD_MIME = 'text/html;profile=mcp-app';
export const PASS_CARD_HTML: string = cardHtml;
// Where the card keys travel in a result's _meta: one per edit the writer may
// accept, by edit id.
export const CARD_KEY_META = 'codex/cardKeys';

const CARD_KEY_TTL_MS = 2 * 60 * 60 * 1000;
// The most edits a pass sends, of those waiting and of those decided. A note
// rarely holds more; the rest wait in Codex.
export const MAX_CARD_EDITS = 50;
// About the most characters of text a pass sends; edits past it wait in Codex.
export const MAX_CARD_CHARS = 100_000;
// How much of the paragraph on each side of a change the card shows.
const CONTEXT_CHARS = 600;
// How much of a decided edit's words the card shows, and of one it cannot
// place.
const DECIDED_CHARS = 300;
// The most characters of passage and wording together for an edit the writer
// may accept on the card. A longer one is shown cut short and cannot be
// accepted there: a cut wording must never be what an accept writes.
export const MAX_CARD_EDIT_CHARS = 20_000;
// How much of an edit's reason the card shows.
const REASON_CHARS = 2000;

export type CardToolName = 'open_guided_pass' | 'decide_suggestion';

export type CardTool = {
	name: CardToolName;
	description: string;
	inputSchema: Record<string, unknown>;
	// Which call budget and queue it takes: reading, or the staging calls'.
	kind: 'read' | 'write';
	// Who may call it: the model and the card, or the card alone.
	visibility: ('model' | 'app')[];
};

const str = (description: string) => ({ type: 'string', description });

const NOTE_ARGUMENTS = {
	universeId: str('The id of the universe the note is in, from list_universes.'),
	noteId: str('The id of a pattern note of yours, from list_review_notes.')
};

export const CARD_TOOLS: CardTool[] = [
	{
		name: 'open_guided_pass',
		kind: 'read',
		visibility: ['model', 'app'],
		description:
			"Show the writer a card where they work through the edits of one of your pattern notes, one at a time: accept, reword or skip each. Only the writer decides, by pressing the card's buttons; you cannot. Call it when the writer asks to go through a note here. Afterwards get_review_note shows what they decided.",
		inputSchema: {
			type: 'object',
			properties: NOTE_ARGUMENTS,
			required: ['universeId', 'noteId'],
			additionalProperties: false
		}
	},
	{
		name: 'decide_suggestion',
		kind: 'write',
		visibility: ['app'],
		description:
			"The guided pass card's Accept button. Only the card calls this, when the writer presses Accept; never call it yourself.",
		inputSchema: {
			type: 'object',
			properties: {
				...NOTE_ARGUMENTS,
				suggestionId: str('The id of the edit to accept.'),
				seen: str('The stamp of the wording the writer was shown.'),
				cardKey: str('The key the card was given with this edit.'),
				replacement: str("Optional: the writer's own wording, to accept in place of the edit's.")
			},
			required: ['universeId', 'noteId', 'suggestionId', 'seen', 'cardKey'],
			additionalProperties: false
		}
	}
];

export function cardTool(name: string): CardTool | undefined {
	return CARD_TOOLS.find((tool) => tool.name === name);
}

export type CardEdit = {
	id: string;
	status: 'pending' | 'accepted' | 'rejected';
	sceneTitle: string | null;
	chapterTitle: string | null;
	// The paragraph around the change as the scene reads now, for an edit still
	// waiting that could be found; empty otherwise.
	before: string;
	after: string;
	// The words the edit replaces, and what it puts in their place (for an
	// accepted edit, what was applied).
	text: string;
	replacement: string;
	reason: string | null;
	// Sent back with an accept, so a revision made meanwhile is not taken.
	stamp: string | null;
	followUp: boolean;
	// False for an edit still waiting whose spot can no longer be found, or
	// that is too long to show whole: it can only be skipped here.
	placed: boolean;
	// Not placed because it is too long for the card; the writer decides it in
	// Codex.
	tooLong?: boolean;
};

export type PassCard = {
	universeId: string;
	noteId: string;
	storyTitle: string;
	name: string;
	// The same pass in Codex.
	link: string;
	edits: CardEdit[];
	// Edits still waiting that MAX_CARD_EDITS left out.
	more: number;
};

export type CardResult = {
	text: string;
	isError: boolean;
	// The connection or the universe went while the call waited.
	refused?: boolean;
	// Another call held the writer's lock; nothing was done.
	busy?: boolean;
	structured?: Record<string, unknown>;
	meta?: Record<string, unknown>;
};

export type CardCall = {
	db: Database;
	identity: BearerIdentity;
	universeId: string;
	args: Record<string, unknown>;
	origin: string;
	// Asked inside the accept's transaction: whether the connection and the
	// universe are still good (see the staging calls in dispatch.ts).
	stillAllowed: (tx: Database) => Promise<boolean>;
};

const NO_NOTE = 'No pattern note of yours with that id.';

function author(identity: BearerIdentity): MachineAuthor {
	return {
		client: {
			id: identity.client.id,
			name: identity.client.clientName,
			host: identity.client.host
		}
	};
}

// A key for one edit as the writer was shown it: this connection, this note,
// this edit and this wording. A revision needs a new pass, and so a new key.
type KeyTarget = { grantId: string; noteId: string; suggestionId: string; stamp: string };

function cardKey(target: KeyTarget): string {
	const { grantId, noteId, suggestionId, stamp } = target;
	return signToken(
		`pass-card.${grantId}.${noteId}.${suggestionId}.${stamp}.${Date.now() + CARD_KEY_TTL_MS}`
	);
}

export function cardKeyValid(key: unknown, target: KeyTarget): boolean {
	if (typeof key !== 'string') return false;
	const payload = verifyToken(key);
	if (!payload) return false;
	const [purpose, grant, note, suggestion, stamp, expires, extra] = payload.split('.');
	return (
		extra === undefined &&
		purpose === 'pass-card' &&
		grant === target.grantId &&
		note === target.noteId &&
		suggestion === target.suggestionId &&
		stamp === target.stamp &&
		Number.isFinite(Number(expires)) &&
		Date.now() <= Number(expires)
	);
}

// The note's story, when the note is one this app opened in a live, unmuted
// story of the connected writer in this universe, on a scene not in the trash.
async function noteStory(
	call: CardCall,
	noteId: string
): Promise<{ storyId: string; storyTitle: string; sceneId: string; opening: string } | null> {
	if (!isUuid(noteId)) return null;
	const { db, identity, universeId } = call;
	const [row] = await db
		.select({
			storyId: stories.id,
			storyTitle: stories.title,
			sceneId: reviewThreads.sceneId
		})
		.from(reviewThreads)
		.innerJoin(stories, eq(reviewThreads.storyId, stories.id))
		.innerJoin(scenes, eq(reviewThreads.sceneId, scenes.id))
		.where(
			and(
				eq(reviewThreads.id, noteId),
				isNull(reviewThreads.suggestionId),
				eq(stories.universeId, universeId),
				eq(stories.ownerId, identity.userId),
				isNull(stories.deletedAt),
				isNull(scenes.deletedAt),
				storyAssistantOn()
			)
		);
	if (!row || !(await isOwnNote(db, noteId, author(identity)))) return null;
	const [opening] = await db
		.select({ body: reviewComments.bodyMd })
		.from(reviewComments)
		.where(eq(reviewComments.threadId, noteId))
		.orderBy(asc(reviewComments.createdAt), asc(reviewComments.id))
		.limit(1);
	return { ...row, opening: opening?.body ?? '' };
}

function clipStart(text: string): string {
	return text.length <= CONTEXT_CHARS ? text : `...${text.slice(text.length - CONTEXT_CHARS)}`;
}
function clipEnd(text: string, chars = CONTEXT_CHARS): string {
	return text.length <= chars ? text : `${text.slice(0, chars)}...`;
}

async function buildPass(
	call: CardCall,
	noteId: string,
	note: { storyId: string; storyTitle: string; sceneId: string; opening: string }
): Promise<PassCard> {
	const { db } = call;
	const suggestions = await listSuggestions(
		db,
		note.storyId,
		undefined,
		createAnchorMapper(APP_DIFF_BUDGET),
		{ patternThreadId: noteId }
	);
	const sceneIds = [...new Set(suggestions.map((s) => s.sceneId))];
	const sceneRows = sceneIds.length
		? await db
				.select({
					id: scenes.id,
					title: scenes.title,
					bodyMd: scenes.bodyMd,
					position: scenes.globalPosition,
					chapterTitle: chapters.title
				})
				.from(scenes)
				.leftJoin(chapters, eq(scenes.chapterId, chapters.id))
				.where(and(inArray(scenes.id, sceneIds), isNull(scenes.deletedAt)))
				.orderBy(asc(scenes.globalPosition))
		: [];
	const sceneById = new Map(sceneRows.map((scene) => [scene.id, scene]));
	const ordered = patternEdits(
		suggestions.filter((s) => sceneById.has(s.sceneId)),
		noteId,
		sceneRows.map((scene) => scene.id)
	);
	const waiting = ordered.filter((s) => s.status === 'pending');
	const decided = ordered.filter((s) => s.status !== 'pending');
	const shown = [...decided.slice(0, MAX_CARD_EDITS), ...waiting.slice(0, MAX_CARD_EDITS)];

	const all = shown.map((s): CardEdit => {
		const scene = sceneById.get(s.sceneId)!;
		const base = {
			id: s.id,
			status: s.status,
			sceneTitle: scene.title,
			chapterTitle: scene.chapterTitle ?? null,
			reason: s.reason === null ? null : clipEnd(s.reason, REASON_CHARS),
			followUp: s.followsId !== null
		};
		// Shown cut short and never given a key (see passResult): it cannot be
		// accepted on the card.
		const unplaced = (text: string, tooLong = false): CardEdit => ({
			...base,
			before: '',
			after: '',
			text: clipEnd(text, DECIDED_CHARS),
			replacement: clipEnd(s.replacement, DECIDED_CHARS),
			stamp: s.status === 'pending' ? (s.stamp ?? null) : null,
			placed: s.status !== 'pending',
			...(tooLong ? { tooLong } : {})
		});
		if (s.status !== 'pending') return unplaced(s.original);
		if (!s.anchor) return unplaced(s.original);
		const body = scene.bodyMd;
		const text = body.slice(s.anchor.start, s.anchor.end);
		if (text.length + s.replacement.length > MAX_CARD_EDIT_CHARS) return unplaced(text, true);
		const span = paragraphWindow(body, s.anchor.start, s.anchor.end);
		return {
			...base,
			before: clipStart(body.slice(Math.min(span.start, s.anchor.start), s.anchor.start)),
			after: clipEnd(body.slice(s.anchor.end, Math.max(span.end, s.anchor.end))),
			text,
			replacement: s.replacement,
			stamp: s.stamp ?? null,
			placed: true
		};
	});

	// Held to a size a client takes in one result: an edit that would go past
	// it waits in Codex, counted in `more`. Each edit is bounded above, so the
	// first one, always sent, fits too.
	const edits: CardEdit[] = [];
	let size = 0;
	for (const edit of all) {
		size += edit.before.length + edit.text.length + edit.replacement.length + edit.after.length;
		size += (edit.reason?.length ?? 0) + (edit.sceneTitle?.length ?? 0);
		size += edit.chapterTitle?.length ?? 0;
		if (size > MAX_CARD_CHARS && edits.length > 0) break;
		edits.push(edit);
	}
	const left = edits.filter((edit) => edit.status === 'pending').length;
	return {
		universeId: call.universeId,
		noteId,
		storyTitle: note.storyTitle,
		name: patternName(note.opening),
		link: `${call.origin}/stories/${note.storyId}/review?scene=${note.sceneId}&pass=${noteId}`,
		edits,
		more: waiting.length - left
	};
}

function passSummary(pass: PassCard): string {
	const waiting = pass.edits.filter((edit) => edit.status === 'pending').length;
	const decided = pass.edits.length - waiting;
	return `The guided pass on the note "${pass.name}" is open in a card: ${waiting} edits waiting, ${decided} decided. The writer accepts, rewords or skips each edit there; you cannot decide them. Use get_review_note to see what they decided. If no card shows, the writer can work through the note in Codex: ${pass.link}`;
}

function passResult(call: CardCall, pass: PassCard, text: string): CardResult {
	const keys = Object.fromEntries(
		pass.edits
			.filter((edit) => edit.status === 'pending' && edit.placed && edit.stamp)
			.map((edit) => [
				edit.id,
				cardKey({
					grantId: call.identity.grantId,
					noteId: pass.noteId,
					suggestionId: edit.id,
					stamp: edit.stamp!
				})
			])
	);
	return {
		text,
		isError: false,
		structured: pass as unknown as Record<string, unknown>,
		meta: { [CARD_KEY_META]: keys }
	};
}

async function openGuidedPass(call: CardCall): Promise<CardResult> {
	const noteId = typeof call.args.noteId === 'string' ? call.args.noteId : '';
	const note = await noteStory(call, noteId);
	if (!note) return { text: NO_NOTE, isError: true };
	const pass = await buildPass(call, noteId, note);
	if (pass.edits.length === 0) {
		return { text: 'That note has no edits to work through.', isError: true };
	}
	return passResult(call, pass, passSummary(pass));
}

const ACCEPT_BUSY = 'Another call is still running. Try again.';

// The card's Accept. Run like a staging call: one transaction with a short
// lock wait and an end, the writer's staging lock, and the connection checked
// again inside it. The pass is built again by the caller, outside the place
// in the queue this takes.
async function decide(call: CardCall): Promise<CardResult> {
	const { args, identity } = call;
	const noteId = typeof args.noteId === 'string' ? args.noteId : '';
	const suggestionId = typeof args.suggestionId === 'string' ? args.suggestionId : '';
	const seen = typeof args.seen === 'string' ? args.seen : '';
	if (
		!cardKeyValid(args.cardKey, { grantId: identity.grantId, noteId, suggestionId, stamp: seen })
	) {
		return {
			text: 'Only the guided pass card can accept an edit. Open the pass again.',
			isError: true
		};
	}
	const replacement = args.replacement;
	if (replacement !== undefined && typeof replacement !== 'string') {
		return { text: 'The wording must be text.', isError: true };
	}
	if (replacement?.includes('\u0000')) {
		return { text: 'The wording holds a character that cannot be saved.', isError: true };
	}
	try {
		const result = await call.db.transaction(async (tx): Promise<CardResult> => {
			await tx.execute(sql.raw(`set local lock_timeout = ${STAGING_LOCK_TIMEOUT_MS}`));
			await tx.execute(
				sql.raw(`set local transaction_timeout = ${STAGING_TRANSACTION_TIMEOUT_MS}`)
			);
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${stagingKey(identity.userId)}))`);
			if (!(await call.stillAllowed(tx))) return { text: '', isError: true, refused: true };
			const inTx = { ...call, db: tx };
			const note = await noteStory(inTx, noteId);
			if (!note) return { text: NO_NOTE, isError: true };
			// The edit must be one of this note's, whoever staged it, on a scene
			// that is not in the trash.
			const [edit] = isUuid(suggestionId)
				? await tx
						.select({ id: reviewSuggestions.id })
						.from(reviewSuggestions)
						.innerJoin(scenes, eq(reviewSuggestions.sceneId, scenes.id))
						.where(
							and(
								eq(reviewSuggestions.id, suggestionId),
								eq(reviewSuggestions.storyId, note.storyId),
								eq(reviewSuggestions.patternThreadId, noteId),
								isNull(scenes.deletedAt)
							)
						)
				: [];
			if (!edit) return { text: 'That edit is not part of this note.', isError: true };
			const decided = await decideSuggestion(
				tx,
				identity.userId,
				note.storyId,
				suggestionId,
				true,
				replacement,
				seen,
				createAnchorMapper(APP_DIFF_BUDGET)
			);
			if (!decided.ok) return { text: decided.reason, isError: true };
			return { text: 'Accepted.', isError: false, structured: { sceneId: decided.sceneId } };
		});
		const sceneId = result.structured?.sceneId;
		// The accept has been stored; a failure to queue the mention update
		// must not report it as failed.
		if (typeof sceneId === 'string') {
			await queueSceneMentions(sceneId).catch(() =>
				logEvent('warn', 'mcp.card_mentions_not_queued', { sceneId })
			);
		}
		return result.isError ? result : { text: result.text, isError: false };
	} catch (err) {
		const code = (err as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code;
		if (code === LOCK_NOT_AVAILABLE) return { text: ACCEPT_BUSY, isError: true, busy: true };
		throw err;
	}
}

export async function callCardTool(name: CardToolName, call: CardCall): Promise<CardResult> {
	return name === 'open_guided_pass' ? openGuidedPass(call) : decide(call);
}

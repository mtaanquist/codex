import { and, asc, desc, eq, getTableName, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { entityMentions, revisions, scenes, stories } from '../db/schema.ts';
import { errorFields, logEvent } from '../log.ts';
import {
	AssistantDisabledError,
	completeDetailed,
	NoModelError,
	ReplyCutOffError,
	type GatewayDeps
} from './gateway.ts';
import { SpendCapError, spentFields, type SpendMeter } from './spend.ts';
import { estimateTokens } from './context/budgets.ts';
import { jobSpendMeter } from './job-spend.ts';
import { buildEnrichMessage, buildEnrichTextMessage } from './prompts/enrich.ts';
import {
	ENRICH_TEXT_REPLY_TOKENS,
	enrichTextBudget,
	entityExcerpts,
	excerptsWithheld,
	estimateEnrich,
	formatExcerpts,
	splitExcerptParts,
	type EnrichEstimate,
	type ExcerptScene,
	type EnrichMode,
	type EnrichTextMode
} from './enrich-context.ts';
import { entityAppearances, type PlanAppearance } from '../plan-data.ts';
import {
	ENTITY_TYPES,
	entityAliasColumn,
	entityNameColumn,
	entityTable,
	resolveOwnedEntity,
	type EntityType
} from '../entity-lookups.ts';
import { inLiveUniverse, storyAssistantOn } from '../universe-scope.ts';
import {
	stageEntitySuggestions,
	summarySuggestionClosed,
	type EntitySuggestion,
	type ProposedSuggestion
} from '../entity-suggestions.ts';
import type { ChatMessage } from './providers/types.ts';
import { requestHash, unusableReplyMark } from './request-hash.ts';
import { resolveLlmConfig, roleReplySettings } from './config.ts';

// Inline per-entity enrichment: gather where an entity appears (in one story, or
// across its universe), ask the Assistant for new aliases, quick details, and a
// summary, and stage the result as suggestions the writer accepts or rejects.
// Sync (one completion), like single-scene review. Nothing is applied here -
// stageEntitySuggestions only stages.

export type EnrichScope = { storyId: string } | { universeId: string };

export const MAX_APPEARANCES = 16;
const MAX_ENRICH_TOKENS = 700;
// Failed reads in a row after which the pass stops rather than keep calling an
// endpoint that is down. A cut-off reply is not counted: the endpoint answered.
export const MAX_FAILURES_IN_A_ROW = 3;
const CUT_OFF_ADVICE =
	'The suggestions were cut off at the reply limit. Raise Longest reply for Background work in its Tune window under Account, Assistant.';

// Defensive parse of the model's reply into proposals. Endpoints vary, so this
// pulls the first JSON object out of the text and validates each field, ignoring
// anything malformed rather than throwing. Lore takes keywords, not aliases, but
// the suggestion field is 'alias' either way (applied to the right column on
// accept). Exported for unit testing.
export function parseEnrichResponse(text: string): ProposedSuggestion[] {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== 'object') return [];
	const obj = parsed as { aliases?: unknown; details?: unknown; summary?: unknown };
	const proposals: ProposedSuggestion[] = [];

	if (Array.isArray(obj.aliases)) {
		for (const a of obj.aliases) {
			if (typeof a === 'string' && a.trim()) proposals.push({ field: 'alias', value: a.trim() });
		}
	}
	if (Array.isArray(obj.details)) {
		for (const d of obj.details) {
			if (d && typeof d === 'object') {
				const label = (d as { label?: unknown }).label;
				const value = (d as { value?: unknown }).value;
				if (
					typeof label === 'string' &&
					typeof value === 'string' &&
					label.trim() &&
					value.trim()
				) {
					proposals.push({ field: 'detail', label: label.trim(), value: value.trim() });
				}
			}
		}
	}
	if (typeof obj.summary === 'string' && obj.summary.trim()) {
		proposals.push({ field: 'summary', value: obj.summary.trim() });
	}
	return proposals;
}

// Up to max appearances, chosen from each story in turn so a universe-wide read
// is not filled by whichever story comes first, then returned in their original
// (reading) order. Exported for unit testing.
export function spreadAppearances<T extends { storyId: string }>(rows: T[], max: number): T[] {
	const byStory = new Map<string, number[]>();
	rows.forEach((row, index) => {
		const list = byStory.get(row.storyId);
		if (list) list.push(index);
		else byStory.set(row.storyId, [index]);
	});
	const queues = [...byStory.values()];
	const picked: number[] = [];
	for (let round = 0; picked.length < max; round++) {
		const before = picked.length;
		for (const queue of queues) {
			if (round < queue.length && picked.length < max) picked.push(queue[round]);
		}
		if (picked.length === before) break;
	}
	return picked.sort((a, b) => a - b).map((index) => rows[index]);
}

function snippetLine(a: PlanAppearance, withStory: boolean): string {
	const where = [withStory ? a.storyTitle : '', a.sceneTitle ?? ''].filter(Boolean).join(' / ');
	return where ? `[${where}] ${a.snippet}` : a.snippet;
}

type EnrichOptions = {
	userId: string;
	scope: EnrichScope;
	entityId: string;
	meter?: SpendMeter;
	signal?: AbortSignal;
};

export async function enrichEntity(
	db: Database,
	opts: EnrichOptions,
	deps: GatewayDeps = {}
): Promise<EntitySuggestion[]> {
	const request = await enrichRequest(db, opts);
	if (!request) return [];
	return await sendEnrichRequest(db, opts, request, deps);
}

// Proposals from a later part of a long read added to those found so far. An
// alias or a detail label already found is kept as first found, and so is the
// summary, which goes last: staging stops at a summary. Exported for unit
// testing.
export function mergeProposals(
	found: ProposedSuggestion[],
	more: ProposedSuggestion[]
): ProposedSuggestion[] {
	const key = (p: ProposedSuggestion) =>
		p.field === 'summary'
			? 'summary'
			: `${p.field}:${(p.field === 'detail' ? p.label : p.value).toLowerCase()}`;
	const seen = new Set(found.map(key));
	const merged = [...found];
	for (const proposal of more) {
		if (seen.has(key(proposal))) continue;
		seen.add(key(proposal));
		merged.push(proposal);
	}
	return [
		...merged.filter((p) => p.field !== 'summary'),
		...merged.filter((p) => p.field === 'summary')
	];
}

export type EnrichTextResult = {
	suggestions: EntitySuggestion[];
	// Scenes read and requests made.
	scenes: number;
	requests: number;
	// Set when a later part failed or the request was stopped: the suggestions
	// are from the parts read before it. partialNote says what to do about it
	// when there is something the writer can do.
	partial?: boolean;
	partialNote?: string;
	// Set when the spend cap stopped the read between parts, with what it had
	// spent.
	capped?: boolean;
	spentUsd?: number;
	// Set when the entity is not the user's, or not in the scope's universe.
	missing?: boolean;
	// Set when stories muted or trashed since the read was queued left nothing
	// to read ('all'), or took the part the summary is asked from ('summary').
	skipped?: 'all' | 'summary';
};

// The entity a read or an estimate is about, when it is the user's and in the
// universe the scope reads from; null otherwise.
export async function enrichTarget(
	db: Database,
	opts: { userId: string; scope: EnrichScope; entityId: string }
): Promise<{ kind: 'character' | 'place' | 'lore'; name: string; universeId: string } | null> {
	const entity = await resolveOwnedEntity(db, opts.userId, opts.entityId, (table) => ({
		universeId: table.universeId,
		name: entityNameColumn(table)
	}));
	if (!entity) return null;
	if (!(await entityInScope(db, opts.userId, opts.scope, entity.universeId))) return null;
	const kind = entity.type === 'lore_entry' ? ('lore' as const) : entity.type;
	return { kind, name: entity.name, universeId: entity.universeId };
}

// Whether the entity belongs to the universe the scope reads from: the named
// universe, or the story's own.
async function entityInScope(
	db: Database,
	userId: string,
	scope: EnrichScope,
	universeId: string
): Promise<boolean> {
	if ('universeId' in scope) return scope.universeId === universeId;
	const [story] = await db
		.select({ universeId: stories.universeId })
		.from(stories)
		.where(and(eq(stories.id, scope.storyId), eq(stories.ownerId, userId)));
	return story?.universeId === universeId;
}

// The parts as the Assistant may still read them: each part's scenes whose
// story is not muted or trashed. A universe-wide read covers several stories
// and the gateway checks a story's mute only on a request scoped to that story,
// so the parts left are checked before each one is sent: a story muted or
// trashed while earlier parts are read is left out of the rest.
async function stillReadable(
	db: Database,
	scope: EnrichScope,
	parts: ExcerptScene[][]
): Promise<ExcerptScene[][]> {
	if (!('universeId' in scope)) return parts;
	const ids = [...new Set(parts.flat().map((scene) => scene.storyId))];
	const open = await db
		.select({ id: stories.id })
		.from(stories)
		.where(and(inArray(stories.id, ids), isNull(stories.deletedAt), storyAssistantOn()));
	const readable = new Set(open.map((row) => row.id));
	return parts.map((part) => part.filter((scene) => readable.has(scene.storyId)));
}

// The button's read, run as a background job: the full text of the scenes that
// mention the entity with the scene before and after each, or the whole book.
// Text that does not fit one request is read in parts in reading order, each
// told what the earlier ones found. Each part's finds are staged as it is
// read, so a later part that fails, or a job that is stopped, keeps what the
// earlier parts found. With a job id the spend cap applies between parts.
// A read that ran to the end and read every scene the /enrich pass would
// stores that pass's fingerprint, so the pass does not read the entity again
// until its input changes.
export async function enrichEntityFromText(
	db: Database,
	opts: EnrichOptions & { mode: EnrichTextMode; jobId?: string },
	deps: GatewayDeps = {}
): Promise<EnrichTextResult> {
	const none = { suggestions: [], scenes: 0, requests: 0 };
	const missing = { ...none, missing: true };
	const entity = await resolveOwnedEntity(db, opts.userId, opts.entityId, (table) => ({
		universeId: table.universeId,
		name: entityNameColumn(table),
		aliases: entityAliasColumn(table),
		details: table.details,
		summaryMd: table.summaryMd
	}));
	if (!entity) return missing;
	if (!(await entityInScope(db, opts.userId, opts.scope, entity.universeId))) return missing;
	const kind = entity.type === 'lore_entry' ? ('lore' as const) : entity.type;
	// Taken before the read, as the pass does, so an edit made while the model
	// reads leaves it behind.
	const passRequest = await enrichFingerprint(db, {
		userId: opts.userId,
		scope: { universeId: entity.universeId },
		entityId: opts.entityId,
		type: entity.type
	});

	const excerpts = await entityExcerpts(db, { ...opts, kind });
	if (excerpts.length === 0) {
		// Muted or trashed stories hold the only scenes it would read.
		const withheld = await excerptsWithheld(db, { ...opts, kind });
		return withheld ? { ...none, skipped: 'all' } : none;
	}
	const budget = await enrichTextBudget(db, opts.userId, opts.scope);
	const parts = splitExcerptParts(excerpts, budget.partTokens);
	// Keyed by the job, so a retry carries on from what it already spent.
	const meter =
		opts.meter ??
		(await jobSpendMeter(db, {
			userId: opts.userId,
			storyId: 'storyId' in opts.scope ? opts.scope.storyId : undefined,
			jobId: opts.jobId
		}));
	const withStory = new Set(excerpts.map((scene) => scene.storyId)).size > 1;
	const summaryClosed = await summarySuggestionClosed(db, {
		ownerId: opts.userId,
		kind,
		entityId: opts.entityId,
		summaryMd: entity.summaryMd
	});
	const fields = {
		kind,
		name: entity.name,
		aliases: entity.aliases ?? [],
		details: entity.details ?? [],
		summaryMd: entity.summaryMd
	};

	let found: ProposedSuggestion[] = [];
	const suggestions: EntitySuggestion[] = [];
	let requests = 0;
	let failure: unknown;
	let capped = false;
	let summaryAsked = false;
	// Pieces in a part whose reply came back whole. A long scene is split into
	// pieces that share its id (stillReadable keeps the same objects), so a
	// scene counts as read only when every piece of it is here.
	const readPieces = new Set<ExcerptScene>();
	for (const index of parts.keys()) {
		if (opts.signal?.aborted) {
			failure = opts.signal.reason ?? new Error('stopped');
			break;
		}
		if (meter.capReached) {
			capped = true;
			break;
		}
		const [part, ...later] = await stillReadable(db, opts.scope, parts.slice(index));
		if (part.length === 0) continue;
		// The last part with anything left to read, so a story muted after the
		// read began does not take the summary request with its part. Asked
		// once: a story unmuted after an earlier part asked can make a later
		// part last too.
		const last = !summaryAsked && later.every((rest) => rest.length === 0);
		const content = buildEnrichTextMessage(
			// The summary is asked for once, from the last part, which also has
			// what the earlier parts found.
			{ ...fields, hasSummary: summaryClosed || !last },
			formatExcerpts(part, withStory),
			{
				...(parts.length > 1 ? { part: { index: index + 1, total: parts.length } } : {}),
				found: {
					aliases: found.flatMap((p) => (p.field === 'alias' ? [p.value] : [])),
					details: found.flatMap((p) =>
						p.field === 'detail' ? [{ label: p.label, value: p.value }] : []
					)
				}
			}
		);
		try {
			const result = await completeDetailed(
				db,
				{
					userId: opts.userId,
					...opts.scope,
					role: 'utility',
					enableTools: false,
					messages: [{ role: 'user', content }],
					maxTokens: ENRICH_TEXT_REPLY_TOKENS,
					meter,
					signal: opts.signal
				},
				deps
			);
			requests += 1;
			if (last) summaryAsked = true;
			if (result.cutOff) {
				throw new ReplyCutOffError(CUT_OFF_ADVICE);
			}
			for (const piece of part) readPieces.add(piece);
			// A summary offered against the instruction (an earlier part, or one
			// the writer already has or turned down) is dropped.
			const proposals = parseEnrichResponse(result.content).filter(
				(p) => p.field !== 'summary' || (last && !summaryClosed)
			);
			const earlier = new Set(found);
			found = mergeProposals(found, proposals);
			// Only what this part added. Picked out by identity, not position: a
			// part read after the summary's (see last above) adds finds ahead of
			// it, since mergeProposals keeps the summary at the end.
			const fresh = found.filter((p) => !earlier.has(p));
			if (fresh.length) {
				suggestions.push(
					...(await stageEntitySuggestions(db, {
						ownerId: opts.userId,
						kind,
						entityId: opts.entityId,
						proposals: fresh
					}))
				);
			}
		} catch (err) {
			if (err instanceof SpendCapError) capped = true;
			else failure = err;
			break;
		}
	}
	await meter.flush();
	// With nothing found there is nothing to show for the read, so the caller
	// gets the error itself.
	if (failure && found.length === 0) throw failure;
	if (failure) {
		logEvent('error', 'assistant.enrich_text_partial', {
			entityId: opts.entityId,
			requests,
			parts: parts.length,
			...errorFields(failure)
		});
	}
	// A story muted or trashed after the read began can leave nothing to read,
	// or empty the parts after the last one sent, so the summary is never asked
	// for. Said only when the read otherwise ran to the end.
	let skipped: EnrichTextResult['skipped'];
	if (!failure && !capped) {
		if (requests === 0) skipped = 'all';
		else if (!summaryAsked && !summaryClosed) skipped = 'summary';
	}
	// Only a whole read: the pass stores nothing for a failed one. A cut-off
	// reply here says nothing about the pass's shorter request, so no
	// unusableReplyMark is stored either.
	const notRead = new Set(
		parts
			.flat()
			.filter((piece) => !readPieces.has(piece))
			.map((piece) => piece.id)
	);
	const readScenes = new Set([...readPieces].map((piece) => piece.id));
	if (
		passRequest &&
		!failure &&
		!capped &&
		!skipped &&
		passRequest.sceneIds.every((id) => readScenes.has(id) && !notRead.has(id))
	) {
		const table = entityTable(entity.type);
		await db
			.update(table)
			.set({
				assistantEnrichedAt: sql`now()`,
				assistantEnrichedInput: passRequest.input,
				updatedAt: sql`${table.updatedAt}`
			})
			.where(eq(table.id, opts.entityId))
			.catch((err) =>
				logEvent('error', 'assistant.enrich_store_failed', {
					entityId: opts.entityId,
					...errorFields(err)
				})
			);
	}
	return {
		suggestions,
		scenes: new Set(excerpts.map((scene) => scene.id)).size,
		requests,
		...(skipped ? { skipped } : {}),
		...(failure ? { partial: true } : {}),
		// A cut-off reply is something the writer can fix in the settings.
		...(failure instanceof ReplyCutOffError ? { partialNote: failure.message } : {}),
		...(capped ? { capped: true, ...spentFields(meter) } : {})
	};
}

export type { EnrichMode };

// What the button's reads would send for this entity, counted without sending
// anything; null when the entity is not the user's or not in the scope.
export async function estimateEntityEnrich(
	db: Database,
	opts: { userId: string; scope: EnrichScope; entityId: string }
): Promise<EnrichEstimate | null> {
	const entity = await resolveOwnedEntity(db, opts.userId, opts.entityId, (table) => ({
		universeId: table.universeId,
		name: entityNameColumn(table),
		aliases: entityAliasColumn(table),
		details: table.details,
		summaryMd: table.summaryMd
	}));
	if (!entity) return null;
	if (!(await entityInScope(db, opts.userId, opts.scope, entity.universeId))) return null;
	const kind = entity.type === 'lore_entry' ? ('lore' as const) : entity.type;
	const task = buildEnrichTextMessage(
		{
			kind,
			name: entity.name,
			aliases: entity.aliases ?? [],
			details: entity.details ?? [],
			summaryMd: entity.summaryMd,
			hasSummary: false
		},
		''
	);
	return await estimateEnrich(db, { ...opts, kind, taskTokens: estimateTokens(task) });
}

// The request an enrich read of this entity would send as things stand, with
// its fingerprint; null when the entity is not the user's or not in the scope.
export async function enrichRequest(
	db: Database,
	opts: { userId: string; scope: EnrichScope; entityId: string }
): Promise<(EnrichFingerprint & { messages: ChatMessage[] }) | null> {
	const fingerprint = await enrichFingerprint(db, opts);
	if (!fingerprint) return null;
	return { ...fingerprint, messages: await enrichMessages(db, opts.userId, fingerprint) };
}

type EnrichFields = Omit<Parameters<typeof buildEnrichMessage>[0], 'hasSummary'>;

type EnrichFingerprint = {
	kind: 'character' | 'place' | 'lore';
	entityId: string;
	fields: EnrichFields;
	snippets: string[];
	// The scenes the snippets are from.
	sceneIds: string[];
	input: string;
	// The same request's fingerprint as releases up to 3.21.4 stored it, with
	// the entry's aliases and details as they are now, or as given.
	inputAsOf3_21: (known?: Pick<EnrichFields, 'aliases' | 'details'>) => string;
	// What is stored with the entry's last read: a fingerprint, an
	// unusableReplyMark, or null.
	lastInput: string | null;
};

// The fingerprint of the request an enrich read would send, without the
// request itself: whether to ask for a summary is left out of it (see input),
// so the pass works out which entries changed without that query. type, when
// the caller knows it, saves looking in every entity table.
async function enrichFingerprint(
	db: Database,
	opts: { userId: string; scope: EnrichScope; entityId: string; type?: EntityType }
): Promise<EnrichFingerprint | null> {
	const entity = await resolveOwnedEntity(
		db,
		opts.userId,
		opts.entityId,
		(table) => ({
			universeId: table.universeId,
			name: entityNameColumn(table),
			aliases: entityAliasColumn(table),
			details: table.details,
			summaryMd: table.summaryMd,
			lastInput: table.assistantEnrichedInput
		}),
		opts.type ? [opts.type] : undefined
	);
	if (!entity) return null;
	if ('universeId' in opts.scope && entity.universeId !== opts.scope.universeId) return null;
	const kind = entity.type === 'lore_entry' ? ('lore' as const) : entity.type;

	const universeWide = 'universeId' in opts.scope;
	const appearances = await entityAppearances(db, { kind, id: opts.entityId }, opts.scope, {
		assistant: true
	});
	const picked = spreadAppearances(appearances, MAX_APPEARANCES);
	const snippets = picked.map((a) => snippetLine(a, universeWide));

	const fields: EnrichFields = {
		kind,
		name: entity.name,
		aliases: entity.aliases ?? [],
		details: entity.details ?? [],
		summaryMd: entity.summaryMd
	};
	// Hashed as if nothing were recorded on the entry: accepting what a read
	// suggested (an alias, a detail, a summary) would otherwise change the next
	// request, and the same passages would be sent again. An entry is read
	// again when its name or its passages change.
	const input = requestHash([
		{
			role: 'user',
			content: buildEnrichMessage(
				{ ...fields, aliases: [], details: [], hasSummary: false },
				snippets
			)
		}
	]);
	return {
		kind,
		entityId: opts.entityId,
		fields,
		snippets,
		sceneIds: [...new Set(picked.map((a) => a.sceneId))],
		input,
		inputAsOf3_21: (known) => enrichInputAsOf3_21({ ...fields, ...known }, snippets),
		lastInput: entity.lastInput
	};
}

// The messages of the request a fingerprint stands for.
async function enrichMessages(
	db: Database,
	userId: string,
	fingerprint: EnrichFingerprint
): Promise<ChatMessage[]> {
	const hasSummary = await summarySuggestionClosed(db, {
		ownerId: userId,
		kind: fingerprint.kind,
		entityId: fingerprint.entityId,
		summaryMd: fingerprint.fields.summaryMd
	});
	return [
		{
			role: 'user',
			content: buildEnrichMessage({ ...fingerprint.fields, hasSummary }, fingerprint.snippets)
		}
	];
}

// The enrich fingerprint as releases 3.21.3 and 3.21.4 stored it: the entry's
// aliases and details were part of it. A read stored by one of them is
// recognised by this on the first pass after the upgrade and kept without a
// call. Delete it, inputAsOf3_21 and readAsOf3_21InHistory once upgrades
// straight from those releases no longer matter.
function enrichInputAsOf3_21(fields: EnrichFields, snippets: string[]): string {
	return requestHash([
		{ role: 'user', content: buildEnrichMessage({ ...fields, hasSummary: false }, snippets) }
	]);
}

// Whether a read stored under the 3.21.4 fingerprint, with the entry's aliases
// or details edited since, read the request that would be sent now: it
// matches with the aliases and details of a version in the entry's history.
// A match means the name and passages are the ones read, which is all
// today's fingerprint covers.
const HISTORY_VERSIONS_CHECKED = 50;
async function readAsOf3_21InHistory(
	db: Database,
	type: EntityType,
	fingerprint: EnrichFingerprint
): Promise<boolean> {
	const rows = await db
		.select({ snapshot: revisions.snapshot })
		.from(revisions)
		.where(
			and(
				eq(revisions.entityType, type),
				eq(revisions.entityId, fingerprint.entityId),
				isNotNull(revisions.snapshot)
			)
		)
		.orderBy(desc(revisions.createdAt))
		.limit(HISTORY_VERSIONS_CHECKED);
	return rows.some(
		({ snapshot }) =>
			!!snapshot &&
			fingerprint.inputAsOf3_21({
				aliases: (type === 'lore_entry' ? snapshot.keywords : snapshot.aliases) ?? [],
				details: snapshot.details ?? []
			}) === fingerprint.lastInput
	);
}

// Sends the request a fingerprint stands for and stages what comes back.
async function sendEnrichRequest(
	db: Database,
	opts: EnrichOptions,
	request: EnrichFingerprint & { messages?: ChatMessage[] },
	deps: GatewayDeps
): Promise<EntitySuggestion[]> {
	const result = await completeDetailed(
		db,
		{
			userId: opts.userId,
			// A story scope carries its mute and its models; the universe scope
			// carries the universe's models.
			...opts.scope,
			role: 'utility',
			enableTools: false,
			messages: request.messages ?? (await enrichMessages(db, opts.userId, request)),
			maxTokens: MAX_ENRICH_TOKENS,
			meter: opts.meter,
			signal: opts.signal
		},
		deps
	);
	// Cut-off JSON parses to nothing; failing keeps the read from being stored
	// (the pass stores an unusableReplyMark instead).
	if (result.cutOff) {
		throw new ReplyCutOffError(CUT_OFF_ADVICE);
	}

	const proposals = parseEnrichResponse(result.content);
	if (proposals.length === 0) return [];
	return await stageEntitySuggestions(db, {
		ownerId: opts.userId,
		kind: request.kind,
		entityId: opts.entityId,
		proposals
	});
}

export type UniverseEnrichResult = {
	// Entities the pass read, and how many suggestions it staged across them.
	entities: number;
	// Entities passed over because the request is the same as their last read.
	unchanged?: number;
	staged: number;
	failed: number;
	// Why reads failed when replies were cut off at the limit, and how many.
	cutOff?: string;
	cutOffs?: number;
	// Set when the job was stopped (expired, shut down) before the pass finished.
	aborted?: boolean;
	// Set when the Assistant was turned off while the pass ran.
	disabled?: boolean;
	// Set when the pass stopped because no model is chosen for it.
	noModel?: boolean;
	// Set when the pass gave up after MAX_FAILURES_IN_A_ROW failed reads.
	stoppedFailing?: boolean;
	// Set when the spend ceiling stopped the pass early, with what it had spent.
	capped?: boolean;
	spentUsd?: number;
	// Set when spentUsd includes estimated counts, not only reported ones.
	spentEstimated?: boolean;
	// Why a cap that was set could not be enforced.
	capNotApplied?: string;
};

// The universe's entities an enrich pass looks at: those mentioned in at least
// one live scene the Assistant reads. Characters, then places, then lore, each
// by name. Which of them are out of date is worked out one by one, from the
// request each would send.
async function entitiesToEnrich(db: Database, userId: string, universeId: string) {
	const out: { id: string; type: (typeof ENTITY_TYPES)[number] }[] = [];
	for (const type of ENTITY_TYPES) {
		const table = entityTable(type);
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.innerJoin(
				entityMentions,
				and(
					eq(entityMentions.targetType, type),
					eq(entityMentions.targetId, table.id),
					eq(entityMentions.sourceType, 'scene')
				)
			)
			.innerJoin(scenes, eq(scenes.id, entityMentions.sourceId))
			.innerJoin(stories, eq(stories.id, scenes.storyId))
			.where(
				and(
					eq(table.universeId, universeId),
					eq(table.ownerId, userId),
					eq(stories.universeId, universeId),
					isNull(stories.deletedAt),
					isNull(scenes.deletedAt),
					storyAssistantOn(),
					inLiveUniverse(table.universeId)
				)
			)
			.groupBy(table.id, entityNameColumn(table))
			.orderBy(asc(entityNameColumn(table)));
		out.push(...rows.map((row) => ({ id: row.id, type })));
	}
	return out;
}

// A watermark before this is a mark an earlier release set to say "read this
// again", not the time of a read. Only read for entities with no fingerprint.
const LEGACY_MARK_BEFORE = '2000-01-01T00:00:00Z';

// Whether a read stored before fingerprints were (a time, no request hash) is
// still good by the rule of the release that stored it: the time is a real one
// and no live scene that mentions the entity has changed since. Such a read is
// given its fingerprint without paying for it again; any other is read.
async function readBeforeFingerprintsIsCurrent(
	db: Database,
	entity: { id: string; type: (typeof ENTITY_TYPES)[number] },
	universeId: string
): Promise<boolean> {
	const table = sql.identifier(getTableName(entityTable(entity.type)));
	const { rows } = await db.execute<{ current: boolean | null }>(sql`
		select e.assistant_enriched_at >= ${LEGACY_MARK_BEFORE}::timestamptz and not exists (
			select 1 from entity_mentions m
			join scenes s on s.id = m.source_id
			join stories on stories.id = s.story_id
			where m.source_type = 'scene' and m.target_type = ${entity.type} and m.target_id = e.id
				and stories.universe_id = ${universeId}
				and stories.deleted_at is null and s.deleted_at is null
				and ${storyAssistantOn()}
				and s.updated_at > e.assistant_enriched_at
		) as current
		from ${table} e where e.id = ${entity.id}
	`);
	return rows[0]?.current === true;
}

// The background pass: enrich every entity in the universe whose request has
// changed since its last read, staging suggestions for the writer exactly as
// the inline button does. An entity is out of date when the request that
// would be sent now has a different fingerprint from the one stored with its
// last read (assistant_enriched_input); no save marks it. A read is stored
// with the fingerprint of the request it sent, so an edit made while the model
// reads is picked up next time. A failed read is not stored, so the next pass
// tries it again. Stops between entities at the spend cap or when the job is
// stopped, and stops early when the Assistant is turned off or the endpoint
// keeps failing.
export async function enrichUniverse(
	db: Database,
	opts: { userId: string; universeId: string; jobId?: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<UniverseEnrichResult> {
	const { userId, universeId, signal } = opts;
	// Keyed by the job, so a retry carries on from what it already spent.
	const meter = await jobSpendMeter(db, { userId, jobId: opts.jobId });
	let entities = 0;
	let unchanged = 0;
	let staged = 0;
	let failed = 0;
	let capped = false;
	let aborted = false;
	let disabled = false;
	let noModel = false;
	let stoppedFailing = false;
	let failedInARow = 0;
	let cutOff: string | undefined;
	let cutOffs = 0;

	// The model and settings the pass's reads go out on, resolved when first
	// needed.
	let settings: string | undefined;
	const replySettings = async () =>
		(settings ??= roleReplySettings(
			(await resolveLlmConfig(db, userId, { universeId })).config,
			'utility'
		));

	const todo = await entitiesToEnrich(db, userId, universeId);
	for (const [index, entity] of todo.entries()) {
		if (signal?.aborted) {
			aborted = true;
			break;
		}
		if (meter.capReached) {
			capped = true;
			break;
		}
		const table = entityTable(entity.type);
		const scope = { universeId };
		let request: EnrichFingerprint | null = null;
		try {
			request = await enrichFingerprint(db, {
				userId,
				scope,
				entityId: entity.id,
				type: entity.type
			});
			// Deleted since the pass listed it: nothing left to read.
			if (!request) continue;
			const last = request.lastInput;
			if (request.input === last) {
				unchanged += 1;
				continue;
			}
			// The same request was cut off at the reply limit on the same model
			// and settings, and would be again: reported, not sent.
			if (last !== null && last === unusableReplyMark(request.input, await replySettings())) {
				failed += 1;
				cutOff = CUT_OFF_ADVICE;
				cutOffs += 1;
				continue;
			}
			// A read an earlier release stored: the same request under that
			// release's fingerprint (with the aliases and details the entry had
			// then, from its history), or from before fingerprints and nothing it
			// read has changed. Kept under today's fingerprint, with no call.
			if (
				(last !== null &&
					(last === request.inputAsOf3_21() ||
						(await readAsOf3_21InHistory(db, entity.type, request)))) ||
				(last === null && (await readBeforeFingerprintsIsCurrent(db, entity, universeId)))
			) {
				await db
					.update(table)
					.set({ assistantEnrichedInput: request.input, updatedAt: sql`${table.updatedAt}` })
					.where(eq(table.id, entity.id));
				unchanged += 1;
				continue;
			}
			const suggestions = await sendEnrichRequest(
				db,
				{ userId, scope, entityId: entity.id, meter, signal },
				request,
				deps
			);
			// The fingerprint of the request that was sent, not of the entity as it
			// is now: a change made while the model was reading leaves it behind,
			// and the next pass reads the entity again.
			await db
				.update(table)
				.set({
					assistantEnrichedAt: sql`now()`,
					assistantEnrichedInput: request.input,
					updatedAt: sql`${table.updatedAt}`
				})
				.where(eq(table.id, entity.id));
			entities += 1;
			staged += suggestions.length;
			failedInARow = 0;
		} catch (err) {
			if (signal?.aborted) {
				aborted = true;
				break;
			}
			if (err instanceof SpendCapError) {
				capped = true;
				break;
			}
			// Every later entity would be refused the same way.
			if (err instanceof NoModelError) {
				noModel = true;
				break;
			}
			if (err instanceof AssistantDisabledError) {
				disabled = true;
				break;
			}
			logEvent('error', 'assistant.enrich_failed', { entityId: entity.id, ...errorFields(err) });
			failed += 1;
			if (err instanceof ReplyCutOffError) {
				cutOff = err.message;
				cutOffs += 1;
				failedInARow = 0;
				// Kept from being sent again as it is (see unusableReplyMark). The
				// entry is not marked read.
				if (request) {
					const input = request.input;
					await replySettings()
						.then((settings) =>
							db
								.update(table)
								.set({
									assistantEnrichedInput: unusableReplyMark(input, settings),
									updatedAt: sql`${table.updatedAt}`
								})
								.where(eq(table.id, entity.id))
						)
						.catch((markErr) =>
							logEvent('error', 'assistant.enrich_mark_failed', {
								entityId: entity.id,
								...errorFields(markErr)
							})
						);
				}
			} else {
				failedInARow += 1;
				// Only a stop with entities still to read; a pass that failed on its
				// last entity finished anyway.
				if (failedInARow >= MAX_FAILURES_IN_A_ROW && index < todo.length - 1) {
					stoppedFailing = true;
					break;
				}
			}
		}
	}

	await meter.flush();
	return {
		entities,
		...(unchanged ? { unchanged } : {}),
		staged,
		failed,
		...(cutOff ? { cutOff, cutOffs } : {}),
		...(aborted ? { aborted: true } : {}),
		...(disabled ? { disabled: true } : {}),
		...(noModel ? { noModel: true } : {}),
		...(stoppedFailing ? { stoppedFailing: true } : {}),
		...(capped ? { capped: true, ...spentFields(meter) } : {}),
		...(meter.notApplied ? { capNotApplied: meter.notAppliedMessage } : {})
	};
}

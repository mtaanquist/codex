import { storyLanguage } from '../language.ts';
import { storyAssistantPreferences } from '../assistant-preferences.ts';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { assistantUsage, scenes, stories } from '../db/schema.ts';
import {
	assembleSceneDelta,
	assembleStoryFrame,
	buildSystemMessage,
	estimateTokens
} from './context/assemble.ts';
import { cacheWriteRate } from '../../assistant-cost.ts';
import {
	AssistantDisabledError,
	capCeilingUsage,
	ceilingPromptTokens,
	personaMessage,
	webSearchAllowed
} from './gateway.ts';
import type { ChatMessage } from './providers/types.ts';
import { requestCostUsd } from './spend.ts';
import { adapterKind } from './providers/presets.ts';
import {
	DEFAULT_SPEND_WARN_USD,
	modelContextWindow,
	pickModel,
	resolveLlmConfig,
	type ResolvedConfig
} from './config.ts';
import {
	buildSurveyMessage,
	readsWording,
	reviewLanguageText,
	splitSurveyChunks
} from './prompts/review.ts';
import { reviewPreferenceText } from './prompts/preferences.ts';
import { PERSONA_TOKENS } from './context/budgets.ts';
import {
	checkBookFit,
	maxApplyRequests,
	patternSurveyMessages,
	patternSurveyOverhead,
	patternSurveySystem,
	patternSurveyTokens,
	planBookPass,
	reviewerReplyTokens,
	type PatternUnit,
	type WholeBookFit
} from './pattern-pass.ts';
import {
	isFullReview,
	runPatternScope,
	type PatternScope,
	type ReviewCategory
} from '../../review-shape.ts';
import { chapterPatternUnits, reviewTiers, surveyBudgetTokens } from './scene-review.ts';
import { storyIsLive } from '../universe-scope.ts';
import { MINIMAL_TOOL_NAMES, toolSpecs } from './tools/registry.ts';

// The pre-flight estimate a review run is confirmed against: how many scenes it
// would read, roughly how many tokens that sends, and - only when the model that
// would answer actually has a price - roughly what that costs. No price means
// tokens alone; the estimate never guesses one.
//
// Read-only by construction: it assembles the same context the run would and
// counts it. Nothing is queued and no provider request is made.

// A provisional allowance, not measured. Each per-scene request carries the
// persona system message and, on a tool-enabled turn, the tool schemas; the task
// message adds its instructions and any prior notes on the scene.
const TASK_MESSAGE_TOKENS = 250;

// The tool schemas the gateway would offer a reviewer request for this config.
function reviewerToolSpecs(config: ResolvedConfig) {
	if (config.supportsTools === false) return undefined;
	return toolSpecs(config.toolProfile === 'minimal' ? MINIMAL_TOOL_NAMES : undefined);
}

// The prompt of one request as the spend cap counts it before sending
// (ceilingPromptTokens): the persona the gateway puts first, then the request's
// own messages and tools.
function capPromptTokens(
	persona: ChatMessage,
	system: ChatMessage | null,
	task: string,
	tools?: ReturnType<typeof reviewerToolSpecs>
): number {
	const user: ChatMessage = { role: 'user', content: task };
	return ceilingPromptTokens(system ? [persona, system, user] : [persona, user], tools);
}

// A reviewer turn is agentic: it reads, stages notes, and answers, resending the
// growing conversation each round. The single-request figure above is therefore
// multiplied. With enough of this account's own history on the model in play the
// multiplier is measured; otherwise this stated constant applies.
const STATIC_MULTIPLIER = 2.5;
// Below this many priced requests the history is too thin to draw a ratio from.
const HISTORY_MIN_ROWS = 5;
// Bounds on the measured multiplier, so one freak run cannot make the estimate
// absurd in either direction.
const MIN_MULTIPLIER = 1;
const MAX_MULTIPLIER = 10;

// What the reviewer writes back per scene: staged notes, each quoting the
// passage it edits, across the rounds of an agentic turn. Provisional, not
// measured; it applies until this account has enough reviewer history on the
// model to average its own completions instead. Completion tokens usually bill
// several times the prompt rate, so leaving them out priced a review far too
// low.
const STATIC_COMPLETION_TOKENS_PER_SCENE = 700;

export type EstimateLine = {
	label: string;
	tokens?: number;
	// Set where a figure cannot be known before the run.
	note?: string;
};

export type ReviewEstimate = {
	scenes: number;
	// What the run would send: prompt tokens only.
	estTokens: number;
	model: string;
	basis: 'history' | 'static';
	multiplier: number;
	lines: EstimateLine[];
	// What the run would write back, which bills at the completion rate. Measured
	// from this account's reviewer history where there is enough of it (basis
	// 'history'), a flat per-scene allowance otherwise.
	estCompletionTokens: number;
	// Present only when the resolved model has a price in the discovered
	// snapshot. Absent means the cost is not known, not that it is zero.
	// estCostUsd is the whole figure; estCompletionCostUsd is the completion
	// share of it, broken out so the modal can show what the answers cost.
	estCostUsd?: number;
	estCompletionCostUsd?: number;
	// The account's warning threshold, and its spend ceiling with whether that
	// ceiling can be applied at all (it cannot without a price).
	warnUsd: number;
	capUsd?: number;
	capEnforceable: boolean;
	// Whether a whole-book pattern pass reads the book in one request; only on
	// an estimate for one.
	wholeBook?: WholeBookFit;
	// The run's requests may search the web. The figures leave searches out,
	// and the spend cap holds back room for every round of the search loop
	// before each request (see searchingPromptTokens), so a capped run can stop
	// well short of the figure.
	webSearch?: true;
	// With web search on, the room the cap holds back for one request of the
	// run is already more than the cap, so the run would stop at that request
	// until the cap is raised. overCapAt names the part of the run it is in:
	// the scene reading, the consistency survey, or the habits survey.
	overCap?: true;
	overCapAt?: OverCapPart;
};

export type OverCapPart = 'scene' | 'continuity' | 'habits';

// How much bigger the actual prompt of a reviewer request has been than the
// single-request figure this estimate computes. Drawn from this account's own
// usage rows for the model in play; provisional, and it conflates the rounds of
// an agentic turn with the first request of one, so it reads low rather than
// high.
async function agenticMultiplier(
	db: Database,
	userId: string,
	model: string,
	perSceneTokens: number
): Promise<{ multiplier: number; basis: 'history' | 'static'; avgCompletion: number }> {
	const none = { multiplier: STATIC_MULTIPLIER, basis: 'static' as const, avgCompletion: 0 };
	if (perSceneTokens <= 0) return none;
	const [row] = await db
		.select({
			requests: sql<number>`count(*)::int`,
			avgPrompt: sql<number>`coalesce(avg(${assistantUsage.promptTokens}), 0)::float`,
			avgCompletion: sql<number>`coalesce(avg(${assistantUsage.completionTokens}), 0)::float`
		})
		.from(assistantUsage)
		.where(
			and(
				eq(assistantUsage.userId, userId),
				eq(assistantUsage.model, model),
				eq(assistantUsage.role, 'reviewer'),
				isNotNull(assistantUsage.promptTokens)
			)
		);
	if (!row || row.requests < HISTORY_MIN_ROWS || row.avgPrompt <= 0) return none;
	const measured = row.avgPrompt / perSceneTokens;
	return {
		multiplier: Math.min(Math.max(measured, MIN_MULTIPLIER), MAX_MULTIPLIER),
		basis: 'history',
		avgCompletion: Math.max(row.avgCompletion, 0)
	};
}

export type EstimateOptions = {
	userId: string;
	storyId: string;
	chapterId?: string;
	categories?: ReviewCategory[];
	patterns?: PatternScope;
};

// Assembles what the run would send and counts it. Mirrors reviewStoryScenes:
// the stable story frame once, each scene's delta, and - for a full review of
// more than one scene - the cross-scene pass on top.
export async function estimateStoryReview(
	db: Database,
	opts: EstimateOptions
): Promise<ReviewEstimate> {
	const categories = opts.categories ?? [];
	const resolved = await resolveLlmConfig(db, opts.userId, opts.storyId);
	const model = pickModel(resolved.config, 'reviewer');
	// The run this estimate is for would refuse outright, so estimating what it
	// would send is meaningless; say so rather than pricing an empty model id.
	if (!model) {
		throw new AssistantDisabledError('No model is configured for reviews.');
	}
	const includeTiers = reviewTiers(categories);
	// The preference lines ride on each scene's task message when the review
	// reads the wording, and the language lines always.
	const preferenceText =
		(readsWording(categories)
			? reviewPreferenceText(await storyAssistantPreferences(db, opts.storyId, opts.userId))
			: '') + reviewLanguageText(await storyLanguage(db, opts.storyId, opts.userId), categories);
	const preferenceTokens = estimateTokens(preferenceText);
	const persona = personaMessage(resolved.config);

	// One pass over the story's scenes, shared by the per-scene reading and the
	// cross-scene survey below. The chapter filter is applied in memory because
	// the survey always covers the whole story, even when the review is scoped to
	// one chapter. Summaries and bodies are only what the survey listing needs,
	// so a review that cannot reach the survey stage leaves them on the server.
	const surveyPossible = isFullReview(categories);
	// The run skips the pattern pass on an endpoint that cannot call tools, so
	// the estimate leaves it out too.
	const patterns =
		resolved.config.supportsTools === false
			? undefined
			: runPatternScope(categories, opts.patterns, opts.chapterId);
	const bodiesNeeded = surveyPossible || Boolean(patterns);
	const allScenes = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			chapterId: scenes.chapterId,
			summaryMd: surveyPossible ? scenes.summaryMd : sql<string | null>`null`,
			bodyMd: bodiesNeeded ? scenes.bodyMd : sql<string>`''`
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.storyId, opts.storyId),
				eq(stories.ownerId, opts.userId),
				storyIsLive(),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(scenes.globalPosition));
	const targets = opts.chapterId
		? allScenes.filter((scene) => scene.chapterId === opts.chapterId)
		: allScenes;

	const frame =
		targets.length > 0
			? await assembleStoryFrame(db, {
					userId: opts.userId,
					storyId: opts.storyId,
					includeTiers
				})
			: null;
	const sceneSystem = frame ? buildSystemMessage(frame, { tools: true }) : null;
	const frameTokens = sceneSystem ? estimateTokens(sceneSystem.content) : 0;

	const tools = reviewerToolSpecs(resolved.config);
	const toolTokens = tools ? estimateTokens(JSON.stringify(tools)) : 0;
	let sceneTokens = 0;
	// The largest scene request as the spend cap counts it, for the over-cap
	// warning. The task message's instructions are the same allowance as above.
	let largestSceneCeiling = 0;
	for (const scene of targets) {
		const delta = frame
			? await assembleSceneDelta(db, {
					userId: opts.userId,
					storyId: opts.storyId,
					sceneId: scene.id,
					entityNames: frame.sources.entities.map((e) => e.name),
					includeTiers
				})
			: null;
		const tokens =
			frameTokens +
			PERSONA_TOKENS +
			toolTokens +
			TASK_MESSAGE_TOKENS +
			preferenceTokens +
			estimateTokens(delta?.text ?? '');
		sceneTokens += tokens;
		largestSceneCeiling = Math.max(
			largestSceneCeiling,
			capPromptTokens(persona, sceneSystem, (delta?.text ?? '') + preferenceText, tools) +
				TASK_MESSAGE_TOKENS
		);
	}

	const { multiplier, basis, avgCompletion } = await agenticMultiplier(
		db,
		opts.userId,
		model,
		targets.length > 0 ? sceneTokens / targets.length : 0
	);

	// What the reviewer writes back. On the measured basis the account's own
	// average completion per request stands in, multiplied by the same factor
	// that stands in for how many requests a scene takes.
	const completionPerScene =
		basis === 'history' && avgCompletion > 0
			? avgCompletion * multiplier
			: STATIC_COMPLETION_TOKENS_PER_SCENE;
	const estCompletionTokens = Math.round(completionPerScene * targets.length);

	const lines: EstimateLine[] = [
		{
			label: `Reading the ${targets.length} scene${targets.length === 1 ? '' : 's'}`,
			tokens: Math.round(sceneTokens * multiplier)
		}
	];

	// The cross-scene pass runs after a full review of more than one scene, over
	// the whole story. Stage A is a listing this can size exactly; stage B is one
	// request per contradiction the survey raises, which nothing can know yet.
	let surveyTokens = 0;
	let largestSurveyCeiling = 0;
	if (surveyPossible && targets.length > 1) {
		({ tokens: surveyTokens, largestCeiling: largestSurveyCeiling } = await surveyStageTokens(
			db,
			opts.userId,
			opts.storyId,
			resolved.config,
			persona,
			allScenes
		));
		lines.push({ label: 'Consistency pass, stage A (the survey)', tokens: surveyTokens });
		lines.push({
			label: 'Consistency pass, stage B (confirming what the survey raises)',
			note: 'Not known before the run: it depends on how many contradictions the survey finds.'
		});
	}

	// The pattern pass: a survey this can size, then one request per pattern per
	// scene it shows in, which nothing can know yet.
	let patternTokens = 0;
	let largestPatternCeiling = 0;
	let wholeBook: WholeBookFit | undefined;
	let fixRequests = 0;
	if (patterns) {
		const contextWindow = modelContextWindow(resolved.config, 'reviewer');
		const budgetTokens = surveyBudgetTokens(contextWindow);
		let units: PatternUnit[] = [];
		if (patterns === 'book' && targets.length > 1) {
			const plan = await planBookPass(db, {
				userId: opts.userId,
				storyId: opts.storyId,
				scenes: targets,
				contextWindow,
				budgetTokens,
				replyTokens: reviewerReplyTokens(resolved.config, contextWindow)
			});
			wholeBook = plan.fit;
			patternTokens = plan.tokens;
			units = [plan.unit];
			fixRequests = maxApplyRequests(units);
		} else if (patterns === 'chapter') {
			units = chapterPatternUnits(targets);
			fixRequests = maxApplyRequests(units);
			patternTokens = units.length
				? patternSurveyTokens(
						units,
						budgetTokens,
						await patternSurveyOverhead(db, opts.userId, opts.storyId),
						await storyLanguage(db, opts.storyId, opts.userId),
						await storyAssistantPreferences(db, opts.storyId, opts.userId)
					)
				: 0;
		}
		if (units.length) {
			const system = await patternSurveySystem(db, opts.userId, opts.storyId);
			for (const message of patternSurveyMessages(
				units,
				budgetTokens,
				await storyLanguage(db, opts.storyId, opts.userId),
				await storyAssistantPreferences(db, opts.storyId, opts.userId)
			)) {
				largestPatternCeiling = Math.max(
					largestPatternCeiling,
					capPromptTokens(persona, system, message)
				);
			}
		}
		if (patternTokens > 0) {
			lines.push({
				label:
					patterns === 'chapter'
						? 'Looking for repeated habits in each chapter'
						: wholeBook === 'fits'
							? 'Reading the whole book for repeated habits'
							: 'Looking for repeated habits, chapter by chapter',
				tokens: patternTokens
			});
			lines.push({
				label: 'Fixing the habits it finds',
				note: `Not known before the run: one round of fixes per habit for each scene it shows up in, at most ${fixRequests} rounds. A round can take several requests.`
			});
		}
	}

	// The surveys are single plain requests per chunk, so the agentic multiplier
	// does not apply to them.
	const estTokens = Math.round(sceneTokens * multiplier + surveyTokens + patternTokens);
	const price = resolved.config.modelPricing?.[model];
	// Claude bills text it has not seen before above the plain price, to cache
	// it (see cacheWriteRate). The first request of each scene and every survey
	// request are priced as all new text; the further rounds of a scene resend
	// what is by then cached, and stay at the plain price, so the figure errs
	// high rather than low.
	const firstReadRate =
		adapterKind(resolved.config.provider) === 'anthropic'
			? cacheWriteRate(resolved.config.cacheTtl)
			: 1;
	const promptUnits =
		sceneTokens * (multiplier - 1 + firstReadRate) + (surveyTokens + patternTokens) * firstReadRate;
	const estCompletionCostUsd = price ? estCompletionTokens * price.completion : undefined;
	const webSearch = await webSearchAllowed(db, resolved.config, {
		userId: opts.userId,
		storyId: opts.storyId,
		role: 'reviewer'
	});

	// With web search on, the cap holds back room for every round of the search
	// loop before each request (capCeilingUsage), counted the way the gateway
	// counts a prompt before sending it. Every reviewer request may search, the
	// surveys included, and a whole-book habits survey is far larger than any
	// scene. When that room for the largest request alone is more than the cap,
	// the run stops at that request until the cap is raised.
	const capUsd = resolved.config.spendCapUsd;
	const replyTokens = reviewerReplyTokens(
		resolved.config,
		modelContextWindow(resolved.config, 'reviewer')
	);
	const ceilingUsd = (prompt: number) =>
		requestCostUsd(
			resolved.config.modelPricing,
			model,
			capCeilingUsage(prompt, replyTokens, {
				webSearch: true,
				claude: adapterKind(resolved.config.provider) === 'anthropic',
				cacheTtl: resolved.config.cacheTtl
			}),
			resolved.config.provider
		);
	// The first part, in run order (the habits survey runs before the scenes,
	// the consistency survey after), whose largest request would be held: a
	// held request stops the run there.
	// Only each part's first request round is checked. The gateway checks every
	// round of the agent loop, and later rounds resend tool results, so a run
	// can be held sooner than this says (the note says "or sooner"). The habits
	// figure also leaves out the open and known pattern lists a chapter survey
	// carries (see pattern-pass.ts).
	const largestCeiling: [OverCapPart, number][] = [
		['habits', largestPatternCeiling],
		['scene', largestSceneCeiling],
		['continuity', largestSurveyCeiling]
	];
	const overCapAt =
		webSearch && capUsd
			? largestCeiling.find(([, prompt]) => {
					const usd = prompt > 0 ? ceilingUsd(prompt) : undefined;
					return usd !== undefined && usd > capUsd + 1e-9;
				})?.[0]
			: undefined;

	return {
		scenes: targets.length,
		estTokens,
		model,
		basis,
		multiplier: Math.round(multiplier * 100) / 100,
		lines,
		estCompletionTokens,
		...(price && estCompletionCostUsd !== undefined
			? {
					estCostUsd: promptUnits * price.prompt + estCompletionCostUsd,
					estCompletionCostUsd
				}
			: {}),
		warnUsd: resolved.config.spendWarnUsd ?? DEFAULT_SPEND_WARN_USD,
		...(resolved.config.spendCapUsd ? { capUsd: resolved.config.spendCapUsd } : {}),
		capEnforceable: Boolean(price),
		...(wholeBook ? { wholeBook } : {}),
		...(webSearch ? { webSearch: true as const } : {}),
		...(overCapAt ? { overCap: true as const, overCapAt } : {})
	};
}

// Stage A of the consistency pass: the scene listing, split into the chunks the
// real pass would send, plus each chunk's own framing, and the largest chunk's
// request as the spend cap counts it. The scene rows come from the caller's
// single pass over the story; the frame is assembled separately because the
// consistency pass ships a different tier selection than the per-scene reading
// does, and the estimate has to mirror what the run sends.
async function surveyStageTokens(
	db: Database,
	userId: string,
	storyId: string,
	config: ResolvedConfig,
	persona: ChatMessage,
	rows: { id: string; title: string | null; summaryMd: string | null; bodyMd: string }[]
): Promise<{ tokens: number; largestCeiling: number }> {
	if (rows.length < 2) return { tokens: 0, largestCeiling: 0 };

	const budgetTokens = surveyBudgetTokens(modelContextWindow(config, 'reviewer'));
	const chunks = splitSurveyChunks(rows, budgetTokens);
	const frame = await assembleStoryFrame(db, {
		userId,
		storyId,
		includeTiers: ['frame', 'entities']
	});
	const system = frame ? buildSystemMessage(frame) : null;
	const frameTokens = system ? estimateTokens(system.content) : 0;
	let tokens = 0;
	let largestCeiling = 0;
	chunks.forEach((chunk, i) => {
		const message = buildSurveyMessage(chunk, {
			scope: 'story',
			...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {})
		});
		tokens += frameTokens + PERSONA_TOKENS + estimateTokens(message);
		largestCeiling = Math.max(largestCeiling, capPromptTokens(persona, system, message));
	});
	return { tokens, largestCeiling };
}

// Whether the review window can offer the whole-book pattern pass, and how it
// would read the book: in one request, or chapter by chapter. A story of fewer
// than two scenes, or a reviewer model with no known window, is not offered it.
export async function wholeBookCheck(
	db: Database,
	opts: { userId: string; storyId: string }
): Promise<WholeBookFit> {
	const resolved = await resolveLlmConfig(db, opts.userId, opts.storyId);
	const contextWindow = modelContextWindow(resolved.config, 'reviewer');
	if (!contextWindow) return 'unavailable';
	// The pass stages its fixes through tools, so the run would skip it.
	if (resolved.config.supportsTools === false) return 'unavailable';
	const rows = await db
		.select({
			id: scenes.id,
			title: scenes.title,
			chapterId: scenes.chapterId,
			bodyChars: sql<number>`length(${scenes.bodyMd})`.mapWith(Number)
		})
		.from(scenes)
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(scenes.storyId, opts.storyId),
				eq(stories.ownerId, opts.userId),
				storyIsLive(),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(scenes.globalPosition));
	if (rows.length < 2) return 'unavailable';
	return checkBookFit(db, {
		...opts,
		scenes: rows,
		contextWindow,
		replyTokens: reviewerReplyTokens(resolved.config, contextWindow)
	});
}

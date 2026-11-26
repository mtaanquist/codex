import { usageCostUsd, type TokenPrice } from '../../assistant-cost.ts';
import type { ModelPricing } from './config.ts';
import type { ProviderId } from './providers/presets.ts';
import type { TokenUsage } from './providers/types.ts';

// What a background run has spent so far, and whether that has passed the
// account's ceiling. A run adds the usage of every request it makes and checks
// the meter at a boundary where stopping stages nothing partial.
//
// A cost figure only ever exists when the model that answered has a price in
// the account's prices (discovered, or entered by the writer) AND the endpoint
// reported token counts for the request. Missing either one, the meter records that the cap could not be
// applied, and the run says so; it never guesses a price, never assumes a
// request was free, and never skips the ceiling in silence.

// The line a result and a notification carry when a cap was set but the run
// could not price itself because the model has no known price.
export const CAP_NOT_APPLIED_MESSAGE =
	'A spend cap is set but the model has no known price, so it was not applied. Enter its price in your Assistant settings.';

// The other reason a priced run cannot be metered: the endpoint answered at
// least one request without reporting how many tokens it billed, so that
// request could not be priced and the cap could not cover the whole run.
export const CAP_NOT_APPLIED_NO_USAGE_MESSAGE =
	'A spend cap is set but the endpoint did not report token counts for every request, so the cap could not be fully applied.';

// Thrown by the gateway in place of sending a metered request that could take
// the run past its cap (SpendMeter.wouldPassCap). A job ends as capped on it,
// at the same boundary its own capReached check stops at.
export class SpendCapError extends Error {
	constructor() {
		super('The next request could take this job past your spend cap, so it was not sent.');
		this.name = 'SpendCapError';
	}
}

export function requestCostUsd(
	pricing: ModelPricing | undefined,
	model: string,
	usage: TokenUsage,
	provider?: ProviderId
): number | undefined {
	const price = pricing?.[model];
	return price ? usageCostUsd(price, usage, provider) : undefined;
}

// What a stopped run reports it spent: the figure, and whether it includes
// estimates (see SpendMeter.spentEstimated).
// overCap is set when the request held back could alone cost more than the
// whole cap, so a rerun would stop at it again (see SpendMeter.hold).
export function spentFields(meter: SpendMeter): {
	spentUsd: number;
	spentEstimated?: true;
	overCap?: true;
} {
	return {
		spentUsd: meter.spentUsd,
		...(meter.spentEstimated ? { spentEstimated: true as const } : {}),
		...(meter.heldOverCap ? { overCap: true as const } : {})
	};
}

export class SpendMeter {
	readonly capUsd: number | undefined;
	private readonly pricing: ModelPricing | undefined;
	private readonly provider: ProviderId | undefined;
	private usd: number;
	private unpriced = false;
	private unreported = false;
	private estimated = false;
	private held = false;
	private overCap = false;
	private readonly persist: ((spentUsd: number) => Promise<void>) | undefined;
	private readonly uncapped: boolean;
	private saving: Promise<void> = Promise.resolve();

	// spentUsd seeds the meter with what an earlier attempt of the same job
	// already spent, so a retry does not get the whole ceiling again. persist is
	// handed the running total after every priced request; writes run one after
	// another, and flush waits for the last.
	// provider is the one the requests go to, which sets the rate cached
	// tokens are metered at (see cacheReadRate); without it, the full price.
	// meterUncapped keeps count with no cap set too, for a job that holds its
	// spend against the cap in force at each request, which may be set later.
	constructor(opts: {
		pricing?: ModelPricing;
		provider?: ProviderId;
		capUsd?: number;
		spentUsd?: number;
		persist?: (spentUsd: number) => Promise<void>;
		meterUncapped?: boolean;
	}) {
		this.pricing = opts.pricing;
		this.provider = opts.provider;
		this.capUsd = opts.capUsd;
		this.usd = opts.spentUsd ?? 0;
		this.persist = opts.persist;
		this.uncapped = opts.meterUncapped ?? false;
	}

	// One request's reported usage. price is the one the request was sent at,
	// which its usage row stores, so a price changed during the run meters as
	// the row shows it; without one, the price the meter was built with. The
	// provider, which sets the cache-read rate, works the same way. The same
	// goes for wouldPassCap and exceedsCap. A model with no price marks the run
	// unpriceable; so does a priced model the endpoint reported no counts for,
	// which would otherwise accrue nothing and let the ceiling pass unenforced.
	record(model: string, usage?: TokenUsage, price?: TokenPrice, provider?: ProviderId): void {
		if (!this.capUsd && !this.uncapped) return;
		if (!(price ?? this.pricing?.[model])) {
			this.unpriced = true;
			return;
		}
		if (!usage) {
			this.unreported = true;
			return;
		}
		const cost = this.costOf(model, usage, price, provider) ?? 0;
		if (usage.estimated) this.estimated = true;
		this.usd += cost;
		if (this.persist) {
			const persist = this.persist;
			const total = this.usd;
			this.saving = this.saving.then(() => persist(total)).catch(() => {});
		}
	}

	flush(): Promise<void> {
		return this.saving;
	}

	get spentUsd(): number {
		return this.usd;
	}

	// True when spentUsd includes estimated counts (a failed attempt metered
	// from what had streamed, say) rather than only what the endpoint
	// reported. Notices mark the figure as estimated.
	get spentEstimated(): boolean {
		return this.estimated;
	}

	// True once the run has spent its ceiling, or a request was held back
	// because it could have passed it (see hold). Always false when there is no
	// cap, and false when nothing could be priced (see notApplied).
	get capReached(): boolean {
		return this.capUsd !== undefined && (this.held || this.usd >= this.capUsd);
	}

	// A request was not sent because it could have passed the ceiling: the run
	// stops at its next boundary, as it would at the ceiling itself. overCap
	// says the request alone could cost more than the whole ceiling.
	hold(overCap = false): void {
		this.held = true;
		if (overCap) this.overCap = true;
	}

	// True when a held request could alone have cost more than the ceiling, so
	// running the job again would stop at it again until the cap goes up.
	get heldOverCap(): boolean {
		return this.overCap;
	}

	// Whether one request, at the usage it could bill at most, could cost more
	// than the whole ceiling on its own. False when it cannot be priced.
	exceedsCap(model: string, usage: TokenUsage, price?: TokenPrice, provider?: ProviderId): boolean {
		if (this.capUsd === undefined) return false;
		const cost = this.costOf(model, usage, price, provider);
		return cost !== undefined && cost > this.capUsd + 1e-9;
	}

	// Whether one more request, at the usage it could bill at most, could take
	// the run past its ceiling. True at or over the ceiling whatever the model;
	// otherwise false when the request cannot be priced (see notApplied).
	wouldPassCap(
		model: string,
		usage: TokenUsage,
		price?: TokenPrice,
		provider?: ProviderId
	): boolean {
		if (this.capUsd === undefined) return false;
		if (this.capReached) return true;
		const cost = this.costOf(model, usage, price, provider);
		return cost !== undefined && this.usd + cost > this.capUsd + 1e-9;
	}

	private costOf(
		model: string,
		usage: TokenUsage,
		price?: TokenPrice,
		provider?: ProviderId
	): number | undefined {
		const metered = price ?? this.pricing?.[model];
		return metered ? usageCostUsd(metered, usage, provider ?? this.provider) : undefined;
	}

	// A cap was set, but at least one request could not be priced, so the ceiling
	// could not be enforced over the whole run.
	get notApplied(): boolean {
		return this.capUsd !== undefined && (this.unpriced || this.unreported);
	}

	// Which of the two reasons to tell the writer about, when notApplied. An
	// unknown price is reported ahead of a missing usage report: it is the more
	// fundamental gap, and it is the one the writer can act on by choosing a
	// priced model. Undefined when the cap was applied cleanly.
	get notAppliedMessage(): string | undefined {
		if (!this.notApplied) return undefined;
		return this.unpriced ? CAP_NOT_APPLIED_MESSAGE : CAP_NOT_APPLIED_NO_USAGE_MESSAGE;
	}
}

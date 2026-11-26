// What a confirm step says about the cost of a run before it starts. One
// wording for every surface that asks (a review, a scene or chapter draft).

export const money = (usd: number) => usd.toFixed(2);

export const NO_PRICE_NOTE = 'This model has no price on record, so the cost cannot be shown.';

export function capNotAppliedNote(capUsd: number): string {
	return `Your spend cap of $${money(capUsd)} cannot be applied to a model with no known price.`;
}

// The surface adds what to do about it.
export function overWarnNote(warnUsd: number): string {
	return `That is more than your warning limit of $${money(warnUsd)}.`;
}

// A review estimate: the total includes the replies, and repliesUsd is that
// share of it.
export function estimateCostNote(totalUsd: number, repliesUsd?: number): string {
	if (cents(totalUsd) === 0) return 'That is less than $0.01 in all.';
	const total = `That is about $${money(totalUsd)} in all`;
	if (repliesUsd === undefined) return total + '.';
	return cents(repliesUsd) === 0
		? `${total}, of which less than $0.01 is for the replies.`
		: `${total}, of which about $${money(repliesUsd)} is for the replies.`;
}

const cents = (usd: number) => Math.round(usd * 100);

// Whether a cost shown to the cent is over a limit shown to the cent, so a
// note never calls "$2.00" more than a limit of $2.00.
export function overLimit(costUsd: number, limitUsd: number): boolean {
	return cents(costUsd) > cents(limitUsd);
}

// A review estimated above the spend cap stops partway.
export function overCapNote(capUsd: number): string {
	return `That is more than your spend cap of $${money(capUsd)}, so the review will stop before it finishes. To carry on, start the same review again, or raise the cap.`;
}

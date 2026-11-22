// Which suggestions "Clear review notes" takes, shared by the clear itself and
// the count its dialog shows. `clears` picks the candidates; an edit that stays
// then keeps the edit it follows, and so on back along the chain, since
// deleting it would null the link that marks the one staying as a follow-up.
export function clearedSuggestions<S extends { id: string; followsId: string | null }>(
	suggestions: S[],
	clears: (suggestion: S) => boolean
): Set<string> {
	const going = new Set(suggestions.filter(clears).map((suggestion) => suggestion.id));
	const byId = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
	for (const suggestion of suggestions) {
		if (going.has(suggestion.id)) continue;
		let followed = suggestion.followsId;
		while (followed && going.delete(followed)) followed = byId.get(followed)?.followsId ?? null;
	}
	return going;
}

import { enhance as kitEnhance, type SubmitFunction } from '$app/forms';

// SvelteKit's enhance, but a result stays on the page that submitted it, as it
// did before kit 3. Kit 3 navigates to where the action lands when that URL
// differs from the current one, query included, and a `?/action` drops the
// page's own query (?scene=, ?entity=), so every action on such a page would
// reload it without its selection. Redirects are still followed. Pass
// `navigate: true` to update() to opt back in.
//
// update() also hands focus back to an editor it took it from: on success kit's
// applyAction resets focus to the body as if the page had navigated, and keys
// the writer types next would be dropped (#1356).
export function enhance<
	Success extends Record<string, unknown> | undefined,
	Failure extends Record<string, unknown> | undefined
>(form: HTMLFormElement, submit?: SubmitFunction<Success, Failure>) {
	return kitEnhance<Success, Failure>(form, async (input) => {
		const callback = await submit?.(input);
		return async (opts) => {
			const update: typeof opts.update = (options) =>
				keepEditorFocus(() => opts.update({ navigate: false, ...options }));
			if (callback) await callback({ ...opts, update });
			else await update();
		};
	});
}

// Runs `work`, and if kit's focus reset moved focus out of an editable element
// onto the body meanwhile, puts focus and the caret back. The reset focuses the
// body itself, so a focusout towards the body is the reset; a click elsewhere
// moves focus to that element or to nothing and is left alone.
export async function keepEditorFocus<T>(work: () => Promise<T>): Promise<T> {
	if (typeof document === 'undefined') return work();
	let taken: { el: HTMLElement; ranges: Range[] } | null = null;
	const onFocusOut = (event: FocusEvent) => {
		const el = event.target;
		if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
		if (event.relatedTarget !== document.body) return;
		const selection = document.getSelection();
		const ranges: Range[] = [];
		for (let i = 0; i < (selection?.rangeCount ?? 0); i++) {
			const range = selection!.getRangeAt(i);
			if (el.contains(range.startContainer)) ranges.push(range.cloneRange());
		}
		taken = { el, ranges };
	};
	document.addEventListener('focusout', onFocusOut, true);
	try {
		return await work();
	} finally {
		document.removeEventListener('focusout', onFocusOut, true);
		restore(taken);
	}
}

function restore(taken: { el: HTMLElement; ranges: Range[] } | null) {
	// Without the caret a bare focus() can land at the start of the text, so
	// restore both or neither.
	if (!taken || !taken.el.isConnected || taken.ranges.length === 0) return;
	const active = document.activeElement;
	if (active && active !== document.body) return;
	const selection = document.getSelection();
	if (!selection) return;
	selection.removeAllRanges();
	for (const range of taken.ranges) selection.addRange(range);
	taken.el.focus({ preventScroll: true });
}

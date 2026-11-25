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
// (an editor, or a field of an autosaving form) onto the body meanwhile,
// puts focus and the caret back. The reset focuses the body itself, so a
// focusout towards the body is the reset; a click elsewhere moves focus to that
// element or to nothing and is left alone.
type Taken =
	| { kind: 'editor'; el: HTMLElement; ranges: Range[] }
	| { kind: 'field'; el: Field; start: number | null; end: number | null };

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isField(el: EventTarget | null): el is Field {
	return (
		el instanceof HTMLInputElement ||
		el instanceof HTMLTextAreaElement ||
		el instanceof HTMLSelectElement
	);
}

// Fields whose focus kit's reset just took and keepEditorFocus will hand back.
// The blur fires the field's change event, which is not the writer leaving it;
// an autosaving form checks this to tell the two apart (see autosave-form).
const regaining = new WeakSet<Element>();

export function focusIsBeingRestored(el: Element): boolean {
	return regaining.has(el);
}

export async function keepEditorFocus<T>(work: () => Promise<T>): Promise<T> {
	if (typeof document === 'undefined') return work();
	let taken: Taken | null = null;
	const onFocusOut = (event: FocusEvent) => {
		if (event.relatedTarget !== document.body) return;
		const el = event.target;
		if (isField(el)) {
			const text = !(el instanceof HTMLSelectElement);
			taken = {
				kind: 'field',
				el,
				start: text ? el.selectionStart : null,
				end: text ? el.selectionEnd : null
			};
			regaining.add(el);
			return;
		}
		if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
		const selection = document.getSelection();
		const ranges: Range[] = [];
		for (let i = 0; i < (selection?.rangeCount ?? 0); i++) {
			const range = selection!.getRangeAt(i);
			if (el.contains(range.startContainer)) ranges.push(range.cloneRange());
		}
		taken = { kind: 'editor', el, ranges };
	};
	document.addEventListener('focusout', onFocusOut, true);
	try {
		return await work();
	} finally {
		document.removeEventListener('focusout', onFocusOut, true);
		restore(taken);
		if (taken) regaining.delete((taken as Taken).el);
	}
}

function restore(taken: Taken | null) {
	if (!taken || !taken.el.isConnected) return;
	const active = document.activeElement;
	if (active && active !== document.body) return;
	if (taken.kind === 'field') {
		const { el, start, end } = taken;
		el.focus({ preventScroll: true });
		// Only text fields have a caret; selectionStart is null on the others.
		if (start !== null && end !== null && !(el instanceof HTMLSelectElement)) {
			el.setSelectionRange(start, end);
		}
		return;
	}
	// Without the caret a bare focus() can land at the start of the text, so
	// restore both or neither.
	if (taken.ranges.length === 0) return;
	const selection = document.getSelection();
	if (!selection) return;
	const ranges = taken.ranges;
	const put = () => {
		selection.removeAllRanges();
		for (const range of ranges) selection.addRange(range);
	};
	put();
	taken.el.focus({ preventScroll: true });
	// Kit's reset also queued a timer that clears the selection when it still
	// matches the one it saw, which the restored caret does: the editor keeps
	// focus with no caret, and the next keys land at the start of the text.
	// This timer runs after kit's and puts the caret back once more.
	const el = taken.el;
	setTimeout(() => {
		if (document.activeElement === el && selection.rangeCount === 0) put();
	});
}

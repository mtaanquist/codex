import type { SubmitFunction } from '$app/forms';
import type { BeforeNavigate } from '$app/navigation';
import { browser } from '$app/env';
import { goto } from '$app/navigation';
import { SvelteSet } from 'svelte/reactivity';
import { focusIsBeingRestored } from '#lib/enhance';

// Helpers for settings forms that save on change instead of with a button. A
// select or checkbox saves at once; a text field saves when it loses focus
// (the native change event fires on blur). Shared by the account and story
// settings pages.

// Use with `use:enhance`. reset:false leaves each field as the writer left it
// while the reload refreshes the saved values across the page.
// A save that moves the page's own address (a rename) answers with a redirect;
// following it without a reset leaves the writer in the field they moved on to,
// where kit's own redirect would take focus away mid-word. The old address no
// longer exists, so it is replaced in the history.
//
// A form with a rename field posts to the page's id-based address, so a field
// saved while a rename is still in flight does not post to the old slug. Its
// result must not reload the page data at the old address either: that page
// may already be gone, and the rename's redirect reloads the data anyway.
//
// A save that errors (a server fault, or no connection) leaves the page and
// its fields alone: kit would replace the page with its error page, losing
// what the writer typed. The form's FormStatus says it was not saved, and the
// writer's next blur in the form tries again.
export const autosaveSubmit: SubmitFunction = ({ formElement }) => {
	failedSaves.delete(formElement);
	const save = (lastSave.get(formElement) ?? 0) + 1;
	lastSave.set(formElement, save);
	const renaming = hasUnsavedRename(formElement);
	if (renaming) renamesInFlight += 1;
	return async ({ result, update }) => {
		if (renaming) renamesInFlight -= 1;
		if (result.type === 'error') {
			leavingTo = null;
			// A later save posts every field again, so only the latest one counts.
			if (lastSave.get(formElement) === save) {
				failedSaves.add(formElement);
				formElement.addEventListener('focusout', retryOnBlur, { once: true });
			}
			return;
		}
		if (result.type === 'redirect') {
			const target = leavingTo && retarget(leavingTo, result.location);
			leavingTo = null;
			redirecting += 1;
			try {
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- the action's own redirect, or where the writer was going with its slug swapped
				if (target) await goto(target);
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- the action's own redirect
				else await goto(result.location, { reset: false, replace: true, refreshAll: true });
			} finally {
				redirecting -= 1;
			}
			return;
		}
		const moving = renamesInFlight > 0 || redirecting > 0;
		await update({ reset: false, refreshAll: moving ? false : undefined });
		if (result.type !== 'success') leavingTo = null;
		else if (leavingTo && renamesInFlight === 0) continueLeaving();
	};
};

// Forms whose last save errored; FormStatus shows the failure.
export const failedSaves = new SvelteSet<HTMLFormElement>();
const lastSave = new WeakMap<HTMLFormElement, number>();
export const NOT_SAVED = 'Your change was not saved. Check your connection and try again.';

function retryOnBlur(event: FocusEvent) {
	const form = event.currentTarget as HTMLFormElement;
	if (failedSaves.has(form) && event.target instanceof Element) {
		saveUnlessRefocused(form, event.target);
	}
}

// Use as a form's onchange handler: any control change submits the form. A
// control marked data-no-autosave only changes the view (a filter box), so its
// changes do not save.
//
// A typed field's change event also fires when another field's save lands and
// kit's focus reset blurs it for a moment (keepEditorFocus puts it back). That
// is not the writer leaving the field, so it does not save half a word; the
// field is marked and saves on its next real blur instead.
export function autosubmitForm(event: Event & { currentTarget: HTMLFormElement }) {
	const control = event.target as HTMLElement | null;
	if (control?.dataset && 'noAutosave' in control.dataset) return;
	const form = event.currentTarget;
	if (!isTypedField(control)) {
		form.requestSubmit();
		return;
	}
	// A real change event covers a save the field was holding.
	held.delete(control);
	saveUnlessRefocused(form, control);
}

// Fields whose save waits for their next real blur.
const held = new WeakSet<Element>();

const NOT_TYPED = new Set(['checkbox', 'radio', 'file', 'range', 'color', 'hidden']);
function isTypedField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
	return (
		el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TYPED.has(el.type))
	);
}

// The reset's focusout comes after the change event in the same task, so a
// microtask sees whether this blur is the writer's or the reset's.
function saveUnlessRefocused(form: HTMLFormElement, field: Element) {
	queueMicrotask(() => {
		if (!focusIsBeingRestored(field)) {
			form.requestSubmit();
			return;
		}
		if (held.has(field)) return;
		held.add(field);
		const onBlur = () => {
			// A change event on this blur saves it already.
			if (!held.has(field)) return;
			held.delete(field);
			saveUnlessRefocused(form, field);
		};
		// After the change event, which fires before blur.
		field.addEventListener('blur', onBlur, { once: true });
	});
}

// A title or name field marked data-renames sets the page's own slug.
function hasUnsavedRename(form: HTMLFormElement): boolean {
	return [...form.querySelectorAll<HTMLInputElement>('input[data-renames]')].some(
		(input) => input.value.trim() !== '' && input.value.trim() !== input.defaultValue.trim()
	);
}

let renamesInFlight = 0;
// Rename redirects still being followed.
let redirecting = 0;
// Where the writer was going when a rename was still saving.
let leavingTo: URL | null = null;

function continueLeaving() {
	const target = leavingTo;
	leavingTo = null;
	// eslint-disable-next-line svelte/no-navigation-without-resolve -- where the writer was going
	if (target) void goto(target);
}

// The target with the page's old slug swapped for the new one: the first path
// segment where the current address and the redirect differ.
function retarget(target: URL, location: string): URL {
	const from = window.location.pathname.split('/');
	const to = new URL(location, window.location.href).pathname.split('/');
	const at = from.findIndex((segment, i) => segment !== to[i]);
	const parts = target.pathname.split('/');
	if (target.origin !== window.location.origin || at < 0 || parts[at] !== from[at]) return target;
	parts[at] = to[at];
	const next = new URL(target);
	next.pathname = parts.join('/');
	return next;
}

// Save a still-focused field before navigating away or closing the page, so
// leaving from inside a field does not lose the edit. Wire it to
// `beforeNavigate` and to the window's pagehide event.
export function flushFocusedField() {
	if (browser) (document.activeElement as HTMLElement | null)?.blur?.();
}

// flushFocusedField for a settings page whose form can move the page's own
// address (see hasUnsavedRename). Leaving while a rename is unsaved or still
// saving would load the target at the old address, which the rename removes,
// so the navigation waits for the save and then goes on to the target at the
// new address.
export function flushBeforeNavigate(navigation: BeforeNavigate) {
	// The rename's own redirect (see autosaveSubmit). A field the writer has
	// moved on to keeps focus, and saves when they leave it, to the new
	// address.
	if (navigation.type === 'goto' && navigation.from?.route.id === navigation.to?.route.id) return;
	if (navigation.type === 'leave' || !navigation.to || !browser) {
		flushFocusedField();
		return;
	}
	const active = document.activeElement;
	const renameField =
		active instanceof HTMLInputElement && 'renames' in active.dataset && active.form
			? active.form
			: null;
	if (renamesInFlight > 0 || (renameField && hasUnsavedRename(renameField))) {
		navigation.cancel();
		leavingTo = navigation.to.url;
		flushFocusedField();
		// The blur's save starts in a microtask (autosubmitForm). If none
		// started (nothing changed since the last save), go on now.
		queueMicrotask(() =>
			queueMicrotask(() => {
				if (renamesInFlight === 0) continueLeaving();
			})
		);
		return;
	}
	flushFocusedField();
}

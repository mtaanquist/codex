import type { SubmitFunction } from '$app/forms';
import type { BeforeNavigate } from '$app/navigation';
import { browser } from '$app/env';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { tick } from 'svelte';
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
// writer's next blur in the form tries again. Leaving the page tries again
// too, and waits for it (see flushBeforeNavigate).
export const autosaveSubmit: SubmitFunction = ({ formElement }) => {
	const startedAt = browser ? window.location.href : null;
	failedSaves.delete(formElement);
	formElement.removeEventListener('focusout', retryOnBlur);
	const save = (lastSave.get(formElement) ?? 0) + 1;
	lastSave.set(formElement, save);
	const renaming = hasUnsavedRename(formElement);
	if (renaming) renamesInFlight += 1;
	savesInFlight += 1;
	return async ({ result, update }) => {
		if (renaming) renamesInFlight -= 1;
		savesInFlight -= 1;
		if (result.type === 'error') {
			const held = leavingTo !== null;
			leavingTo = null;
			// A later save posts every field again, so only the latest one counts.
			if (lastSave.get(formElement) === save) {
				failedSaves.add(formElement);
				unsaved.add(formElement);
				formElement.addEventListener('focusout', retryOnBlur, { once: true });
				if (held) await showNotSaved(formElement, startedAt);
			}
			return;
		}
		if (lastSave.get(formElement) === save) unsaved.delete(formElement);
		if (result.type === 'redirect') {
			const leaving = leavingTo;
			const target = leaving && retarget(leaving.url, result.location);
			leavingTo = null;
			redirecting += 1;
			try {
				await gotoOwn(result.location, { reset: false, replace: true, refreshAll: true });
				// A Back or Forward press goes on through the history, unless the
				// entry it was going to is under the old address too.
				if (leaving && target)
					await goOn({
						url: target,
						delta: target.href === leaving.url.href ? leaving.delta : undefined
					});
			} finally {
				redirecting -= 1;
			}
			return;
		}
		const moving = renamesInFlight > 0 || redirecting > 0;
		await update({ reset: false, refreshAll: moving ? false : undefined });
		if (result.type !== 'success') leavingTo = null;
		else if (leavingTo && savesInFlight === 0 && unsavedForms().length === 0) continueLeaving();
	};
};

// An autosaving form's action, on the page the form is on. A save that a Back
// or Forward press starts runs after the browser has already moved to the
// entry it was going to, so a relative `?/action` would post to that page,
// which may be another story's settings with the same action. A form whose
// page can be renamed posts to its id-based address instead.
export function ownAction(name: string): string {
	return `${page.url.pathname}?/${name}`;
}

// Forms whose last save errored; FormStatus shows the failure.
export const failedSaves = new SvelteSet<HTMLFormElement>();
const lastSave = new WeakMap<HTMLFormElement, number>();
// Forms whose change has not landed since a save errored, including while it
// is being tried again.
const unsaved = new Set<HTMLFormElement>();
export const NOT_SAVED = 'Your change was not saved. Check your connection and try again.';

// The writer tried to leave and was held, so show them why: back on the
// section the form sits on, if they have since moved off it, with the message
// scrolled into view.
async function showNotSaved(form: HTMLFormElement, startedAt: string | null) {
	if (!form.isConnected) return;
	if (startedAt && startedAt !== window.location.href && form.checkVisibility?.() === false) {
		await gotoOwn(startedAt, { reset: false });
	}
	await tick();
	form.querySelector('.fs-error')?.scrollIntoView({ block: 'nearest' });
}

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
	savesStarting += 1;
	queueMicrotask(() => {
		savesStarting -= 1;
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
let savesInFlight = 0;
// Saves a blur has asked for, which start in a microtask (saveUnlessRefocused).
let savesStarting = 0;
// Rename redirects still being followed.
let redirecting = 0;
// Where the writer was going when a save was still in flight, and for a Back
// or Forward press, how far through the history.
type Leaving = { url: URL; delta?: number };
let leavingTo: Leaving | null = null;
// Kit undoes a held Back or Forward press with a history step of its own,
// which has to land before the press is replayed.
let historyRestored: Promise<void> = Promise.resolve();
// Navigations this module makes on the same page (the rename's redirect, back
// to the section a failed form sits on), which flushBeforeNavigate lets through.
let ownNavigations = 0;

async function gotoOwn(url: string, opts: Parameters<typeof goto>[1]) {
	ownNavigations += 1;
	try {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- the action's own redirect, or the page the save started on
		await goto(url, opts);
	} finally {
		ownNavigations -= 1;
	}
}

function continueLeaving() {
	const leaving = leavingTo;
	leavingTo = null;
	if (leaving) void goOn(leaving);
}

async function goOn({ url, delta }: Leaving) {
	if (delta) {
		await historyRestored;
		history.go(delta);
		return;
	}
	// eslint-disable-next-line svelte/no-navigation-without-resolve -- where the writer was going
	await goto(url);
}

function holdLeaving(navigation: BeforeNavigate, url: URL) {
	const delta = navigation.type === 'popstate' ? navigation.delta : undefined;
	leavingTo = { url, delta };
	if (delta) {
		historyRestored = new Promise((resolve) =>
			window.addEventListener('popstate', () => resolve(), { once: true })
		);
	}
}

// The target with the page's old slug swapped for the new one: the first path
// segment where the current address and the redirect differ. Only a target
// under the same path up to that segment is the same work: a story and a
// universe can share a slug.
function retarget(target: URL, location: string): URL {
	const from = window.location.pathname.split('/');
	const to = new URL(location, window.location.href).pathname.split('/');
	const at = from.findIndex((segment, i) => segment !== to[i]);
	const parts = target.pathname.split('/');
	if (
		target.origin !== window.location.origin ||
		at < 0 ||
		from.slice(0, at + 1).some((segment, i) => parts[i] !== segment)
	)
		return target;
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

// A form that is gone can no longer be saved, so it does not hold the writer
// on the page.
function unsavedForms(): HTMLFormElement[] {
	for (const form of unsaved) if (!form.isConnected) unsaved.delete(form);
	return [...unsaved];
}

// flushFocusedField for an autosaving settings page, wired to `beforeNavigate`.
//
// Leaving while a save is in flight, or about to start (a link clicked
// straight from an edited field saves it on the way), would lose the change
// if that save failed, so the navigation waits for it and goes on only if it
// lands. If it fails the page stays with its message. A save that moves the
// page's own address (a rename) first replaces the old address in the
// history, then goes on to the target at the new address (see autosaveSubmit).
// A held Back or Forward press goes on as a history step, not a new entry.
//
// Leaving while a save has already failed waits too, while the save is tried
// again. Closing the tab or leaving the app cannot wait, so the browser asks
// first.
export function flushBeforeNavigate(navigation: BeforeNavigate) {
	// The rename's own redirect, or back to a failed form (see gotoOwn). A
	// field the writer has moved on to keeps focus, and saves when they leave
	// it, to the new address. Any other goto is held like a link, even on the
	// same route: the command palette can open another universe's page there.
	if (navigation.type === 'goto' && ownNavigations > 0) return;
	if (!browser) return;
	const failed = unsavedForms().length > 0;
	if (failed) {
		navigation.cancel();
		flushFocusedField();
		if (navigation.type === 'leave' || !navigation.to) return;
		holdLeaving(navigation, navigation.to.url);
		// A form whose retry is already saving (the blur that started this
		// navigation retries its form) is waited for; the rest are sent again.
		queueMicrotask(() =>
			queueMicrotask(() => {
				for (const form of unsavedForms()) if (failedSaves.has(form)) form.requestSubmit();
			})
		);
		return;
	}
	flushFocusedField();
	if (savesInFlight === 0 && savesStarting === 0) return;
	navigation.cancel();
	if (navigation.type === 'leave' || !navigation.to) return;
	holdLeaving(navigation, navigation.to.url);
	// The blur's save starts in a microtask (saveUnlessRefocused). If none
	// started (a field held for its next blur), go on now.
	queueMicrotask(() =>
		queueMicrotask(() => {
			if (savesInFlight === 0 && savesStarting === 0) continueLeaving();
		})
	);
}

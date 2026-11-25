import type { SubmitFunction } from '$app/forms';
import type { BeforeNavigate } from '$app/navigation';
import { browser } from '$app/env';
import { goto } from '$app/navigation';
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
export const autosaveSubmit: SubmitFunction =
	() =>
	async ({ result, update }) => {
		if (result.type === 'redirect') {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- the action's own redirect
			await goto(result.location, { reset: false, replace: true, refreshAll: true });
			return;
		}
		await update({ reset: false });
	};

// Use as a form's onchange handler: any control change submits the form. A
// control marked data-no-autosave only changes the view (a filter box), so its
// changes do not save.
//
// A text field's change event also fires when another field's save lands and
// kit's focus reset blurs it for a moment (keepEditorFocus puts it back). That
// is not the writer leaving the field, so it does not save half a word; the
// field saves on its next real blur instead.
export function autosubmitForm(event: Event & { currentTarget: HTMLFormElement }) {
	const control = event.target as HTMLElement | null;
	if (control?.dataset && 'noAutosave' in control.dataset) return;
	const form = event.currentTarget;
	if (!isTextField(control)) {
		form.requestSubmit();
		return;
	}
	saveUnlessRefocused(form, control);
}

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
	return (
		el instanceof HTMLTextAreaElement ||
		(el instanceof HTMLInputElement && el.selectionStart !== null)
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
		field.addEventListener('blur', () => saveUnlessRefocused(form, field), { once: true });
	});
}

// Save a still-focused field before navigating away or closing the page, so
// leaving from inside a field does not lose the edit. Wire it to
// `beforeNavigate` and to the window's pagehide event.
export function flushFocusedField() {
	if (browser) (document.activeElement as HTMLElement | null)?.blur?.();
}

// flushFocusedField for a settings page whose form can move the page's own
// address: a title or name field marked data-renames sets the slug, and its
// save redirects to the new address.
export function flushBeforeNavigate(navigation: BeforeNavigate) {
	// The rename's own redirect (see autosaveSubmit). A field the writer has
	// moved on to keeps focus, and saves when they leave it, to the new
	// address.
	if (navigation.type === 'goto' && navigation.from?.route.id === navigation.to?.route.id) return;
	const active = browser ? document.activeElement : null;
	if (
		navigation.type !== 'leave' &&
		active instanceof HTMLInputElement &&
		'renames' in active.dataset &&
		active.value !== active.defaultValue
	) {
		// Leaving now would load the target at the old address while the rename
		// lands. Save the rename instead; it brings the writer back to the
		// settings at the new address.
		navigation.cancel();
		active.blur();
		return;
	}
	flushFocusedField();
}

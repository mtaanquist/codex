import { describe, it, expect, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: false }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/enhance', () => ({ focusIsBeingRestored: () => false }));

const { autosaveSubmit, failedSaves } = await import('./autosave-form');

function fakeForm() {
	return {
		querySelectorAll: () => [],
		addEventListener: vi.fn()
	} as unknown as HTMLFormElement;
}

async function save(formElement: HTMLFormElement, result: { type: string }) {
	const update = vi.fn(async () => {});
	const callback = await (autosaveSubmit as unknown as (input: unknown) => unknown)({
		formElement
	});
	await (callback as (opts: unknown) => Promise<void>)({ result, update });
	return update;
}

describe('autosaveSubmit', () => {
	it('keeps the page when a save errors, and marks the form unsaved', async () => {
		const form = fakeForm();
		const update = await save(form, { type: 'error' });
		// update() would apply the error and replace the page with kit's error page.
		expect(update).not.toHaveBeenCalled();
		expect(failedSaves.has(form)).toBe(true);
		expect(form.addEventListener).toHaveBeenCalledWith('focusout', expect.any(Function), {
			once: true
		});
	});

	it('clears the unsaved mark when the form saves again', async () => {
		const form = fakeForm();
		await save(form, { type: 'error' });
		const update = await save(form, { type: 'success' });
		expect(update).toHaveBeenCalledWith({ reset: false, refreshAll: undefined });
		expect(failedSaves.has(form)).toBe(false);
	});

	it('still shows a validation failure through update', async () => {
		const form = fakeForm();
		const update = await save(form, { type: 'failure' });
		expect(update).toHaveBeenCalled();
		expect(failedSaves.has(form)).toBe(false);
	});
});

describe('autosaveSubmit with overlapping saves', () => {
	it('does not mark the form unsaved when an older save errors after a newer one started', async () => {
		const form = fakeForm();
		const submit = autosaveSubmit as unknown as (input: unknown) => unknown;
		const older = (await submit({ formElement: form })) as (opts: unknown) => Promise<void>;
		const newer = (await submit({ formElement: form })) as (opts: unknown) => Promise<void>;
		await older({ result: { type: 'error' }, update: vi.fn() });
		expect(failedSaves.has(form)).toBe(false);
		await newer({ result: { type: 'error' }, update: vi.fn() });
		expect(failedSaves.has(form)).toBe(true);
	});
});

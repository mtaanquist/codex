import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BeforeNavigate } from '$app/navigation';

const env = vi.hoisted(() => ({ browser: false }));
const goto = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/env', () => ({
	get browser() {
		return env.browser;
	}
}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('#lib/enhance', () => ({ focusIsBeingRestored: () => false }));

const { autosaveSubmit, failedSaves, flushBeforeNavigate } = await import('./autosave-form');

function fakeForm() {
	return {
		querySelectorAll: () => [],
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
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

// Leaving a page while a save has failed would lose the change (#1692).
describe('flushBeforeNavigate after a failed save', () => {
	type Callback = (opts: unknown) => Promise<void>;
	let retries: Callback[];
	let forms: HTMLFormElement[];

	// A form on the page whose requestSubmit runs the enhance callback, as kit does.
	function connectedForm() {
		const form = { ...fakeForm(), isConnected: true } as unknown as HTMLFormElement;
		form.requestSubmit = vi.fn(() => {
			retries.push(
				(autosaveSubmit as unknown as (input: unknown) => Callback)({ formElement: form })
			);
		});
		forms.push(form);
		return form;
	}

	function navigation(type: string) {
		const to = { url: new URL('http://localhost/stories/s/settings/editor'), route: { id: 'b' } };
		return {
			type,
			from: { route: { id: 'a' } },
			to: type === 'leave' ? null : to,
			cancel: vi.fn()
		} as unknown as BeforeNavigate & { cancel: ReturnType<typeof vi.fn> };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	beforeEach(() => {
		env.browser = true;
		retries = [];
		forms = [];
		goto.mockClear();
		vi.stubGlobal('document', { activeElement: null });
		vi.stubGlobal('HTMLInputElement', class {});
	});
	afterEach(() => {
		env.browser = false;
		failedSaves.clear();
		// Gone from the page, so they hold no later test.
		for (const form of forms) (form as { isConnected: boolean }).isConnected = false;
		vi.unstubAllGlobals();
	});

	async function failedForm() {
		const form = connectedForm();
		await save(form, { type: 'error' });
		expect(failedSaves.has(form)).toBe(true);
		return form;
	}

	it('holds the navigation, saves again, and goes on when the save lands', async () => {
		const form = await failedForm();
		const nav = navigation('link');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await settle();
		expect(form.requestSubmit).toHaveBeenCalledTimes(1);
		expect(goto).not.toHaveBeenCalled();
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(goto).toHaveBeenCalledWith(nav.to!.url);
	});

	it('stays on the page with the message when the save fails again', async () => {
		const form = await failedForm();
		flushBeforeNavigate(navigation('link'));
		await settle();
		await retries[0]({ result: { type: 'error' }, update: vi.fn() });
		expect(goto).not.toHaveBeenCalled();
		expect(failedSaves.has(form)).toBe(true);
	});

	it('waits for a retry already saving instead of sending another', async () => {
		const form = await failedForm();
		// The blur on the way to the link retries the form.
		form.requestSubmit();
		const nav = navigation('link');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await settle();
		expect(form.requestSubmit).toHaveBeenCalledTimes(1);
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(goto).toHaveBeenCalledWith(nav.to!.url);
	});

	it('asks before the tab is closed', async () => {
		await failedForm();
		const nav = navigation('leave');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
	});

	it('lets the navigation go when nothing has failed', () => {
		const nav = navigation('link');
		flushBeforeNavigate(nav);
		expect(nav.cancel).not.toHaveBeenCalled();
		const leave = navigation('leave');
		flushBeforeNavigate(leave);
		expect(leave.cancel).not.toHaveBeenCalled();
	});

	it('does not hold the writer for a form that is no longer on the page', async () => {
		const form = await failedForm();
		(form as { isConnected: boolean }).isConnected = false;
		const nav = navigation('link');
		flushBeforeNavigate(nav);
		expect(nav.cancel).not.toHaveBeenCalled();
	});
});

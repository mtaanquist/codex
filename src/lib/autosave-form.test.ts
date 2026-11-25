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

const { autosaveSubmit, autosubmitForm, failedSaves, flushBeforeNavigate } =
	await import('./autosave-form');

function fakeForm() {
	return {
		querySelectorAll: () => [],
		querySelector: () => null,
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
describe('flushBeforeNavigate holding a navigation', () => {
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

	function navigation(type: string, toRoute = 'b') {
		const to = {
			url: new URL('http://localhost/stories/s/settings/editor'),
			route: { id: toRoute }
		};
		return {
			type,
			...(type === 'popstate' ? { delta: -1 } : {}),
			from: { route: { id: 'a' } },
			to: type === 'leave' ? null : to,
			cancel: vi.fn()
		} as unknown as BeforeNavigate & { cancel: ReturnType<typeof vi.fn> };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	// Kit undoes a cancelled Back press with a history step of its own.
	let popstateListeners: (() => void)[];
	function stubWindow(location: object) {
		popstateListeners = [];
		vi.stubGlobal('window', {
			location,
			addEventListener: (type: string, listener: () => void) => {
				if (type === 'popstate') popstateListeners.push(listener);
			}
		});
	}
	async function historyRestored() {
		for (const listener of popstateListeners.splice(0)) listener();
		await settle();
	}

	beforeEach(() => {
		env.browser = true;
		retries = [];
		forms = [];
		goto.mockReset();
		goto.mockImplementation(async () => {});
		vi.stubGlobal('document', { activeElement: null });
		stubWindow({ href: 'http://localhost/stories/s/settings' });
		vi.stubGlobal('history', { go: vi.fn() });
		vi.stubGlobal('HTMLInputElement', class {});
		vi.stubGlobal('HTMLTextAreaElement', class {});
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

	// A link clicked straight from an edited field: its blur starts the save on
	// the way, and nothing has failed yet (#1697).
	it('holds the navigation while a save is in flight, and goes on when it lands', async () => {
		const form = connectedForm();
		form.requestSubmit();
		const nav = navigation('link');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await settle();
		expect(goto).not.toHaveBeenCalled();
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(goto).toHaveBeenCalledWith(nav.to!.url);
	});

	it('stays on the page when a save in flight fails', async () => {
		const form = connectedForm();
		form.requestSubmit();
		flushBeforeNavigate(navigation('link'));
		await settle();
		await retries[0]({ result: { type: 'error' }, update: vi.fn() });
		await settle();
		expect(goto).not.toHaveBeenCalled();
		expect(failedSaves.has(form)).toBe(true);
	});

	it('holds the navigation for the save the focused field starts as it is left', async () => {
		const form = connectedForm();
		const field = Object.assign(
			new (globalThis.HTMLTextAreaElement as unknown as new () => object)(),
			{
				dataset: {}
			}
		);
		vi.stubGlobal('document', {
			activeElement: {
				blur: () =>
					autosubmitForm({ target: field, currentTarget: form } as unknown as Event & {
						currentTarget: HTMLFormElement;
					})
			}
		});
		const nav = navigation('link');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await settle();
		expect(form.requestSubmit).toHaveBeenCalledTimes(1);
		expect(goto).not.toHaveBeenCalled();
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(goto).toHaveBeenCalledWith(nav.to!.url);
	});

	it('asks before the tab is closed while a save is in flight', async () => {
		connectedForm().requestSubmit();
		const leave = navigation('leave');
		flushBeforeNavigate(leave);
		expect(leave.cancel).toHaveBeenCalled();
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
	});

	// The command palette navigates with goto, and a universe's main page and
	// its settings share one route (#1709).
	it('holds a goto to another page on the same route while a save is in flight', async () => {
		const form = connectedForm();
		form.requestSubmit();
		const nav = navigation('goto', 'a');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await retries[0]({ result: { type: 'error' }, update: vi.fn() });
		await settle();
		expect(goto).not.toHaveBeenCalled();
	});

	it('holds a goto to another page on the same route after a save failed', async () => {
		await failedForm();
		const nav = navigation('goto', 'a');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await settle();
		await retries[0]({ result: { type: 'error' }, update: vi.fn() });
		expect(goto).not.toHaveBeenCalled();
	});

	it('lets the held goto go on once the save lands', async () => {
		const form = connectedForm();
		form.requestSubmit();
		const nav = navigation('goto', 'a');
		flushBeforeNavigate(nav);
		const again = navigation('goto', 'a');
		goto.mockImplementationOnce(async () => flushBeforeNavigate(again));
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(goto).toHaveBeenCalledWith(nav.to!.url);
		expect(again.cancel).not.toHaveBeenCalled();
	});

	it('does not hold the rename redirect while another save is in flight', async () => {
		const renamed = connectedForm();
		const other = connectedForm();
		renamed.requestSubmit();
		other.requestSubmit();
		const redirect = navigation('goto', 'a');
		goto.mockImplementationOnce(async () => flushBeforeNavigate(redirect));
		await retries[0]({
			result: { type: 'redirect', location: '/universes/new-name' },
			update: vi.fn()
		});
		expect(goto).toHaveBeenCalledWith(
			'/universes/new-name',
			expect.objectContaining({ replace: true })
		);
		expect(redirect.cancel).not.toHaveBeenCalled();
		await retries[1]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
	});

	// A held Back press goes back once the save lands, instead of pushing the
	// page it was going to as a new entry (#1710).
	it('goes back through the history after holding a Back press', async () => {
		const form = connectedForm();
		form.requestSubmit();
		const nav = navigation('popstate');
		flushBeforeNavigate(nav);
		expect(nav.cancel).toHaveBeenCalled();
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(history.go).not.toHaveBeenCalled();
		await historyRestored();
		expect(history.go).toHaveBeenCalledWith(-1);
		expect(goto).not.toHaveBeenCalled();
	});

	it('goes back through the history after a failed save is retried', async () => {
		const form = await failedForm();
		flushBeforeNavigate(navigation('popstate'));
		await settle();
		expect(form.requestSubmit).toHaveBeenCalledTimes(1);
		await retries[0]({ result: { type: 'success' }, update: vi.fn(async () => {}) });
		expect(history.go).not.toHaveBeenCalled();
		await historyRestored();
		expect(history.go).toHaveBeenCalledWith(-1);
		expect(goto).not.toHaveBeenCalled();
	});

	it('moves to the renamed address before going back after a rename', async () => {
		stubWindow({
			href: 'http://localhost/universes/old/categories',
			pathname: '/universes/old/categories',
			origin: 'http://localhost'
		});
		const form = connectedForm();
		form.requestSubmit();
		const nav = {
			type: 'popstate',
			delta: -1,
			from: { route: { id: 'a' } },
			to: { url: new URL('http://localhost/universes'), route: { id: 'b' } },
			cancel: vi.fn()
		} as unknown as BeforeNavigate;
		flushBeforeNavigate(nav);
		const landed = retries[0]({
			result: { type: 'redirect', location: '/universes/new/categories' },
			update: vi.fn()
		});
		await settle();
		expect(goto).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledWith(
			'/universes/new/categories',
			expect.objectContaining({ replace: true })
		);
		expect(history.go).not.toHaveBeenCalled();
		await historyRestored();
		await landed;
		expect(history.go).toHaveBeenCalledWith(-1);
	});

	it('goes to the renamed address of a held Back press into the same page', async () => {
		stubWindow({
			href: 'http://localhost/universes/old/categories',
			pathname: '/universes/old/categories',
			origin: 'http://localhost'
		});
		const form = connectedForm();
		form.requestSubmit();
		const nav = {
			type: 'popstate',
			delta: -1,
			from: { route: { id: 'a' } },
			to: { url: new URL('http://localhost/universes/old'), route: { id: 'a' } },
			cancel: vi.fn()
		} as unknown as BeforeNavigate;
		flushBeforeNavigate(nav);
		await retries[0]({
			result: { type: 'redirect', location: '/universes/new/categories' },
			update: vi.fn()
		});
		expect(goto).toHaveBeenLastCalledWith(new URL('http://localhost/universes/new'));
		expect(history.go).not.toHaveBeenCalled();
	});
});

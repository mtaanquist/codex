import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browseAdult, syncBrowseAdult } from './browse-adult.svelte';
import { BROWSE_ADULT_KEY } from './browse';

// What another tab's change looks like here: storage already holds the new
// value, and the window gets a storage event naming the key.
function changeInOtherTab(key: string | null) {
	const event = new Event('storage') as Event & { key: string | null };
	event.key = key;
	window.dispatchEvent(event);
}

let stored: Map<string, string>;

beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('window', new EventTarget());
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key)
	});
	browseAdult.remembered = false;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('syncBrowseAdult', () => {
	it('follows the choice when another tab changes it', () => {
		stored.set(BROWSE_ADULT_KEY, 'show');
		const stop = syncBrowseAdult();
		expect(browseAdult.remembered).toBe(true);

		stored.delete(BROWSE_ADULT_KEY);
		changeInOtherTab(BROWSE_ADULT_KEY);
		expect(browseAdult.remembered).toBe(false);

		stored.set(BROWSE_ADULT_KEY, 'show');
		changeInOtherTab(BROWSE_ADULT_KEY);
		expect(browseAdult.remembered).toBe(true);

		// Another tab clearing all of storage.
		stored.clear();
		changeInOtherTab(null);
		expect(browseAdult.remembered).toBe(false);
		stop();
	});

	it('ignores other keys and stops listening once cleaned up', () => {
		stored.set(BROWSE_ADULT_KEY, 'show');
		const stop = syncBrowseAdult();
		stored.delete(BROWSE_ADULT_KEY);
		changeInOtherTab('codex-theme');
		expect(browseAdult.remembered).toBe(true);

		stop();
		changeInOtherTab(BROWSE_ADULT_KEY);
		expect(browseAdult.remembered).toBe(true);
	});
});

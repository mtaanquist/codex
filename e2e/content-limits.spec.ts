import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';

// Runs as the account with the Assistant switched on, so the section shows.
test.use({ storageState: 'e2e/.auth/assistant.json' });

async function query(text: string, values: unknown[] = []) {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		return await pool.query(text, values);
	} finally {
		await pool.end();
	}
}

// A content limit saves when it is picked, and saving another setting later
// leaves it as it is.
test('a content limit is kept when another preference saves', async ({ page }) => {
	const slug = `e2e-limit-${Date.now()}`;
	const name = `E2E limit ${Date.now()}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await gotoReady(page, '/');
		await pickFromLibraryMenu(page, 'New universe');
		await page.getByLabel('New universe').fill(`Limits ${Date.now()}`);
		await page.getByRole('button', { name: 'Create universe' }).click();
		await expect(page.locator('#u-name')).toBeVisible();
		await gotoReady(page, `${new URL(page.url()).pathname}/preferences`);

		const limit = page.getByRole('combobox', { name });
		await limit.selectOption('avoid');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('avoid');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');

		// Clearing it again is saved too.
		await page.getByRole('combobox', { name }).selectOption('');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
	} finally {
		await query(`delete from tags where slug = $1 and kind = 'warning'`, [slug]);
	}
});

async function openUniversePreferences(page: import('@playwright/test').Page) {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Limits ${Date.now()}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.locator('#u-name')).toBeVisible();
	await gotoReady(page, `${new URL(page.url()).pathname}/preferences`);
}

// A limit picked after the warning list changed under the open page is not
// stored, and the select goes back to what is stored instead of keeping the
// pick on show.
test('a limit not stored because the list changed shows what is stored', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-stale-${stamp}`;
	const name = `E2E stale ${stamp}`;
	const added = `e2e-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E added ${stamp}`,
			added
		]);
		const limit = page.getByRole('combobox', { name });
		await limit.selectOption('avoid');
		await expect(
			page.getByRole('status').filter({ hasText: 'your content limits were not changed' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');

		// Another save says Saved and still shows the stored limit.
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('past');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('past');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// Two quick picks save one after the other, so the last one is what is stored
// even when the first save is slow to land.
test('the last of two quick limit picks is the one stored', async ({ page }) => {
	const slug = `e2e-quick-${Date.now()}`;
	const name = `E2E quick ${Date.now()}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		let first = true;
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				if (first) {
					first = false;
					await new Promise((resolve) => setTimeout(resolve, 800));
				}
				await route.continue();
			}
		);
		const limit = page.getByRole('combobox', { name });
		await limit.selectOption('write');
		await limit.selectOption('avoid');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await expect(limit).toHaveValue('avoid');
		await page.unrouteAll({ behavior: 'wait' });
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('avoid');
	} finally {
		await query(`delete from tags where slug = $1 and kind = 'warning'`, [slug]);
	}
});

// A limit picked after the warning list changed, with another change queued
// behind its slow save, is not stored, and the writer is told so instead of
// seeing "Saved." while the pick quietly goes away.
test('a limit not stored with a change queued behind it still says why', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-queued-${stamp}`;
	const name = `E2E queued ${stamp}`;
	const added = `e2e-queued-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E queued added ${stamp}`,
			added
		]);
		let first = true;
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				if (first) {
					first = false;
					await new Promise((resolve) => setTimeout(resolve, 800));
				}
				await route.continue();
			}
		);
		await page.getByRole('combobox', { name }).selectOption('avoid');
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(
			page.getByRole('status').filter({ hasText: 'your content limits were not changed' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
		await page.unrouteAll({ behavior: 'wait' });
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// A limit whose save was refused, with the warning list changed by the time
// the page refreshes, is dropped with a note instead of being lost quietly
// on the next save.
test('a refused limit pick is not lost quietly when the list changes', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-refused-${stamp}`;
	const name = `E2E refused ${stamp}`;
	const added = `e2e-refused-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		const words = page.getByLabel('Length of a drafted scene, in words');
		await words.fill('5');
		await words.press('Tab');
		await expect(page.getByRole('alert')).toBeVisible();
		await page.getByRole('combobox', { name }).selectOption('avoid');
		await expect(page.getByRole('alert')).toBeVisible();
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E refused added ${stamp}`,
			added
		]);
		const nav = page.getByRole('navigation', { name: 'Universe settings' });
		await nav.getByRole('link', { name: 'Entity categories' }).click();
		await nav.getByRole('link', { name: 'Assistant preferences' }).click();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(
			page.getByRole('status').filter({ hasText: 'the content limits you changed were not saved' })
		).toBeVisible();
		await page.getByLabel('Length of a drafted scene, in words').fill('500');
		await page.getByLabel('Length of a drafted scene, in words').press('Tab');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// A pick made while a slow refresh is landing, whose own save is refused
// because the list changed, stays reset to what is stored once that slow
// refresh lands.
test('a refused pick is not put back by a slower refresh', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-putback-${stamp}`;
	const name = `E2E putback ${stamp}`;
	const added = `e2e-putback-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E putback added ${stamp}`,
			added
		]);
		let first = true;
		let landed!: () => void;
		const slowLanded = new Promise<void>((resolve) => (landed = resolve));
		await page.route(
			(url) => url.pathname.endsWith('__data.json'),
			async (route) => {
				if (first) {
					first = false;
					await new Promise((resolve) => setTimeout(resolve, 1500));
					await route.continue();
					landed();
					return;
				}
				await route.continue();
			}
		);
		const refresh = page.waitForRequest((request) => request.url().includes('__data.json'));
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await refresh;
		await page.getByRole('combobox', { name }).selectOption('avoid');
		await expect(
			page.getByRole('status').filter({ hasText: 'your content limits were not changed' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await slowLanded;
		await page.waitForTimeout(300);
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await page.unrouteAll({ behavior: 'wait' });
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// A refresh that brings a changed list while a limit's own save is in flight
// leaves that limit to the save: it landed, so no note says it was not saved.
test('a limit saved while the list changes under its save says nothing was lost', async ({
	page
}) => {
	const stamp = Date.now();
	const slug = `e2e-inflight-${stamp}`;
	const name = `E2E inflight ${stamp}`;
	const added = `e2e-inflight-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let handled!: () => void;
		const processed = new Promise<void>((resolve) => (handled = resolve));
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				const response = await route.fetch();
				handled();
				await gate;
				await route.fulfill({ response });
			}
		);
		await page.getByRole('combobox', { name }).selectOption('avoid');
		await processed;
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E inflight added ${stamp}`,
			added
		]);
		// Another section's save refreshes the page with the new list.
		const refreshed = page.waitForResponse((response) => response.url().includes('__data.json'));
		await page.evaluate(() =>
			document.querySelector<HTMLFormElement>('form[action$="?/update"]')!.requestSubmit()
		);
		await refreshed;
		await expect(page.getByRole('combobox', { name: `E2E inflight added ${stamp}` })).toBeVisible();
		release();
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' }).first()).toBeVisible();
		await page.waitForTimeout(300);
		await expect(
			page.getByRole('status').filter({ hasText: 'the content limits you changed were not saved' })
		).toHaveCount(0);
		await page.unrouteAll({ behavior: 'wait' });
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('avoid');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// One whose save fails while a refresh brings a changed list is dropped with
// a note, so the next save cannot post it against the new list.
test('a limit whose save fails while the list changes is not sent again', async ({ page }) => {
	const stamp = Date.now();
	const slug = `e2e-failed-${stamp}`;
	const name = `E2E failed ${stamp}`;
	const added = `e2e-failed-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let held!: () => void;
		const holding = new Promise<void>((resolve) => (held = resolve));
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				held();
				await gate;
				await route.abort();
			},
			{ times: 1 }
		);
		await page.getByRole('combobox', { name }).selectOption('avoid');
		await holding;
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E failed added ${stamp}`,
			added
		]);
		const refreshed = page.waitForResponse((response) => response.url().includes('__data.json'));
		await page.evaluate(() =>
			document.querySelector<HTMLFormElement>('form[action$="?/update"]')!.requestSubmit()
		);
		await refreshed;
		release();
		await expect(
			page.getByRole('status').filter({ hasText: 'the content limits you changed were not saved' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		await expect(page.getByRole('status').filter({ hasText: 'Saved.' }).first()).toBeVisible();
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// A limit whose save is left alone because the list changed while it was in
// flight, with the new list already on the page and another change queued
// behind it, is not sent again with the new list: the writer is told it was
// not saved and the select shows what is stored.
test('a limit left alone while the list changed is not sent again by a queued save', async ({
	page
}) => {
	const stamp = Date.now();
	const slug = `e2e-requeue-${stamp}`;
	const name = `E2E requeue ${stamp}`;
	const added = `e2e-requeue-added-${stamp}`;
	await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
	try {
		await openUniversePreferences(page);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let held!: () => void;
		const holding = new Promise<void>((resolve) => (held = resolve));
		await page.route(
			(url) => url.search.includes('saveAssistantPreferences'),
			async (route) => {
				held();
				await gate;
				await route.continue();
			},
			{ times: 1 }
		);
		await page.getByRole('combobox', { name }).selectOption('write');
		await holding;
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
			`E2E requeue added ${stamp}`,
			added
		]);
		// Another section's save refreshes the page with the new list.
		const refreshed = page.waitForResponse((response) => response.url().includes('__data.json'));
		await page.evaluate(() =>
			document.querySelector<HTMLFormElement>('form[action$="?/update"]')!.requestSubmit()
		);
		await refreshed;
		await expect(page.getByRole('combobox', { name: `E2E requeue added ${stamp}` })).toBeVisible();
		const queued = page.waitForRequest(
			(request) =>
				request.url().includes('saveAssistantPreferences') &&
				(request.postData() ?? '').includes('present')
		);
		await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
		release();
		const sent = await queued;
		expect(sent.postData() ?? '').not.toContain('changedLimits');
		await expect(
			page.getByRole('status').filter({ hasText: 'the content limits you changed were not saved' })
		).toBeVisible();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
		await page.reload();
		await expect(page.getByRole('combobox', { name })).toHaveValue('');
		await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
	} finally {
		await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
	}
});

// A limit picked while another save's refresh is landing starts its own save
// at once, against the list the page showed. When that refresh brings a
// changed list and the limit's save then fails, or fails before the refresh
// lands, the pick is dropped with a note, so the next save cannot post it
// against the new list.
for (const failFirst of [false, true]) {
	test(`a limit whose save fails during a refresh with a new list is not sent again${failFirst ? ' (save fails first)' : ''}`, async ({
		page
	}) => {
		const stamp = Date.now();
		const slug = `e2e-midrefresh-${stamp}`;
		const name = `E2E midrefresh ${stamp}`;
		const added = `e2e-midrefresh-added-${stamp}`;
		await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [name, slug]);
		try {
			await openUniversePreferences(page);
			let releaseRefresh!: () => void;
			const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
			let refreshHeld!: () => void;
			const refreshHolding = new Promise<void>((resolve) => (refreshHeld = resolve));
			// Held with a flag rather than a route that runs once: taking that
			// route off once it has run lets the held save through as well.
			let refreshing = true;
			await page.route(
				(url) => url.pathname.endsWith('__data.json'),
				async (route) => {
					if (refreshing) {
						refreshing = false;
						refreshHeld();
						await refreshGate;
					}
					await route.continue();
				}
			);
			await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
			await refreshHolding;
			await query(`insert into tags (kind, name, slug) values ('warning', $1, $2)`, [
				`E2E midrefresh added ${stamp}`,
				added
			]);

			let releaseSave!: () => void;
			const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
			let saveHeld!: () => void;
			const saveHolding = new Promise<void>((resolve) => (saveHeld = resolve));
			let failing = true;
			await page.route(
				(url) => url.search.includes('saveAssistantPreferences'),
				async (route) => {
					if (!failing) return route.continue();
					failing = false;
					saveHeld();
					await saveGate;
					await route.abort();
				}
			);
			await page.getByRole('combobox', { name }).selectOption('avoid');
			await saveHolding;
			const newList = page.getByRole('combobox', { name: `E2E midrefresh added ${stamp}` });
			if (failFirst) {
				releaseSave();
				await expect(page.getByRole('alert')).toBeVisible();
				releaseRefresh();
				await expect(newList).toBeVisible();
			} else {
				releaseRefresh();
				await expect(newList).toBeVisible();
				releaseSave();
				await expect(page.getByRole('alert')).toBeVisible();
			}
			await expect(
				page
					.getByRole('status')
					.filter({ hasText: 'the content limits you changed were not saved' })
			).toBeVisible();
			await expect(page.getByRole('combobox', { name })).toHaveValue('');

			const next = page.waitForRequest(
				(request) =>
					request.url().includes('saveAssistantPreferences') &&
					(request.postData() ?? '').includes('past')
			);
			await page.getByRole('combobox', { name: 'Tense' }).selectOption('past');
			const sent = await next;
			expect(sent.postData() ?? '').not.toContain('changedLimits');
			await expect(page.getByRole('status').filter({ hasText: 'Saved.' }).first()).toBeVisible();
			await page.unrouteAll({ behavior: 'wait' });
			await page.reload();
			await expect(page.getByRole('combobox', { name })).toHaveValue('');
			await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('past');
		} finally {
			await query(`delete from tags where slug = any($1) and kind = 'warning'`, [[slug, added]]);
		}
	});
}

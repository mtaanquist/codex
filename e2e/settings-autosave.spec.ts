import { expect, test, type Browser, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// The Details forms save as the writer moves between fields (#1573). A save
// landing while the writer types elsewhere, or in the same field again, must
// not move focus or put back an older value.

// Holds each Details save back, so it lands while the writer is typing.
async function slowSaves(page: Page) {
	await page.route(/\?\/update$/, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 400));
		await route.continue();
	});
}

// A page that has not run its script (a slow load, or a script that failed).
async function withoutScript(browser: Browser, baseURL: string | undefined) {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
		storageState: 'e2e/.auth/e2e.json'
	});
	return { context, page: await context.newPage() };
}

async function newStory(page: Page) {
	const stamp = Date.now();
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Autosave world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	const universeUrl = new URL(page.url()).pathname;
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Autosave world ${stamp}`);
	await page.getByLabel('New story').fill(`Autosave ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(`Autosave ${stamp}`);
	const slug = new URL(page.url()).pathname.split('/')[2];
	await gotoReady(page, `/stories/${slug}/settings`);
	return { slug, stamp, universeUrl };
}

test('typing in the next field while a save lands keeps focus and text', async ({ page }) => {
	await newStory(page);
	await slowSaves(page);
	await page.locator('#st-description').fill('A courier races the ash north.');
	await page.locator('#st-style-notes').click();
	const text = 'Epic fantasy serial, omniscient narrator, formal prose.';
	const saved = page.waitForResponse(/\?\/update$/);
	await page.keyboard.type(text, { delay: 25 });
	await saved;
	await expect(page.locator('#st-style-notes')).toHaveValue(text);
	await expect(page.locator('#st-style-notes')).toBeFocused();
	// Leaving the field saves it, once.
	let posts = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().endsWith('?/update')) posts += 1;
	});
	const final = page.waitForResponse(/\?\/update$/);
	await page.locator('#st-style-notes').press('Tab');
	await final;
	await page.waitForTimeout(200);
	expect(posts).toBe(1);
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(page.locator('#st-description')).toHaveValue('A courier races the ash north.');
	await expect(page.locator('#st-style-notes')).toHaveValue(text);
});

test('going back into a field before its save lands keeps the newer text', async ({ page }) => {
	await newStory(page);
	await slowSaves(page);
	const field = page.locator('#st-brief');
	await field.fill('First half');
	await field.press('Tab');
	const saved = page.waitForResponse(/\?\/update$/);
	await field.click();
	await page.keyboard.press('End');
	await page.keyboard.type(', second half', { delay: 25 });
	await saved;
	await page.waitForTimeout(300);
	await expect(field).toHaveValue('First half, second half');
	const final = page.waitForResponse(/\?\/update$/);
	await field.press('Tab');
	await final;
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(page.locator('#st-brief')).toHaveValue('First half, second half');
});

test('renaming and typing in the next field keeps both', async ({ page }) => {
	const { stamp } = await newStory(page);
	await slowSaves(page);
	await page.locator('#st-title').fill(`Renamed ${stamp}`);
	await page.locator('#st-title').press('Tab');
	await expect(page.locator('#st-author')).toBeFocused();
	const renamed = page.waitForResponse(/\?\/update$/);
	await page.keyboard.type('A. Writer', { delay: 50 });
	await renamed;
	await expect(page).toHaveURL(`/stories/renamed-${stamp}/settings`);
	await expect(page.locator('#st-author')).toHaveValue('A. Writer');
	await page.locator('#st-author').press('Tab');
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await gotoReady(page, `/stories/renamed-${stamp}/settings`);
	await expect(page.locator('#st-author')).toHaveValue('A. Writer');
});

test('renaming and then leaving by a sidebar link does not end on a missing page', async ({
	page
}) => {
	const { stamp } = await newStory(page);
	await slowSaves(page);
	await page.locator('#st-title').fill(`Moved ${stamp}`);
	await page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Editor' })
		.click();
	// The rename saves first, then the link goes on to the new address.
	await expect(page).toHaveURL(`/stories/moved-${stamp}/settings/editor`);
	await expect(page.getByLabel('Editing mode')).toBeVisible();
});

// A settings page reached by id (as the Assistant links a universe's
// suggestions) moves to its slug address, so a rename followed by a sidebar
// link still lands on the renamed page (#1691).
test('a settings page reached by id moves to its slug address', async ({ page }) => {
	const { slug, stamp } = await newStory(page);
	// The Details form posts by id.
	const action = await page.locator('form:has(#st-title)').getAttribute('action');
	const id = action!.split('/')[2];
	expect(id).not.toBe(slug);
	await gotoReady(page, `/stories/${id}/settings`);
	await expect(page).toHaveURL(`/stories/${slug}/settings`);
	await slowSaves(page);
	await page.locator('#st-title').fill(`Moved ${stamp}`);
	await page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Editor' })
		.click();
	await expect(page).toHaveURL(`/stories/moved-${stamp}/settings/editor`);
	await expect(page.getByLabel('Editing mode')).toBeVisible();
});

// A Details save that lands after the writer has moved to Publish refreshes the
// page data; a genre ticked meanwhile, not yet saved, must stay ticked (#1651).
test('a genre ticked on Publish while a Details save lands stays ticked', async ({ page }) => {
	await newStory(page);
	await page.route(/\?\/update$/, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.continue();
	});
	await page.locator('#st-description').fill('A courier races the ash north.');
	const saved = page.waitForResponse(/\?\/update$/);
	// Leaving the field for Publish starts its save.
	await page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Publish' })
		.click();
	await expect(page).toHaveURL(/\/settings\/publish$/);
	const fantasy = page.getByRole('checkbox', { name: 'Fantasy' });
	await fantasy.check();
	const refreshed = page.waitForResponse(/__data\.json/);
	await saved;
	await refreshed;
	await expect(fantasy).toBeChecked();
});

// The rename commits at once but its answer arrives late, so the next field's
// save is posted, and answered, while the page still has its old address. That
// save must land and the page must stay (#1667).
async function slowRenameAnswer(page: Page) {
	let first = true;
	await page.route(/\?\/update$/, async (route) => {
		if (!first) return route.continue();
		first = false;
		const response = await route.fetch();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.fulfill({ response });
	});
}

test('a story field saved while a rename is still saving is kept', async ({ page }) => {
	const { stamp } = await newStory(page);
	await slowRenameAnswer(page);
	await page.locator('#st-title').fill(`Raced ${stamp}`);
	await page.locator('#st-title').press('Tab');
	await expect(page.locator('#st-author')).toBeFocused();
	await page.keyboard.type('A. Writer');
	const second = page.waitForResponse(
		(response) =>
			/\?\/update$/.test(response.url()) &&
			(response.request().postData() ?? '').includes('author=A.+Writer')
	);
	await page.keyboard.press('Tab');
	expect((await second).ok()).toBe(true);
	await expect(page).toHaveURL(`/stories/raced-${stamp}/settings`);
	await expect(page.locator('#st-author')).toHaveValue('A. Writer');
	await gotoReady(page, `/stories/raced-${stamp}/settings`);
	await expect(page.locator('#st-title')).toHaveValue(`Raced ${stamp}`);
	await expect(page.locator('#st-author')).toHaveValue('A. Writer');
});

test('a universe field saved while a rename is still saving is kept', async ({ page }) => {
	const stamp = Date.now();
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Race world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	await gotoReady(page, new URL(page.url()).pathname);
	await slowRenameAnswer(page);
	await page.locator('#u-name').fill(`Raced world ${stamp}`);
	await page.locator('#u-name').press('Tab');
	await expect(page.locator('#u-description')).toBeFocused();
	await page.keyboard.type('Ash and bells.');
	const second = page.waitForResponse(
		(response) =>
			/\?\/update$/.test(response.url()) &&
			(response.request().postData() ?? '').includes('description=Ash+and+bells.')
	);
	await page.keyboard.press('Tab');
	expect((await second).ok()).toBe(true);
	await expect(page).toHaveURL(`/universes/raced-world-${stamp}`);
	await expect(page.locator('#u-description')).toHaveValue('Ash and bells.');
	await gotoReady(page, `/universes/raced-world-${stamp}`);
	await expect(page.locator('#u-description')).toHaveValue('Ash and bells.');
});

// The text boxes hold the stored text before the page's script runs, so they
// never show empty and a save from that state does not post them empty (#1683).
test('the Details text boxes hold the stored text before the script runs', async ({
	page,
	browser,
	baseURL
}) => {
	const { slug, universeUrl } = await newStory(page);
	const description = 'A courier races the ash north.';
	const style = 'Epic fantasy serial, omniscient narrator.';
	await page.locator('#st-description').fill(description);
	await page.locator('#st-style-notes').fill(style);
	const saved = page.waitForResponse(
		(response) =>
			/\?\/update$/.test(response.url()) &&
			(response.request().postData() ?? '').includes('styleNotes=Epic')
	);
	await page.locator('#st-style-notes').press('Tab');
	expect((await saved).ok()).toBe(true);
	await gotoReady(page, universeUrl);
	await page.locator('#u-description').fill('Ash and bells.');
	const universeSaved = page.waitForResponse(/\?\/update$/);
	await page.locator('#u-description').press('Tab');
	expect((await universeSaved).ok()).toBe(true);

	const plain = await withoutScript(browser, baseURL);
	try {
		await plain.page.goto(`/stories/${slug}/settings`);
		await expect(plain.page.locator('#st-description')).toHaveValue(description);
		await expect(plain.page.locator('#st-style-notes')).toHaveValue(style);

		await plain.page.goto(universeUrl);
		await expect(plain.page.locator('#u-description')).toHaveValue('Ash and bells.');
	} finally {
		await plain.context.close();
	}
});

// A save that fails (no connection, a server fault) keeps the page and the
// typed text, says it was not saved, and the next blur saves it (#1681).
test('a failed save keeps the page and the text, and the next blur retries', async ({ page }) => {
	await newStory(page);
	await page.route(/\?\/update$/, (route) => route.abort());
	const field = page.locator('#st-description');
	await field.fill('A courier races the ash north.');
	await field.press('Tab');
	await expect(page.getByRole('alert')).toHaveText(
		'Your change was not saved. Check your connection and try again.'
	);
	await expect(page.locator('#st-title')).toBeVisible();
	await expect(field).toHaveValue('A courier races the ash north.');
	await page.unroute(/\?\/update$/);
	const saved = page.waitForResponse(/\?\/update$/);
	await page.keyboard.press('Tab');
	await saved;
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(page.locator('#st-description')).toHaveValue('A courier races the ash north.');
});

// Following a link while a save has failed tries the save again first, and
// stays on the page if it fails again, so the change is not lost (#1692).
test('leaving after a failed save waits for the save, and stays if it fails', async ({ page }) => {
	const { slug } = await newStory(page);
	await page.route(/\?\/update$/, (route) => route.abort());
	const field = page.locator('#st-description');
	await field.fill('A courier races the ash north.');
	await field.press('Tab');
	const alert = page.getByRole('alert');
	await expect(alert).toHaveText('Your change was not saved. Check your connection and try again.');
	const editorLink = page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Editor' });
	await editorLink.click();
	await expect(alert).toHaveText('Your change was not saved. Check your connection and try again.');
	await page.waitForTimeout(300);
	await expect(page).toHaveURL(`/stories/${slug}/settings`);
	await expect(field).toHaveValue('A courier races the ash north.');
	// Once the connection is back, the same link saves and then goes on.
	await page.unroute(/\?\/update$/);
	await editorLink.click();
	await expect(page).toHaveURL(`/stories/${slug}/settings/editor`);
	await gotoReady(page, `/stories/${slug}/settings`);
	await expect(page.locator('#st-description')).toHaveValue('A courier races the ash north.');
});

test('closing the tab after a failed save asks first', async ({ page }) => {
	await newStory(page);
	await page.route(/\?\/update$/, (route) => route.abort());
	await page.locator('#st-description').fill('A courier races the ash north.');
	await page.locator('#st-description').press('Tab');
	await expect(page.getByRole('alert')).toBeVisible();
	const dialog = page.waitForEvent('dialog');
	await page.close({ runBeforeUnload: true });
	const asked = await dialog;
	expect(asked.type()).toBe('beforeunload');
	await asked.accept();
});

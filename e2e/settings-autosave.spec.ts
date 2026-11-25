import { expect, test, type Page } from '@playwright/test';
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

async function newStory(page: Page) {
	const stamp = Date.now();
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Autosave world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Autosave world ${stamp}`);
	await page.getByLabel('New story').fill(`Autosave ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(`Autosave ${stamp}`);
	const slug = new URL(page.url()).pathname.split('/')[2];
	await gotoReady(page, `/stories/${slug}/settings`);
	return { slug, stamp };
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

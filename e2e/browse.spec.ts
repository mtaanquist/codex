import { expect, test } from '@playwright/test';
import pg from 'pg';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { e2eDatabaseUrl } from './database';
import { violations } from './axe';

// Browse: an author lists a public story, a signed-out reader finds it, and it
// leaves Browse when the story stops being public. Turns Browse on for the run
// and off again after, so the other specs see the default.

async function setBrowse(enabled: boolean) {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(
			`insert into app_settings (key, value) values ('browse', $1)
			 on conflict (key) do update set value = excluded.value`,
			[JSON.stringify({ enabled })]
		);
	} finally {
		await pool.end();
	}
}

test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
	await setBrowse(false);
});

test('a listed public story shows on Browse until it is made private', async ({
	page,
	browser
}) => {
	await setBrowse(true);
	const stamp = Date.now();
	const title = `Browse story ${stamp}`;

	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Browse world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Browse world ${stamp}`);
	await page.getByLabel('New story').fill(title);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText(title);
	await gotoReady(page, page.url());
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('The bell rang twice.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyPath = new URL(page.url()).pathname;

	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByLabel('Visibility').selectOption('public');
	await page.getByLabel('List in Browse').check();
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.getByRole('button', { name: 'Publish edition' }).click();
	const penPrompt = page.getByRole('dialog', { name: 'Choose your author name' });
	if (await penPrompt.isVisible()) {
		await penPrompt.getByRole('button', { name: 'Continue' }).click();
	}
	await expect(page.getByRole('status')).toContainText('Edition published.');

	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const reader = await anonymous.newPage();
	await gotoReady(reader, '/');
	await reader.getByRole('banner').getByRole('link', { name: 'Browse' }).click();
	await expect(reader).toHaveURL('/browse');
	await reader.getByLabel('Search stories').fill(`${stamp}`);
	await reader.getByRole('button', { name: 'Search' }).click();
	await expect(reader.locator('.shelf-item-title')).toHaveText([title]);
	expect(await violations(reader)).toEqual([]);

	await gotoReady(page, `${storyPath}/settings/publish`);
	await page.getByLabel('Visibility').selectOption('private');
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');

	await reader.reload();
	await expect(reader.locator('.browse-empty')).toBeVisible();
	await anonymous.close();
});

test('Browse includes adult work on load once a reader searched with it', async ({ browser }) => {
	await setBrowse(true);
	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const reader = await anonymous.newPage();
	const adultBox = reader.getByLabel('Include adult content');

	await gotoReady(reader, '/browse');
	await expect(adultBox).not.toBeChecked();
	await adultBox.check();
	await reader.getByRole('button', { name: 'Search' }).click();
	await expect(reader).toHaveURL(/adult=show/);

	// A full load and a link inside the app both bring the choice back.
	await gotoReady(reader, '/browse?q=bell');
	await expect(reader).toHaveURL('/browse?q=bell&adult=show');
	await expect(adultBox).toBeChecked();
	await gotoReady(reader, '/');
	await reader.getByRole('banner').getByRole('link', { name: 'Browse' }).click();
	await expect(reader).toHaveURL('/browse?adult=show');

	// Unticking and searching leaves adult work out from then on.
	await adultBox.uncheck();
	await reader.getByRole('button', { name: 'Search' }).click();
	await expect(reader).not.toHaveURL(/adult=/);
	await gotoReady(reader, '/browse');
	await expect(reader).toHaveURL('/browse');
	await expect(adultBox).not.toBeChecked();
	await anonymous.close();
});

test('Browse does not exist while it is off', async ({ page }) => {
	await setBrowse(false);
	const response = await gotoReady(page, '/browse');
	expect(response?.status()).toBe(404);
});

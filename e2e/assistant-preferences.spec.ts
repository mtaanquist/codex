import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { violations } from './axe';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Runs as the account with the Assistant switched on, so the section shows.
test.use({ storageState: 'e2e/.auth/assistant.json' });

// #1548: Assistant preferences is its own settings item, not part of Details.
test('Assistant preferences has its own settings page for a universe and a story', async ({
	page,
	browser,
	baseURL
}) => {
	await gotoReady(page, '/');
	const name = `Prefs ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);
	const universeUrl = new URL(page.url()).pathname;

	// Details no longer holds the form.
	await expect(page.locator('#u-name')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Assistant preferences' })).toHaveCount(0);

	await page
		.getByRole('navigation', { name: 'Universe settings' })
		.getByRole('link', { name: 'Assistant preferences' })
		.click();
	await expect(page).toHaveURL(`${universeUrl}/preferences`);
	await expect(
		page.getByRole('heading', { name: 'Assistant preferences', level: 2 })
	).toBeVisible();
	await expect(page.locator('#u-name')).toBeHidden();
	// A choice saves as soon as it is made, and the page stays put.
	await page.getByRole('combobox', { name: 'Tense' }).selectOption('present');
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await expect(page).toHaveURL(`${universeUrl}/preferences`);
	await page.reload();
	await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('present');
	expect(await violations(page)).toEqual([]);

	// A story in the universe shows the universe's choice as its default.
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill('Prefs story');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Prefs story');
	const slug = new URL(page.url()).pathname.split('/')[2];

	await gotoReady(page, `/stories/${slug}/settings`);
	await expect(page.locator('#st-title')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Assistant preferences' })).toHaveCount(0);
	await page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Assistant preferences' })
		.click();
	await expect(page).toHaveURL(`/stories/${slug}/settings/preferences`);
	const tense = page.getByRole('combobox', { name: 'Tense' });
	await expect(tense.locator('option').first()).toHaveText(/: Present$/);
	await tense.selectOption('past');
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

	// The notes save when the box loses focus; leaving the page from inside
	// it saves them too.
	// Typing in one field while another saves keeps what is typed.
	await page.getByRole('combobox', { name: 'Comma splices' }).selectOption('leave');
	await page.getByLabel('Your own habits').pressSequentially('Fragments are on purpose.');
	await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await expect(page.getByLabel('Your own habits')).toHaveValue('Fragments are on purpose.');
	await page
		.getByRole('navigation', { name: 'Story settings' })
		.getByRole('link', { name: 'Details' })
		.click();
	await expect(page.locator('#st-title')).toBeVisible();
	await gotoReady(page, `/stories/${slug}/settings/preferences`);
	await expect(page.getByRole('combobox', { name: 'Tense' })).toHaveValue('past');
	await expect(page.getByLabel('Your own habits')).toHaveValue('Fragments are on purpose.');
	expect(await violations(page)).toEqual([]);

	// The notes are in the page before its script runs, so a save from that
	// state does not post them empty (#1683).
	const plain = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
		storageState: 'e2e/.auth/assistant.json'
	});
	try {
		const plainPage = await plain.newPage();
		await plainPage.goto(`/stories/${slug}/settings/preferences`);
		await expect(plainPage.getByLabel('Your own habits')).toHaveValue('Fragments are on purpose.');
	} finally {
		await plain.close();
	}
});

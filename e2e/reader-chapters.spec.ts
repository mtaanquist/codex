import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Front and back matter in a published edition is named by its type and never
// numbered, on the reading page and in the moderator's view of the edition.
// The edition is published through the page, then its frozen chapters are
// replaced in the database with a dedication, a prologue and a chapter.
test('the reading page numbers only regular chapters', async ({ page, browser }) => {
	const stamp = Date.now();
	const title = `Matter story ${stamp}`;
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Matter world ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Matter world ${stamp}`);
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
	await page.getByRole('button', { name: 'Save visibility' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.getByRole('button', { name: 'Publish edition' }).click();
	const penPrompt = page.getByRole('dialog', { name: 'Choose your author name' });
	const published = page.getByRole('status').filter({ hasText: 'Edition published.' });
	await expect(published.or(penPrompt)).toBeVisible();
	if (await penPrompt.isVisible()) {
		await penPrompt.getByRole('button', { name: 'Continue' }).click();
	}
	const readingPath = (await published.getByRole('link').getAttribute('href'))!;

	const scene = (bodyMd: string) => [{ title: null, bodyMd }];
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	let editionId: string;
	try {
		const { rows } = await pool.query<{ id: string }>(
			`update publications set content = $1 where title = $2 and is_current returning id`,
			[
				JSON.stringify({
					chapters: [
						{ title: null, role: 'dedication', scenes: scene('For you.') },
						{ title: null, role: 'prologue', scenes: scene('Before.') },
						{ title: null, scenes: scene('The bell rang twice.') }
					],
					unfiled: []
				}),
				title
			]
		);
		editionId = rows[0].id;
	} finally {
		await pool.end();
	}

	const names = ['Dedication', 'Prologue', 'Chapter 1'];
	await gotoReady(page, readingPath);
	await expect(page.locator('.reader-toc a')).toHaveText(names);
	await expect(page.locator('h2.reader-chapter')).toHaveText(names);

	const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
	try {
		const moderator = await admin.newPage();
		await gotoReady(moderator, `/admin/published/${editionId}`);
		await expect(moderator.locator('h2.reader-chapter')).toHaveText(names);
	} finally {
		await admin.close();
	}
});

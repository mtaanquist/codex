import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// #1367: typing earlier in the scene and then changing focus redrew every mark
// off by the typed length, until the page data next reloaded. After an
// autosave, the same focus change also put the stale loaded text back.
test('a comment mark stays on its passage after typing before it', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Marks ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Marks ${stamp}`);
	await page.getByLabel('New story').fill('Marks');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await page.locator('.cm-content').click();
	await page.keyboard.type('The original sentence.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	await page.getByRole('link', { name: 'Review', exact: true }).click();
	const prose = page.locator('.review-edit .cm-content');
	await expect(prose).toContainText('The original sentence.');

	const line = prose.locator('.cm-line').first();
	const box = (await line.boundingBox())!;
	await page.mouse.move(box.x + 3, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Comment' }).click();
	await page.getByLabel('Your comment').fill('Tighten this line.');
	await page
		.locator('.rv-card.is-draft')
		.getByRole('button', { name: 'Comment', exact: true })
		.click();
	const card = page.locator('.rv-card').filter({ hasText: 'Tighten this line.' });
	await expect(card).toBeVisible();
	const mark = prose.locator('.rv-comment');
	await expect(mark).toHaveText('The original sentence.');

	// Type before the passage and let the autosave land; it does not reload the
	// page data, so the comment's loaded anchor is now stale.
	const saved = page.waitForResponse(
		(response) =>
			response.url().includes('/api/scenes/') &&
			response.request().method() === 'PUT' &&
			response.ok() &&
			(response.request().postData() ?? '').includes('Opening. ')
	);
	await prose.press('Home');
	await prose.pressSequentially('Opening. ');
	await saved;
	await expect(mark).toHaveText('The original sentence.');

	// Changing focus rebuilds the marks; they must stay on the passage, and the
	// typing must stay in the editor.
	await card.click();
	await expect(prose).toContainText('Opening. The original sentence.');
	await expect(prose.locator('.rv-comment.is-focused')).toHaveText('The original sentence.');
	const filters = page.getByLabel('Filter comments');
	await filters.getByRole('button', { name: /^Done/ }).click();
	await expect(mark).toHaveCount(0);
	await filters.getByRole('button', { name: /^Open/ }).click();
	await expect(mark).toHaveText('The original sentence.');
});

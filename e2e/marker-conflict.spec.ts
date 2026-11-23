import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Ctrl/Cmd+Alt+M while the scene was changed in another window: the server
// holds text this editor has not seen, so a marker would count into the wrong
// words. Nothing is marked until the writer picks a version.

async function newStory(page: Page, name: string) {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`${name}vale`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `${name}vale`);
	await page.getByLabel('New story').fill(`${name} Book`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(/\/stories\//);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
}

const saved = (page: Page) =>
	page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);

test('a marker is not made while the scene was changed in another window', async ({ page }) => {
	test.slow();
	await newStory(page, `Ferry ${Date.now()}`);
	const editor = page.getByRole('textbox', { name: 'Scene text' });
	let landed = saved(page);
	await editor.click();
	await page.keyboard.type('The ferry left at dawn.');
	await landed;

	const other = await page.context().newPage();
	await gotoReady(other, page.url());
	const otherEditor = other.getByRole('textbox', { name: 'Scene text' });
	await expect(otherEditor).toContainText('The ferry left at dawn.');
	landed = saved(other);
	await otherEditor.click();
	await other.keyboard.press('ControlOrMeta+Home');
	await other.keyboard.type('Rain. ');
	await landed;
	await other.close();

	const refused = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.status() === 409
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' It was late.');
	await refused;
	await expect(page.getByText('This scene was changed in another window').first()).toBeVisible();

	const posts: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/markers') && request.method() === 'POST')
			posts.push(request.url());
	});
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await expect(
		page.getByText('Choose which version to keep, then mark the words again.')
	).toBeVisible();
	expect(posts).toEqual([]);
	await expect(page.locator('.todo-marker')).toHaveCount(0);

	// Once the newer text is loaded, marking works again.
	await page.getByRole('button', { name: 'Load newer version' }).click();
	await expect(editor).toContainText('Rain. The ferry left at dawn.');
	const created = page.waitForResponse(
		(r) => r.url().includes('/markers') && r.request().method() === 'POST' && r.ok()
	);
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
	await page.keyboard.press('ControlOrMeta+Alt+m');
	await created;
	await expect(page.locator('.todo-marker')).toHaveText(['dawn.']);
});

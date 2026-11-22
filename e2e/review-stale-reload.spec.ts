import { expect, test, type APIResponse } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// A page data reload that read the scene before the writer's latest save
// landed, and arrives after it, must not put the older text back over the
// writer's words.
test('a stale reload after a review save keeps the newer text', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Stale ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Stale ${stamp}`);
	await page.getByLabel('New story').fill('Stale');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('Base sentence here.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);

	await page.getByRole('link', { name: 'Review', exact: true }).click();
	const prose = page.locator('.review-edit .cm-content');
	await expect(prose).toContainText('Base sentence here.');

	// A comment to resolve later: resolving reloads the page data without
	// waiting on the editor's save.
	const line = prose.locator('.cm-line').first();
	const box = (await line.boundingBox())!;
	await page.mouse.move(box.x + 3, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	await page.locator('.rv-seltool').getByRole('button', { name: 'Comment' }).click();
	await page.getByLabel('Your comment').fill('Look again.');
	await page
		.locator('.rv-card.is-draft')
		.getByRole('button', { name: 'Comment', exact: true })
		.click();
	const card = page.locator('.rv-card').filter({ hasText: 'Look again.' });
	await expect(card).toBeVisible();

	const savedWith = (word: string) =>
		page.waitForResponse(
			(r) =>
				r.url().includes('/api/scenes/') &&
				r.request().method() === 'PUT' &&
				r.ok() &&
				(r.request().postData() ?? '').includes(word)
		);

	// A first save lands, so the stored text is one this editor saved after
	// the page loaded.
	const firstSaved = savedWith('ONE');
	await prose.press('End');
	await prose.pressSequentially(' ONE');
	await firstSaved;

	// Hold the next save open.
	let releaseSave!: () => void;
	const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
	let saveHeld!: () => void;
	const saveIsHeld = new Promise<void>((resolve) => (saveHeld = resolve));
	await page.route('**/api/scenes/*', async (route) => {
		if (route.request().method() !== 'PUT') return route.fallback();
		saveHeld();
		await saveGate;
		return route.fallback();
	});
	const secondSaved = savedWith('TWO');
	await prose.pressSequentially(' TWO');
	await saveIsHeld;

	// The reload reads the scene now, before the held save lands, and its
	// answer is held until that save has landed.
	let releaseData!: () => void;
	const dataGate = new Promise<void>((resolve) => (releaseData = resolve));
	let dataRead!: () => void;
	const dataIsRead = new Promise<void>((resolve) => (dataRead = resolve));
	await page.route('**/__data.json*', async (route) => {
		const response: APIResponse = await route.fetch();
		dataRead();
		await dataGate;
		await route.fulfill({ response });
	});
	const resolve = card.getByRole('button', { name: 'Resolve comment' });
	await resolve.click();
	await dataIsRead;

	releaseSave();
	await secondSaved;
	await page.unroute('**/api/scenes/*');

	releaseData();
	await expect(resolve).toHaveCount(0);
	await expect(prose).toContainText('Base sentence here. ONE TWO');
	await page.unroute('**/__data.json*');

	// No conflict: the next typing saves on top of the newer text.
	const thirdSaved = savedWith('THREE');
	await prose.press('End');
	await prose.pressSequentially(' THREE');
	await thirdSaved;
	await expect(
		page.getByRole('alert').filter({ hasText: 'changed in another window' })
	).toHaveCount(0);
	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toContainText(
		'Base sentence here. ONE TWO THREE'
	);
});

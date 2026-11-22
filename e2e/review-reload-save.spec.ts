import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// #1374: page data that reloads while a review save is still on its way must
// not replace the text that save is carrying. The scene changed somewhere else
// first, so the save is refused and the writer chooses between the versions.
test('a reload during a review save keeps the text being saved', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Inflight ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Inflight ${stamp}`);
	await page.getByLabel('New story').fill('Inflight');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	const sceneId = new URL(page.url()).searchParams.get('scene')!;
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

	// The scene changes somewhere else (another window).
	const elsewhere = await page.request.put(`/api/scenes/${sceneId}`, {
		data: { title: null, bodyMd: 'Changed elsewhere.' }
	});
	expect(elsewhere.ok()).toBe(true);

	// Hold the editor's next save open.
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let held!: () => void;
	const saveHeld = new Promise<void>((resolve) => (held = resolve));
	await page.route('**/api/scenes/*', async (route) => {
		if (route.request().method() !== 'PUT') return route.fallback();
		held();
		await gate;
		return route.fallback();
	});

	await prose.press('End');
	await prose.pressSequentially(' MINETAIL');
	await saveHeld;

	// Reload the page data while the save is held. The resolve button leaves
	// once the reloaded data, with the other window's text, has landed.
	const resolve = card.getByRole('button', { name: 'Resolve comment' });
	await resolve.click();
	await expect(resolve).toHaveCount(0);
	await expect(prose).toContainText('MINETAIL');

	// The save is refused, and the writer is offered the choice; keeping
	// theirs saves it.
	release();
	const banner = page.getByRole('alert').filter({ hasText: 'changed in another window' });
	await expect(banner).toBeVisible();
	await expect(prose).toContainText('MINETAIL');
	const kept = page.waitForResponse(
		(r) =>
			r.url().includes('/api/scenes/') &&
			r.request().method() === 'PUT' &&
			r.ok() &&
			(r.request().postData() ?? '').includes('MINETAIL')
	);
	await banner.getByRole('button', { name: 'Keep mine' }).click();
	await kept;
	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toContainText(
		'Base sentence here. MINETAIL'
	);
});

import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// #1287: the paths of the review page's accept and reject that had no browser
// test: a partial failure in the decide dialog, a reject, an edit whose anchor
// is lost, an edit that is white space only, and two card accepts in quick
// succession.

type Edit = { find: string; replacement: string; length?: number; offset?: number };

// Creates a story with one scene holding body, then stages suggested edits on
// it straight in the database (each placed at the first match of find), so a
// test can stage edits the composer would refuse. baseBody, when given, is the
// text the edits were placed against; a find that is not in the scene's body
// then gives an edit whose anchor is lost.
async function seedScene(page: Page, prefix: string, body: string, edits: Edit[], baseBody = body) {
	await gotoReady(page, '/');
	const name = `${prefix} ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill(prefix);
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await page.locator('.cm-content').click();
	await page.keyboard.type(body);
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyPath = new URL(page.url()).pathname;

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const { rows } = await pool.query<{ id: string; story_id: string; body_md: string }>(
			`select s.id, s.story_id, s.body_md from scenes s join stories st on st.id = s.story_id
			 join universes u on u.id = st.universe_id where u.name = $1`,
			[name]
		);
		const [scene] = rows;
		expect(scene.body_md).toBe(body);
		const revision = await pool.query<{ id: string }>(
			`insert into revisions (entity_type, entity_id, body_md, reason)
			 values ('scene', $1, $2, 'autosave') returning id`,
			[scene.id, baseBody]
		);
		const ids: string[] = [];
		for (const edit of edits) {
			const at = baseBody.indexOf(edit.find);
			expect(at).toBeGreaterThanOrEqual(0);
			const start = at + (edit.offset ?? 0);
			const end = start + (edit.length ?? edit.find.length);
			const inserted = await pool.query<{ id: string }>(
				`insert into review_suggestions
				 (story_id, scene_id, assistant, base_revision_id, range_start, range_end, replacement)
				 values ($1, $2, true, $3, $4, $5, $6) returning id`,
				[scene.story_id, scene.id, revision.rows[0].id, start, end, edit.replacement]
			);
			ids.push(inserted.rows[0].id);
		}
		await gotoReady(page, `${storyPath}/review?scene=${scene.id}`);
		await expect.poll(() => exactText(page)).toBe(body);
		await expect(page.locator('.rv-card.sugg')).toHaveCount(edits.length);
		return { ids, prose: page.locator('.review-edit .cm-content') };
	} finally {
		await pool.end();
	}
}

async function markDecided(id: string) {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(
			`update review_suggestions set status = 'rejected', decided_at = now() where id = $1`,
			[id]
		);
	} finally {
		await pool.end();
	}
}

// The exact text of the scene, without the ghosts of pending edits.
// toHaveText would fold a doubled space into one.
async function exactText(page: Page) {
	return page.locator('.review-edit .cm-content').evaluate((el) =>
		[...el.querySelectorAll('.cm-line')]
			.map((line) => {
				const copy = line.cloneNode(true) as HTMLElement;
				copy.querySelectorAll('.cm-widgetBuffer, [contenteditable=false]').forEach((w) => {
					w.remove();
				});
				return copy.textContent;
			})
			.join('\n')
	);
}

const sidePanel = (page: Page) => page.getByRole('complementary', { name: 'Side panel' });

test('the decide dialog reports a partial failure with the server reason', async ({ page }) => {
	const { ids, prose } = await seedScene(
		page,
		'Partial',
		'Alpha beta. Gamma delta. Epsilon zeta.',
		[
			{ find: 'Alpha', replacement: 'EDITONE' },
			{ find: 'Gamma', replacement: 'EDITTWO' },
			{ find: 'Epsilon', replacement: 'EDITTHREE' }
		]
	);

	// Typing waits to be saved, and the save is held, so the dialog shows that
	// it saves first.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(
		(url) => url.pathname.startsWith('/api/scenes/'),
		async (route) => {
			if (route.request().method() === 'PUT') await held;
			await route.continue();
		}
	);
	await prose.press('ControlOrMeta+End');
	await prose.pressSequentially(' TYPED');

	await page.getByRole('button', { name: 'Decide together...' }).click();
	const dialog = page.getByRole('dialog', { name: 'Decide on suggested edits' });
	await expect(dialog.getByRole('listitem')).toHaveCount(3);
	// Someone decides the second edit while the dialog is open.
	await markDecided(ids[1]);
	await dialog.getByRole('button', { name: 'Accept 3 edits' }).click();
	await expect(dialog.getByRole('status')).toHaveText('Saving your latest typing first...');
	release();

	await expect(dialog.getByRole('alert')).toHaveText(
		'2 edits accepted. 1 edit could not be accepted. That suggestion was already decided.'
	);
	// The dialog stays open on a partial result.
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('No suggested edits are waiting on this scene.');
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);

	await expect.poll(() => exactText(page)).toBe('EDITONE beta. Gamma delta. EDITTHREE zeta. TYPED');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.reload();
	await expect.poll(() => exactText(page)).toBe('EDITONE beta. Gamma delta. EDITTHREE zeta. TYPED');
});

test('rejecting from the dialog announces it and keeps focus in the side panel', async ({
	page
}) => {
	const { prose } = await seedScene(page, 'Reject', 'Alpha beta. Gamma delta.', [
		{ find: 'Alpha', replacement: 'EDITONE' },
		{ find: 'Gamma', replacement: 'EDITTWO' }
	]);
	await page.getByRole('button', { name: 'Decide together...' }).click();
	const dialog = page.getByRole('dialog', { name: 'Decide on suggested edits' });
	await dialog.getByRole('button', { name: 'Reject 2 edits' }).click();
	await expect(dialog).toHaveCount(0);

	// The toolbar that opened the dialog went with the edits, so focus moves to
	// the side panel, and the outcome is read out there.
	await expect(page.getByRole('group', { name: 'Suggested edits' })).toHaveCount(0);
	await expect(sidePanel(page)).toBeFocused();
	await expect(sidePanel(page).getByRole('status')).toHaveText('2 edits rejected.');
	await expect(page.getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0);
	await expect(prose).toHaveText('Alpha beta. Gamma delta.');

	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toHaveText('Alpha beta. Gamma delta.');
	await expect(page.getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0);
});

test('an edit whose passage changed can only be rejected', async ({ page }) => {
	const { prose } = await seedScene(
		page,
		'Lost',
		'Alpha beta. Gamma delta.',
		[
			{ find: 'OLDWORD', replacement: 'EDITLOST' },
			{ find: 'Gamma', replacement: 'EDITKEPT' }
		],
		'Alpha OLDWORD. Gamma delta.'
	);
	const lost = page.locator('.rv-card.sugg').filter({ hasText: 'EDITLOST' });
	await expect(lost).toContainText('can only be rejected');
	await expect(lost.getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0);

	// The dialog leaves it out of the accept.
	await page.getByRole('button', { name: 'Decide together...' }).click();
	const dialog = page.getByRole('dialog', { name: 'Decide on suggested edits' });
	await expect(dialog.getByRole('listitem').filter({ hasText: 'EDITLOST' })).toContainText(
		'can only be rejected'
	);
	await expect(dialog.getByRole('button', { name: 'Reject 2 edits' })).toBeEnabled();
	await dialog.getByRole('button', { name: 'Accept 1 edit' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(sidePanel(page).getByRole('status')).toHaveText('1 edit accepted.');
	await expect(prose).toContainText('EDITKEPT delta.');

	// The card rejects it.
	await lost.getByRole('button', { name: 'Reject suggestion' }).click();
	await expect(page.locator('.rv-card.sugg').filter({ hasText: 'EDITLOST' })).toHaveCount(0);
	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toHaveText('Alpha beta. EDITKEPT delta.');
	await expect(page.locator('.rv-card.sugg').filter({ hasText: 'EDITLOST' })).toHaveCount(0);
});

test('accepting an edit that only removes a space', async ({ page }) => {
	// One of the two spaces after "Alpha": the edit has no visible mark.
	const { prose } = await seedScene(page, 'Space', 'Alpha  beta. Gamma delta.', [
		{ find: '  ', replacement: '', offset: 1, length: 1 }
	]);
	await expect.poll(() => exactText(page)).toBe('Alpha  beta. Gamma delta.');
	const card = page.locator('.rv-card.sugg');
	await card.getByRole('button', { name: 'Accept suggestion' }).click();
	await expect(card).toHaveCount(0);
	await expect.poll(() => exactText(page)).toBe('Alpha beta. Gamma delta.');

	// Typing builds on the accepted text, and the next save keeps one space.
	await prose.press('ControlOrMeta+End');
	await prose.pressSequentially(' AFTERWORD');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.reload();
	await expect.poll(() => exactText(page)).toBe('Alpha beta. Gamma delta. AFTERWORD');
});

test('two card accepts in quick succession both land, and a card ignores a second click', async ({
	page
}) => {
	const { prose } = await seedScene(page, 'Quick', 'Alpha beta. Gamma delta.', [
		{ find: 'Alpha', replacement: 'EDITONE' },
		{ find: 'Gamma', replacement: 'EDITTWO' }
	]);
	let accepts = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes('acceptSuggestion')) accepts++;
	});
	// Hold every accept until both have been sent.
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(
		(url) => url.search.includes('acceptSuggestion'),
		async (route) => {
			await held;
			await route.continue();
		}
	);

	const first = page
		.locator('.rv-card.sugg')
		.filter({ hasText: 'EDITONE' })
		.getByRole('button', { name: 'Accept suggestion' });
	const second = page
		.locator('.rv-card.sugg')
		.filter({ hasText: 'EDITTWO' })
		.getByRole('button', { name: 'Accept suggestion' });
	await first.click();
	await expect(first).toHaveAttribute('aria-disabled', 'true');
	await expect.poll(() => accepts).toBe(1);
	// A second click on the busy card sends nothing more.
	await first.click({ force: true });
	await second.click();
	await expect.poll(() => accepts).toBe(2);
	release();

	await expect(page.getByRole('button', { name: 'Accept suggestion' })).toHaveCount(0);
	await expect(prose).toHaveText('EDITONE beta. EDITTWO delta.');
	expect(accepts).toBe(2);
	await expect(page.getByText('This scene was changed in another window')).toHaveCount(0);

	await prose.press('ControlOrMeta+End');
	await prose.pressSequentially(' AFTERWORD');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await expect(page.getByText('This scene was changed in another window')).toHaveCount(0);
	await page.reload();
	await expect(page.locator('.review-edit .cm-content')).toHaveText(
		'EDITONE beta. EDITTWO delta. AFTERWORD'
	);
});

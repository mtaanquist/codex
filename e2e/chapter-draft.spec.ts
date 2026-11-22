import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady, waitForHydration } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { openRowMenu } from './context-menu';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

async function sql(text: string, values: unknown[]): Promise<void> {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		await pool.query(text, values);
	} finally {
		await pool.end();
	}
}

// A story with one chapter of two empty scenes, open in Write, with a model
// chosen for Write so the drafts can be counted. Resolves to the story's slug.
async function chapterOfTwo(page: Page, stamp: number): Promise<string> {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Rivermen ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Rivermen ${stamp}`);
	await page.getByLabel('New story').fill(`Flight ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/flight-${stamp}`);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(1);
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await sql(
		`update stories set llm_config = '{"models":{"coauthor":"e2e-model"}}' where slug = $1`,
		[`flight-${stamp}`]
	);
	return `flight-${stamp}`;
}

async function openChapterForm(page: Page) {
	await openRowMenu(page, page.locator('.chapter-row').first());
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page
		.locator('.row-submenu')
		.getByRole('menuitem', { name: 'Draft this chapter...' })
		.click();
}

// #1168, step 2: the Assistant drafts a chapter scene by scene. Counting the
// cost and asking for the run go through the real endpoints; the background
// job has no model to call, so the drafts' rows are then marked written as the
// job would leave them, and the job's status is stubbed. The form's scene
// list, reading the drafts back, and keeping each one are real too.
test('a chapter draft is costed first, and each drafted scene is kept on its own', async ({
	page
}) => {
	const stamp = Date.now();
	await chapterOfTwo(page, stamp);

	const asked: { brief?: string; scenes?: { brief: string }[] }[] = [];
	let chapterId = '';
	await page.route('**/api/assistant/draft/chapter', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const body = route.request().postDataJSON() as {
			defaults?: boolean;
			estimate?: boolean;
			chapterId: string;
			brief: string;
			scenes: { sceneId: string; brief: string }[];
		};
		if (body.defaults || body.estimate) return route.continue();
		chapterId = body.chapterId;
		asked.push({ brief: body.brief, scenes: body.scenes.map((s) => ({ brief: s.brief })) });
		const response = await route.fetch();
		const { draftIds } = (await response.json()) as { draftIds: string[] };
		await sql(
			`update assistant_drafts
			 set status = 'ready', text_md = 'Drafted scene ' || (position + 1) || '. The river ran on.'
			 where id = any($1::uuid[])`,
			[draftIds]
		);
		await route.fulfill({ response });
	});
	await page.route('**/api/assistant/job-status*', async (route) => {
		await route.fulfill({ json: { state: 'done' } });
	});

	// Asked for from the chapter's own menu.
	await openChapterForm(page);

	const card = page.getByRole('group', { name: 'Chapter draft' });
	await card.getByLabel('What happens in this chapter').fill('Ilse flees across the river.');
	// Both empty scenes are ticked, each with a line of its own to fill.
	const lines = card.getByPlaceholder('What happens in this scene');
	await expect(lines).toHaveCount(2);
	await lines.first().fill('She reaches the quay.');
	await card.getByRole('button', { name: 'Check the cost' }).click();
	// The count is shown and nothing has been asked for yet.
	await expect(card).toContainText(
		/This drafts 2 scenes\. It sends about [\d,]+ tokens and writes up to [\d,]+\./
	);
	await expect(card.getByRole('button', { name: 'Draft the chapter' })).toBeFocused();
	expect(asked).toEqual([]);
	// A second press at once starts nothing: the cost has to have been on
	// screen for a moment first.
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	expect(asked).toEqual([]);
	await page.waitForTimeout(800);
	await card.getByRole('button', { name: 'Draft the chapter' }).click();

	// Both scenes are listed as ready, and neither scene has changed.
	await expect(card.getByRole('link')).toHaveCount(2);
	await expect(card).toContainText('Open each scene to read its draft');
	expect(asked).toEqual([
		{
			brief: 'Ilse flees across the river.',
			scenes: [{ brief: 'She reaches the quay.' }, { brief: '' }]
		}
	]);

	// The link the run's notice carries opens the list of drafts again, not a
	// new form, and opens it once: its marker is then gone from the address.
	await gotoReady(page, `/stories/flight-${stamp}?draftChapter=${chapterId}`);
	await expect(card.getByRole('link')).toHaveCount(2);
	await expect(card.getByLabel('What happens in this chapter')).toHaveCount(0);
	await expect(page).not.toHaveURL(/draftChapter/);

	// The first scene's draft is kept from that scene's own card.
	await card.getByRole('link').first().click();
	const sceneCard = page.getByRole('group', { name: 'Scene draft' });
	const draftText = sceneCard.getByLabel('Read it, and change anything you like before keeping it');
	await expect(draftText).toHaveValue('Drafted scene 1. The river ran on.');
	await sceneCard.getByRole('button', { name: 'Fill this scene' }).click();
	await expect(page.locator('.cm-content')).toContainText('Drafted scene 1.');
	await expect(sceneCard).toHaveCount(0);

	// The other scene's draft still waits. Added as a new scene, it leaves the
	// chapter's list too, though the new scene is the one now open.
	await expect(card.getByRole('link')).toHaveCount(1);
	await card.getByRole('link').click();
	await expect(draftText).toHaveValue('Drafted scene 2. The river ran on.');
	await sceneCard.getByRole('button', { name: 'Add as a new scene after this one' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(3);
	await expect(page.locator('.cm-content')).toContainText('Drafted scene 2.');
	await expect(card).toHaveCount(0);

	await page.reload();
	await expect(page.locator('.scene-row')).toHaveCount(3);
	await expect(card).toHaveCount(0);
});

// #1334: the chapter card while its run is under way. The job is the test's
// to answer for, and the drafts are written into the database one by one, as
// the job would write them.
// The scene made last is the one open in the editor.
const OPEN_SCENE = 1;
test('a chapter draft under way shows its progress and can be stopped', async ({ page }) => {
	const stamp = Date.now();
	const slug = await chapterOfTwo(page, stamp);
	let draftIds: string[] = [];
	let chapterId = '';
	await page.route('**/api/assistant/draft/chapter', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const body = route.request().postDataJSON() as {
			defaults?: boolean;
			estimate?: boolean;
			chapterId: string;
		};
		if (body.defaults || body.estimate) return route.continue();
		chapterId = body.chapterId;
		const response = await route.fetch();
		draftIds = ((await response.json()) as { draftIds: string[] }).draftIds;
		await route.fulfill({ response });
	});
	let job: Record<string, unknown> = { state: 'running', phase: 'scenes', completed: 0, total: 2 };
	await page.route('**/api/assistant/job-status*', (route) => route.fulfill({ json: job }));
	let stopped = false;
	await page.route('**/api/assistant/job-stop', async (route) => {
		stopped = true;
		await sql(
			`update assistant_drafts set status = 'discarded',
			   note = 'The chapter draft ended before it reached this scene, so it was not drafted.'
			 where id = any($1::uuid[]) and status in ('pending', 'running')`,
			[draftIds]
		);
		job = { state: 'stopped', phase: 'scenes', completed: 2, total: 2 };
		await route.fulfill({ json: { ok: true } });
	});

	await openChapterForm(page);
	const card = page.getByRole('group', { name: 'Chapter draft' });
	await card.getByLabel('What happens in this chapter').fill('Ilse flees across the river.');
	await card.getByRole('button', { name: 'Check the cost' }).click();
	await expect(card.getByRole('button', { name: 'Draft the chapter' })).toBeVisible();
	await page.waitForTimeout(1100);
	await card.getByRole('button', { name: 'Draft the chapter' }).click();

	// Both scenes wait; nothing can be opened yet, and the run can be stopped.
	await expect(card).toContainText(
		'drafting these scenes in the background, one at a time: 0 of 2'
	);
	await expect(card.getByRole('listitem')).toHaveCount(2);
	await expect(card.getByRole('listitem').first()).toContainText('Waiting');
	await expect(card.getByRole('link')).toHaveCount(0);
	await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible();
	await expect(card).toContainText('Stopping keeps the scenes already drafted.');
	// After a reload the chapter card comes back. The open scene's own card
	// stays hidden while the run writes its draft, once it has read that draft.
	await page.reload();
	await waitForHydration(page);
	const sceneRead = page.waitForResponse(
		(response) =>
			response.request().method() === 'GET' &&
			new URL(response.url()).pathname === '/api/assistant/draft'
	);
	await page.getByRole('tab', { name: 'Assistant' }).click();
	const { draft: openDraft } = (await (await sceneRead).json()) as {
		draft: { id: string; inChapterRun: boolean } | null;
	};
	expect(openDraft).toMatchObject({ id: draftIds[OPEN_SCENE], inChapterRun: true });
	await expect(card).toContainText('0 of 2');
	const sceneCard = page.getByRole('group', { name: 'Scene draft' });
	await expect(sceneCard).toHaveCount(0);

	// The open scene is written: the list follows with no reload.
	await sql(
		`update assistant_drafts set status = 'ready', text_md = 'Drafted scene 2.' where id = $1`,
		[draftIds[OPEN_SCENE]]
	);
	job = { state: 'running', phase: 'scenes', completed: 1, total: 2 };
	await expect(card).toContainText('1 of 2', { timeout: 15_000 });
	await expect(card.getByRole('link')).toHaveCount(1);
	await expect(card.getByRole('listitem').nth(OPEN_SCENE)).toContainText('Ready');
	// The open scene's own card shows its draft once it is written.
	await expect(sceneCard.getByRole('textbox')).toHaveValue('Drafted scene 2.', {
		timeout: 15_000
	});

	// Stop keeps the scene already drafted and drops the other.
	await card.getByRole('button', { name: 'Stop' }).click();
	await expect.poll(() => stopped).toBe(true);
	await expect(card).toContainText('Open each scene to read its draft', { timeout: 15_000 });
	await expect(card.getByRole('button', { name: 'Stop' })).toHaveCount(0);
	// The scene dropped by the stop leaves the list; the drafted one stays.
	await expect(card.getByRole('listitem')).toHaveCount(1);
	await expect(card.getByRole('link')).toHaveCount(1);
	await gotoReady(page, `/stories/${slug}?draftChapter=${chapterId}`);
	await expect(card.getByRole('listitem')).toHaveCount(1);
	await expect(card.getByRole('listitem')).toContainText('Ready');
});

import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { confirmPrompt } from './confirm';

// #1323: what the account Assistant page says about prices and cost, and the
// out-of-date arc hint. Runs as an account of its own, since these tests
// rewrite its endpoint, prices and usage rows; each test seeds what it needs.
test.use({ storageState: 'e2e/.auth/prices.json' });
test.describe.configure({ mode: 'serial' });

const EMAIL = 'prices-e2e@example.com';
const ENDPOINT = 'http://ollama.local:11434/v1';
// Two dollars per million sent, ten per million received.
const PRICED = { 'priced-model': { prompt: 0.000002, completion: 0.00001 } };

async function withDb<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl(), max: 1 });
	try {
		return await run(pool);
	} finally {
		await pool.end();
	}
}

// A custom endpoint with no key and no model picks, the given typed prices,
// and no usage rows.
async function seed(modelPricingManual: Record<string, unknown> = {}) {
	await withDb(async (pool) => {
		await pool.query(`update users set llm_config = $2 where email = $1`, [
			EMAIL,
			JSON.stringify({ enabled: true, provider: 'custom', endpoint: ENDPOINT, modelPricingManual })
		]);
		await pool.query(
			`delete from assistant_usage where user_id = (select id from users where email = $1)`,
			[EMAIL]
		);
	});
}

test('the usage list shows each priced request and the total cost', async ({ page }) => {
	await seed(PRICED);
	await withDb((pool) =>
		pool.query(
			`insert into assistant_usage (user_id, role, model, prompt_tokens, completion_tokens, created_at)
			 select id, 'chat', $2, $3, $4, now() - $5::interval from users where email = $1`,
			[EMAIL, 'priced-model', 100000, 20000, '2 minutes']
		)
	);
	await withDb((pool) =>
		pool.query(
			`insert into assistant_usage (user_id, role, model, prompt_tokens, completion_tokens, created_at)
			 select id, 'chat', $2, $3, $4, now() - $5::interval from users where email = $1`,
			[EMAIL, 'unpriced-model', 5000, 100, '1 minute']
		)
	);

	await gotoReady(page, '/account/assistant');
	const usage = page.locator('#assistant-usage');
	// 100,000 sent at $2 per million and 20,000 received at $10 per million.
	const row = (model: string) =>
		usage
			.locator('.list-row')
			.filter({ has: page.locator('.list-title').getByText(model, { exact: true }) });
	const priced = row('priced-model');
	await expect(priced.locator('.list-sub')).toContainText('about $0.4000');
	// A model with no price shows its tokens and no cost.
	const unpriced = row('unpriced-model');
	await expect(unpriced.locator('.list-sub')).toContainText('5,000 in / 100 out');
	await expect(unpriced.locator('.list-sub')).not.toContainText('$');
	// The total counts only what has a price, and says the rest is left out.
	await expect(usage.getByText(/Last 30 days: 2 requests/)).toContainText(
		'about $0.40, and some requests could not be priced'
	);
});

test('moving the endpoint to another server clears typed prices and says so', async ({ page }) => {
	await seed(PRICED);
	await gotoReady(page, '/account/assistant');

	const urlField = page.getByLabel('Base URL', { exact: true });
	await expect(urlField).toHaveValue(ENDPOINT);
	const saved = page.waitForResponse(
		(response) =>
			response.url().includes('saveAssistantEndpoint') && response.request().method() === 'POST'
	);
	await urlField.fill('http://other.local:11434/v1');
	await urlField.blur();
	await saved;
	await expect(
		page.getByText(
			'The prices you typed for priced-model were cleared because the endpoint changed.'
		)
	).toBeVisible();

	const left = await withDb(async (pool) => {
		const { rows } = await pool.query<{ prices: unknown }>(
			`select llm_config->'modelPricingManual' as prices from users where email = $1`,
			[EMAIL]
		);
		return rows[0].prices;
	});
	expect(left ?? {}).toEqual({});
});

test('switching provider asks first when only typed prices would be lost', async ({ page }) => {
	await seed(PRICED);
	await gotoReady(page, '/account/assistant');
	const provider = page.getByLabel('Provider', { exact: true });

	// No key and no model picks: the typed prices alone make it ask.
	await provider.selectOption('anthropic');
	const prompt = page.getByRole('alertdialog');
	await expect(prompt).toContainText('any prices you typed are cleared');
	await prompt.getByRole('button', { name: 'Cancel' }).click();
	await expect(prompt).toBeHidden();
	await expect(provider).toHaveValue('custom');

	const saved = page.waitForResponse(
		(response) =>
			response.url().includes('saveAssistantEndpoint') && response.request().method() === 'POST'
	);
	await provider.selectOption('anthropic');
	await confirmPrompt(page, 'Switch provider');
	await saved;
	await page.reload();
	await expect(provider).toHaveValue('anthropic');
});

test('a character arc written from older scenes says it is out of date', async ({ page }) => {
	await seed();
	const { universeId, characterId } = await withDb(async (pool) => {
		const name = `Arcs ${Date.now()}`;
		const universe = await pool.query<{ id: string; owner_id: string }>(
			`insert into universes (owner_id, name, slug)
			 select id, $2, $3 from users where email = $1 returning id, owner_id`,
			[EMAIL, name, name.toLowerCase().replace(/\s+/g, '-')]
		);
		const character = await pool.query<{ id: string }>(
			`insert into characters (universe_id, owner_id, name, arc_summary_md, arc_summary_input, arc_summary_at)
			 values ($1, $2, 'Mara', 'Mara leaves the harbour and comes back changed.', 'an older request', now())
			 returning id`,
			[universe.rows[0].id, universe.rows[0].owner_id]
		);
		return { universeId: universe.rows[0].id, characterId: character.rows[0].id };
	});

	await gotoReady(page, `/universes/${universeId}/plan?entity=${characterId}`);
	await expect(page.getByText('Mara leaves the harbour and comes back changed.')).toBeVisible();
	await expect(page.getByText('This is out of date.')).toContainText(
		'Select Refresh arc to write it again from the scenes as they are now.'
	);
	await expect(page.getByRole('button', { name: 'Refresh arc' })).toBeVisible();
});

test('the embeddings form saves on its own and leaves the Assistant endpoint alone', async ({
	page
}) => {
	await seed();
	await gotoReady(page, '/account/assistant');
	const section = page.locator('#assistant-embeddings');
	// Each change autosaves, and the save's response comes before the page
	// applies it: kit reloads the page data, then moves focus to the page and
	// back. A field filled meanwhile can lose its text or its blur, so each
	// step waits until the save's "Saved." is drawn again, the last thing the
	// update does.
	const saveApplied = async () => {
		await section.locator('form').evaluate((form) => {
			const win = window as unknown as { saveApplied?: Promise<void> };
			win.saveApplied = new Promise<void>((resolve) => {
				const observer = new MutationObserver((records) => {
					const drawn = records.some((record) =>
						[...record.addedNodes].some(
							(node) =>
								node instanceof Element &&
								(node.matches('.fs-ok') || !!node.querySelector('.fs-ok'))
						)
					);
					if (!drawn) return;
					observer.disconnect();
					resolve();
				});
				observer.observe(form, { childList: true, subtree: true });
			});
		});
		return () =>
			page.evaluate(() => (window as unknown as { saveApplied?: Promise<void> }).saveApplied);
	};
	const url = section.getByLabel('Embeddings base URL', { exact: true });
	const model = section.getByLabel('Embeddings model', { exact: true });
	const price = section.getByLabel('Embeddings price per million tokens (USD)', { exact: true });
	const enabled = section.getByLabel('Use embeddings');
	for (const [field, value] of [
		[url, 'http://localhost:11434/v1'],
		[model, 'nomic-embed-text'],
		[price, '0']
	] as const) {
		const applied = await saveApplied();
		await field.fill(value);
		await field.blur();
		await applied();
	}
	const applied = await saveApplied();
	await enabled.check();
	await applied();

	await page.reload();
	await expect(enabled).toBeChecked();
	await expect(url).toHaveValue('http://localhost:11434/v1');
	await expect(model).toHaveValue('nomic-embed-text');
	await expect(price).toHaveValue('0');
	await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue(ENDPOINT);
});

test('the search index list reloads when indexing found running after a reload ends', async ({
	page
}) => {
	const universeId = await withDb(async (pool) => {
		const { rows } = await pool.query<{ id: string }>(
			`update users set llm_config = $2 where email = $1 returning id`,
			[
				EMAIL,
				JSON.stringify({
					enabled: true,
					provider: 'custom',
					endpoint: ENDPOINT,
					embeddings: {
						enabled: true,
						provider: 'custom',
						endpoint: 'http://localhost:11434/v1',
						model: 'nomic-embed-text'
					}
				})
			]
		);
		const ownerId = rows[0].id;
		const name = `Index ${Date.now()}`;
		const universe = await pool.query<{ id: string }>(
			`insert into universes (owner_id, name, slug) values ($1, $2, $3) returning id`,
			[ownerId, name, name.toLowerCase().replace(/\s+/g, '-')]
		);
		const id = universe.rows[0].id;
		const story = await pool.query<{ id: string }>(
			`insert into stories (universe_id, owner_id, title, slug) values ($1, $2, 'Tides', 'tides') returning id`,
			[id, ownerId]
		);
		await pool.query(
			`insert into scenes (story_id, global_position, body_md) values ($1, 0, 'The sea came in.')`,
			[story.rows[0].id]
		);
		// Turned on, its first full index not finished yet.
		await pool.query(`insert into embedding_indexes (user_id, universe_id) values ($1, $2)`, [
			ownerId,
			id
		]);
		return id;
	});

	// The page finds the index running, as after a reload, and it then ends.
	let finished = false;
	await page.route('**/api/assistant/jobs', (route) =>
		route.fulfill({
			json: {
				jobs: finished
					? []
					: [{ id: 'index-job', kind: 'embeddings', mode: 'full', title: 'Index', universeId }]
			}
		})
	);
	await page.route('**/api/assistant/job-status**', (route) =>
		route.fulfill({ json: { state: finished ? 'done' : 'running' } })
	);

	await gotoReady(page, '/account/assistant');
	const row = page
		.locator('#assistant-embeddings-index .list-row')
		.filter({ has: page.locator('.list-title', { hasText: /^Index \d+$/ }) });
	await expect(row.locator('.list-sub')).toContainText('Indexing:');

	await withDb((pool) =>
		pool.query(
			`update embedding_indexes set model = 'nomic-embed-text', completed_at = now() where universe_id = $1`,
			[universeId]
		)
	);
	finished = true;
	await expect(row.locator('.list-sub')).toContainText('Catching up');
	await expect(row.locator('.list-sub')).not.toContainText('Indexing stopped');
});

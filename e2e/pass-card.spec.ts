import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The guided pass card's own script (src/lib/server/mcp/pass-card.html), in a
// frame under a fake client page that answers its messages. No Codex server is
// involved: the client's answers are scripted per test.

const CARD = readFileSync('src/lib/server/mcp/pass-card.html', 'utf8');

const HOST = `<!doctype html><html><body>
<iframe id="card" style="width: 600px; height: 700px"></iframe>
<script>
	const frame = document.getElementById('card');
	window.addEventListener('message', async (event) => {
		if (event.source !== frame.contentWindow) return;
		const reply = await window.hostHandle(event.data);
		if (reply) frame.contentWindow.postMessage(reply, '*');
	});
	window.toCard = (message) => frame.contentWindow.postMessage(message, '*');
</script>
</body></html>`;

type Edit = { id: string; text: string; replacement: string; stamp: string; status?: string };
type ToolAnswer = Record<string, unknown> | 'fail';

const edit = (id: string, text: string, replacement: string, stamp = `${id}-1`): Edit => ({
	id,
	text,
	replacement,
	stamp
});
const FIRST = edit('e1', 'open door', 'shut door');
const SECOND = edit('e2', 'dark lantern', 'dim lantern');

function pass(edits: Edit[]) {
	return {
		universeId: 'u1',
		noteId: 'n1',
		storyTitle: 'The Story',
		name: 'Doors',
		link: 'http://localhost/stories/s1/review',
		more: 0,
		decided: edits.filter((e) => e.status && e.status !== 'pending').length,
		edits: edits.map((e) => ({
			status: 'pending',
			before: 'The ',
			after: ' creaked.',
			sceneTitle: 'Scene one',
			chapterTitle: null,
			reason: null,
			followUp: false,
			placed: true,
			...e
		}))
	};
}

// A tool result as the client hands it over: the pass, and keys unless left out.
function passResult(edits: Edit[], withKeys = true) {
	const pending = edits.filter((e) => !e.status || e.status === 'pending');
	return {
		content: [{ type: 'text', text: 'The guided pass is open.' }],
		structuredContent: pass(edits),
		...(withKeys
			? {
					_meta: { 'codex/cardKeys': Object.fromEntries(pending.map((e) => [e.id, `key-${e.id}`])) }
				}
			: {})
	};
}
const refusal = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

// Opens the card with a first pass, answering each tools/call from `answers`
// in turn (by tool name). Returns the tool calls the card made.
async function openCard(
	page: Page,
	first: Record<string, unknown>,
	answers: Record<string, ToolAnswer[]>
) {
	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	let initialized = false;
	await page.exposeFunction('hostHandle', (message: Record<string, unknown>) => {
		const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
		if (message.method === 'ui/notifications/initialized') initialized = true;
		if (message.method === 'ui/initialize') {
			return reply({ hostCapabilities: { serverTools: {} }, hostContext: {} });
		}
		if (message.method === 'tools/call') {
			const params = message.params as { name: string; arguments: Record<string, unknown> };
			calls.push(params);
			const answer = answers[params.name]?.shift();
			if (!answer || answer === 'fail') {
				return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Not found' } };
			}
			return reply(answer);
		}
		if (message.id !== undefined) return reply({});
		return null;
	});
	await page.setContent(HOST);
	await page.evaluate((html) => {
		(document.getElementById('card') as HTMLIFrameElement).srcdoc = html;
	}, CARD);
	const card = page.frameLocator('#card');
	await expect(card.getByText('Loading the guided pass...')).toBeVisible();
	await expect.poll(() => initialized).toBe(true);
	await page.evaluate(
		(params) =>
			(window as unknown as { toCard: (m: unknown) => void }).toCard({
				jsonrpc: '2.0',
				method: 'ui/notifications/tool-result',
				params
			}),
		first
	);
	return { card, calls };
}

const accepts = (calls: { name: string }[]) =>
	calls.filter((call) => call.name === 'decide_suggestion').length;

test.describe('the guided pass card', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('an expired key on the same edit asks to press Accept again', async ({ page }) => {
		const { card } = await openCard(page, passResult([FIRST, SECOND]), {
			decide_suggestion: [
				refusal('This card was open for a long time. Ask the app to open the pass again.')
			],
			open_guided_pass: [passResult([FIRST, SECOND])]
		});
		await card.getByRole('button', { name: 'Accept', exact: true }).click();
		await expect(card.getByRole('status')).toHaveText(
			'This card was open for a long time, so it has been refreshed. Press Accept again.'
		);
		await expect(card.locator('del')).toHaveText('open door');
		await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeEnabled();
	});

	test('an expired key keeps its own text when the pass comes back without keys', async ({
		page
	}) => {
		const expired = 'This card was open for a long time. Ask the app to open the pass again.';
		const { card } = await openCard(page, passResult([FIRST, SECOND]), {
			decide_suggestion: [refusal(expired)],
			open_guided_pass: [passResult([FIRST, SECOND], false)]
		});
		await card.getByRole('button', { name: 'Accept', exact: true }).click();
		await expect(card.getByRole('status')).toHaveText(expired);
	});

	test('a stale key on the same edit asks to read it again', async ({ page }) => {
		const { card } = await openCard(page, passResult([FIRST, SECOND]), {
			decide_suggestion: [
				refusal('Only the guided pass card can accept an edit. Open the pass again.')
			],
			open_guided_pass: [passResult([FIRST, SECOND])]
		});
		await card.getByRole('button', { name: 'Accept', exact: true }).click();
		await expect(card.getByRole('status')).toHaveText(
			'This edit was out of date. Read it again, then decide.'
		);
	});

	test('a refusal for an edit decided in Codex moves on and says so', async ({ page }) => {
		const { card } = await openCard(page, passResult([FIRST, SECOND]), {
			decide_suggestion: [refusal('That suggestion was already decided.')],
			open_guided_pass: [passResult([{ ...FIRST, status: 'accepted' }, SECOND])]
		});
		await card.getByRole('button', { name: 'Accept', exact: true }).click();
		await expect(card.locator('del')).toHaveText('dark lantern');
		await expect(card.getByRole('status')).toHaveText(
			'That edit was decided or changed in Codex. This is the next one.'
		);
	});

	test('a result without keys gets the pass again, and says when that brings none', async ({
		page
	}) => {
		const { card, calls } = await openCard(page, passResult([FIRST, SECOND], false), {
			open_guided_pass: [passResult([FIRST, SECOND], false)]
		});
		await expect(card.getByRole('status')).toHaveText(
			'This app cannot show the buttons for this pass. Open it in Codex instead.'
		);
		expect(calls.map((call) => call.name)).toEqual(['open_guided_pass']);
		await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
	});

	test('accepting turned off keeps its message and does not load the pass again', async ({
		page
	}) => {
		const off = 'Accepting in the app was turned off. Open the note in Codex.';
		const { card, calls } = await openCard(page, passResult([FIRST, SECOND]), {
			decide_suggestion: [refusal(off)]
		});
		await card.getByRole('button', { name: 'Accept', exact: true }).click();
		await expect(card.getByRole('status')).toHaveText(off);
		await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
		await page.waitForTimeout(100);
		expect(calls.map((call) => call.name)).toEqual(['decide_suggestion']);
		expect(accepts(calls)).toBe(1);
	});

	test('an accepted edit is not shown as waiting when the pass cannot be loaded again', async ({
		page
	}) => {
		const { card } = await openCard(page, passResult([FIRST, SECOND]), {
			decide_suggestion: [{ content: [{ type: 'text', text: 'Accepted.' }] }],
			open_guided_pass: ['fail']
		});
		await card.getByRole('button', { name: 'Accept', exact: true }).click();
		await expect(card.locator('del')).toHaveText('dark lantern');
		await expect(card.getByText('1 edit waiting, 1 decided.', { exact: false })).toBeVisible();
	});
});

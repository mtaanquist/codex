import { describe, it, expect } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
	parseFrontMatter,
	parseStoryZip,
	rewriteBundledAssetLinks,
	StoryZipError
} from './import-markdown';
import { overlappingStoredZip } from '../../tests/zip-fixtures';

const ASSET_ID = '0b154c2d-13ef-4f3c-9a85-2f1c0a9d8e11';

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
	const entries: Zippable = {};
	for (const [path, content] of Object.entries(files)) {
		entries[path] = typeof content === 'string' ? strToU8(content) : content;
	}
	return zipSync(entries);
}

describe('parseFrontMatter', () => {
	it('reads JSON-quoted scalars and lists, leaving the body intact', () => {
		const { fields, body } = parseFrontMatter(
			'---\ntitle: "A \\"quoted\\" name"\naliases:\n  - "One"\n  - "Two"\n---\nThe body.\n\n---\nNot front matter.'
		);
		expect(fields.title).toBe('A "quoted" name');
		expect(fields.aliases).toEqual(['One', 'Two']);
		expect(body).toBe('The body.\n\n---\nNot front matter.');
	});

	it('treats text without a front matter block as all body', () => {
		expect(parseFrontMatter('Just prose.').body).toBe('Just prose.');
		expect(parseFrontMatter('---\nnever closed').body).toBe('---\nnever closed');
	});

	it('keeps values and list items that hold a line or paragraph separator', () => {
		const value = 'One\u2028two\u2029three';
		const { fields } = parseFrontMatter(
			`---\nstyle-notes: ${JSON.stringify(value)}\naliases:\n  - ${JSON.stringify(value)}\n---\n`
		);
		expect(fields['style-notes']).toBe(value);
		expect(fields.aliases).toEqual([value]);
	});

	it('falls back to the raw text for unquoted values', () => {
		expect(parseFrontMatter('---\ntitle: Plain words\n---\n').fields.title).toBe('Plain words');
	});
});

describe('parseStoryZip', () => {
	const full = () =>
		zip({
			'halden/story.md': '---\ntitle: "Halden"\nauthor: "A. Vane"\n---\nThe description.',
			'halden/chapters/02-the-road/chapter.md': '---\ntitle: "The Road"\n---\n',
			'halden/chapters/02-the-road/01-tollgate.md':
				'---\ntitle: "Tollgate"\nstatus: "final"\n---\nThey paid.',
			'halden/chapters/01-the-caravan/chapter.md': '---\ntitle: "The Caravan"\n---\n',
			'halden/chapters/01-the-caravan/01-departure.md':
				'---\ntitle: "Departure"\nstatus: "draft"\n---\nThe gate opened.',
			'halden/chapters/01-the-caravan/02-night.md':
				'---\ntitle: "Night"\nstatus: "sketchy"\n---\nStars.',
			'halden/unfiled/01-loose-end.md': '---\ntitle: "Loose end"\n---\nA thought.',
			'halden/notes/characters/alice-vane.md':
				'---\nname: "Alice Vane"\nkind: "character"\n---\nLimps here.',
			'halden/notes/lore/the-toll.md': '---\nname: "The Toll"\nkind: "lore"\n---\nSteep.',
			'halden/notebook/threads.md':
				'---\ntitle: "Threads"\npinned: "true"\nscene: "chapters/02-the-road/01-tollgate.md"\ncreated: "2026-01-01T10:00:00.000Z"\n---\nWho paid the toll?\n',
			'halden/notebook/note-1.md': '---\n---\nUntitled thought.',
			[`halden/assets/${ASSET_ID}.png`]: new Uint8Array([1, 2, 3])
		});

	it('reads the language and Assistant settings from story.md', () => {
		const plan = parseStoryZip(
			zip({
				'halden/story.md': [
					'---',
					'title: "Halden"',
					'style-notes: "Epic fantasy,\\nformal prose."',
					'language: "en-GB"',
					'assistant-preferences:',
					'  - "quoteMarks: single"',
					'  - "filterVerbs: leave"',
					'assistant-notes: "Keep \\"ye\\".\\nNo modern slang."',
					'---',
					''
				].join('\n')
			})
		);
		expect(plan.story).toMatchObject({
			styleNotes: 'Epic fantasy,\nformal prose.',
			language: 'en-GB',
			assistantPreferences: { quoteMarks: 'single', filterVerbs: 'leave' },
			assistantNotes: 'Keep "ye".\nNo modern slang.'
		});
		expect(plan.problems).toEqual([]);
	});

	it('leaves the settings out when story.md has none', () => {
		const plan = parseStoryZip(zip({ 'halden/story.md': '---\ntitle: "Halden"\n---\n' }));
		for (const key of ['styleNotes', 'language', 'assistantPreferences', 'assistantNotes']) {
			expect(plan.story).not.toHaveProperty(key);
		}
	});

	it('reports settings it cannot use instead of storing them', () => {
		const plan = parseStoryZip(
			zip({
				'halden/story.md': [
					'---',
					'title: "Halden"',
					'language: "Klingon"',
					'assistant-preferences:',
					'  - "tense: future"',
					`assistant-notes: "${'x'.repeat(1001)}"`,
					'---',
					''
				].join('\n')
			})
		);
		for (const key of ['language', 'assistantPreferences', 'assistantNotes']) {
			expect(plan.story).not.toHaveProperty(key);
		}
		expect(plan.problems).toHaveLength(3);
		expect(plan.problems[0]).toContain('Klingon');
	});

	it('skips saved drafts without counting them against the file limit', () => {
		const files: Record<string, string> = {
			'halden/story.md': '---\ntitle: "Halden"\n---\n',
			'halden/unfiled/01-loose-end.md': '---\ntitle: "Loose end"\n---\nNow.'
		};
		for (let index = 0; index < 5001; index++) {
			files[`halden/drafts/first/characters/c-${index}.md`] = '---\nname: "C"\n---\n';
		}
		files['halden/drafts/first/story.md'] = '---\ntitle: "Halden, then"\n---\n';
		const plan = parseStoryZip(zip(files));
		expect(plan.story.title).toBe('Halden');
		expect(plan.unfiled.map((scene) => scene.bodyMd)).toEqual(['Now.']);
		expect(plan.problems).toContain(
			'The saved drafts in this archive were not imported, only the working draft.'
		);
	});

	it('reports saved drafts at the top of a re-zipped story folder and review comments', () => {
		const plan = parseStoryZip(
			zip({
				'story.md': '---\ntitle: "Halden"\n---\n',
				'reviews.md': '# Review comments\n',
				'drafts/first/story.md': '---\ntitle: "Halden, then"\n---\n'
			})
		);
		expect(plan.story.title).toBe('Halden');
		expect(plan.problems).toEqual([
			'The saved drafts in this archive were not imported, only the working draft.',
			'The review comments in this archive were not imported.'
		]);
	});

	it('reads a story folder named drafts as the story, not as saved drafts', () => {
		const plan = parseStoryZip(
			zip({
				'drafts/story.md': '---\ntitle: "Drafts"\n---\n',
				'drafts/unfiled/01-a.md': '---\ntitle: "A"\n---\nNow.'
			})
		);
		expect(plan.unfiled.map((scene) => scene.bodyMd)).toEqual(['Now.']);
		expect(plan.problems).toEqual([]);
	});

	it('rebuilds the story plan in NN order with notes and assets', () => {
		const plan = parseStoryZip(full());
		expect(plan.story).toEqual({
			title: 'Halden',
			author: 'A. Vane',
			brief: null,
			descriptionMd: 'The description.'
		});
		expect(plan.chapters.map((c) => c.title)).toEqual(['The Caravan', 'The Road']);
		expect(plan.chapters[0].scenes.map((s) => s.title)).toEqual(['Departure', 'Night']);
		expect(plan.chapters[0].scenes[0]).toEqual({
			title: 'Departure',
			status: 'draft',
			bodyMd: 'The gate opened.'
		});
		expect(plan.unfiled).toEqual([{ title: 'Loose end', status: null, bodyMd: 'A thought.' }]);
		expect(plan.notes).toEqual([
			{ kind: 'character', name: 'Alice Vane', notesMd: 'Limps here.' },
			{ kind: 'lore', name: 'The Toll', notesMd: 'Steep.' }
		]);
		expect(plan.freeformNotes).toEqual([
			{
				title: 'Threads',
				bodyMd: 'Who paid the toll?',
				pinned: true,
				scene: { chapter: 1, index: 0 },
				createdAt: new Date('2026-01-01T10:00:00.000Z')
			},
			// An older zip's note: no pin, scene, or created time.
			{ title: null, bodyMd: 'Untitled thought.', pinned: false, scene: null, createdAt: null }
		]);
		expect(plan.assets).toEqual([
			{ id: ASSET_ID, path: `${ASSET_ID}.png`, bytes: new Uint8Array([1, 2, 3]) }
		]);
	});

	it('reads an archive saved with Windows line endings as plain newlines', () => {
		const plan = parseStoryZip(
			zip({
				'halden/story.md': '---\r\ntitle: "Halden"\r\n---\r\nThe description.\r\n',
				'halden/unfiled/01-loose-end.md':
					'---\r\ntitle: "Loose end"\r\nstatus: "final"\r\n---\r\nOne.\r\n\r\nTwo.\r\n',
				'halden/notes/lore/the-toll.md':
					'---\r\nname: "The Toll"\r\nkind: "lore"\r\n---\r\nSteep.\r\nVery.'
			})
		);
		expect(plan.story.title).toBe('Halden');
		expect(plan.story.descriptionMd).toBe('The description.');
		expect(plan.unfiled).toEqual([{ title: 'Loose end', status: 'final', bodyMd: 'One.\n\nTwo.' }]);
		expect(plan.notes).toEqual([{ kind: 'lore', name: 'The Toll', notesMd: 'Steep.\nVery.' }]);
		expect(plan.problems).toEqual([]);
	});

	it('keeps the indent of a first line and drops only blank lines around a body', () => {
		const code = '    let x = 1;\n\nThen prose.';
		const plan = parseStoryZip(
			zip({
				'h/story.md': `---\ntitle: "H"\n---\n${code}`,
				'h/chapters/01-a/chapter.md': `---\ntitle: "A"\n---\n\n${code}\n\n`,
				'h/chapters/01-a/01-s.md': `---\ntitle: "S"\n---\n${code}\n`,
				'h/notes/characters/ann.md': `---\nname: "Ann"\n---\n${code}`,
				'h/notebook/idea.md': `---\ntitle: "Idea"\n---\n${code}`,
				'h/waiting-drafts/01.md': `---\nscene: "chapters/01-a/01-s.md"\n---\n${code}`
			})
		);
		expect(plan.story.descriptionMd).toBe(code);
		expect(plan.chapters[0].summaryMd).toBe(code);
		expect(plan.chapters[0].scenes[0].bodyMd).toBe(code);
		expect(plan.notes[0].notesMd).toBe(code);
		expect(plan.freeformNotes![0].bodyMd).toBe(code);
		expect(plan.waitingDrafts![0].textMd).toBe(code);
	});

	it('trims a body with a long whitespace run inside it in linear time', () => {
		const run = ' \t\n'.repeat(30_000);
		const body = `a${run}x${run}`;
		const started = performance.now();
		const plan = parseStoryZip(
			zip({
				'h/story.md': '---\ntitle: "H"\n---\n',
				'h/chapters/01-a/01-s.md': `---\ntitle: "S"\n---\n${body}`
			})
		);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(plan.chapters[0].scenes[0].bodyMd).toBe(`a${run}x`);
	});

	it('flags unknown statuses as problems and starts those scenes as drafts', () => {
		const plan = parseStoryZip(full());
		expect(plan.chapters[0].scenes[1].status).toBeNull();
		expect(plan.problems).toEqual([expect.stringContaining('unknown status "sketchy"')]);
	});

	it('keeps a notebook note whose scene is missing on the story, with a problem', () => {
		const plan = parseStoryZip(
			zip({
				'story.md': '---\ntitle: "T"\n---\n',
				'unfiled/01-one.md': '---\ntitle: "One"\n---\nText.',
				'notebook/a.md': '---\nscene: "unfiled/01-one.md"\ncreated: "not a date"\n---\nA.',
				'notebook/b.md': '---\nscene: "unfiled/09-gone.md"\n---\nB.'
			})
		);
		expect(plan.freeformNotes?.map((n) => [n.scene, n.createdAt])).toEqual([
			[{ chapter: null, index: 0 }, null],
			[null, null]
		]);
		expect(plan.problems).toEqual([expect.stringContaining('unfiled/09-gone.md')]);
	});

	it('reads waiting drafts onto their scenes, skipping a missing scene and a second draft', () => {
		const plan = parseStoryZip(
			zip({
				'story.md': '---\ntitle: "T"\n---\n',
				'chapters/01-a/01-one.md': '---\ntitle: "One"\n---\n',
				'unfiled/01-two.md': '---\ntitle: "Two"\n---\n',
				'waiting-drafts/a.md':
					'---\nscene: "chapters/01-a/01-one.md"\nbrief: "B"\nwords: "800"\npov: "Mara"\nnote: "N"\nchapter-brief: "C"\nsource: "app"\n---\nRain.\n',
				'waiting-drafts/b.md': '---\nscene: "unfiled/01-two.md"\nwords: "lots"\n---\nSun.',
				'waiting-drafts/c.md': '---\nscene: "unfiled/01-two.md"\n---\nAgain.',
				'waiting-drafts/d.md': '---\nscene: "unfiled/09-gone.md"\n---\nGone.'
			})
		);
		expect(plan.waitingDrafts).toEqual([
			{
				scene: { chapter: 0, index: 0 },
				brief: 'B',
				targetWords: 800,
				pov: 'Mara',
				note: 'N',
				chapterBrief: 'C',
				source: 'app',
				textMd: 'Rain.'
			},
			{
				scene: { chapter: null, index: 0 },
				brief: '',
				targetWords: null,
				pov: null,
				note: null,
				chapterBrief: null,
				source: 'assistant',
				textMd: 'Sun.'
			}
		]);
		expect(plan.problems).toEqual([
			expect.stringContaining('waiting-drafts/c.md'),
			expect.stringContaining('waiting-drafts/d.md')
		]);
	});

	it('falls back to de-slugified chapter names for zips without chapter.md', () => {
		const plan = parseStoryZip(
			zip({
				'story.md': '---\ntitle: "Old Export"\n---\n',
				'chapters/01-the-long-road/01-scene.md': '---\ntitle: "S"\n---\nText.'
			})
		);
		expect(plan.chapters[0].title).toBe('The long road');
	});

	it('names an untitled story and skips nameless notes, with problems', () => {
		const plan = parseStoryZip(
			zip({
				'my-tale/story.md': 'Only a description.',
				'my-tale/notes/places/somewhere.md': 'No front matter.'
			})
		);
		expect(plan.story.title).toBe('My tale');
		expect(plan.notes).toEqual([]);
		expect(plan.problems).toHaveLength(2);
	});

	it('rejects archives that are not story exports', () => {
		expect(() => parseStoryZip(strToU8('not a zip'))).toThrow(StoryZipError);
		expect(() => parseStoryZip(zip({ 'readme.md': 'hello' }))).toThrow(StoryZipError);
	});

	it('rejects an archive with too many entries before unpacking', () => {
		const files: Record<string, string> = { 'story.md': 'x' };
		for (let i = 0; i < 5001; i++) files[`unfiled/${i}-s.md`] = 'x';
		expect(() => parseStoryZip(zip(files))).toThrow(/too many files/);
	});

	it('counts stored entries by their stored size, not the size they declare', () => {
		expect(() => parseStoryZip(overlappingStoredZip(11, 20 * 1024 * 1024))).toThrow(
			/too large to import once unpacked/
		);
	});

	it('rejects an oversized entry before decompressing it', () => {
		// Compresses to almost nothing, but the central directory reports the
		// full size, so the cap trips without expanding it in memory.
		const big = new Uint8Array(51 * 1024 * 1024);
		expect(() => parseStoryZip(zip({ 'story.md': 'x', 'unfiled/01-s.md': big }))).toThrow(
			/too large/
		);
	});
});

describe('rewriteBundledAssetLinks', () => {
	it('rewrites mapped relative links and leaves the rest alone', () => {
		const body = `![a](../../assets/${ASSET_ID}.png) ![b](assets/${ASSET_ID}.png) ![c](/assets/${ASSET_ID})`;
		const out = rewriteBundledAssetLinks(body, (id) => (id === ASSET_ID ? '/assets/new-id' : null));
		expect(out).toBe(`![a](/assets/new-id) ![b](/assets/new-id) ![c](/assets/${ASSET_ID})`);
	});

	it('leaves links untouched when the map declines', () => {
		const body = `![a](../assets/${ASSET_ID}.png)`;
		expect(rewriteBundledAssetLinks(body, () => null)).toBe(body);
	});
});

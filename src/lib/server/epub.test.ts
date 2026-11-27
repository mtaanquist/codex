import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildEpub, sectionTypes } from './epub';
import { zipBytes } from './zip-stream';
import type { StoryContent } from './export';

const story = {
	id: '00000000-0000-4000-8000-000000000001',
	title: 'Book',
	author: null,
	brief: null,
	descriptionMd: null
};

async function epubFiles(content: StoryContent) {
	const { entries } = await buildEpub(story, content, async () => [], null);
	const files = unzipSync(await zipBytes(entries));
	return (name: string) => strFromU8(files[`OEBPS/${name}`]);
}

describe('sectionTypes', () => {
	it('starts the body after the front matter, with a prologue in the body', () => {
		expect(sectionTypes(['dedication', 'foreword', 'prologue', null, 'epilogue'])).toEqual({
			types: ['dedication', 'foreword', 'prologue', 'chapter', 'epilogue'],
			bodyStart: 2
		});
	});

	it('starts the body at the first chapter when there is no front matter', () => {
		expect(sectionTypes([null, null]).bodyStart).toBe(0);
	});

	it("places an author's note by where it sits", () => {
		expect(sectionTypes(['authors_note', null, 'authors_note', 'acknowledgements'])).toEqual({
			types: ['frontmatter', 'chapter', 'backmatter', 'acknowledgments'],
			bodyStart: 1
		});
	});

	it('has no body start when every section is front matter', () => {
		expect(sectionTypes(['dedication']).bodyStart).toBe(-1);
	});
});

describe('buildEpub with chapter roles', () => {
	const content: StoryContent = {
		chapters: [
			{ id: 'a', title: null, role: 'dedication' },
			{ id: 'b', title: null, role: 'prologue' },
			{ id: 'c', title: null },
			{ id: 'd', title: null },
			{ id: 'e', title: 'Last words', role: 'epilogue' }
		],
		scenes: ['a', 'b', 'c', 'd', 'e'].map((chapterId) => ({
			chapterId,
			title: null,
			bodyMd: `Text of ${chapterId}.`
		}))
	};

	it('marks each section, numbers only regular chapters, and adds landmarks', async () => {
		const file = await epubFiles(content);
		expect(file('ch1.xhtml')).toContain('<section epub:type="dedication">');
		expect(file('ch1.xhtml')).toContain('<h1>Dedication</h1>');
		expect(file('ch2.xhtml')).toContain('<section epub:type="prologue">');
		expect(file('ch2.xhtml')).toContain('<h1>Prologue</h1>');
		expect(file('ch3.xhtml')).toContain('<section epub:type="chapter">');
		expect(file('ch3.xhtml')).toContain('<h1>Chapter 1</h1>');
		expect(file('ch4.xhtml')).toContain('<h1>Chapter 2</h1>');
		expect(file('ch5.xhtml')).toContain('<section epub:type="epilogue">');
		expect(file('ch5.xhtml')).toContain('<h1>Last words</h1>');

		const nav = file('nav.xhtml');
		expect(nav).toContain('<nav epub:type="toc" id="toc">');
		expect(nav).toContain('<nav epub:type="landmarks" hidden="">');
		expect(nav).toContain('<a epub:type="toc" href="nav.xhtml#toc">');
		expect(nav).toContain('<a epub:type="bodymatter" href="ch2.xhtml">Prologue</a>');
	});

	it('keeps the old numbering for a book without roles', async () => {
		const file = await epubFiles({
			chapters: [
				{ id: 'a', title: null },
				{ id: 'b', title: null }
			],
			scenes: [{ chapterId: 'b', title: null, bodyMd: 'Only b.' }]
		});
		// An empty chapter is skipped but still counted, as in the outline.
		expect(file('ch2.xhtml')).toContain('<h1>Chapter 2</h1>');
		expect(file('nav.xhtml')).toContain('<a epub:type="bodymatter" href="ch2.xhtml">');
	});
});

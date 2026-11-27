import { describe, expect, it } from 'vitest';
import { chapterLabel, chapterLabels, chapterNumbers, chapterRoleOf } from './chapter-role';

describe('chapterLabels', () => {
	it('numbers untitled regular chapters by their place', () => {
		expect(chapterLabels([{ title: null }, { title: null }])).toEqual(['Chapter 1', 'Chapter 2']);
	});

	it('counts only regular chapters, and names an untitled role chapter by its role', () => {
		expect(
			chapterLabels([
				{ title: null, role: 'dedication' },
				{ title: null, role: 'prologue' },
				{ title: null, role: null },
				{ title: 'The storm', role: null },
				{ title: null },
				{ title: null, role: 'authors_note' }
			])
		).toEqual(['Dedication', 'Prologue', 'Chapter 1', 'The storm', 'Chapter 3', "Author's note"]);
	});

	it('shows the title over the role', () => {
		expect(chapterLabels([{ title: 'Before', role: 'prologue' }])).toEqual(['Before']);
	});

	it('treats a blank title as no title', () => {
		expect(chapterLabels([{ title: '   ' }, { title: '', role: 'epilogue' }])).toEqual([
			'Chapter 1',
			'Epilogue'
		]);
	});

	it('treats an unknown role as a regular chapter', () => {
		expect(chapterLabels([{ title: null, role: 'interlude' }, { title: null }])).toEqual([
			'Chapter 1',
			'Chapter 2'
		]);
	});
});

describe('chapterNumbers and chapterLabel', () => {
	it('gives role chapters no number', () => {
		expect(chapterNumbers([{ title: null, role: 'foreword' }, { title: 'A' }])).toEqual([null, 1]);
	});

	it('labels one chapter from its number', () => {
		expect(chapterLabel({ title: null, role: null }, 4)).toBe('Chapter 4');
		expect(chapterLabel({ title: null, role: 'afterword' }, null)).toBe('Afterword');
	});
});

describe('chapterRoleOf', () => {
	it('keeps known roles and drops anything else', () => {
		expect(chapterRoleOf('acknowledgements')).toBe('acknowledgements');
		expect(chapterRoleOf('Prologue')).toBeNull();
		expect(chapterRoleOf(undefined)).toBeNull();
		expect(chapterRoleOf(3)).toBeNull();
	});
});

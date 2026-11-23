import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
	finishUpload,
	hasPendingUploads,
	startUpload,
	storedText,
	uploadTracking,
	withoutRanges
} from './editor-images';

describe('withoutRanges', () => {
	const text = 'Before. ![Uploading a.png...]()\nAfter.';
	const from = text.indexOf('!');
	const to = text.indexOf('After.');

	it('leaves an uploading placeholder out of the stored text', () => {
		expect(withoutRanges(text, [{ from, to }]).text).toBe('Before. After.');
	});

	it('moves positions after a placeholder back by its length', () => {
		const { mapPos } = withoutRanges(text, [{ from, to }]);
		expect(mapPos(3)).toBe(3);
		expect(mapPos(to)).toBe(from);
		expect(mapPos(text.length)).toBe('Before. After.'.length);
		expect(mapPos(from + 4)).toBe(from);
	});

	it('handles several placeholders in any order', () => {
		const result = withoutRanges('a[x]b[y]c', [
			{ from: 5, to: 8 },
			{ from: 1, to: 4 }
		]);
		expect(result.text).toBe('abc');
		expect(result.mapPos(9)).toBe(3);
	});

	it('returns the text unchanged with nothing uploading', () => {
		expect(withoutRanges('Plain.', []).text).toBe('Plain.');
	});
});

describe('upload placeholder tracking', () => {
	const image = '![a.png](/assets/a.png)\n';

	function pasted(doc: string, at: number) {
		const state = EditorState.create({ doc, extensions: uploadTracking });
		const { id, spec } = startUpload(at, 'a.png');
		return { id, state: state.update(spec).state };
	}

	function finish(state: EditorState, id: number) {
		const spec = finishUpload(state, id, image);
		return spec ? state.update(spec).state : state;
	}

	it('lands the image where the placeholder was, around later typing', () => {
		const placed = pasted('One.\nTwo.', 5);
		const id = placed.id;
		let state = placed.state;
		state = state.update({ changes: { from: 0, insert: 'Zero. ' } }).state;
		state = state.update({ changes: { from: state.doc.length, insert: ' Three.' } }).state;
		expect(finish(state, id).doc.toString()).toBe(`Zero. One.\n${image}Two. Three.`);
	});

	it('keeps text typed right before or after the placeholder', () => {
		const placed = pasted('One.\nTwo.', 5);
		const id = placed.id;
		let state = placed.state;
		const placeholder = '![Uploading a.png...]()\n';
		state = state.update({ changes: { from: 5, insert: 'Before ' } }).state;
		const end = 5 + 'Before '.length + placeholder.length;
		state = state.update({ changes: { from: end, insert: 'After ' } }).state;
		expect(storedText(state).text).toBe('One.\nBefore After Two.');
		expect(finish(state, id).doc.toString()).toBe(`One.\nBefore ${image}After Two.`);
	});

	it('keeps several images pasted at once apart and in order', () => {
		let state = EditorState.create({ doc: 'One.\n', extensions: uploadTracking });
		const first = startUpload(5, 'a.png');
		state = state.update(first.spec).state;
		const second = startUpload(5 + first.length, 'b.png');
		state = state.update(second.spec).state;
		const b = '![b.png](/assets/b.png)\n';
		state = state.update(finishUpload(state, second.id, b)!).state;
		state = finish(state, first.id);
		expect(state.doc.toString()).toBe(`One.\n${image}${b}`);
	});

	it('never replaces a loaded newer version when the whole text is swapped', () => {
		const placed = pasted('Old words.\n', 11);
		const id = placed.id;
		let state = placed.state;
		const newer = 'Newer words from another window.\n';
		state = state.update({ changes: { from: 0, to: state.doc.length, insert: newer } }).state;
		expect(storedText(state).text).toBe(newer);
		expect(hasPendingUploads(state)).toBe(false);
		expect(finish(state, id).doc.toString()).toBe(newer);
	});

	it('drops the upload when the placeholder is deleted', () => {
		const placed = pasted('One.\n', 5);
		const id = placed.id;
		let state = placed.state;
		state = state.update({ changes: { from: 5, to: state.doc.length } }).state;
		expect(finish(state, id).doc.toString()).toBe('One.\n');
	});

	it('drops the upload when a selection over the placeholder is typed over', () => {
		const placed = pasted('One.\nTwo.', 5);
		const id = placed.id;
		let state = placed.state;
		state = state.update({ changes: { from: 2, to: state.doc.length - 2, insert: 'new' } }).state;
		const typed = state.doc.toString();
		expect(storedText(state).text).toBe(typed);
		expect(finish(state, id).doc.toString()).toBe(typed);
	});
});

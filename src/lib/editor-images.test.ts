import { describe, expect, it } from 'vitest';
import {
	EditorState,
	type StateCommand,
	type Transaction,
	type TransactionSpec
} from '@codemirror/state';
import { history, isolateHistory, moveLineDown, redo, undo } from '@codemirror/commands';
import {
	finishUpload,
	hasPendingUploads,
	settleUploads,
	startUpload,
	storedText,
	uploadPlaced,
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

describe('upload placeholder through undo and everyday edits', () => {
	const image = '![a.png](/assets/a.png)\n';
	const placeholder = '![Uploading a.png...]()';

	function run(state: EditorState, command: StateCommand) {
		let next = state;
		command({ state, dispatch: (tr: Transaction) => (next = tr.state) });
		return next;
	}

	function pasted(doc: string, at: number) {
		let state = EditorState.create({
			doc,
			selection: { anchor: at },
			extensions: [uploadTracking, history()]
		});
		const { id, spec } = startUpload(at, 'a.png', state);
		state = state.update(spec).state;
		return { id, state };
	}

	// What the editor does on its own once an edit brings a settled
	// placeholder back (the view dispatches this).
	function settle(state: EditorState) {
		let next = state;
		for (let spec = settleUploads(next); spec; spec = settleUploads(next)) {
			next = next.update(spec).state;
		}
		return next;
	}

	function finish(state: EditorState, id: number, replacement: string | null = image) {
		const spec = finishUpload(state, id, replacement);
		return settle(spec ? state.update(spec).state : state);
	}

	function edit(state: EditorState, spec: TransactionSpec) {
		return state.update({ ...spec, annotations: isolateHistory.of('full') }).state;
	}

	it('lands the image after Enter at the end of the placeholder line', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = placed.state;
		const lineEnd = state.doc.lineAt(6).to;
		state = edit(state, { changes: { from: lineEnd, insert: '\nNew.' } });
		expect(hasPendingUploads(state)).toBe(true);
		expect(storedText(state).text).toBe('One.\nNew.\nTwo.');
		expect(finish(state, placed.id).doc.toString()).toBe(`One.\n${image}New.\nTwo.`);
	});

	it('lands the image after the paste is undone and redone', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = run(placed.state, undo);
		state = run(state, redo);
		expect(hasPendingUploads(state)).toBe(true);
		expect(storedText(state).text).toBe('One.\nTwo.');
		expect(finish(state, placed.id).doc.toString()).toBe(`One.\n${image}Two.`);
	});

	it('lands the image when a redo brings the placeholder back after the upload finished', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = run(placed.state, undo);
		state = finish(state, placed.id);
		expect(state.doc.toString()).toBe('One.\nTwo.');
		state = settle(run(state, redo));
		expect(state.doc.toString()).toBe(`One.\n${image}Two.`);
		expect(hasPendingUploads(state)).toBe(false);
	});

	it('lands the image after typing inside the placeholder is undone', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = edit(placed.state, { changes: { from: 8, insert: 'x' } });
		state = run(state, undo);
		expect(hasPendingUploads(state)).toBe(true);
		expect(storedText(state).text).toBe('One.\nTwo.');
		expect(finish(state, placed.id).doc.toString()).toBe(`One.\n${image}Two.`);
	});

	it('lands the image after a neighbouring line is moved past the placeholder', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = placed.state.update({ selection: { anchor: 0 } }).state;
		state = run(state, moveLineDown);
		expect(state.doc.toString()).toBe(`${placeholder}\nOne.\nTwo.`);
		expect(hasPendingUploads(state)).toBe(true);
		expect(storedText(state).text).toBe('One.\nTwo.');
		expect(finish(state, placed.id).doc.toString()).toBe(`${image}One.\nTwo.`);
	});

	it('lands the image after the placeholder line itself is moved', () => {
		const placed = pasted('One.\nTwo.\n', 5);
		const state = run(placed.state, moveLineDown);
		expect(state.doc.toString()).toBe(`One.\nTwo.\n${placeholder}\n`);
		expect(finish(state, placed.id).doc.toString()).toBe(`One.\nTwo.\n${image}`);
	});

	it('removes the image, not restores the placeholder, when the landing is undone', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = finish(placed.state, placed.id);
		expect(state.doc.toString()).toBe(`One.\n${image}Two.`);
		state = run(state, undo);
		expect(storedText(state).text).toBe('One.\nTwo.');
		state = settle(state);
		expect(state.doc.toString()).toBe('One.\nTwo.');
		expect(hasPendingUploads(state)).toBe(false);
		state = run(state, redo);
		expect(state.doc.toString()).toBe(`One.\n${image}Two.`);
		state = settle(run(run(state, undo), undo));
		expect(state.doc.toString()).toBe('One.\nTwo.');
	});

	it('removes a failed upload with its line, outside undo history', () => {
		const placed = pasted('One.\nTwo.', 5);
		let state = finish(placed.state, placed.id, null);
		expect(state.doc.toString()).toBe('One.\nTwo.');
		state = settle(run(state, undo));
		expect(state.doc.toString()).toBe('One.\nTwo.');
	});

	it('gives the same file pasted twice its own placeholder', () => {
		const first = pasted('One.\n', 5);
		const second = startUpload(first.state.doc.length, 'a.png', first.state);
		let state = first.state.update(second.spec).state;
		state = finish(state, second.id, '![a.png](/assets/b.png)\n');
		state = finish(state, first.id);
		expect(state.doc.toString()).toBe(`One.\n${image}![a.png](/assets/b.png)\n`);
	});

	it('reports an upload whose placeholder is gone, and inserts nothing', () => {
		const placed = pasted('One.\n', 5);
		let state = placed.state.update({
			changes: { from: 0, to: placed.state.doc.length, insert: 'Newer.\n' }
		}).state;
		expect(uploadPlaced(state, placed.id)).toBe(false);
		state = finish(state, placed.id);
		expect(state.doc.toString()).toBe('Newer.\n');
	});
});

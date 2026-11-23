import { describe, it, expect } from 'vitest';
import { Compartment, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { redo, undo, undoDepth } from '@codemirror/commands';
import { proseExtensions, showNewerText } from './editor';
import { markerExtensions } from './editor-markers';

function setup(text: string, markers: { id: string; anchorStart: number; anchorEnd: number }[]) {
	const historyCompartment = new Compartment();
	const handle = markerExtensions(markers, () => {});
	let state = EditorState.create({
		doc: text,
		extensions: [
			proseExtensions({
				label: 'Scene text',
				placeholder: '',
				onDocChanged: () => {},
				compartments: { history: historyCompartment }
			}),
			handle.extension
		]
	});
	const view = {
		get state() {
			return state;
		},
		dispatch(spec: TransactionSpec) {
			state = state.update(spec).state;
		}
	};
	const run = (command: typeof undo) => command({ state, dispatch: (tr) => (state = tr.state) });
	return {
		get text() {
			return state.doc.toString();
		},
		get state() {
			return state;
		},
		type(from: number, to: number, insert: string) {
			view.dispatch({
				changes: { from, to, insert },
				userEvent: insert ? 'input.type' : 'delete.backward'
			});
		},
		load: (next: string) => showNewerText(view, next, historyCompartment),
		undo: () => run(undo),
		redo: () => run(redo),
		anchors: () => handle.anchors({ state } as EditorView)
	};
}

describe('showNewerText', () => {
	it('leaves nothing to undo onto the newer text', () => {
		const editor = setup('the mat', []);
		editor.type(4, 7, 'rug');
		editor.load('the mat');
		expect(editor.text).toBe('the mat');
		expect(editor.undo()).toBe(false);
		expect(editor.text).toBe('the mat');
	});

	it('does not replay a deletion made before the load', () => {
		const editor = setup('The cat sat on the old mat today.', []);
		editor.type(19, 23, '');
		expect(editor.text).toBe('The cat sat on the mat today.');
		editor.load('The dog sat on the mat yesterday.');
		editor.undo();
		expect(editor.text).toBe('The dog sat on the mat yesterday.');
		expect(undoDepth(editor.state)).toBe(0);
	});

	it('undoes edits made after the load back to the newer text', () => {
		const editor = setup('Rain.', []);
		editor.type(5, 5, ' Old.');
		editor.load('Snow.');
		editor.type(5, 5, ' Wind.');
		expect(editor.undo()).toBe(true);
		expect(editor.text).toBe('Snow.');
		expect(editor.undo()).toBe(false);
		editor.redo();
		expect(editor.text).toBe('Snow. Wind.');
	});

	it('keeps markers outside the change, and undo still puts a deleted one back', () => {
		// "sat"
		const editor = setup('The cat sat.', [{ id: 'm1', anchorStart: 8, anchorEnd: 11 }]);
		editor.type(4, 7, 'dog');
		editor.load('The cow sat.');
		expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 11 }]);
		editor.type(8, 11, '');
		expect(editor.anchors()).toEqual([]);
		editor.undo();
		expect(editor.text).toBe('The cow sat.');
		expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 11 }]);
	});
});

import { describe, it, expect } from 'vitest';
import { Compartment, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, isolateHistory, redo, undo, undoDepth } from '@codemirror/commands';
import { proseExtensions, redoText, showNewerText, undoText } from './editor';
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
		// Whether the last transaction changed the text, which is what
		// schedules an autosave.
		changedBy(run: () => void) {
			let changed = false;
			const dispatch = view.dispatch;
			view.dispatch = (spec) => {
				const tr = state.update(spec);
				changed ||= tr.docChanged;
				state = tr.state;
			};
			run();
			view.dispatch = dispatch;
			return changed;
		},
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

	it('reads Windows line breaks in the newer text as the editor does', () => {
		const editor = setup('Intro\nThe end.', []);
		editor.load('Intro!\r\nThe end.');
		expect(editor.text).toBe('Intro!\nThe end.');
		expect(editor.state.doc.lines).toBe(2);
	});

	it('changes nothing when only the line breaks differ, so no save follows', () => {
		const editor = setup('a\nb', []);
		expect(editor.changedBy(() => editor.load('a\r\nb'))).toBe(false);
		expect(editor.text).toBe('a\nb');
	});
});

describe('undoText and redoText', () => {
	const doc = 'The cat sat on the mat.';
	// "sat"
	const sat = { id: 'sat', anchorStart: 8, anchorEnd: 11 };

	function setupHistory(text = doc) {
		const handle = markerExtensions([sat], () => {});
		let state = EditorState.create({
			doc: text,
			extensions: [history({ newGroupDelay: 1e9 }), handle.extension]
		});
		const target = {
			get state() {
				return state;
			},
			dispatch: (tr: Transaction) => {
				state = tr.state;
			}
		};
		return {
			get text() {
				return state.doc.toString();
			},
			edit(from: number, to: number, insert: string, joined = false) {
				state = state.update({
					changes: { from, to, insert },
					userEvent: insert ? 'input.type' : 'delete.backward',
					annotations: joined ? [] : [isolateHistory.of('full')]
				}).state;
			},
			// A change kept out of undo, as removing an image placeholder is.
			outside(from: number, to: number) {
				state = state.update({
					changes: { from, to },
					annotations: Transaction.addToHistory.of(false)
				}).state;
			},
			undo: () => undoText(target),
			redo: () => redoText(target)
		};
	}

	it('undoes the step before one a change kept out of undo emptied', () => {
		const editor = setupHistory();
		editor.edit(0, 0, 'Oh. ');
		// Typed inside the marked words, so the step carries a marker record.
		editor.edit(13, 13, 'XYZ');
		editor.outside(13, 16);
		expect(editor.text).toBe('Oh. ' + doc);
		expect(editor.undo()).toBe(true);
		expect(editor.text).toBe(doc);
		expect(editor.redo()).toBe(true);
		expect(editor.text).toBe('Oh. ' + doc);
	});

	it('undoes the step before keystrokes that cancelled out', () => {
		const editor = setupHistory();
		editor.edit(0, 0, 'Oh. ');
		editor.edit(23, 23, 'x', true);
		editor.edit(23, 24, '', true);
		expect(editor.undo()).toBe(true);
		expect(editor.text).toBe(doc);
	});

	it('does nothing when there is nothing to undo', () => {
		const editor = setupHistory();
		expect(editor.undo()).toBe(false);
		expect(editor.redo()).toBe(false);
	});
});

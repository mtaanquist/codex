import { describe, it, expect } from 'vitest';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { markerExtensions, type SceneMarker } from './editor-markers';

const doc = 'The cat sat on the mat.';
// "sat"
const marker: SceneMarker = { id: 'm1', anchorStart: 8, anchorEnd: 11 };

function setup(markers: SceneMarker[] = [marker]) {
	const handle = markerExtensions(markers, () => {});
	let state = EditorState.create({ doc, extensions: [history(), handle.extension] });
	const run = (command: typeof undo) => {
		command({
			state,
			dispatch: (tr: Transaction) => {
				state = tr.state;
			}
		});
	};
	return {
		get state() {
			return state;
		},
		change(from: number, to: number, insert = '', addToHistory = true) {
			state = state.update({
				changes: { from, to, insert },
				annotations: Transaction.addToHistory.of(addToHistory)
			}).state;
		},
		// One keystroke deleting [from, to). Joined: one undo step for the run of
		// keystrokes, as in typing; otherwise each is its own undo step.
		key(from: number, to: number, userEvent: string, joined = true) {
			state = state.update({
				changes: { from, to },
				userEvent,
				annotations: joined ? [] : [isolateHistory.of('full')]
			}).state;
		},
		undo: () => run(undo),
		redo: () => run(redo),
		anchors: () => handle.anchors({ state } as EditorView)
	};
}

describe('markerExtensions', () => {
	it('maps a marker through edits before it', () => {
		const editor = setup();
		editor.change(0, 0, 'Oh. ');
		expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 12, anchorEnd: 15 }]);
	});

	it('drops a marker whose words are deleted', () => {
		const editor = setup();
		editor.change(4, 15);
		expect(editor.anchors()).toEqual([]);
	});

	it('puts a deleted marker back on its words when the deletion is undone', () => {
		const editor = setup();
		editor.change(4, 15);
		editor.undo();
		expect(editor.state.doc.toString()).toBe(doc);
		expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 11 }]);
	});

	it('restores the marker where its words land after a change kept out of undo', () => {
		const editor = setup();
		editor.change(8, 12);
		expect(editor.anchors()).toEqual([]);
		// A change undo does not revert, such as text put in by the app.
		editor.change(0, 0, 'Oh. ', false);
		editor.undo();
		expect(editor.state.doc.toString()).toBe('Oh. ' + doc);
		expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 12, anchorEnd: 15 }]);
	});

	it('drops the marker again on redo and restores it on a second undo', () => {
		const editor = setup();
		editor.change(4, 15);
		editor.undo();
		editor.redo();
		expect(editor.anchors()).toEqual([]);
		editor.undo();
		expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 11 }]);
	});

	it('does not restore a marker this editor no longer holds', () => {
		const compartment = new Compartment();
		const handle = markerExtensions([marker], () => {});
		let state = EditorState.create({
			doc,
			extensions: [history(), compartment.of(handle.extension)]
		});
		state = state.update({ changes: { from: 4, to: 15 } }).state;
		// The marker was checked off elsewhere, so the page hands the editor a
		// marker set without it.
		const next = markerExtensions([], () => {});
		state = state.update({ effects: compartment.reconfigure(next.extension) }).state;
		undo({
			state,
			dispatch: (tr: Transaction) => {
				state = tr.state;
			}
		});
		expect(state.doc.toString()).toBe(doc);
		expect(next.anchors({ state } as EditorView)).toEqual([]);
	});

	describe('after deleting the marked words one character at a time', () => {
		const sat = [{ id: 'm1', anchorStart: 8, anchorEnd: 11 }];
		const backspaceSat = (editor: ReturnType<typeof setup>, joined: boolean) => {
			for (const at of [11, 10, 9]) editor.key(at - 1, at, 'delete.backward', joined);
			expect(editor.state.doc.toString()).toBe('The cat  on the mat.');
			expect(editor.anchors()).toEqual([]);
		};

		it('restores the whole marker when one undo step brings the word back', () => {
			const editor = setup();
			backspaceSat(editor, true);
			editor.undo();
			expect(editor.state.doc.toString()).toBe(doc);
			expect(editor.anchors()).toEqual(sat);
		});

		it('restores the whole marker when undoing keystroke by keystroke', () => {
			const editor = setup();
			backspaceSat(editor, false);
			editor.undo();
			editor.undo();
			editor.undo();
			expect(editor.state.doc.toString()).toBe(doc);
			expect(editor.anchors()).toEqual(sat);
		});

		it('grows the marker back with each undone keystroke', () => {
			const editor = setup();
			backspaceSat(editor, false);
			editor.undo();
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 9 }]);
			editor.undo();
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 10 }]);
		});

		it('drops it again on redo and restores it fully on the next undo', () => {
			const editor = setup();
			backspaceSat(editor, true);
			editor.undo();
			editor.redo();
			expect(editor.anchors()).toEqual([]);
			editor.undo();
			expect(editor.anchors()).toEqual(sat);
		});
	});

	describe('after deleting only part of the marked words', () => {
		const sat = [{ id: 'm1', anchorStart: 8, anchorEnd: 11 }];

		it('restores the end of the marker', () => {
			const editor = setup();
			// Backspace "at" from the end of "sat".
			editor.key(10, 11, 'delete.backward');
			editor.key(9, 10, 'delete.backward');
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 9 }]);
			editor.undo();
			expect(editor.state.doc.toString()).toBe(doc);
			expect(editor.anchors()).toEqual(sat);
		});

		it('restores the start of the marker', () => {
			const editor = setup();
			// Forward-delete "sa" from the start of "sat".
			editor.key(8, 9, 'delete.forward');
			editor.key(8, 9, 'delete.forward');
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 9 }]);
			editor.undo();
			expect(editor.state.doc.toString()).toBe(doc);
			expect(editor.anchors()).toEqual(sat);
		});

		it('restores a marker cut by a selection that overlaps its start', () => {
			const editor = setup();
			// "cat sa" goes in one deletion.
			editor.change(4, 10);
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 4, anchorEnd: 5 }]);
			editor.undo();
			expect(editor.state.doc.toString()).toBe(doc);
			expect(editor.anchors()).toEqual(sat);
		});

		it('shrinks it again on redo', () => {
			const editor = setup();
			editor.key(10, 11, 'delete.backward');
			editor.undo();
			editor.redo();
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 8, anchorEnd: 10 }]);
			editor.undo();
			expect(editor.anchors()).toEqual(sat);
		});
	});

	it('keeps a single marker when a partial delete is undone', () => {
		const editor = setup();
		editor.key(10, 11, 'delete.backward');
		editor.undo();
		expect(editor.anchors()).toHaveLength(1);
	});

	it('leaves other markers alone when one is cut and the cut is undone', () => {
		// "cat" and "mat"
		const editor = setup([
			{ id: 'm1', anchorStart: 4, anchorEnd: 7 },
			{ id: 'm2', anchorStart: 19, anchorEnd: 22 }
		]);
		editor.key(6, 7, 'delete.backward');
		editor.undo();
		expect(editor.anchors()).toEqual([
			{ id: 'm1', anchorStart: 4, anchorEnd: 7 },
			{ id: 'm2', anchorStart: 19, anchorEnd: 22 }
		]);
	});
});

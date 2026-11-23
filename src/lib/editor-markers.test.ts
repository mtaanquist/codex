import { describe, it, expect } from 'vitest';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
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
});

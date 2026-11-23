import { describe, it, expect } from 'vitest';
import { ChangeSet, Compartment, EditorState, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, isolateHistory, redo, undo, undoDepth } from '@codemirror/commands';
import {
	markerExtensions,
	rebuiltMarkers,
	unsavedChanges,
	type SceneMarker
} from './editor-markers';

const doc = 'The cat sat on the mat.';
// "sat"
const marker: SceneMarker = { id: 'm1', anchorStart: 8, anchorEnd: 11 };

function setup(markers: SceneMarker[] = [marker], text = doc) {
	const handle = markerExtensions(markers, () => {});
	let state = EditorState.create({
		doc: text,
		// Keystrokes join into one undo step however slowly the test runs.
		extensions: [history({ newGroupDelay: 1e9 }), handle.extension]
	});
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
		// Typing or deleting in one undo step with the edits before it, unless
		// isolated.
		edit(from: number, to: number, insert = '', joined = true) {
			state = state.update({
				changes: { from, to, insert },
				userEvent: insert ? 'input.type' : 'delete.backward',
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

	describe('when one undo step mixes typing and deleting', () => {
		const long = 'The cat sat on the mat and the dog ran far away.';

		it('does not widen a marker over the words before it', () => {
			// "mat and the"
			const markers = [{ id: 'm1', anchorStart: 19, anchorEnd: 30 }];
			const editor = setup(markers, long);
			// Type over "ma", then delete from "he " before the marker into the
			// typed text.
			editor.edit(19, 21, 'xy');
			editor.edit(15, 20);
			editor.undo();
			expect(editor.state.doc.toString()).toBe(long);
			expect(editor.anchors()).toEqual(markers);
		});

		it('does not bring a deleted marker back over new words on redo', () => {
			// "dog"
			const editor = setup([{ id: 'm1', anchorStart: 31, anchorEnd: 34 }], long);
			// Type before "dog", then delete it along with part of the typing.
			editor.edit(31, 31, 'xy');
			editor.edit(32, 36, 'xy');
			expect(editor.anchors()).toEqual([]);
			editor.undo();
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 31, anchorEnd: 34 }]);
			editor.redo();
			expect(editor.state.doc.toString()).toBe('The cat sat on the mat and the xxy ran far away.');
			expect(editor.anchors()).toEqual([]);
		});

		it('does not stretch a cut marker over words typed after it on redo', () => {
			// "cat sat"
			const editor = setup([{ id: 'm1', anchorStart: 4, anchorEnd: 11 }], long);
			// Type over "sat on", then type again just after "cat ".
			editor.edit(8, 14, 'xy');
			editor.edit(8, 8, 'xy');
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 4, anchorEnd: 8 }]);
			editor.undo();
			editor.redo();
			expect(editor.anchors()).toEqual([{ id: 'm1', anchorStart: 4, anchorEnd: 8 }]);
		});
	});

	// Random edits, undos and redos on three markers. Whenever undo or redo
	// brings back text the editor held before, the markers must be back where
	// they were then too. Seeded, so a failure reproduces.
	it('puts markers back exactly through random undo and redo', () => {
		const long = 'The cat sat on the mat and the dog ran far away.';
		const markers = [
			{ id: 'a', anchorStart: 4, anchorEnd: 11 },
			{ id: 'b', anchorStart: 19, anchorEnd: 30 },
			{ id: 'c', anchorStart: 31, anchorEnd: 34 }
		];
		const failures: string[] = [];
		for (let seed = 1; seed <= 1500; seed++) {
			let n = seed;
			const random = () => {
				n = (n * 1103515245 + 12345) & 0x7fffffff;
				return n / 0x7fffffff;
			};
			const editor = setup(markers, long);
			const snapshot = () => editor.state.doc.toString() + JSON.stringify(editor.anchors());
			const seen = new Map<string, Set<string>>();
			const remember = () => {
				const text = editor.state.doc.toString();
				if (!seen.has(text)) seen.set(text, new Set());
				seen.get(text)!.add(snapshot());
			};
			const steps: string[] = [];
			const randomEdit = () => {
				const length = editor.state.doc.length;
				const from = Math.floor(random() * (length + 1));
				const to = Math.min(length, from + Math.floor(random() * 8));
				const insert = random() < 0.5 ? '' : 'xyz'.slice(0, 1 + Math.floor(random() * 3));
				const joined = random() < 0.6;
				if (from === to && !insert) return;
				steps.push(`edit(${from}, ${to}, '${insert}', ${joined})`);
				editor.edit(from, to, insert, joined);
				remember();
			};
			const check = (command: 'undo' | 'redo') => {
				steps.push(`${command}()`);
				editor[command]();
				const known = seen.get(editor.state.doc.toString());
				if (known && !known.has(snapshot())) failures.push(`seed ${seed}: ${steps.join('; ')}`);
			};
			remember();
			const edits = 1 + Math.floor(random() * 8);
			for (let i = 0; i < edits; i++) randomEdit();
			for (let i = 0; i < 6; i++) {
				const pick = random();
				if (pick < 0.4) check('undo');
				else if (pick < 0.7) check('redo');
				else randomEdit();
			}
			while (undoDepth(editor.state)) check('undo');
			if (snapshot() !== long + JSON.stringify(markers))
				failures.push(`seed ${seed}: ${steps.join('; ')}`);
		}
		expect(failures.slice(0, 3)).toEqual([]);
	});
});

// The page hands the editor a new marker set (one checked off, one made)
// while edits since the last autosave are still unsaved: the server's anchors
// are against the saved text, not the text on screen.
describe('rebuiltMarkers', () => {
	const text = 'The cat sat on the mat.';
	const cat: SceneMarker = { id: 'cat', anchorStart: 4, anchorEnd: 7 };
	const sat: SceneMarker = { id: 'sat', anchorStart: 8, anchorEnd: 11 };
	const mat: SceneMarker = { id: 'mat', anchorStart: 19, anchorEnd: 22 };

	function setupRebuild(markers: SceneMarker[]) {
		const compartment = new Compartment();
		let handle = markerExtensions(markers, () => {});
		let state = EditorState.create({
			doc: text,
			extensions: [history({ newGroupDelay: 1e9 }), compartment.of(handle.extension)]
		});
		let unsaved = ChangeSet.empty(text.length).desc;
		const marked = () =>
			handle
				.anchors({ state } as EditorView)
				.map((anchor) => [anchor.id, state.sliceDoc(anchor.anchorStart, anchor.anchorEnd)]);
		return {
			get state() {
				return state;
			},
			edit(from: number, to: number, insert = '') {
				const tr = state.update({ changes: { from, to, insert }, userEvent: 'input' });
				unsaved = unsaved.composeDesc(tr.changes.desc);
				state = tr.state;
			},
			// What the SceneEditor does when the page data brings a changed set.
			reload(incoming: SceneMarker[]) {
				const current = handle.anchors({ state } as EditorView);
				handle = markerExtensions(rebuiltMarkers(incoming, current, unsaved), () => {});
				state = state.update({ effects: compartment.reconfigure(handle.extension) }).state;
			},
			undo() {
				undo({
					state,
					dispatch: (tr: Transaction) => {
						state = tr.state;
					}
				});
			},
			marked
		};
	}

	it('keeps the other markers on their words when one is checked off before the save', () => {
		const editor = setupRebuild([cat, mat]);
		editor.edit(0, 0, 'Oh. ');
		editor.reload([mat]);
		expect(editor.marked()).toEqual([['mat', 'mat']]);
	});

	it('keeps a marker where the editor moved it, not where the server last stored it', () => {
		const editor = setupRebuild([cat, mat]);
		// Typing inside the marked words grows the marker.
		editor.edit(21, 21, 'tt');
		editor.reload([mat]);
		expect(editor.marked()).toEqual([['mat', 'mattt']]);
	});

	it('places a marker new to the editor through the unsaved edits', () => {
		const editor = setupRebuild([cat, mat]);
		editor.edit(0, 0, 'Oh. ');
		editor.reload([cat, sat, mat]);
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat'],
			['mat', 'mat']
		]);
	});

	it('leaves out a new marker whose words were deleted since the save', () => {
		const editor = setupRebuild([cat]);
		editor.edit(8, 12);
		editor.reload([cat, sat]);
		expect(editor.marked()).toEqual([['cat', 'cat']]);
	});

	it('keeps a marker gone when its words were deleted, and undo still puts it back', () => {
		const editor = setupRebuild([cat, mat]);
		editor.edit(18, 22);
		editor.reload([mat]);
		expect(editor.marked()).toEqual([]);
		editor.undo();
		expect(editor.state.doc.toString()).toBe(text);
		expect(editor.marked()).toEqual([['mat', 'mat']]);
	});

	it('maps a kept marker back when the unsaved edit is undone', () => {
		const editor = setupRebuild([cat, mat]);
		editor.edit(0, 0, 'Oh. ');
		editor.reload([mat]);
		editor.undo();
		expect(editor.state.doc.toString()).toBe(text);
		expect(editor.marked()).toEqual([['mat', 'mat']]);
	});
});

describe('unsavedChanges', () => {
	const insert = (length: number, at: number, text: string) =>
		ChangeSet.of({ from: at, insert: text }, length).desc;

	it('maps saved positions through every edit while nothing has landed', () => {
		const unsaved = unsavedChanges(10);
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent();
		unsaved.record(insert(12, 0, 'cd'));
		expect(unsaved.changes.mapPos(5)).toBe(9);
	});

	it('keeps only the edits made after the text a landed save sent', () => {
		const unsaved = unsavedChanges(10);
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent();
		unsaved.record(insert(12, 0, 'cd'));
		unsaved.landed();
		expect(unsaved.changes.mapPos(5)).toBe(7);
	});

	it('keeps every edit when a save fails, until a later one lands', () => {
		const unsaved = unsavedChanges(10);
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent();
		unsaved.record(insert(12, 0, 'cd'));
		unsaved.sent();
		expect(unsaved.changes.mapPos(5)).toBe(9);
		unsaved.landed();
		expect(unsaved.changes.mapPos(5)).toBe(5);
	});
});

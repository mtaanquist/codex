import { describe, it, expect } from 'vitest';
import { ChangeSet, Compartment, EditorState, Text, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, isolateHistory, redo, undo, undoDepth } from '@codemirror/commands';
import {
	markerExtensions,
	rebuiltMarkers,
	unsavedChanges,
	type SceneMarker
} from './editor-markers';
import { textHash } from './text-hash';
import { createAnchorMapper, SAVE_DIFF_BUDGET } from './review-anchor';

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

	it('keeps no records in an undo step for markers that were never shown', () => {
		// Open markers with no position are held but never placed in the text.
		const unplaced = Array.from({ length: 20 }, (_, i) => ({
			id: `u${i}`,
			anchorStart: null,
			anchorEnd: null
		}));
		const editor = setup([marker, ...unplaced]);
		for (let i = 0; i < 50; i++) editor.edit(0, 0, 'x');
		let undone: Transaction | undefined;
		undo({
			state: editor.state,
			dispatch: (tr: Transaction) => {
				undone = tr;
			}
		});
		expect(undone!.state.doc.toString()).toBe(doc);
		const records = undone!.effects.flatMap(
			(effect) => (effect.value as { records: unknown[] }).records
		);
		expect(records).toEqual([]);
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

	// Text the app puts in or takes out without an undo step, such as an image
	// placeholder: undo must still put markers back on their words around it.
	describe('after a change kept out of undo', () => {
		const mat = { id: 'mat', anchorStart: 19, anchorEnd: 22 };
		const marked = (editor: ReturnType<typeof setup>) =>
			editor.anchors().map((anchor) => editor.state.sliceDoc(anchor.anchorStart, anchor.anchorEnd));

		it('does not move a marker onto redone words when the change took the words it had', () => {
			const satOn = { id: 'sat-on', anchorStart: 8, anchorEnd: 14 };
			const editor = setup([satOn]);
			// Typing over "t on " leaves the marker on "sa".
			editor.edit(10, 15, 'XYZ', false);
			expect(marked(editor)).toEqual(['sa']);
			editor.undo();
			expect(marked(editor)).toEqual(['sat on']);
			// "sa" and the space after "on" go outside undo; the marker keeps
			// "t on".
			editor.change(8, 10, '', false);
			editor.change(12, 13, '', false);
			expect(marked(editor)).toEqual(['t on']);
			// Redo types over "t on" again; the marker had only "sa" then.
			editor.redo();
			expect(editor.state.doc.toString()).toBe('The cat XYZthe mat.');
			expect(marked(editor)).toEqual([]);
			// Undo gives back the text and marker from before the redo.
			editor.undo();
			expect(editor.state.doc.toString()).toBe('The cat t onthe mat.');
			expect(marked(editor)).toEqual(['t on']);
		});

		it('puts a marker back when the change shortened the text before its words', () => {
			const editor = setup([mat]);
			editor.edit(15, 22);
			editor.change(0, 4, '', false);
			editor.undo();
			expect(editor.state.doc.toString()).toBe('cat sat on the mat.');
			expect(editor.anchors()).toEqual([{ id: 'mat', anchorStart: 15, anchorEnd: 18 }]);
		});

		it('puts a marker back when the change came just after its deleted words', () => {
			const editor = setup([mat], doc + ' Rain fell.');
			editor.edit(15, 22);
			editor.change(16, 21, '', false);
			editor.undo();
			expect(editor.state.doc.toString()).toBe(doc + ' fell.');
			expect(marked(editor)).toEqual(['mat']);
		});

		it('puts a marker back when the change came where its words were', () => {
			const editor = setup([mat]);
			editor.edit(19, 22);
			editor.change(19, 19, '##', false);
			editor.undo();
			expect(editor.state.doc.toString().replace(/#/g, '')).toBe(doc);
			expect(marked(editor)).toEqual(['mat']);
		});

		it('puts a marker back when later keystrokes joined the undo step', () => {
			const editor = setup([mat]);
			editor.edit(19, 22);
			editor.edit(19, 19, 'xy');
			editor.change(0, 4, '', false);
			editor.undo();
			expect(editor.state.doc.toString()).toBe('cat sat on the mat.');
			expect(marked(editor)).toEqual(['mat']);
		});

		it('puts a marker back after such changes before and after a joined keystroke', () => {
			const editor = setup([mat]);
			editor.edit(19, 22);
			editor.change(0, 4, '', false);
			editor.edit(15, 15, 'xy');
			editor.change(0, 0, 'A ', false);
			editor.undo();
			expect(editor.state.doc.toString()).toBe('A cat sat on the mat.');
			expect(marked(editor)).toEqual(['mat']);
		});

		it('does not put a marker on words such a change put in its place', () => {
			// The edit types right after "the mat", so its undo step records it.
			const editor = setup([{ id: 'm', anchorStart: 15, anchorEnd: 22 }]);
			editor.edit(22, 23, ' now', false);
			editor.change(15, 24, 'NEW', false);
			expect(editor.anchors()).toEqual([]);
			editor.undo();
			expect(editor.state.doc.toString()).toBe('The cat sat on NEW.');
			expect(editor.anchors()).toEqual([]);
		});

		it('takes the marker away on redo and puts it back on the next undo', () => {
			const editor = setup([mat]);
			editor.edit(15, 22);
			editor.undo();
			editor.change(0, 4, '', false);
			editor.redo();
			expect(editor.state.doc.toString()).toBe('cat sat on .');
			expect(editor.anchors()).toEqual([]);
			editor.change(0, 0, 'A ', false);
			editor.undo();
			expect(editor.state.doc.toString()).toBe('A cat sat on the mat.');
			expect(marked(editor)).toEqual(['mat']);
		});

		// Random edits, undos, redos, and runs of "#" put in or taken out
		// without an undo step. With every "#" left out, the text and markers
		// after an undo or redo must match a state the editor held before.
		it('puts markers back exactly through random undo, redo and such changes', () => {
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
				const plain = () => editor.state.doc.toString().replace(/#/g, '');
				const snapshot = () => {
					const text = editor.state.doc.toString();
					const count = (at: number) => text.slice(0, at).replace(/#/g, '').length;
					const anchors = editor
						.anchors()
						.map((anchor) => [anchor.id, count(anchor.anchorStart), count(anchor.anchorEnd)])
						.filter(([, from, to]) => from < to);
					return plain() + JSON.stringify(anchors);
				};
				const seen = new Map<string, Set<string>>();
				const remember = () => {
					if (!seen.has(plain())) seen.set(plain(), new Set());
					seen.get(plain())!.add(snapshot());
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
				const outsideUndo = () => {
					const text = editor.state.doc.toString();
					const runs = [...text.matchAll(/#+/g)];
					if (runs.length && random() < 0.5) {
						const run = runs[Math.floor(random() * runs.length)];
						const to = run.index + run[0].length;
						steps.push(`change(${run.index}, ${to}, '', false)`);
						editor.change(run.index, to, '', false);
					} else {
						const at = Math.floor(random() * (text.length + 1));
						const insert = '##'.slice(0, 1 + Math.floor(random() * 2));
						steps.push(`change(${at}, ${at}, '${insert}', false)`);
						editor.change(at, at, insert, false);
					}
				};
				const check = (command: 'undo' | 'redo') => {
					steps.push(`${command}()`);
					editor[command]();
					const known = seen.get(plain());
					if (known && !known.has(snapshot())) failures.push(`seed ${seed}: ${steps.join('; ')}`);
				};
				remember();
				const edits = 1 + Math.floor(random() * 8);
				for (let i = 0; i < edits; i++) randomEdit();
				for (let i = 0; i < 8; i++) {
					const pick = random();
					if (pick < 0.3) check('undo');
					else if (pick < 0.5) check('redo');
					else if (pick < 0.75) outsideUndo();
					else randomEdit();
				}
				while (undoDepth(editor.state)) check('undo');
			}
			expect(failures.slice(0, 3)).toEqual([]);
		});

		// Such changes replacing the writer's words with "#": undo or redo must
		// not put a marker on "#" alone unless it was there before.
		it('never puts a marker back on words such changes put in', () => {
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
				const onHashes = () =>
					new Set(
						editor
							.anchors()
							.filter(({ anchorStart, anchorEnd }) =>
								/^#+$/.test(editor.state.sliceDoc(anchorStart, anchorEnd))
							)
							.map((anchor) => anchor.id)
					);
				// Markers a change already left on "#" alone, which undo may put back.
				const wasOnHashes = new Set<string>();
				const steps: string[] = [];
				const span = (insert: string) => {
					const length = editor.state.doc.length;
					const from = Math.floor(random() * (length + 1));
					const to = Math.min(length, from + Math.floor(random() * 8));
					return { from, to, insert, joined: random() < 0.6 };
				};
				for (let i = 0; i < 16; i++) {
					const pick = random();
					if (pick < 0.45) {
						const { from, to, insert, joined } = span(random() < 0.5 ? '' : 'xyz');
						if (from === to && !insert) continue;
						steps.push(`edit(${from}, ${to}, '${insert}', ${joined})`);
						editor.edit(from, to, insert, joined);
					} else if (pick < 0.65) {
						const { from, to } = span('##');
						steps.push(`change(${from}, ${to}, '##', false)`);
						editor.change(from, to, '##', false);
					} else {
						const command = pick < 0.85 ? 'undo' : 'redo';
						steps.push(`${command}()`);
						editor[command]();
						if ([...onHashes()].some((id) => !wasOnHashes.has(id))) {
							failures.push(`seed ${seed}: ${steps.join('; ')}`);
							break;
						}
					}
					for (const id of onHashes()) wasOnHashes.add(id);
				}
			}
			expect(failures.slice(0, 3)).toEqual([]);
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

	function setupRebuild(markers: SceneMarker[], initial = text) {
		const compartment = new Compartment();
		let handle = markerExtensions(markers, () => {});
		let state = EditorState.create({
			doc: initial,
			extensions: [history({ newGroupDelay: 1e9 }), compartment.of(handle.extension)]
		});
		const unsaved = unsavedChanges(initial);
		// The markers and text as the server stores them.
		let server = markers;
		let stored = initial;
		const anchors = () => handle.anchors({ state } as EditorView);
		const apply = (tr: Transaction) => {
			if (!tr.changes.empty) unsaved.record(tr.changes);
			state = tr.state;
		};
		const editor = {
			get state() {
				return state;
			},
			get server() {
				return server;
			},
			anchors,
			marked: () =>
				anchors().map((anchor) => [
					anchor.id,
					state.sliceDoc(anchor.anchorStart, anchor.anchorEnd)
				]),
			edit(from: number, to: number, insert = '', joined = true) {
				apply(
					state.update({
						changes: { from, to, insert },
						userEvent: insert ? 'input.type' : 'delete.backward',
						annotations: joined ? [] : [isolateHistory.of('full')]
					})
				);
			},
			// An autosave as the SceneEditor runs it: send() takes the text and
			// anchors, and the function it returns is the save landing. The server
			// maps a marker the save sends no anchors for by comparing the texts,
			// as remapMarkerAnchors does, and detaches it when its words are gone.
			send() {
				const sent = anchors();
				const text = state.doc.toString();
				unsaved.sent(textHash(text));
				return () => {
					const mapper = createAnchorMapper(SAVE_DIFF_BUDGET);
					server = server.map((marker) => {
						const own = sent.find((anchor) => anchor.id === marker.id);
						if (own) return own;
						const { anchorStart: start, anchorEnd: end } = marker;
						if (start === null || end === null) return marker;
						const now = mapper.ends(stored, text, start, end);
						return now
							? { id: marker.id, anchorStart: now.start, anchorEnd: now.end }
							: { id: marker.id, anchorStart: null, anchorEnd: null };
					});
					stored = text;
					unsaved.landed();
				};
			},
			save() {
				editor.send()();
			},
			// What the SceneEditor does when the page data brings a changed set.
			// version is the fingerprint of the text the anchors count into; by
			// default the one the editor last heard was stored.
			reload(incoming: SceneMarker[] = server, version = unsaved.version) {
				server = incoming;
				const rebuilt = rebuiltMarkers(
					incoming,
					anchors(),
					handle.ids,
					unsaved.settledFrom(version)
				);
				handle = markerExtensions(rebuilt, () => {});
				state = state.update({ effects: compartment.reconfigure(handle.extension) }).state;
			},
			// The SceneEditor after its own save lands: the markers are read again.
			settle() {
				editor.save();
				editor.reload();
			},
			// The server's set without one marker, as checking it off leaves it.
			checkOff(id: string) {
				editor.reload(server.filter((marker) => marker.id !== id));
			},
			undo: () => undo({ state, dispatch: apply }),
			redo: () => redo({ state, dispatch: apply })
		};
		return editor;
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

	it('places a new marker at once when nothing is waiting to save', () => {
		const editor = setupRebuild([cat, mat]);
		editor.reload([cat, sat, mat]);
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat'],
			['mat', 'mat']
		]);
	});

	it('holds a new marker while edits are unsaved, and places it once the save lands', () => {
		const editor = setupRebuild([cat, mat]);
		editor.edit(0, 0, 'Oh. ');
		editor.reload([cat, sat, mat]);
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['mat', 'mat']
		]);
		editor.settle();
		expect(editor.state.doc.toString()).toBe('Oh. ' + text);
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat'],
			['mat', 'mat']
		]);
	});

	it('holds a new marker while a save is on its way', () => {
		const editor = setupRebuild([cat]);
		editor.edit(0, 0, 'Oh. ', false);
		const sentText = editor.state.doc.toString();
		const land = editor.send();
		// The page data is read after the save is stored, before it answers.
		const read = [cat, { id: 'sat', anchorStart: 12, anchorEnd: 15 }];
		editor.reload(read, textHash(sentText));
		expect(editor.marked()).toEqual([['cat', 'cat']]);
		land();
		// The editor checks again once its save lands; the markers it has
		// already count into the text it sent.
		editor.reload(read, textHash(sentText));
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat']
		]);
	});

	it('holds a new marker counted into the text before the save until it is read again', () => {
		const editor = setupRebuild([cat]);
		editor.edit(0, 0, 'Oh. ', false);
		editor.save();
		// Read before the save was stored, and arriving after it answered.
		editor.reload([cat, sat], textHash(text));
		expect(editor.marked()).toEqual([['cat', 'cat']]);
		expect(editor.state.doc.toString()).toBe('Oh. ' + text);
	});

	it('keeps holding while the writer types on, until a save lands with nothing typed after it', () => {
		const editor = setupRebuild([cat]);
		editor.edit(0, 0, 'Oh. ', false);
		editor.reload([cat, sat]);
		const land = editor.send();
		editor.edit(0, 0, 'Ah. ', false);
		land();
		editor.reload();
		expect(editor.marked()).toEqual([['cat', 'cat']]);
		editor.settle();
		expect(editor.state.doc.toString()).toBe('Ah. Oh. ' + text);
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat']
		]);
	});

	it('keeps holding when a save fails, and places the marker once a later one lands', () => {
		const editor = setupRebuild([cat]);
		editor.edit(0, 0, 'Oh. ', false);
		editor.reload([cat, sat]);
		// The save fails: it never lands.
		editor.send();
		editor.reload();
		expect(editor.marked()).toEqual([['cat', 'cat']]);
		editor.settle();
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat']
		]);
	});

	it('holds a new marker counted into a text this editor never had', () => {
		const editor = setupRebuild([cat]);
		editor.reload([cat, sat], textHash('Another window wrote this.'));
		expect(editor.marked()).toEqual([['cat', 'cat']]);
		editor.edit(0, 0, 'Oh. ', false);
		editor.undo();
		expect(editor.marked()).toEqual([['cat', 'cat']]);
	});

	// Edits that partly cancel out inside one combined change (words deleted
	// and partly typed back) left the unsaved edits unable to say which words
	// are the stored ones, so a new marker came out short or waited.
	it('places a new marker on its words after edits that partly cancel out', () => {
		const catSat: SceneMarker = { id: 'cat-sat', anchorStart: 4, anchorEnd: 11 };
		const editor = setupRebuild([mat]);
		editor.edit(9, 10, '', false);
		// Typing over "cat st", then undoing it, leaves one change over "cat sat"
		// that puts back all but the "a".
		editor.edit(4, 10, 'dog', false);
		editor.undo();
		editor.reload([catSat, mat]);
		expect(editor.marked()).toEqual([['mat', 'mat']]);
		editor.settle();
		expect(editor.state.doc.toString()).toBe('The cat st on the mat.');
		expect(editor.marked()).toEqual([
			['cat-sat', 'cat st'],
			['mat', 'mat']
		]);
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

	const long = 'The cat sat on the mat and the dog ran far away.';
	const dog: SceneMarker = { id: 'dog', anchorStart: 31, anchorEnd: 34 };
	const the: SceneMarker = { id: 'the', anchorStart: 0, anchorEnd: 3 };

	it('does not bring back a marker whose words were typed over before the save', () => {
		const editor = setupRebuild([dog, the], long);
		// Type "big" before "dog", then select "gdog" and type "g cat".
		editor.edit(31, 31, 'big');
		editor.edit(33, 37, 'g cat');
		expect(editor.state.doc.toString()).toBe(
			'The cat sat on the mat and the big cat ran far away.'
		);
		expect(editor.marked()).toEqual([['the', 'The']]);
		editor.checkOff('the');
		expect(editor.marked()).toEqual([]);
		editor.save();
		expect(editor.server).toEqual([{ id: 'dog', anchorStart: null, anchorEnd: null }]);
	});

	it('does not bring a deleted marker back over new words on redo after a save and a reload', () => {
		const editor = setupRebuild([dog, the], long);
		// Type before "dog", then delete it along with part of the typing.
		editor.edit(31, 31, 'xy');
		editor.edit(32, 36, 'xy');
		editor.save();
		editor.checkOff('the');
		expect(editor.marked()).toEqual([]);
		editor.undo();
		expect(editor.state.doc.toString()).toBe(long);
		expect(editor.marked()).toEqual([['dog', 'dog']]);
		editor.redo();
		expect(editor.state.doc.toString()).toBe('The cat sat on the mat and the xxy ran far away.');
		expect(editor.marked()).toEqual([]);
	});

	it('takes a marker away again on redo after a reload between undo and redo', () => {
		const editor = setupRebuild([dog, the], long);
		// In one undo step: type before "dog", then type over it.
		editor.edit(31, 31, 'xy');
		editor.edit(32, 36, 'xy');
		editor.undo();
		expect(editor.marked()).toEqual([
			['the', 'The'],
			['dog', 'dog']
		]);
		editor.checkOff('the');
		editor.redo();
		expect(editor.state.doc.toString()).toBe('The cat sat on the mat and the xxy ran far away.');
		expect(editor.marked()).toEqual([]);
		editor.save();
		expect(editor.server).toEqual([{ id: 'dog', anchorStart: null, anchorEnd: null }]);
	});

	it('places a new marker on its words when a deletion was undone before the save', () => {
		const editor = setupRebuild([the], long);
		// Delete "at on", then undo: the text is what the server holds again.
		editor.edit(9, 14, '', false);
		editor.undo();
		editor.reload([
			the,
			{ id: 'sat', anchorStart: 8, anchorEnd: 14 },
			{ id: 'on', anchorStart: 12, anchorEnd: 14 }
		]);
		expect(editor.marked()).toEqual([['the', 'The']]);
		editor.settle();
		expect(editor.marked()).toEqual([
			['the', 'The'],
			['sat', 'sat on'],
			['on', 'on']
		]);
	});

	// Random edits, undos, redos, autosaves (some still on their way at the
	// next step) and marker sets reloaded with one checked off. A reload must
	// not move the markers that stay, and undo and redo must still put them
	// back as they were. Seeded, so a failure reproduces.
	it('keeps markers right through random edits, saves and reloads', () => {
		const markers = [
			{ id: 'a', anchorStart: 4, anchorEnd: 11 },
			{ id: 'b', anchorStart: 19, anchorEnd: 30 },
			{ id: 'c', anchorStart: 31, anchorEnd: 34 },
			{ id: 'd', anchorStart: 0, anchorEnd: 3 },
			{ id: 'e', anchorStart: 39, anchorEnd: 42 }
		];
		const kept = new Set(['a', 'b', 'c']);
		const failures: string[] = [];
		for (let seed = 1; seed <= 1500; seed++) {
			let n = seed;
			const random = () => {
				n = (n * 1103515245 + 12345) & 0x7fffffff;
				return n / 0x7fffffff;
			};
			const editor = setupRebuild(markers, long);
			const snapshot = () =>
				editor.state.doc.toString() +
				JSON.stringify(editor.anchors().filter((anchor) => kept.has(anchor.id)));
			const seen = new Map<string, Set<string>>();
			const remember = () => {
				const doc = editor.state.doc.toString();
				if (!seen.has(doc)) seen.set(doc, new Set());
				seen.get(doc)!.add(snapshot());
			};
			const steps: string[] = [];
			const fail = (why: string) => failures.push(`seed ${seed} ${why}: ${steps.join('; ')}`);
			const checkOffs = ['d', 'e'];
			let land: (() => void) | null = null;
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
				if (known && !known.has(snapshot())) fail(command);
			};
			// One save at a time: a save on its way lands before the next is sent.
			const save = () => {
				if (land) {
					steps.push('land()');
					land();
					land = null;
				} else {
					steps.push('send()');
					land = editor.send();
				}
			};
			const reload = () => {
				const before = snapshot();
				const id = checkOffs.shift();
				steps.push(`checkOff(${id})`);
				if (id) editor.checkOff(id);
				else editor.reload();
				if (snapshot() !== before) fail('reload moved');
			};
			remember();
			const edits = 1 + Math.floor(random() * 8);
			for (let i = 0; i < edits; i++) randomEdit();
			for (let i = 0; i < 10; i++) {
				const pick = random();
				if (pick < 0.3) check('undo');
				else if (pick < 0.5) check('redo');
				else if (pick < 0.6) save();
				else if (pick < 0.75) reload();
				else randomEdit();
			}
			while (undoDepth(editor.state)) check('undo');
			const want = long + JSON.stringify(markers.filter((marker) => kept.has(marker.id)));
			if (snapshot() !== want) fail('final');
		}
		expect(failures.slice(0, 3)).toEqual([]);
	});
});

describe('unsavedChanges', () => {
	const insert = (length: number, at: number, text: string) =>
		ChangeSet.of({ from: at, insert: text }, length);

	it('maps saved positions through every edit while nothing has landed', () => {
		const unsaved = unsavedChanges('0123456789');
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent('');
		unsaved.record(insert(12, 0, 'cd'));
		expect(unsaved.changes.mapPos(5)).toBe(9);
	});

	it('keeps only the edits made after the text a landed save sent', () => {
		const unsaved = unsavedChanges('0123456789');
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent('');
		unsaved.record(insert(12, 0, 'cd'));
		unsaved.landed();
		expect(unsaved.changes.mapPos(5)).toBe(7);
	});

	it('keeps every edit when a save fails, until a later one lands', () => {
		const unsaved = unsavedChanges('0123456789');
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent('');
		unsaved.record(insert(12, 0, 'cd'));
		unsaved.sent('');
		expect(unsaved.changes.mapPos(5)).toBe(9);
		unsaved.landed();
		expect(unsaved.changes.mapPos(5)).toBe(5);
	});

	it('counts a Windows line break as one character, as the editor does', () => {
		const unsaved = unsavedChanges('Ab\r\ncd');
		unsaved.record(insert(5, 0, 'x'));
		expect(unsaved.changes.mapPos(4)).toBe(5);
	});

	it('names the text the server holds: the last one a save landed', () => {
		const unsaved = unsavedChanges('0123456789');
		expect(unsaved.version).toBe(textHash('0123456789'));
		unsaved.record(insert(10, 0, 'ab'));
		unsaved.sent('first');
		// The save fails: the server still holds the loaded text.
		expect(unsaved.version).toBe(textHash('0123456789'));
		unsaved.sent('second');
		unsaved.landed();
		expect(unsaved.version).toBe('second');
		unsaved.reset('newer');
		expect(unsaved.version).toBe('newer');
	});

	describe('settledFrom', () => {
		it('gives no edits when the editor shows the text with that fingerprint', () => {
			const unsaved = unsavedChanges('0123456789');
			expect(unsaved.settledFrom(textHash('0123456789'))?.empty).toBe(true);
			unsaved.record(insert(10, 0, 'ab'));
			unsaved.sent(textHash('ab0123456789'));
			unsaved.landed();
			expect(unsaved.settledFrom(textHash('ab0123456789'))?.empty).toBe(true);
		});

		it('gives nothing while edits are unsaved or a save is on its way', () => {
			const unsaved = unsavedChanges('0123456789');
			unsaved.record(insert(10, 0, 'ab'));
			expect(unsaved.settledFrom(textHash('0123456789'))).toBeNull();
			unsaved.sent(textHash('ab0123456789'));
			expect(unsaved.settledFrom(textHash('0123456789'))).toBeNull();
			expect(unsaved.settledFrom(textHash('ab0123456789'))).toBeNull();
			unsaved.landed();
			unsaved.record(insert(12, 0, 'cd'));
			expect(unsaved.settledFrom(textHash('ab0123456789'))).toBeNull();
		});

		it('gives nothing after a save failed, until a later one lands', () => {
			const unsaved = unsavedChanges('0123456789');
			unsaved.record(insert(10, 0, 'ab'));
			unsaved.sent(textHash('ab0123456789'));
			// The save fails: landed() never runs.
			expect(unsaved.settledFrom(textHash('0123456789'))).toBeNull();
			unsaved.sent(textHash('ab0123456789'));
			unsaved.landed();
			expect(unsaved.settledFrom(textHash('ab0123456789'))?.empty).toBe(true);
		});

		it('gives nothing for a text it does not show, until the newer text loads', () => {
			const unsaved = unsavedChanges('0123456789');
			expect(unsaved.settledFrom(textHash('other'))).toBeNull();
			expect(unsaved.settledFrom(null)).toBeNull();
			unsaved.record(insert(10, 0, 'ab'));
			unsaved.reset(textHash('ab0123456789'));
			expect(unsaved.settledFrom(textHash('0123456789'))).toBeNull();
			expect(unsaved.settledFrom(textHash('ab0123456789'))?.empty).toBe(true);
		});
	});

	describe('while an image is uploading', () => {
		// The placeholder is in the editor text, but a save leaves it out.
		const text = 'The gate scene.';
		const placeholder = '![Uploading x.png...]()\n';
		const cut = [{ from: 0, to: placeholder.length }];

		it('counts from the text the save stored, without the placeholder', () => {
			const unsaved = unsavedChanges(text);
			unsaved.record(insert(text.length, 0, placeholder));
			unsaved.sent(textHash(text), cut);
			unsaved.landed();
			const gate = placeholder.length + 4;
			expect(unsaved.pin(gate, gate + 4).at()).toEqual({ from: 4, to: 8 });
			expect(unsaved.changes.mapPos(4)).toBe(gate);
			expect(unsaved.version).toBe(textHash(text));
			expect(unsaved.settledFrom(textHash(text))?.mapPos(4)).toBe(gate);
		});

		it('follows edits and the upload landing while the save was on its way', () => {
			const unsaved = unsavedChanges(text);
			unsaved.record(insert(text.length, 0, placeholder));
			const gate = placeholder.length + 4;
			const pinned = unsaved.pin(gate, gate + 4);
			unsaved.sent(textHash(text), cut);
			// The upload lands: the placeholder becomes the image line.
			const image = '![x.png](/a/1)\n';
			unsaved.record(
				ChangeSet.of(
					{ from: 0, to: placeholder.length, insert: image },
					text.length + placeholder.length
				)
			);
			unsaved.landed();
			expect(pinned.at()).toEqual({ from: 4, to: 8 });
			expect(unsaved.changes.mapPos(4)).toBe(image.length + 4);
		});
	});

	describe('pin', () => {
		// "gate" in 'The gate scene.'
		const text = 'The gate scene.';

		it('gives a selection in the text the server holds when a save failed', () => {
			const unsaved = unsavedChanges(text);
			unsaved.record(insert(text.length, 0, 'Oh. '));
			// "gate" is now at 8-12 on screen.
			const pinned = unsaved.pin(8, 12);
			unsaved.sent('');
			// The save fails: landed() never runs.
			expect(pinned.at()).toEqual({ from: 4, to: 8 });
		});

		it('follows edits made while the save was on its way', () => {
			const unsaved = unsavedChanges(text);
			unsaved.record(insert(text.length, 0, 'Oh. '));
			const pinned = unsaved.pin(8, 12);
			unsaved.sent('');
			unsaved.record(insert(text.length + 4, 0, 'Ah. '));
			unsaved.landed();
			// The server holds 'Oh. The gate scene.'
			expect(pinned.at()).toEqual({ from: 8, to: 12 });
		});

		it('gives nothing for words the server does not hold yet', () => {
			const unsaved = unsavedChanges(text);
			unsaved.record(insert(text.length, 0, 'Oh. '));
			expect(unsaved.pin(0, 3).at()).toBeNull();
		});

		it('gives the whole selection when a deletion inside it was undone', () => {
			const unsaved = unsavedChanges(text);
			const del = ChangeSet.of({ from: 5, to: 7 }, text.length);
			unsaved.record(del);
			unsaved.record(del.invert(Text.of([text])));
			expect(unsaved.pin(4, 8).at()).toEqual({ from: 4, to: 8 });
			expect(unsaved.pin(5, 7).at()).toEqual({ from: 5, to: 7 });
		});

		it('keeps only the stored part of a selection that runs into unsaved words', () => {
			const unsaved = unsavedChanges(text);
			unsaved.record(insert(text.length, 8, 'way'));
			// "gateway" on screen.
			expect(unsaved.pin(4, 11).at()).toEqual({ from: 4, to: 8 });
		});
	});
});

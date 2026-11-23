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
		expect(undone!.effects).toEqual([]);
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

	function setupRebuild(markers: SceneMarker[], initial = text) {
		const compartment = new Compartment();
		let handle = markerExtensions(markers, () => {});
		let state = EditorState.create({
			doc: initial,
			extensions: [history({ newGroupDelay: 1e9 }), compartment.of(handle.extension)]
		});
		const unsaved = unsavedChanges(initial);
		// The markers as the server stores them.
		let server = markers;
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
			// detaches a marker the save sends no anchors for (its diff mapping
			// would, for words that are gone, which is all these tests need).
			send() {
				const sent = anchors();
				unsaved.sent('');
				return () => {
					server = server.map(
						(marker) =>
							sent.find((anchor) => anchor.id === marker.id) ?? {
								id: marker.id,
								anchorStart: null,
								anchorEnd: null
							}
					);
					unsaved.landed();
				};
			},
			save() {
				editor.send()();
			},
			// What the SceneEditor does when the page data brings a changed set.
			reload(incoming: SceneMarker[] = server) {
				server = incoming;
				handle = markerExtensions(
					rebuiltMarkers(incoming, anchors(), handle.ids, unsaved.changes),
					() => {}
				);
				state = state.update({ effects: compartment.reconfigure(handle.extension) }).state;
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
		expect(editor.marked()).toEqual([
			['the', 'The'],
			['sat', 'sat on'],
			['on', 'on']
		]);
	});

	it('places a new marker through edits that only partly cancel out', () => {
		const editor = setupRebuild([the], long);
		// "cat" typed over as "cot", then "Oh. " typed at the start.
		editor.edit(4, 7, 'cot');
		editor.edit(0, 0, 'Oh. ');
		editor.reload([the, { id: 'sat', anchorStart: 8, anchorEnd: 11 }]);
		expect(editor.marked()).toEqual([
			['the', 'The'],
			['sat', 'sat']
		]);
	});

	it('places a new marker through the edits made while a save was on its way', () => {
		const editor = setupRebuild([cat]);
		editor.edit(0, 0, 'Oh. ');
		const land = editor.send();
		editor.edit(0, 0, 'Ah. ');
		land();
		// "sat" in the text the server holds, which has "Oh. " in front.
		editor.reload([cat, { id: 'sat', anchorStart: 12, anchorEnd: 15 }]);
		expect(editor.marked()).toEqual([
			['cat', 'cat'],
			['sat', 'sat']
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

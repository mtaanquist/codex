import {
	ChangeSet,
	EditorState,
	StateEffect,
	Text,
	StateField,
	type Transaction,
	Prec,
	type ChangeDesc,
	type Extension
} from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { findTodoLines } from './todo-markers';
import { textHash } from './text-hash';
import { defineUndoSteps } from './undo-steps';

// TODO markers in the editor: plain "TODO:" lines get a line highlight
// straight from the text, and selection markers (rows in scene_markers)
// get a mark decoration whose position maps through edits. The mapped
// positions ride the autosave payload via the handle's anchors().

export type SceneMarker = {
	id: string;
	anchorStart: number | null;
	anchorEnd: number | null;
};

type MarkerRange = { id: string; from: number; to: number };

// A marker that reached the editor while its words were deleted and not yet
// saved (see waitingMarkers), with where its words are followed through the
// edits (see unsavedChanges().follow).
export type WaitingMarker = { id: string } & Followed;

type Followed = {
	locate: (changes: ChangeSet) => { from: number; to: number } | null;
	release: () => void;
};

// Puts a marker on a range of the text a transaction produces, for undo or
// redo that brings back the words of a waiting marker.
const restoreMarker = StateEffect.define<MarkerRange>();

// What one edit's undo (or one undo's redo) does to markers, carried in the
// undo history (see undo-steps). A range sets a marker back to exactly the
// range it had just before the edit. A drop takes away a marker that was gone
// before the edit: without it, a marker that undo put back could map onto the
// replacement text on redo and survive. Drops apply across a marker set
// rebuilt in between, since a rebuild keeps the positions the editor shows and
// never places a held marker it was not showing.
type MarkerRecord = MarkerRange | { drop: string };
const markerSteps = defineUndoSteps<MarkerRecord>();

function placeMarkers(tr: Transaction) {
	return markerSteps.place(tr, (record, over) => {
		if ('drop' in record) return record;
		const { id, from, to } = record;
		if (to > over.length) return null;
		const start = over.mapPos(from, 1);
		const end = over.mapPos(to, -1);
		return start < end ? { id, from: start, to: end } : null;
	});
}

function markerMark(id: string, from: number, to: number) {
	return Decoration.mark({ class: 'todo-marker', todoId: id }).range(from, to);
}

function markerField(markers: SceneMarker[], waiting: WaitingMarker[]) {
	const held = new Set(markers.map((marker) => marker.id));
	// Markers this set has placed in the text, at load or by a restore. Only
	// these can be brought back by undo, so only these need a drop record;
	// one that loaded with no position would otherwise add a record per
	// keystroke for nothing.
	const shown = new Set<string>();
	const field = StateField.define<DecorationSet>({
		create(state) {
			const length = state.doc.length;
			const ranges = markers
				.filter(
					(marker) =>
						marker.anchorStart !== null &&
						marker.anchorEnd !== null &&
						marker.anchorStart < marker.anchorEnd &&
						marker.anchorStart < length
				)
				.map((marker) =>
					markerMark(marker.id, marker.anchorStart!, Math.min(marker.anchorEnd!, length))
				);
			for (const range of ranges) shown.add(range.value.spec.todoId as string);
			return Decoration.set(ranges, true);
		},
		update(value, tr) {
			value = value.map(tr.changes);
			const length = tr.newDoc.length;
			// Only a marker this editor still holds, and never twice: what is
			// left of it is replaced, not merged, since that remnant can map onto
			// words the marker never covered.
			const restore = ({ id, from, to }: MarkerRange) => {
				if (!held.has(id) || to > length) return;
				shown.add(id);
				value = value.update({
					filter: (_from, _to, mark) => mark.spec.todoId !== id,
					add: [markerMark(id, from, to)]
				});
			};
			const steps = placeMarkers(tr);
			let next = 0;
			for (const effect of tr.effects) {
				if (effect.is(restoreMarker)) restore(effect.value);
				if (!markerSteps.is(effect)) continue;
				for (const record of steps[next++]) {
					if ('drop' in record) {
						const id = record.drop;
						value = value.update({ filter: (_from, _to, mark) => mark.spec.todoId !== id });
					} else restore(record);
				}
			}
			return value;
		},
		provide: (field) => EditorView.decorations.from(field)
	});
	// An edit that deletes some or all of a marker's words shrinks or drops its
	// highlight, and the next autosave stores that. Each edit that touches a
	// marker keeps the range the marker had just before it in the undo step,
	// so undo sets the marker back to exactly that range (or puts it back) and
	// the autosave after that sends the full anchor again. Mapping the marker
	// back through the undone change would not do: an edge inside or at the
	// edge of the change can land on the wrong side of text put back or taken
	// out. Markers it has shown that are gone before the edit are recorded
	// as gone. Undo steps joined from several keystrokes carry every
	// keystroke's record, earliest last, so the state from before the whole
	// step wins.
	const undoable = invertedEffects.of((tr) => {
		if (tr.changes.empty) return [];
		const before = tr.startState.field(field, false);
		if (!before) return [];
		const touched = new Map<string, MarkerRange>();
		tr.changes.iterChangedRanges((fromA, toA) => {
			before.between(fromA, toA, (from, to, mark) => {
				const id = mark.spec.todoId as string;
				if (fromA <= to && toA >= from) touched.set(id, { id, from, to });
			});
		});
		const present = new Set<string>();
		for (const cursor = before.iter(); cursor.value; cursor.next()) {
			present.add(cursor.value.spec.todoId as string);
		}
		// A marker this transaction puts back was gone before it, whether or not
		// this set has shown it yet: undo can restore a marker that loaded with
		// no position, and the redo step must take it away again.
		const restored = [
			...placeMarkers(tr)
				.flat()
				.flatMap((record) => ('drop' in record ? [] : [record])),
			...tr.effects.flatMap((effect) => (effect.is(restoreMarker) ? [effect.value] : []))
		].flatMap((range) => (held.has(range.id) ? [range.id] : []));
		const gone = [...new Set([...shown, ...restored])].filter((id) => !present.has(id));
		return [markerSteps.of(tr, [...gone.map((id) => ({ drop: id })), ...touched.values()])];
	});
	// Undo or redo that brings back the words of a waiting marker puts the
	// marker on them. As a restore on the transaction, the redo step records
	// taking it away again like any other restore.
	const placeWaiting = EditorState.transactionExtender.of((tr) => {
		if (tr.changes.empty || !(tr.isUserEvent('undo') || tr.isUserEvent('redo'))) return null;
		const effects = waiting.flatMap((marker) => {
			if (shown.has(marker.id)) return [];
			const range = marker.locate(tr.changes);
			return range ? [restoreMarker.of({ id: marker.id, ...range })] : [];
		});
		return effects.length ? { effects } : null;
	});
	return {
		field,
		extension: [field, undoable, placeWaiting],
		placed: (id: string) => shown.has(id)
	};
}

const todoLine = Decoration.line({ class: 'todo-line' });

// Line highlights recomputed from the text itself; scenes are small enough
// to rescan whole.
const todoLinePlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.compute(view);
		}

		update(update: ViewUpdate) {
			if (update.docChanged) this.decorations = this.compute(update.view);
		}

		compute(view: EditorView) {
			const ranges = findTodoLines(view.state.doc.toString()).map((line) =>
				todoLine.range(view.state.doc.lineAt(line.from).from)
			);
			return Decoration.set(ranges);
		}
	},
	{ decorations: (instance) => instance.decorations }
);

export type MarkerHandle = {
	extension: Extension;
	anchors(view: EditorView): { id: string; anchorStart: number; anchorEnd: number }[];
	ids: string[];
	waiting: WaitingMarker[];
	// Whether this set has shown the marker.
	placed(id: string): boolean;
};

// One scene's marker behaviour: highlights, the text-line detector, and
// Mod-Alt-m handing the selection to onMark, which creates the row and
// refreshes the page data.
export function markerExtensions(
	markers: SceneMarker[],
	onMark: (from: number, to: number) => void,
	waiting: WaitingMarker[] = []
): MarkerHandle {
	const { field, extension, placed } = markerField(markers, waiting);

	const markKeymap = keymap.of([
		{
			key: 'Mod-Alt-m',
			run: (view) => {
				const { from, to } = view.state.selection.main;
				if (from === to) return false;
				onMark(from, to);
				return true;
			}
		}
	]);

	return {
		extension: [extension, todoLinePlugin, Prec.high(markKeymap)],
		anchors: (view) => {
			const anchors: { id: string; anchorStart: number; anchorEnd: number }[] = [];
			const set = view.state.field(field, false);
			if (!set) return anchors;
			const cursor = set.iter();
			while (cursor.value) {
				const id = cursor.value.spec.todoId as string | undefined;
				if (id) anchors.push({ id, anchorStart: cursor.from, anchorEnd: cursor.to });
				cursor.next();
			}
			return anchors;
		},
		ids: markers.map((marker) => marker.id),
		waiting,
		placed
	};
}

// The marker set for a rebuild when the page data brings a changed set (one
// checked off, one made). The server's anchors are against the text it last
// stored, so edits made since would put them on the wrong words: a marker the
// editor still highlights keeps its own mapped range, which is newer, and a
// marker new to the editor has its anchors mapped through the unsaved
// changes. A marker the editor held but no longer shows (its words are gone)
// comes back with no anchors, so it stays held and undo can still put it
// back; mapping its old anchors would not do, since the combined changes can
// lose the step that removed it and land it on the words that replaced them.
export function rebuiltMarkers(
	incoming: SceneMarker[],
	current: { id: string; anchorStart: number; anchorEnd: number }[],
	held: string[],
	unsaved: ChangeDesc
): SceneMarker[] {
	const shown = new Map(current.map((anchor) => [anchor.id, anchor]));
	const before = new Set(held);
	return incoming.map((marker) => {
		const own = shown.get(marker.id);
		if (own) return { id: marker.id, anchorStart: own.anchorStart, anchorEnd: own.anchorEnd };
		const { anchorStart: start, anchorEnd: end } = marker;
		if (before.has(marker.id) || start === null || end === null || end > unsaved.length) {
			return { id: marker.id, anchorStart: null, anchorEnd: null };
		}
		const from = unsaved.mapPos(start, 1);
		const to = unsaved.mapPos(end, -1);
		return from < to && keepsSome(unsaved, start, end)
			? { id: marker.id, anchorStart: from, anchorEnd: to }
			: { id: marker.id, anchorStart: null, anchorEnd: null };
	});
}

// The markers a rebuild could not place because their words are deleted and
// not saved yet: the new ones, and those the previous set was still waiting
// on. Undo that brings their words back puts them there (they would otherwise
// only come back on a reload). follow is unsavedChanges().follow.
export function waitingMarkers(
	incoming: SceneMarker[],
	rebuilt: SceneMarker[],
	previous: MarkerHandle,
	follow: (start: number, end: number) => Followed
): WaitingMarker[] {
	const held = new Set(previous.ids);
	const before = new Map(
		previous.waiting
			.filter((marker) => !previous.placed(marker.id))
			.map((marker) => [marker.id, marker])
	);
	const waiting = incoming.flatMap((marker, index): WaitingMarker[] => {
		if (rebuilt[index].anchorStart !== null) return [];
		const kept = before.get(marker.id);
		if (kept) return [kept];
		const { anchorStart: start, anchorEnd: end } = marker;
		if (held.has(marker.id) || start === null || end === null || start >= end) return [];
		return [{ id: marker.id, ...follow(start, end) }];
	});
	for (const marker of previous.waiting) if (!waiting.includes(marker)) marker.release();
	return waiting;
}

// The edits made since the text the server last stored, for rebuiltMarkers.
// Saves run one at a time: sent() marks the text a save is sending, and
// landed() drops the edits up to it once the server has stored it. A failed
// save leaves them in, since the server still holds the older text. The
// texts are kept too, so an edit that puts back exactly what was removed (a
// deletion and its undo) counts as no change: positions do not move, and the
// words count as the stored ones. Any other replacement counts as new words,
// even where it shares letters with the old ones.
// version is the fingerprint of the text the server holds as this editor
// knows it, which the caller passes with each save.
export function unsavedChanges(text: string) {
	// Split into lines as the editor splits its doc.
	let base = Text.of(text.split(/\r\n?|\n/));
	let version = textHash(text);
	let total = ChangeSet.empty(base.length);
	let sending: { text: Text; version: string; since: ChangeSet } | null = null;
	const pins = new Set<{ start: Text; since: ChangeSet }>();
	return {
		record(changes: ChangeSet) {
			total = settled(total.compose(changes), base);
			if (sending) sending.since = settled(sending.since.compose(changes), sending.text);
			for (const pin of pins) pin.since = settled(pin.since.compose(changes), pin.start);
		},
		// Follows a range on screen through the edits after it until released.
		// at() gives the range in the text the server holds at that moment (the
		// one version names), or null when none of its words are stored yet (a
		// save failed or has not run). A range that runs into words not stored
		// yet is cut to the stored part.
		pin(from: number, to: number) {
			const pin = { start: total.apply(base), since: ChangeSet.empty(total.newLength) };
			pins.add(pin);
			return {
				at(): { from: number; to: number } | null {
					const back = total.invertedDesc;
					const after = pin.since.desc;
					const start = back.mapPos(after.mapPos(from, 1), 1);
					const end = back.mapPos(after.mapPos(to, -1), -1);
					return start < end ? { from: start, to: end } : null;
				},
				release() {
					pins.delete(pin);
				}
			};
		},
		// cuts are the ranges of the editor text the save leaves out (an image
		// still uploading), so the base after landing is the text the server
		// stores, and the edits since put them back in.
		sent(sentVersion: string, cuts: readonly { from: number; to: number }[] = []) {
			const shown = total.apply(base);
			const toStored = ChangeSet.of(mergedRanges(cuts), shown.length);
			sending = {
				text: toStored.apply(shown),
				version: sentVersion,
				since: toStored.invert(shown)
			};
		},
		landed() {
			if (sending) {
				base = sending.text;
				version = sending.version;
				total = sending.since;
			}
			sending = null;
		},
		// Follows a range of the text the server holds now through every edit
		// after it until released, for a marker waiting on its words. locate
		// maps it, as rebuiltMarkers maps a new marker, on through the given
		// changes (the next transaction's), and gives null while none of its
		// words are back.
		follow(start: number, end: number) {
			const pin = { start: base, since: total };
			pins.add(pin);
			return {
				locate(next: ChangeSet): { from: number; to: number } | null {
					if (next.length !== pin.since.newLength || end > pin.start.length) return null;
					const mapping = settled(pin.since.compose(next), pin.start).desc;
					if (!keepsSome(mapping, start, end)) return null;
					const at = mapping.mapPos(start, 1);
					const to = mapping.mapPos(end, -1);
					return at < to ? { from: at, to } : null;
				},
				release() {
					pins.delete(pin);
				}
			};
		},
		// The editor now shows exactly what the server holds.
		reset(resetVersion: string) {
			base = total.apply(base);
			version = resetVersion;
			total = ChangeSet.empty(base.length);
			sending = null;
		},
		get changes(): ChangeDesc {
			return total.desc;
		},
		get version(): string {
			return version;
		}
	};
}

// Whether any character in [start, end) comes through the changes untouched.
// Mapping alone can give a range that holds only new words typed where the
// old ones were.
function keepsSome(changes: ChangeDesc, start: number, end: number) {
	let pos = start;
	changes.iterChangedRanges((fromA, toA) => {
		if (fromA <= pos && toA > pos) pos = toA;
	});
	return pos < end;
}

// Sorted, with overlapping or touching ranges joined, as ChangeSet.of needs.
function mergedRanges(ranges: readonly { from: number; to: number }[]) {
	const merged: { from: number; to: number }[] = [];
	for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
		const last = merged.at(-1);
		if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
		else merged.push({ ...range });
	}
	return merged;
}

// changes as applied to before, without the replacements that put back
// exactly what they removed (a deletion and its undo). Run after each edit, so
// that text put back is taken as unchanged even when later edits are composed
// onto the same span (a word deleted, undone, then typed over in part).
function settled(changes: ChangeSet, before: Text): ChangeSet {
	const specs: { from: number; to: number; insert: Text }[] = [];
	let same = false;
	changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (fromA < toA && inserted.eq(before.slice(fromA, toA))) same = true;
		else specs.push({ from: fromA, to: toA, insert: inserted });
	});
	return same ? ChangeSet.of(specs, changes.length) : changes;
}

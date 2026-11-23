import {
	ChangeSet,
	StateEffect,
	Text,
	StateField,
	Prec,
	type ChangeDesc,
	type Extension
} from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { findTodoLines } from './todo-markers';
import { textHash } from './text-hash';

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

// Sets a marker back to the range it had before an undone edit, putting it
// back if the edit had deleted its words. Carried in the undo history, so it
// maps through later changes like the text does.
const restoreMarker = StateEffect.define<MarkerRange>({
	map: (value, mapping) => {
		const from = mapping.mapPos(value.from, 1);
		const to = mapping.mapPos(value.to, -1);
		return from < to ? { id: value.id, from, to } : undefined;
	}
});

// Takes a marker away again on undo or redo when it was gone before the
// change being reverted. Without it, a marker that undo put back can map
// onto the replacement text on redo and survive. It applies across a marker
// set rebuilt in between, since a rebuild keeps the positions the editor
// shows and never places a held marker it was not showing.
const dropMarker = StateEffect.define<string>();

function markerMark(id: string, from: number, to: number) {
	return Decoration.mark({ class: 'todo-marker', todoId: id }).range(from, to);
}

function markerField(markers: SceneMarker[]) {
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
			for (const effect of tr.effects) {
				if (effect.is(dropMarker)) {
					const id = effect.value;
					value = value.update({ filter: (_from, _to, mark) => mark.spec.todoId !== id });
					continue;
				}
				if (!effect.is(restoreMarker)) continue;
				const { id, from, to } = effect.value;
				// Only a marker this editor still holds, and never twice: what is
				// left of it is replaced, not merged, since that remnant can map
				// onto words the marker never covered.
				if (!held.has(id) || to > tr.newDoc.length) continue;
				shown.add(id);
				value = value.update({
					filter: (_from, _to, mark) => mark.spec.todoId !== id,
					add: [markerMark(id, from, to)]
				});
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
		const restored = tr.effects.flatMap((effect) =>
			effect.is(restoreMarker) && held.has(effect.value.id) ? [effect.value.id] : []
		);
		const gone = [...new Set([...shown, ...restored])].filter((id) => !present.has(id));
		return [
			...gone.map((id) => dropMarker.of(id)),
			...[...touched.values()].map((range) => restoreMarker.of(range))
		];
	});
	return { field, extension: [field, undoable] };
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
};

// One scene's marker behaviour: highlights, the text-line detector, and
// Mod-Alt-m handing the selection to onMark, which creates the row and
// refreshes the page data.
export function markerExtensions(
	markers: SceneMarker[],
	onMark: (from: number, to: number) => void
): MarkerHandle {
	const { field, extension } = markerField(markers);

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
		ids: markers.map((marker) => marker.id)
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
		return from < to
			? { id: marker.id, anchorStart: from, anchorEnd: to }
			: { id: marker.id, anchorStart: null, anchorEnd: null };
	});
}

// The edits made since the text the server last stored, for rebuiltMarkers.
// Saves run one at a time: sent() marks the text a save is sending, and
// landed() drops the edits up to it once the server has stored it. A failed
// save leaves them in, since the server still holds the older text. The
// texts are kept too, so edits that cancel out (a deletion and its undo) do
// not move positions: composed, they read as a replacement of the span.
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
			total = total.compose(changes);
			if (sending) sending.since = sending.since.compose(changes);
			for (const pin of pins) pin.since = pin.since.compose(changes);
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
					const back = net(total, base).invertedDesc;
					const after = net(pin.since, pin.start);
					const start = back.mapPos(after.mapPos(from, 1), 1);
					const end = back.mapPos(after.mapPos(to, -1), -1);
					return start < end ? { from: start, to: end } : null;
				},
				release() {
					pins.delete(pin);
				}
			};
		},
		sent(sentVersion: string) {
			sending = {
				text: total.apply(base),
				version: sentVersion,
				since: ChangeSet.empty(total.newLength)
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
		// The editor now shows exactly what the server holds.
		reset(resetVersion: string) {
			base = total.apply(base);
			version = resetVersion;
			total = ChangeSet.empty(base.length);
			sending = null;
		},
		get changes(): ChangeDesc {
			return net(total, base);
		},
		get version(): string {
			return version;
		}
	};
}

// changes as applied to before, with the text each replacement puts back
// unchanged at its start and end left out of it.
function net(changes: ChangeSet, before: Text): ChangeDesc {
	const specs: { from: number; to: number; insert: string }[] = [];
	changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		const removed = before.sliceString(fromA, toA);
		const added = inserted.toString();
		let head = 0;
		while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
		let tail = 0;
		while (
			tail < removed.length - head &&
			tail < added.length - head &&
			removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
		)
			tail++;
		specs.push({
			from: fromA + head,
			to: toA - tail,
			insert: added.slice(head, added.length - tail)
		});
	});
	return ChangeSet.of(specs, before.length).desc;
}

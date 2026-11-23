import { StateEffect, StateField, Prec, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { findTodoLines } from './todo-markers';

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
// onto the replacement text on redo and survive. Scoped to the marker set
// that recorded it, so a set rebuilt from fresh server anchors keeps its own.
const dropMarker = StateEffect.define<{ id: string; owner: object }>();

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
					const { id, owner } = effect.value;
					if (owner !== held) continue;
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
		const gone = [...shown].filter((id) => !present.has(id));
		return [
			...gone.map((id) => dropMarker.of({ id, owner: held })),
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

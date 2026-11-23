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

// Puts back a marker whose words an undone edit had deleted. Carried in the
// undo history, so it maps through later changes like the text does.
const restoreMarker = StateEffect.define<MarkerRange>({
	map: (value, mapping) => {
		const from = mapping.mapPos(value.from, 1);
		const to = mapping.mapPos(value.to, -1);
		return from < to ? { id: value.id, from, to } : undefined;
	}
});

function markerMark(id: string, from: number, to: number) {
	return Decoration.mark({ class: 'todo-marker', todoId: id }).range(from, to);
}

function markerField(markers: SceneMarker[]) {
	const held = new Set(markers.map((marker) => marker.id));
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
			return Decoration.set(ranges, true);
		},
		update(value, tr) {
			value = value.map(tr.changes);
			for (const effect of tr.effects) {
				if (!effect.is(restoreMarker)) continue;
				const { id, from, to } = effect.value;
				// Only a marker this editor still holds, and never twice.
				if (!held.has(id) || to > tr.newDoc.length || idsIn(value).has(id)) continue;
				value = value.update({ add: [markerMark(id, from, to)] });
			}
			return value;
		},
		provide: (field) => EditorView.decorations.from(field)
	});
	// An edit that deletes a marker's words drops its highlight, so the next
	// autosave detaches it. Undoing the edit puts the marker back on the
	// restored words, and the autosave after that sends its anchor again.
	const undoable = invertedEffects.of((tr) => {
		if (tr.changes.empty) return [];
		const before = tr.startState.field(field, false);
		if (!before) return [];
		const kept = idsIn(before.map(tr.changes));
		const effects: StateEffect<MarkerRange>[] = [];
		const cursor = before.iter();
		for (; cursor.value; cursor.next()) {
			const id = cursor.value.spec.todoId as string;
			if (!kept.has(id)) effects.push(restoreMarker.of({ id, from: cursor.from, to: cursor.to }));
		}
		return effects;
	});
	return { field, extension: [field, undoable] };
}

function idsIn(set: DecorationSet) {
	const ids = new Set<string>();
	for (const cursor = set.iter(); cursor.value; cursor.next()) {
		ids.add(cursor.value.spec.todoId as string);
	}
	return ids;
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

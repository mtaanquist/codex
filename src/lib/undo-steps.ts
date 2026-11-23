import { ChangeSet, StateEffect, type ChangeDesc, type Transaction } from '@codemirror/state';

// Records an editor extension keeps in the undo history (through
// invertedEffects) with positions counted in the text from before an edit, the
// text undo brings back: where a marker was, where a line break went.
//
// History maps what it carries through each change kept out of undo (an image
// placeholder taken out, newer text loaded), but hands that change over
// counted in the text after the edit, not before it. Mapping the positions
// there would put them on the wrong words or throw. So a step keeps those
// changes in mapped, and its positions are mapped when undo applies it, over
// the undo change as it stood at each mapping, as history maps its own
// changes (see placeSteps). When history joins a keystroke onto the undo step
// before it, it maps the keystroke's step once through the earlier undo
// change, which is counted in the right text; that comes first in mapped.
//
// An extension emits one step for every edit, empty or not (see undoStep).

export type UndoStep<T> = {
	records: T[];
	// The edit's undo, as history keeps it before any mapping.
	undo: ChangeDesc;
	mapped: readonly ChangeDesc[];
};

// History joins a keystroke on with the earlier undo change itself, a
// ChangeSet; a change kept out of undo comes as a plain description.
function isJoin(mapping: ChangeDesc) {
	return mapping instanceof ChangeSet;
}

export function defineUndoSteps<T>() {
	const effect = StateEffect.define<UndoStep<T>>({
		map: (step, mapping) => {
			if (mapping.empty) return step;
			// A step with no records is kept only for placeSteps to map the steps
			// of earlier keystrokes it joined. One that joined none is dropped, so
			// history can still drop an undo step a change kept out of undo has
			// emptied.
			if (!step.mapped.length && !isJoin(mapping) && !step.records.length) return undefined;
			return { ...step, mapped: [...step.mapped, mapping] };
		}
	});
	return {
		// The step for an edit, for invertedEffects to return.
		of: (tr: Transaction, records: T[]) =>
			effect.of({ records, undo: tr.changes.invertedDesc, mapped: [] }),
		// The steps a transaction (an undo or redo) carries, newest first as
		// history lists them, each with its records mapped into the text the
		// transaction produces by map (which returns null for a record that does
		// not survive). Use the effect order to pair them with tr.effects.
		place(tr: Transaction, map: (record: T, over: ChangeDesc) => T | null): T[][] {
			const steps = tr.effects.flatMap((e) => (e.is(effect) ? [e.value] : []));
			return placeSteps(steps, map);
		},
		is: (e: StateEffect<unknown>): e is StateEffect<UndoStep<T>> => e.is(effect)
	};
}

// A step only knows its own part of the undo change: once a later keystroke
// has joined it, the change is taken from that keystroke's step, which saw
// the same mappings (the same objects) after it joined. So steps are placed
// newest first.
function placeSteps<T>(
	steps: UndoStep<T>[],
	map: (record: T, over: ChangeDesc) => T | null
): T[][] {
	const known = new Map<ChangeDesc, ChangeDesc>();
	return steps.map((step) => {
		let undo: ChangeDesc | null = step.undo;
		let records = step.records;
		step.mapped.forEach((mapping, index) => {
			let over = known.get(mapping);
			if (index === 0 && isJoin(mapping)) {
				over = mapping;
				undo = undo!.composeDesc(mapping);
			} else if (over) {
				undo = null;
			} else if (undo && undo.length === mapping.length) {
				over = mapping.mapDesc(undo, true);
				undo = undo.mapDesc(mapping);
				known.set(mapping, over);
			} else {
				undo = null;
				records = [];
				return;
			}
			const through = over;
			records = records.flatMap((record) => {
				const mapped = map(record, through);
				return mapped === null ? [] : [mapped];
			});
		});
		return records;
	});
}

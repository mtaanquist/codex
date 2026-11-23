import { EditorView } from '@codemirror/view';
import {
	EditorState,
	StateEffect,
	StateField,
	Transaction,
	type Extension,
	type Text,
	type TransactionSpec
} from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { landsWhilePaused } from './editor-paused';

// Paste or drop an image into the prose: it uploads and lands as a
// markdown image pointing at the app-served path. Markdown is the stored
// form, so exports carry the reference as plain text.
//
// The upload is async, so the insertion point is captured as a placeholder
// the moment the image arrives and tracked through every later edit; when the
// upload finishes the placeholder's current range is replaced. This keeps each
// image at the spot it was dropped even if the author keeps typing, and keeps
// several images pasted at once in order.
//
// An upload only ever replaces its own placeholder text, found where it was
// tracked or, once an edit has broken the tracking (undo, redo, a moved line),
// as the one exact copy of that text in the document. Each placeholder's text
// is unique in its editor so the copy can only be its own.

type Pending = {
	id: number;
	text: string;
	from: number;
	to: number;
	// Whether the placeholder is in the text now, at from..to.
	placed: boolean;
	// undefined while uploading. Afterwards, what the placeholder turns into
	// if it is (or comes back) in the text: the image, or null to remove it
	// (a failed upload, or one that already landed and was undone).
	result?: string | null;
};

const addPending = StateEffect.define<Pending>();
const settlePending = StateEffect.define<{ id: number; result: string | null }>();

// Where an edit brought `text` back, if it did and the text is now in the
// document exactly once. Only the changed stretches are looked at first, so
// ordinary typing does not scan the whole document.
function reappeared(tr: Transaction, text: string, wholeDoc: () => string): number | null {
	let near = false;
	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (near) return;
		const from = Math.max(0, fromB - text.length);
		const to = Math.min(tr.newDoc.length, toB + text.length);
		near = tr.newDoc.sliceString(from, to).includes(text);
	});
	if (!near) return null;
	const doc = wholeDoc();
	const at = doc.indexOf(text);
	return at >= 0 && doc.indexOf(text, at + 1) < 0 ? at : null;
}

const pendingField = StateField.define<Pending[]>({
	create: () => [],
	update(value, tr) {
		let next = value;
		if (tr.docChanged && next.length > 0) {
			let whole: string | undefined;
			const wholeDoc = () => (whole ??= tr.newDoc.toString());
			// Text typed against either edge stays outside the placeholder. An
			// edit that touches the placeholder itself unplaces it until its
			// exact text comes back.
			next = next.map((p) => {
				if (p.placed) {
					const from = tr.changes.mapPos(p.from, 1);
					const to = tr.changes.mapPos(p.to, -1);
					if (to - from === p.text.length && tr.newDoc.sliceString(from, to) === p.text) {
						return { ...p, from, to };
					}
				}
				const at = reappeared(tr, p.text, wholeDoc);
				return at === null
					? { ...p, placed: false }
					: { ...p, placed: true, from: at, to: at + p.text.length };
			});
		}
		for (const effect of tr.effects) {
			if (effect.is(addPending)) next = [...next, effect.value];
			else if (effect.is(settlePending)) {
				const { id, result } = effect.value;
				next = next.map((p) => (p.id === id ? { ...p, result } : p));
			}
		}
		return next;
	}
});

let nextId = 0;

type Range = { from: number; to: number };

// Text with the given ranges cut out, and a map from positions in the full
// text to positions in the cut one (a position inside a cut lands at its
// start).
export function withoutRanges(text: string, ranges: Range[]) {
	const cuts = [...ranges].sort((a, b) => a.from - b.from);
	let kept = '';
	let at = 0;
	for (const cut of cuts) {
		kept += text.slice(at, Math.max(at, cut.from));
		at = Math.max(at, cut.to);
	}
	kept += text.slice(at);
	const mapPos = (pos: number) =>
		pos - cuts.reduce((shift, cut) => shift + Math.max(0, Math.min(pos, cut.to) - cut.from), 0);
	return { text: kept, mapPos, cuts };
}

function placedUploads(state: EditorState): Pending[] {
	return (state.field(pendingField, false) ?? []).filter((p) => p.placed);
}

// A placeholder and the line break after it, when there is one: the stretch
// it was inserted as, and what the image or its removal replaces.
function extent(doc: Text, p: Pending): Range {
	return { from: p.from, to: doc.sliceString(p.to, p.to + 1) === '\n' ? p.to + 1 : p.to };
}

// The text to store: an image still uploading is not the writer's text yet,
// so its placeholder stays out (or a save on the way out would keep it for
// good once the upload lands on a closed editor).
export function storedText(state: EditorState) {
	return withoutRanges(
		state.doc.toString(),
		placedUploads(state).map((p) => extent(state.doc, p))
	);
}

// Whether an image is still uploading into this editor; its placeholder is
// not the writer's text yet, so leaving now would lose the image.
export function hasPendingUploads(state: EditorState): boolean {
	return placedUploads(state).length > 0;
}

// Whether an upload's placeholder is in the text now.
export function uploadPlaced(state: EditorState, id: number): boolean {
	return placedUploads(state).some((p) => p.id === id);
}

// The transaction that puts an upload's placeholder at a position. With the
// state, a file already uploading or already in the text gets a numbered
// placeholder, so each one's text is unique.
export function startUpload(at: number, fileName: string, state?: EditorState) {
	const id = nextId++;
	const doc = state?.doc.toString() ?? '';
	const pending = state?.field(pendingField, false) ?? [];
	const taken = (candidate: string) =>
		doc.includes(candidate) || pending.some((p) => p.text === candidate);
	let text = `![Uploading ${fileName}...]()`;
	for (let n = 2; taken(text); n++) text = `![Uploading ${fileName} (${n})...]()`;
	const spec: TransactionSpec = {
		changes: { from: at, insert: `${text}\n` },
		effects: addPending.of({ id, text, from: at, to: at + text.length, placed: true }),
		scrollIntoView: true
	};
	return { id, spec, length: text.length + 1 };
}

// Swap a placed placeholder for `result`. An image that lands is its own undo
// step, and undoing it brings the placeholder back only for the editor to
// remove it (see settleUploads); a removal stays out of undo history.
function replaceSpec(
	state: EditorState,
	p: Pending,
	result: string | null,
	ownStep: boolean
): TransactionSpec {
	const range = extent(state.doc, p);
	// Keep the lines as they are when the writer joined the next line on.
	const insert = result === null ? '' : range.to > p.to ? result : result.replace(/\n$/, '');
	return {
		changes: { ...range, insert },
		// Once replaced, a later return of the placeholder (an undo) removes it.
		effects: settlePending.of({ id: p.id, result: null }),
		// Even while the page swaps the scene: the editor's last save then
		// carries it, where waiting could lose it with the editor.
		annotations: [
			landsWhilePaused.of(true),
			ownStep ? isolateHistory.of('full') : Transaction.addToHistory.of(false)
		],
		scrollIntoView: ownStep
	};
}

// The transaction that settles a finished upload: its placeholder turns into
// the result (null removes it, the failed-upload case). When the placeholder
// is not in the text, nothing else is touched; the result is kept in case an
// undo or redo brings the placeholder back. Null when there is nothing to do.
export function finishUpload(
	state: EditorState,
	id: number,
	replacement: string | null
): TransactionSpec | null {
	const p = state.field(pendingField).find((entry) => entry.id === id);
	if (!p || p.result !== undefined) return null;
	if (!p.placed) return { effects: settlePending.of({ id, result: replacement }) };
	return replaceSpec(state, p, replacement, replacement !== null);
}

// The transaction for a settled upload whose placeholder is back in the
// text, or null. The editor dispatches these after each edit.
export function settleUploads(state: EditorState): TransactionSpec | null {
	const p = placedUploads(state).find((entry) => entry.result !== undefined);
	return p ? replaceSpec(state, p, p.result ?? null, false) : null;
}

export const uploadTracking: Extension = pendingField;

// onLost hears a message for the writer when an image finished uploading but
// its placeholder was no longer in the text, so it was not added.
export function imageUploadExtension(
	universeId: string,
	onLost?: (message: string) => void
): Extension {
	// Settle a finished upload; a null replacement just removes the
	// placeholder, the failed-upload case.
	function clear(view: EditorView, id: number, replacement: string | null, fileName: string) {
		// The upload can resolve after the editor was torn down (a scene switch
		// mid-upload); dispatching on a destroyed view throws. Its DOM is detached
		// once destroyed, so skip the update.
		if (!view.dom.isConnected) return;
		const lost = replacement !== null && !uploadPlaced(view.state, id);
		const spec = finishUpload(view.state, id, replacement);
		if (spec) view.dispatch(spec);
		if (lost) {
			onLost?.(
				`The image ${fileName} was not added because its "Uploading" line was changed or removed. Paste the image again.`
			);
		}
	}

	async function resolve(view: EditorView, file: File, id: number) {
		try {
			const form = new FormData();
			form.set('file', file);
			form.set('kind', 'inline');
			form.set('universeId', universeId);
			const response = await fetch('/api/assets', { method: 'POST', body: form });
			if (!response.ok) {
				clear(view, id, null, file.name);
				return;
			}
			const { path } = (await response.json()) as { path: string };
			clear(view, id, `![${file.name}](${path})\n`, file.name);
		} catch {
			clear(view, id, null, file.name);
		}
	}

	// Insert a placeholder per file at consecutive positions, then start the
	// uploads. Done synchronously in the event handler so the placeholders keep
	// the files' original order before any upload resolves.
	function start(view: EditorView, files: File[], pos: number) {
		let at = pos;
		for (const file of files) {
			const { id, spec, length } = startUpload(at, file.name, view.state);
			view.dispatch(spec);
			at += length;
			void resolve(view, file, id);
		}
	}

	function imageFiles(data: DataTransfer | null): File[] {
		return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'));
	}

	return [
		uploadTracking,
		// A view cannot dispatch while it applies an update, so a settled
		// placeholder an edit brought back is replaced just after.
		EditorView.updateListener.of((update) => {
			if (!update.docChanged || !settleUploads(update.state)) return;
			queueMicrotask(() => {
				if (!update.view.dom.isConnected) return;
				const spec = settleUploads(update.view.state);
				if (spec) update.view.dispatch(spec);
			});
		}),
		EditorView.domEventHandlers({
			paste(event, view) {
				const files = imageFiles(event.clipboardData);
				if (files.length === 0) return false;
				event.preventDefault();
				if (view.state.readOnly) return true;
				start(view, files, view.state.selection.main.head);
				return true;
			},
			drop(event, view) {
				const files = imageFiles(event.dataTransfer);
				if (files.length === 0) return false;
				event.preventDefault();
				if (view.state.readOnly) return true;
				const pos =
					view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
					view.state.selection.main.head;
				start(view, files, pos);
				return true;
			}
		})
	];
}

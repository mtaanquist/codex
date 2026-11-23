import { EditorView, keymap, placeholder } from '@codemirror/view';
import {
	Compartment,
	Transaction,
	type EditorState,
	type Extension,
	type StateCommand,
	type TransactionSpec
} from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { markdownStyling, richModeExtension } from './editor-richtext';
import { formatKeymap } from './editor-format';
import { enterKeymap } from './editor-enter';
import { alignmentExtension } from './editor-alignment';
import { indentExtension } from './editor-indent';
import { nonPrintingExtension } from './editor-nonprinting';
import { searchScopeExtension, type WiderSearch } from './editor-search-scope';

export type EditingMode = 'markdown' | 'rich';
export type MarkVisibility = 'shown' | 'hidden';

// The command-marker decorations (alignment and indent) for the current
// setting, and the non-printing glyphs for theirs. Single source for both the
// initial config and the toolbar's runtime reconfigure, so they never drift.
export function commandMarkerExtensions(commandMarkers: MarkVisibility): Extension {
	const hide = commandMarkers === 'hidden';
	return [alignmentExtension(hide), indentExtension(hide)];
}
export function nonPrintingFor(nonPrintingMarks: MarkVisibility): Extension {
	return nonPrintingMarks === 'shown' ? nonPrintingExtension() : [];
}

// Undo and redo that always change the text. A step whose text change was
// emptied by a change kept out of undo (an image placeholder taken out) stays
// in the history while it carries marker or upload records, and a step of
// keystrokes that cancel out (a letter typed and deleted) changes nothing
// either; on their own, each would make one Ctrl+Z do nothing. Such steps are
// taken together with the next one that changes the text.
function changingText(command: StateCommand): StateCommand {
	return (target) => {
		let state = target.state;
		let changed = false;
		let ran = false;
		const dispatch = (tr: Transaction) => {
			state = tr.state;
			if (!tr.changes.empty) changed = true;
			target.dispatch(tr);
		};
		while (!changed && command({ state, dispatch })) ran = true;
		return ran;
	};
}
export const undoText = changingText(undo);
export const redoText = changingText(redo);
const textHistoryKeymap = historyKeymap.map((binding) =>
	binding.run === undo
		? { ...binding, run: undoText }
		: binding.run === redo
			? { ...binding, run: redoText }
			: binding
);

// The CodeMirror base shared by every prose editor (scenes, entity bodies).
// Markdown renders styled in both modes; rich mode additionally hides the
// syntax marks away from the cursor, reading like formatted text while the
// document stays markdown.
export function proseExtensions(opts: {
	placeholder: string;
	// The editor's accessible name ("Scene text", "Note text", ...).
	label: string;
	onDocChanged: () => void;
	editingMode?: EditingMode;
	// Plain prose: no markdown styling and no formatting shortcuts; entity
	// descriptions use it. The text still stores (and exports) as markdown,
	// it just is not treated as markdown while editing.
	plain?: boolean;
	// Browser-native spell-check; the language tag picks the dictionary,
	// blank follows the browser. CodeMirror turns spellcheck off by
	// default, so this opts back in.
	spellCheck?: { enabled: boolean; language: string };
	// The prose-view toggles, defaulting to the stored defaults. Hosts that
	// flip them at runtime pass compartments to wrap the matching slot.
	nonPrintingMarks?: MarkVisibility;
	commandMarkers?: MarkVisibility;
	// history lets showNewerText clear the undo history.
	compartments?: { nonPrinting?: Compartment; alignment?: Compartment; history?: Compartment };
	// The scene editors on the story page: the find panel can widen the
	// search to the chapter or the whole story.
	widerSearch?: WiderSearch;
}): Extension[] {
	const commandMarkers = commandMarkerExtensions(opts.commandMarkers ?? 'shown');
	const nonPrinting = nonPrintingFor(opts.nonPrintingMarks ?? 'hidden');
	return [
		opts.compartments?.history ? opts.compartments.history.of(history()) : history(),
		keymap.of([...defaultKeymap, ...textHistoryKeymap, ...searchKeymap]),
		// Enter makes a paragraph (Shift+Enter is a soft break); the prose
		// editors store markdown, where that is the natural break.
		opts.plain ? [] : enterKeymap(),
		opts.plain ? [] : formatKeymap(),
		// Find and replace within the scene; Ctrl+F opens the panel.
		search(),
		opts.widerSearch ? searchScopeExtension(opts.widerSearch) : [],
		opts.plain
			? []
			: [
					markdown(),
					markdownStyling(),
					opts.compartments?.alignment
						? opts.compartments.alignment.of(commandMarkers)
						: commandMarkers,
					opts.compartments?.nonPrinting
						? opts.compartments.nonPrinting.of(nonPrinting)
						: nonPrinting
				],
		!opts.plain && opts.editingMode === 'rich' ? richModeExtension() : [],
		opts.spellCheck?.enabled
			? EditorView.contentAttributes.of({
					spellcheck: 'true',
					...(opts.spellCheck.language ? { lang: opts.spellCheck.language } : {})
				})
			: [],
		EditorView.contentAttributes.of({ 'aria-label': opts.label }),
		placeholder(opts.placeholder),
		EditorView.lineWrapping,
		EditorView.updateListener.of((update) => {
			if (update.docChanged) opts.onDocChanged();
		})
	];
}

// Shows the newer text of a scene changed elsewhere (another window). Only the
// part that differs is replaced, so marker highlights outside it stay. The
// undo history is cleared, since its steps were taken on the older text: undo
// would replay this window's old edits onto the newer words, and the next
// save would store the result. history is the compartment proseExtensions
// was given.
export function showNewerText(
	view: { state: EditorState; dispatch: (spec: TransactionSpec) => void },
	stored: string,
	historyCompartment: Compartment
) {
	// The stored text may hold \r\n line breaks, which the editor reads as one
	// newline; compared raw, a lone \r would be left in and add a line.
	const next = view.state.toText(stored).toString();
	const doc = view.state.doc.toString();
	let head = 0;
	while (head < doc.length && head < next.length && doc[head] === next[head]) head++;
	let tail = 0;
	while (
		tail < doc.length - head &&
		tail < next.length - head &&
		doc[doc.length - 1 - tail] === next[next.length - 1 - tail]
	)
		tail++;
	view.dispatch({
		changes: { from: head, to: doc.length - tail, insert: next.slice(head, next.length - tail) },
		annotations: Transaction.addToHistory.of(false),
		// Taking history out of the state drops its steps; putting it back
		// starts an empty one.
		effects: historyCompartment.reconfigure([])
	});
	view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}

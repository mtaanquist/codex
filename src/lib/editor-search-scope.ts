import { showPanel, type EditorView, type Panel } from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';

// A row under the editor's find panel (Ctrl+F) that hands the search over to
// the page, which opens find and replace across the chapter or the story.

export type SearchScope = 'chapter' | 'story';
export type WiderSearch = {
	// Whether the scene sits in a chapter; an unfiled scene offers the story only.
	hasChapter: () => boolean;
	open: (
		scope: SearchScope,
		query: { find: string; matchCase: boolean; wholeWord: boolean }
	) => void;
};

// Dispatched by the host when the scene moves into or out of a chapter, so an
// open panel shows or hides its chapter button without being reopened.
export const searchScopeChanged = StateEffect.define<null>();

export function searchScopeExtension(wider: WiderSearch): Extension {
	const create = (view: EditorView): Panel => {
		const dom = document.createElement('div');
		dom.className = 'cm-search-scope';
		const button = (text: string, scope: SearchScope) => {
			const el = document.createElement('button');
			el.type = 'button';
			el.className = 'cm-button';
			el.textContent = text;
			el.setAttribute('aria-haspopup', 'dialog');
			el.addEventListener('click', () => {
				const query = getSearchQuery(view.state);
				wider.open(scope, {
					find: query.search,
					matchCase: query.caseSensitive,
					wholeWord: query.wholeWord
				});
			});
			return el;
		};
		const label = document.createElement('span');
		label.className = 'cm-search-scope-label';
		label.textContent = 'Find and replace in';
		const chapter = button('This chapter...', 'chapter');
		const story = button('Whole story...', 'story');
		let shown: boolean | null = null;
		const render = () => {
			const hasChapter = wider.hasChapter();
			if (hasChapter === shown) return;
			shown = hasChapter;
			dom.replaceChildren(...(hasChapter ? [label, chapter, story] : [label, story]));
		};
		render();
		return {
			dom,
			top: false,
			update: (update) => {
				const changed = update.transactions.some((tr) =>
					tr.effects.some((effect) => effect.is(searchScopeChanged))
				);
				if (changed) render();
			}
		};
	};
	return StateField.define<boolean>({
		create: (state) => searchPanelOpen(state),
		update: (_, tr) => searchPanelOpen(tr.state),
		provide: (field) => showPanel.from(field, (open) => (open ? create : null))
	});
}

// markdown-it 15 ships its own typings, where the default export is a callable
// value rather than a class, so the instance type comes from the named type
// export beside it.
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import { UUID_BODY } from './slug.ts';
import { alignmentOf } from './alignment.ts';
import { indentMargin, indentOf } from './indent.ts';

// A paragraph containing exactly \page becomes an explicit page break:
// styled with a forced break in print and PDF, an inert empty element
// everywhere else. The marker survives in the markdown itself, so exports
// round-trip it as plain text.
function pageBreaks(md: MarkdownItInstance) {
	md.core.ruler.push('codex_page_break', (state) => {
		const tokens = state.tokens;
		for (let index = 0; index < tokens.length - 2; index++) {
			if (
				tokens[index].type === 'paragraph_open' &&
				tokens[index + 1].type === 'inline' &&
				tokens[index + 1].content.trim() === '\\page' &&
				tokens[index + 2].type === 'paragraph_close'
			) {
				const breakToken = new state.Token('html_block', '', 0);
				breakToken.content = '<div class="page-break"></div>\n';
				tokens.splice(index, 3, breakToken);
			}
		}
	});
}

// A paragraph starting with \center, \right, or \justify renders with that
// text alignment; the marker is stripped from the text. Runs before inline
// parsing so the marker never reaches the rendered output.
function alignments(md: MarkdownItInstance) {
	md.core.ruler.before('inline', 'codex_alignment', (state) => {
		const tokens = state.tokens;
		for (let index = 0; index < tokens.length - 1; index++) {
			if (tokens[index].type !== 'paragraph_open' || tokens[index + 1].type !== 'inline') continue;
			const found = alignmentOf(tokens[index + 1].content);
			if (!found) continue;
			tokens[index + 1].content = tokens[index + 1].content.slice(found.markerLength);
			tokens[index].attrJoin('class', `align-${found.align}`);
		}
	});
}

// A paragraph starting with \indent (or \indent2, ...) is shifted right by
// that many levels; the marker is stripped and the indent rides as an inline
// left margin, so it renders on every surface with no per-surface CSS. Runs
// after alignment so an aligned paragraph can also indent.
function indents(md: MarkdownItInstance) {
	md.core.ruler.before('inline', 'codex_indent', (state) => {
		const tokens = state.tokens;
		for (let index = 0; index < tokens.length - 1; index++) {
			if (tokens[index].type !== 'paragraph_open' || tokens[index + 1].type !== 'inline') continue;
			const found = indentOf(tokens[index + 1].content);
			if (!found) continue;
			tokens[index + 1].content = tokens[index + 1].content.slice(found.markerLength);
			tokens[index].attrSet('style', indentMargin(found.level));
		}
	});
}

// The one markdown renderer, shared by every surface that turns prose
// into HTML: exports, the print view, and later the public reading pages.
// Raw HTML stays off, so prose can never smuggle markup onto a page.
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false })
	.use(pageBreaks)
	.use(alignments)
	.use(indents);

export function renderMarkdown(markdown: string): string {
	return renderer.render(markdown);
}

// Author markdown shown on a public page (the reading page, a profile bio)
// can reach readers who never signed in, so it may only load images Codex
// serves itself. Any other image becomes a plain link to it, labelled with its
// alt text, so a listed author cannot learn who reads their page from an image
// request. The writer's own views keep remote images (renderMarkdown).
function localImagesOnly(isLocal: (src: string) => boolean) {
	return (md: MarkdownItInstance) => {
		const defaultImage = md.renderer.rules.image!;
		md.renderer.rules.image = (tokens, index, options, env, self) => {
			const token = tokens[index];
			const src = String(token.attrGet('src') ?? '');
			if (src && isLocal(src)) return defaultImage(tokens, index, options, env, self);
			const escape = md.utils.escapeHtml;
			// renderInlineAsText returns raw token content, so it must be escaped here.
			const label = self.renderInlineAsText(token.children ?? [], options, env) || src;
			// Inside a link the label alone stands in, since anchors cannot nest.
			let linkDepth = 0;
			for (const sibling of tokens.slice(0, index)) {
				if (sibling.type === 'link_open') linkDepth++;
				else if (sibling.type === 'link_close') linkDepth--;
			}
			if (!src || linkDepth > 0) return escape(label);
			return `<a href="${escape(src)}" rel="noopener noreferrer nofollow">${escape(label)}</a>`;
		};
	};
}

const OWN_ASSET = new RegExp(`^/assets/${UUID_BODY}$`);
const publicRenderer = new MarkdownIt({ html: false, linkify: false, typographer: false })
	.use(pageBreaks)
	.use(alignments)
	.use(indents)
	.use(localImagesOnly((src) => OWN_ASSET.test(src)));

export function renderPublicMarkdown(markdown: string): string {
	return publicRenderer.render(markdown);
}

// EPUB chapters are XHTML, which wants self-closed void elements. An EPUB can
// be offered to signed-out readers as a download, so it follows the public
// rule: only the images bundled in it (rewritten to images/<id>.<ext>) load,
// and any other image becomes a link.
const EPUB_IMAGE = new RegExp(`^images/${UUID_BODY}\\.[a-z0-9]+$`);
const epubRenderer = new MarkdownIt({ html: false, linkify: false, xhtmlOut: true })
	.use(pageBreaks)
	.use(alignments)
	.use(indents)
	.use(localImagesOnly((src) => EPUB_IMAGE.test(src)));

export function renderEpubMarkdown(markdown: string): string {
	return epubRenderer.render(markdown);
}

// The words of a markdown snippet with every bit of markup dropped, for a
// place that shows a short text inside a link (a shelf card): link text stays,
// images go, and each block ends on its own line.
export function markdownToPlainText(markdown: string): string {
	const lines: string[] = [];
	for (const token of publicRenderer.parse(markdown, {})) {
		if (token.type === 'inline') {
			let line = '';
			for (const child of token.children ?? []) {
				if (child.type === 'text' || child.type === 'code_inline') line += child.content;
				else if (child.type === 'softbreak' || child.type === 'hardbreak') line += ' ';
			}
			lines.push(line.replace(/\s+/g, ' '));
		} else if (token.type === 'fence' || token.type === 'code_block') {
			lines.push(token.content.replace(/\n$/, ''));
		}
	}
	return lines
		.map((line) => line.trim())
		.filter(Boolean)
		.join('\n');
}

// Assistant replies are model output, so they get their own renderer: raw
// HTML stays escaped, images render as their alt text (a remote image would
// make the browser fetch a URL the model chose, which a prompt injection could
// use to leak story text), and links open in a new tab without a referrer.
const replyRenderer = new MarkdownIt({ html: false, linkify: false, typographer: false });
replyRenderer.renderer.rules.image = (tokens, index, options, env, self) =>
	// renderInlineAsText returns raw token content, so it must be escaped here.
	replyRenderer.utils.escapeHtml(
		self.renderInlineAsText(tokens[index].children ?? [], options, env)
	);
replyRenderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
	tokens[index].attrSet('target', '_blank');
	tokens[index].attrSet('rel', 'noopener noreferrer nofollow');
	return self.renderToken(tokens, index, options);
};
const SAFE_LINK = /^(https?:|mailto:)/i;
replyRenderer.validateLink = (url) => SAFE_LINK.test(url.trim());

export function renderReplyMarkdown(markdown: string): string {
	return replyRenderer.render(markdown);
}

// The same HTML as renderReplyMarkdown, cut into its top-level blocks (a
// paragraph, a whole list, a code block). A reply that is still arriving only
// ever changes its last block or two, so a caller that renders each block on
// its own leaves the finished ones in place, and a text selection or a hovered
// link inside them survives the next token. The reply is parsed once as a
// whole, so a block renders exactly as it would in the full reply.
export function renderReplyBlocks(markdown: string): string[] {
	const env = {};
	const tokens = replyRenderer.parse(markdown, env);
	const blocks: string[] = [];
	let start = 0;
	let depth = 0;
	tokens.forEach((token, index) => {
		depth += token.nesting;
		if (depth !== 0) return;
		blocks.push(
			replyRenderer.renderer.render(tokens.slice(start, index + 1), replyRenderer.options, env)
		);
		start = index + 1;
	});
	// Unbalanced tokens cannot come out of the parser; if they ever did, the
	// rest still renders rather than vanishing.
	if (start < tokens.length) {
		blocks.push(replyRenderer.renderer.render(tokens.slice(start), replyRenderer.options, env));
	}
	return blocks;
}

// Asset references in prose look like /assets/<uuid>; exports bundle the
// files and rewrite the links to a relative assets/ folder.
const ASSET_REFERENCE = new RegExp(`/assets/(${UUID_BODY})`, 'g');

export function findAssetReferences(markdown: string): string[] {
	const ids = new Set<string>();
	for (const match of markdown.matchAll(ASSET_REFERENCE)) {
		ids.add(match[1]);
	}
	return [...ids];
}

export function rewriteAssetReferences(
	markdown: string,
	pathFor: (assetId: string) => string
): string {
	return markdown.replace(ASSET_REFERENCE, (_, assetId: string) => pathFor(assetId));
}

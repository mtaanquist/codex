// The part of Turndown's HTML parser (domino) that import-document.ts uses.
// domino ships no types for its parser module.
declare module '@mixmark-io/domino/lib/HTMLParser.js' {
	interface Parser {
		parse(html: string, end: boolean): boolean;
		document(): Document;
	}
	interface HTMLParserConstructor {
		new (): Parser;
		// Read when a parser is created, to make its stack of open elements.
		ElementStack: new () => unknown;
	}
	const HTMLParser: HTMLParserConstructor;
	export default HTMLParser;
}

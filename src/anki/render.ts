import { Marked, type Token } from 'marked';

/** Parsed maths, as produced by the inline tokenizer below. */
interface MathToken { text: string; display: boolean }

/** Escape text for an HTML text node. Attribute values use the same escaping, which is stricter than needed. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Link targets that may reach Anki. Anything else, such as javascript: or data: pages, becomes an empty link. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

function safeHref(href: string): string {
	// Browsers ignore spaces and control characters inside a scheme, so remove them before checking.
		const compact = href.replace(/[\s\p{Cc}]/gu, '');
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
	return !scheme || SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? href : '';
}

// Display maths first, so `$$` is not read as an empty inline expression. The inline form needs
// a non-space character after the opening `$` and before the closing `$`, so "$5 and $10" stays text.
const DISPLAY_MATH = /^\$\$([\s\S]+?)\$\$/;
const INLINE_MATH = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$/;

/**
 * Markdown for Anki fields. Maths is converted to the \( \) and \[ \] forms that Anki's
 * built-in MathJax reads; code, escaped dollars and raw HTML are handled by the Markdown parser.
 */
const markdown = new Marked({
	breaks: true,
	gfm: true,
	extensions: [{
		name: 'ankiMath',
		level: 'inline',
		// Stops the ordinary text rule before a dollar sign, so the tokenizer below gets a chance to match.
		start: text => text.indexOf('$'),
		tokenizer(text) {
			const display = DISPLAY_MATH.exec(text);
			if (display) return { type: 'ankiMath', raw: display[0], text: display[1].trim(), display: true };
			const inline = INLINE_MATH.exec(text);
			if (inline) return { type: 'ankiMath', raw: inline[0], text: inline[1], display: false };
		},
		renderer(token) {
			const { text, display } = token as unknown as MathToken;
			const body = escapeHtml(text);
			return display ? `\\[${body}\\]` : `\\(${body}\\)`;
		},
	}],
	renderer: {
		// Raw HTML from a note or the model is shown as text, not run in the card.
		html({ text }) {
			return escapeHtml(text);
		},
	},
	walkTokens(token: Token) {
		if (token.type === 'link' || token.type === 'image') token.href = safeHref(String(token.href));
	},
});

/**
 * Convert one native field value to the HTML Anki stores. The cloze deletion syntax is left as written.
 * A field that is one plain paragraph is returned without its <p> wrapper, so it keeps the spacing
 * of the text it had before rendering. Raw HTML is escaped, so any <p> here came from the parser.
 */
export function renderAnkiField(value: string): string {
	const html = markdown.parse(value, { async: false }).trim();
	const paragraph = /^<p>([\s\S]*)<\/p>$/.exec(html);
	return paragraph && !paragraph[1].includes('</p>') ? paragraph[1] : html;
}

import { Marked } from 'marked';

export interface SourceNote {
	markdown: string;
	title: string;
	/** The original note path resolves relative attachment links, including for selections. */
	path: string;
}

/** Remove metadata and private comments from the request without changing the note on disk. */
export function cleanNote(markdown: string): string {
	const text = markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
	let result = '';
	let position = 0;
	let fence: { character: string; length: number } | undefined;
	while (position < text.length) {
		if (position === 0 || text[position - 1] === '\n') {
			const end = text.indexOf('\n', position);
			const line = text.slice(position, end < 0 ? text.length : end + 1);
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
			if (fence) {
				if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
				result += line;
				position += line.length;
				continue;
			}
			if (marker) {
				fence = { character: marker[1][0], length: marker[1].length };
				result += line;
				position += line.length;
				continue;
			}
		}
		if (text[position] === '`') {
			const delimiter = /^`+/.exec(text.slice(position))![0];
			const end = text.indexOf(delimiter, position + delimiter.length);
			if (end >= 0) {
				result += text.slice(position, end + delimiter.length);
				position = end + delimiter.length;
				continue;
			}
		}
		if (text.startsWith('%%', position)) {
			const end = text.indexOf('%%', position + 2);
			// Keep a word boundary when a comment was embedded between two words.
			result += '\n';
			position = end < 0 ? text.length : end + 2;
			continue;
		}
		result += text[position++];
	}
	return result;
}

// Let the Markdown parser handle code, reference images, nested lists and escaped
// markup. This extension adds Obsidian's ![[attachment|size]] syntax to that parser.
const markdown = new Marked({ extensions: [{
	name: 'wikiEmbed', level: 'inline',
	start: text => text.indexOf('![['),
	tokenizer(text) {
		const match = /^!\[\[([^\]\n]+)\]\]/.exec(text);
		if (match) return { type: 'wikiEmbed', raw: match[0], href: match[1].split('|')[0] };
	},
}] });

/** Only real embeds are returned; examples inside code are not attachments. */
export function embeddedFiles(text: string): string[] {
	const links: string[] = [];
	void markdown.walkTokens(markdown.lexer(text), token => {
		if ((token.type === 'image' || token.type === 'wikiEmbed') && typeof token.href === 'string') links.push(token.href);
	});
	return [...new Set(links)];
}

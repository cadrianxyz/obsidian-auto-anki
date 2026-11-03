/** Require c1 deletions for one recall task, allowing balanced braces in maths and code. */
export function validCloze(text: string): boolean {
	let found = false;
	let cursor = 0;
	while (cursor < text.length) {
		const relative = text.slice(cursor).search(/\{\{c/i);
		if (relative < 0) break;
		const start = cursor + relative;
		const prefix = /^\{\{c1::/.exec(text.slice(start));
		if (!prefix) return false;
		const bodyStart = start + prefix[0].length;
		let depth = 0;
		let end = bodyStart;
		for (; end < text.length; end++) {
			if (depth === 0 && text.startsWith('}}', end)) break;
			if (text[end] === '{') depth++;
			else if (text[end] === '}') { if (depth === 0) return false; depth--; }
		}
		if (end === text.length || depth !== 0) return false;
		const body = text.slice(bodyStart, end);
		if (/\{\{c/i.test(body)) return false;
		const separator = body.indexOf('::');
		const answer = separator < 0 ? body : body.slice(0, separator);
		if (!answer.trim()) return false;
		cursor = end + 2;
		found = true;
	}
	return found;
}

export interface DeckTemplateSource { vault: string; path: string; title: string }
export interface DeckTemplateResult { deck?: string; error?: string }

// --- Template expansion ---

export function resolveDeckTemplate(template: string, { vault, path, title }: DeckTemplateSource): DeckTemplateResult {
	if (!template.trim()) return {};
	const folders = path.split('/').slice(0, -1);
	const values = new Map([['vault', vault], ['folder', folders.join('::')], ['lastFolder', folders[folders.length - 1] ?? ''], ['note', title]]);
	const placeholders = /\{\{([^{}]*)\}\}/g;
	if (/[{}]/.test(template.replace(placeholders, ''))) return { error: 'Use double braces around each placeholder.' };
	for (const [, name] of template.matchAll(placeholders)) {
		if (!values.has(name)) return { error: `Unknown deck template placeholder: {{${name}}}.` };
	}
	const levels = template.split('::')
		.filter(level => folders.length || (level !== '{{folder}}' && level !== '{{lastFolder}}'));
	if (!levels.length) return {};
	const deck = levels
		.map(level => level.replace(placeholders, (_, name: string) => values.get(name) ?? ''))
		.join('::');
	if (deck.split('::').some(level => !level.trim()) || [...deck].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
		return { error: 'A deck name cannot contain blank levels or control characters.' };
	}
	return { deck };
}

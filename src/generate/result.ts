import { asRecord } from '../utils/data';

/** Text pairs accepted by the existing review and Anki export screens. */
export interface CardInformation { q: string; a: string }
export interface GenerationResult { cards: CardInformation[]; noteIssues: string[]; warnings: string[] }

export const CARD_RESPONSE_SCHEMA = {
	type: 'object', additionalProperties: false,
	properties: {
		cards: { type: 'array', items: {
			type: 'object', additionalProperties: false,
			properties: { type: { type: 'string', enum: ['basic'] }, front: { type: 'string' }, back: { type: 'string' } },
			required: ['type', 'front', 'back'],
		} },
		note_issues: { type: 'array', items: { type: 'string' } },
	},
	required: ['cards', 'note_issues'],
};

/** A model reply is untrusted even with structured output. Never export malformed entries. */
export function parseGeneratedCards(content: string, maximumCards?: number): GenerationResult {
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch { throw new Error("The model's reply wasn't in the expected format, so no cards were made. Try again or choose another model."); }
	const root = asRecord(parsed);
	if (!Array.isArray(root.cards) || !Array.isArray(root.note_issues) || !root.note_issues.every((issue: unknown) => typeof issue === 'string')) {
		throw new Error("The model's reply wasn't in the expected format, so no cards were made. Try again or choose another model.");
	}
	const result: GenerationResult = { cards: [], noteIssues: root.note_issues, warnings: [] };
	for (const [index, value] of root.cards.entries()) {
		const card = asRecord(value);
		if (card.type !== 'basic' || typeof card.front !== 'string' || !card.front.trim() || typeof card.back !== 'string' || !card.back.trim()
			|| /\{\{(?:image:|c\d+::)|!\[|<img\b/i.test(`${card.front}\n${card.back}`)) {
			result.warnings.push(`Card ${index + 1} was skipped because it is empty, malformed or uses a format this export flow cannot display.`);
			continue;
		}
		if (maximumCards !== undefined && result.cards.length >= maximumCards) {
			result.warnings.push(`Card ${index + 1} was skipped because it exceeds the maximum of ${maximumCards}.`);
			continue;
		}
		result.cards.push({ q: card.front, a: card.back });
	}
	return result;
}

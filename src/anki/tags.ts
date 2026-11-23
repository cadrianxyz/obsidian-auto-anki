import type { NoteWritingInstructions } from '../settings/schema';
import { NOTE_WRITING_INSTRUCTIONS_VERSION } from '../generate/note-writing-instructions';

// --- Settings and run details ---

/** The saved tag choices. Nothing is tagged unless `enabled` is on. */
export interface TagSettings {
	enabled: boolean;
	model: boolean;
	reasoningEffort: boolean;
	promptVersion: boolean;
	/** Put `auto-anki::` in front of the automatic tags. Never applied to the user's own tags. */
	prefix: boolean;
	/** The user's own tags, separated by spaces as in Anki. */
	extra: string;
}

/** What one run used, captured when it starts, so later setting changes don't alter its tags. */
export interface TagRun {
	/** The provider's ID, such as `anthropic`, never its display name. */
	providerId: string;
	modelId: string;
	/** The level chosen for this run; 'default' when the model's own default is used. */
	reasoningEffort: string;
	/** From promptVersionTag(). */
	promptVersion: string;
}

export const TAG_PREFIX = 'auto-anki';

/** The built-in instructions' version, or the version an edit started from plus `-edited`. */
export function promptVersionTag(edited: NoteWritingInstructions | undefined): string {
	return edited ? `${edited.defaultVersion}-edited` : NOTE_WRITING_INSTRUCTIONS_VERSION;
}

// --- Building tags ---

/** One value inside an automatic tag. Spaces and `::` would split it into extra tags or levels. */
function tagValue(value: string): string {
	return value.trim().replace(/::/g, '-').replace(/\s+/g, '_');
}

/** The model, effort and prompt-version tags the settings ask for. */
export function automaticTags(settings: TagSettings, run: TagRun): string[] {
	if (!settings.enabled) return [];
	const tags: string[][] = [];
	if (settings.model) tags.push([run.providerId, run.modelId]);
	if (settings.reasoningEffort) tags.push(['effort', run.reasoningEffort]);
	if (settings.promptVersion) tags.push(['prompt', run.promptVersion]);
	return tags.map(parts => [...settings.prefix ? [TAG_PREFIX] : [], ...parts.map(tagValue)].join('::'));
}

/**
 * The user's own tags, kept as typed: `::` is their hierarchy, so `uni::cs101` nests in Anki.
 * Only empty levels (`a::::b`, a leading `::`) are removed, so they don't make blank levels in Anki.
 */
export function parseExtraTags(text: string): string[] {
	return text.split(/\s+/).map(tag => tag.split('::').filter(Boolean).join('::')).filter(Boolean);
}

/** Every tag for the notes of one export. `extra` is this export's box, or the saved extra tags. */
export function noteTags(settings: TagSettings, run: TagRun, extra = settings.extra): string[] {
	if (!settings.enabled) return [];
	// Anki treats tags that differ only in case as one tag, so keep the first spelling.
	const seen = new Set<string>();
	return [...automaticTags(settings, run), ...parseExtraTags(extra)].filter(tag => {
		const key = tag.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

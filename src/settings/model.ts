import { asBoolean, asNonEmptyString, asOption, asRecord, asString, positiveInteger } from '../utils/data';
import { ModelReasoningEffort, PROVIDER_IDS, PROVIDER_PRESETS, ProviderId, providerSecretName } from '../ai/presets';
import { getReasoningEffortsForModel, normalizeModelCapabilities, OUTPUT_MODES, OutputMode, type ModelCapabilities } from '../ai/model-info';

export const SETTINGS_VERSION = 1;
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000;
export const IMAGE_OPTIONS = ['auto', 'yes', 'no'] as const;
type ImageOption = typeof IMAGE_OPTIONS[number];
export const COVERAGE_LEVELS = ['key-ideas', 'main-ideas-and-details', 'everything'] as const;
export type CoverageLevel = typeof COVERAGE_LEVELS[number];

/** Settings for one model ID, keeping user choices separate from discovered capabilities. */
export interface ModelSettings {
	id: string;
	/** User-selected level; 'default' omits the API parameter and uses the model's own default. */
	reasoningEffort: ModelReasoningEffort;
	/** Per-request output ceiling, including reasoning tokens where the provider counts them. */
	maxOutputTokens: number;
	/** 'auto' chooses a discovered working format or uses the adapter's format fallback. */
	outputMode: OutputMode;
	/** 'auto' uses discovered image support; 'yes' and 'no' explicitly override it. */
	acceptsImages: ImageOption;
	capabilities?: ModelCapabilities;
}

/** A configured provider. Only its Keychain secret name is saved here, never the key. */
export interface ProviderSettings {
	id: ProviderId;
	name: string;
	secretName: string;
	/** Saved per-model preferences, not a fixed catalogue; the selectable list comes from the provider. */
	models: ModelSettings[];
}

/** Model IDs are scoped to a provider so two services can expose the same ID safely. */
export interface ModelReference {
	providerId: ProviderId;
	modelId: string;
}

/** A user's replacement for the editable card-writing part of the prompt. */
export interface CardWritingInstructions {
	/** The full edited instructions as multi-line Markdown, kept verbatim (see `extraInstructions`).
	 * Fixed output-format instructions are stored elsewhere. */
	text: string;
	/** Version of the built-in instructions when editing began, for a future comparison view. */
	defaultVersion: string;
}

/**
 * Destination names for the generated front/back text. For Basic, front goes to
 * "Front" and back to "Back"; a custom type might call them "Prompt" and "Explanation".
 * The user selects these once in Anki settings when the standard fields are absent.
 */
export interface QuestionAnswerMapping {
	/** Existing Anki note type, such as Basic or a custom equivalent. */
	noteType: string | null;
	/** Field receiving the question/front text. */
	questionField: string | null;
	/** Field receiving the answer/back text. */
	answerField: string | null;
}

/** Exact Anki field names for a cloze entry, such as Text and Back Extra. */
export interface ClozeMapping {
	/** Existing cloze note type. Null means cloze generation has not been configured. */
	noteType: string | null;
	/** Field receiving text containing {{c1::...}} blanks. */
	textField: string | null;
	/** Optional field for an explanation revealed after answering; no source link is added. */
	extraField: string | null;
}

/** Versioned data.json layout. Raw disk data must pass normalizeSettings before use. */
export interface SettingsV1 {
	/** Schema version used for migration, independent of the plugin's release number. */
	settings_version: typeof SETTINGS_VERSION;
	providers: Record<ProviderId, ProviderSettings>;
	/** Starting selection for a run. Null until setup chooses one; no key availability is stored here. */
	defaultModel: ModelReference | null;
	cards: {
		/** Include supported image embeds from the note or selected text in generation. */
		sendDiagrams: boolean;
		/** Desired breadth of coverage; this is not a target number of cards. */
		coverageLevel: CoverageLevel;
		/** Standing preferences appended to the card-writing instructions on every generation.
		 * Multi-line Markdown, kept verbatim: never trimmed or collapsed to one line. Edit it in
		 * a multi-line text area and insert it into the prompt as-is, newlines included. */
		extraInstructions: string;
		// Absence means the current default. Reset removes the override, so future
		// improvements to the default reach users who have not edited their instructions.
		cardWritingInstructions?: CardWritingInstructions;
	};
	anki: {
		/** Complete AnkiConnect address, including a non-default port or path if needed. */
		url: string;
		// Empty until a live Anki lookup confirms the built-in types and field names,
		// or the user selects their own. Localised and renamed types are never guessed.
		questionAnswer: QuestionAnswerMapping;
		cloze: ClozeMapping;
		/** Target deck name with optional {{vault}}, {{folder}} and {{note}} placeholders. */
		deckTemplate: string;
		/** When false, add no tags and hide the tag-template setting. */
		tagCards: boolean;
		/** Space-separated tags, with deck placeholders plus {{provider}} and {{model}}. */
		tagTemplate: string;
	};
}

/** Fresh per-model defaults; choosing Model default leaves reasoning effort out of the request. */
export function createModelSettings(id: string): ModelSettings {
	return { id, reasoningEffort: 'default', maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, outputMode: OutputMode.Auto, acceptsImages: 'auto' };
}

function createProviderSettings(id: ProviderId): ProviderSettings {
	return { id, name: PROVIDER_PRESETS[id].name, secretName: providerSecretName(id), models: [] };
}

/** Create independent defaults for a new vault or for validating a saved settings file. */
export function createDefaultSettings(): SettingsV1 {
	// A factory prevents one vault, a test, or a settings page from mutating shared defaults.
	const providers = {} as Record<ProviderId, ProviderSettings>;
	for (const id of PROVIDER_IDS) providers[id] = createProviderSettings(id);
	return {
		settings_version: SETTINGS_VERSION,
		providers,
		defaultModel: null,
		cards: { sendDiagrams: true, coverageLevel: 'main-ideas-and-details', extraInstructions: '' },
		anki: {
			url: 'http://127.0.0.1:8765',
			questionAnswer: { noteType: null, questionField: null, answerField: null },
			cloze: { noteType: null, textField: null, extraField: null },
			deckTemplate: 'Obsidian::{{vault}}', tagCards: true, tagTemplate: 'auto-anki::{{provider}}::{{model}}',
		},
	};
}

/** Validate the AnkiConnect setting; protocol and credential rules belong to this setting. */
export function ankiUrl(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	try {
		const parsed = new URL(value.trim());
		return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? value.trim() : fallback;
	}
	catch {
		return fallback;
	}
}

function normalizeModel(value: unknown, providerId: ProviderId): ModelSettings | null {
	const stored = asRecord(value);
	const id = asNonEmptyString(stored.id)?.trim();
	if (!id) return null;
	const model = createModelSettings(id);
	const capabilities = normalizeModelCapabilities(stored.capabilities);
	if (capabilities) model.capabilities = capabilities;
	model.reasoningEffort = asOption(stored.reasoningEffort, getReasoningEffortsForModel(providerId, model), model.reasoningEffort);
	model.maxOutputTokens = positiveInteger(stored.maxOutputTokens, model.maxOutputTokens);
	model.outputMode = asOption(stored.outputMode, OUTPUT_MODES, model.outputMode);
	model.acceptsImages = asOption(stored.acceptsImages, IMAGE_OPTIONS, model.acceptsImages);
	return model;
}

export class NewerSettingsVersionError extends Error {
	constructor(version: number) {
		super(`These settings were saved by a newer Auto Anki version (settings version ${version}). Update Auto Anki before changing them.`);
		this.name = 'NewerSettingsVersionError';
	}
}

export function checkSettingsVersion(stored: Record<string, unknown>): void {
	if (typeof stored.settings_version === 'number' && stored.settings_version > SETTINGS_VERSION) {
		throw new NewerSettingsVersionError(stored.settings_version);
	}
}

/** Rebuild a validated copy from known fields, dropping arbitrary fields such as pasted API keys. */
export function normalizeSettings(value: unknown): SettingsV1 {
	const stored = asRecord(value);
	checkSettingsVersion(stored);
	const settings = createDefaultSettings();
	const savedProviders = asRecord(stored.providers);
	for (const id of PROVIDER_IDS) {
		const provider = settings.providers[id];
		const saved = asRecord(savedProviders[id]);
		provider.name = asNonEmptyString(saved.name) ?? provider.name;
		const models: unknown[] = Array.isArray(saved.models) ? saved.models : [];
		for (const item of models) {
			const model = normalizeModel(item, id);
			if (model && !provider.models.some(existing => existing.id === model.id)) provider.models.push(model);
		}
		// Never trust a synced secret name: provider IDs own the names in 1.0.
	}
	const selected = asRecord(stored.defaultModel);
	if (typeof selected.providerId === 'string' && PROVIDER_IDS.includes(selected.providerId as ProviderId)) {
		const selectedProvider = settings.providers[selected.providerId as ProviderId];
		if (selectedProvider.models.some(model => model.id === selected.modelId)) {
			settings.defaultModel = { providerId: selectedProvider.id, modelId: selected.modelId as string };
		}
	}

	// No saved override means the current built-in card-writing instructions. Store an
	// edit only with its original default version, so it can be compared after an update.
	const cards = asRecord(stored.cards);
	settings.cards.sendDiagrams = asBoolean(cards.sendDiagrams, settings.cards.sendDiagrams);
	settings.cards.coverageLevel = asOption(cards.coverageLevel, COVERAGE_LEVELS, settings.cards.coverageLevel);
	settings.cards.extraInstructions = asString(cards.extraInstructions, '');
	const instructions = asRecord(cards.cardWritingInstructions);
	if (typeof instructions.text === 'string' && asNonEmptyString(instructions.defaultVersion)) {
		settings.cards.cardWritingInstructions = { text: instructions.text, defaultVersion: instructions.defaultVersion as string };
	}

	// These are Anki note-type and field names, not card content. The live mapping
	// step checks that they still exist before any generated entry can be added.
	const anki = asRecord(stored.anki);
	settings.anki.url = ankiUrl(anki.url, settings.anki.url);
	const qa = asRecord(anki.questionAnswer);
	settings.anki.questionAnswer = { noteType: asNonEmptyString(qa.noteType), questionField: asNonEmptyString(qa.questionField), answerField: asNonEmptyString(qa.answerField) };
	const cloze = asRecord(anki.cloze);
	settings.anki.cloze = { noteType: asNonEmptyString(cloze.noteType), textField: asNonEmptyString(cloze.textField), extraField: asNonEmptyString(cloze.extraField) };
	settings.anki.deckTemplate = asNonEmptyString(anki.deckTemplate) ?? settings.anki.deckTemplate;
	settings.anki.tagCards = asBoolean(anki.tagCards, settings.anki.tagCards);
	settings.anki.tagTemplate = asString(anki.tagTemplate, settings.anki.tagTemplate);
	return settings;
}

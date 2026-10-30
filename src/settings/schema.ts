import { asBoolean, asNonEmptyString, asOption, asRecord, asString, positiveInteger } from '../utils/data';
import { PROVIDER_IDS, PROVIDER_NAMES, ProviderId, providerSecretName } from '../ai/providers';
import { normalizeModelCapabilities, type ModelCapabilities, type ModelReasoningEffort } from '../ai/models/metadata';
import { OUTPUT_MODES, OutputMode } from '../ai/generation';

export const SETTINGS_VERSION = 1;
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000;
export const DEFAULT_ANKI_URL = 'http://127.0.0.1:8765';
export const IMAGE_OPTIONS = ['auto', 'yes', 'no'] as const;
type ImageOption = typeof IMAGE_OPTIONS[number];
export const COVERAGE_LEVELS = ['key-ideas', 'main-ideas-and-details', 'everything'] as const;
export type CoverageLevel = typeof COVERAGE_LEVELS[number];

/** Settings for one model ID, keeping user choices separate from discovered capabilities. */
export interface ModelSettings {
	id: string;
	/** Show this model in the normal picker. Hiding it keeps its per-model settings. */
	enabled: boolean;
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
	/** Models the user has added, including hidden ones. Discovery is kept separately. */
	models: ModelSettings[];
}

/** Model IDs are scoped to a provider so two services can expose the same ID safely. */
export interface ModelReference {
	providerId: ProviderId;
	modelId: string;
}

/** A user's replacement for the editable note-writing part of the prompt. */
export interface NoteWritingInstructions {
	/** The full edited instructions as multi-line Markdown, kept verbatim (see `extraInstructions`).
	 * Fixed output-format instructions are stored elsewhere. */
	text: string;
	/** Version of the built-in instructions when editing began, for a future comparison view. */
	defaultVersion: string;
}

/** Versioned data.json layout. Raw disk data must pass normalizeSettings before use. */
export interface PluginSettings {
	/** Schema version used for migration, independent of the plugin's release number. */
	settings_version: typeof SETTINGS_VERSION;
	providers: Record<ProviderId, ProviderSettings>;
	/** Starting selection for a run. Null until setup chooses one; no key availability is stored here. */
	defaultModel: ModelReference | null;
	/** Generation preferences for the Anki notes written from Obsidian notes. */
	notes: {
		/** Include supported image embeds from the note or selected text in generation. */
		sendDiagrams: boolean;
		/** Desired breadth of coverage; this is not a target number of Anki notes. */
		coverageLevel: CoverageLevel;
		/** Standing preferences appended to the note-writing instructions on every generation.
		 * Multi-line Markdown, kept verbatim: never trimmed or collapsed to one line. Edit it in
		 * a multi-line text area and insert it into the prompt as-is, newlines included. */
		extraInstructions: string;
		// Absence means the current default. Reset removes the override, so future
		// improvements to the default reach users who have not edited their instructions.
		/** The user’s edited note-writing guidance. */
		noteWritingInstructions?: NoteWritingInstructions;
	};
	anki: {
		/** Complete AnkiConnect address, including a non-default port or path if needed. */
		url: string;
		/** Existing note-type names the AI may use. Missing types retain their selection. */
		enabledNoteTypes: string[];
		/** Existing Anki deck that starts selected in the export dialog. If Anki no longer has it, Anki's Default deck is used. */
		defaultDeck: string;
		/** When false, add no tags to Anki notes and hide the tag-template setting. */
		tagNotes: boolean;
		/** Space-separated tags, with deck placeholders plus {{provider}} and {{model}}. */
		tagTemplate: string;
	};
}

/** Fresh per-model defaults; choosing Model default leaves reasoning effort out of the request. */
export function createModelSettings(id: string): ModelSettings {
	return { id, enabled: true, reasoningEffort: 'default', maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, outputMode: OutputMode.Auto, acceptsImages: 'auto' };
}

function createProviderSettings(id: ProviderId): ProviderSettings {
	return { id, name: PROVIDER_NAMES[id], secretName: providerSecretName(id), models: [] };
}

/** Create independent defaults for a new vault or for validating a saved settings file. */
export function createDefaultSettings(): PluginSettings {
	// A factory prevents one vault, a test, or a settings page from mutating shared defaults.
	const providers = {} as Record<ProviderId, ProviderSettings>;
	for (const id of PROVIDER_IDS) providers[id] = createProviderSettings(id);
	return {
		settings_version: SETTINGS_VERSION,
		providers,
		defaultModel: null,
		notes: { sendDiagrams: true, coverageLevel: 'main-ideas-and-details', extraInstructions: '' },
		anki: {
			url: DEFAULT_ANKI_URL,
			enabledNoteTypes: ['Basic', 'Cloze'],
			defaultDeck: 'Default', tagNotes: true, tagTemplate: 'auto-anki::{{provider}}::{{model}}',
		},
	};
}

/** Validate the AnkiConnect setting; protocol and credential rules belong to this setting. */
export function ankiUrl(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim();
	try {
		const parsed = new URL(trimmed);
		return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? trimmed : fallback;
	}
	catch {
		return fallback;
	}
}

function normalizeModel(value: unknown): ModelSettings | null {
	const stored = asRecord(value);
	const id = typeof stored.id === 'string' ? stored.id.trim() : '';
	if (!id) return null;
	const model = createModelSettings(id);
	// A model is shown unless it was explicitly hidden.
	model.enabled = asBoolean(stored.enabled, true);
	const capabilities = normalizeModelCapabilities(stored.capabilities);
	if (capabilities) model.capabilities = capabilities;
	// Loading never resets a saved level: what a model accepts may be unknown offline or change
	// later. Choices are checked when made, and a provider rejection names the setting.
	model.reasoningEffort = asString(stored.reasoningEffort, '').trim() || model.reasoningEffort;
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
export function normalizeSettings(value: unknown): PluginSettings {
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
			const model = normalizeModel(item);
			if (model && !provider.models.some(existing => existing.id === model.id)) provider.models.push(model);
		}
		// Never trust a synced secret name: provider IDs own the names in 1.0.
	}
	const selected = asRecord(stored.defaultModel);
	if (typeof selected.providerId === 'string' && PROVIDER_IDS.includes(selected.providerId as ProviderId)) {
		const selectedProvider = settings.providers[selected.providerId as ProviderId];
		if (selectedProvider.models.some(model => model.id === selected.modelId && model.enabled)) {
			settings.defaultModel = { providerId: selectedProvider.id, modelId: selected.modelId as string };
		}
	}

	// No saved override means the current built-in note-writing instructions. Store an
	// edit only with its original default version, so it can be compared after an update.
	const preferences = asRecord(stored.notes);
	settings.notes.sendDiagrams = asBoolean(preferences.sendDiagrams, settings.notes.sendDiagrams);
	settings.notes.coverageLevel = asOption(preferences.coverageLevel, COVERAGE_LEVELS, settings.notes.coverageLevel);
	settings.notes.extraInstructions = asString(preferences.extraInstructions, '');
	const instructions = asRecord(preferences.noteWritingInstructions);
	if (typeof instructions.text === 'string' && asNonEmptyString(instructions.defaultVersion)) {
		settings.notes.noteWritingInstructions = { text: instructions.text, defaultVersion: instructions.defaultVersion as string };
	}

	const anki = asRecord(stored.anki);
	settings.anki.url = ankiUrl(anki.url, settings.anki.url);
	if (Array.isArray(anki.enabledNoteTypes)) {
		settings.anki.enabledNoteTypes = [...new Set(anki.enabledNoteTypes.filter((name): name is string => typeof name === 'string' && !!name.trim()))];
	}
	settings.anki.defaultDeck = asNonEmptyString(anki.defaultDeck) ?? settings.anki.defaultDeck;
	settings.anki.tagNotes = asBoolean(anki.tagNotes, settings.anki.tagNotes);
	settings.anki.tagTemplate = asString(anki.tagTemplate, settings.anki.tagTemplate);
	return settings;
}

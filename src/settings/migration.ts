import type { App } from 'obsidian';
import { KeyMigrationResult, LegacyKeyFields, migrateLegacyApiKey } from '../utils/api-key';
import { LEGACY_DEFAULT_ANKI_PORT, LEGACY_DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_DEFAULT_OPENAI_MODEL, migrateLegacyGenerationOptions } from './legacy';
import { PluginSettings, SETTINGS_VERSION, checkSettingsVersion, createDefaultSettings, createModelSettings, normalizeSettings } from './schema';
import { asRecord, asString, positiveInteger } from '../utils/data';

export interface PreparedSettings {
	settings: PluginSettings;
	// A failed key move is the sole exception to writing no secrets. Keep the original
	// legacy fields on EVERY save until a later load can verify the Keychain write.
	pendingLegacyKey: LegacyKeyFields;
	keyMigration: KeyMigrationResult;
	hadCustomSampling: boolean;
	migrated: boolean;
}

function migrateOldSettings(stored: Record<string, unknown>): PluginSettings {
	const settings = createDefaultSettings();

	// 0.x had a single OpenAI model. It stays the default, with its customised settings.
	const modelId = asString(stored.openAiModel, '').trim() || LEGACY_DEFAULT_OPENAI_MODEL;
	const generation = asRecord(stored.generation);
	const model = createModelSettings(modelId);
	model.reasoningEffort = asString(generation.reasoningEffort, '').trim() || model.reasoningEffort;
	const oldLimit = positiveInteger(generation.maxOutputTokens, LEGACY_DEFAULT_MAX_OUTPUT_TOKENS);
	if (oldLimit !== LEGACY_DEFAULT_MAX_OUTPUT_TOKENS) model.maxOutputTokens = oldLimit;
	settings.providers.openai.models.push(model);
	settings.defaultModel = { providerId: 'openai', modelId };

	const port = positiveInteger(stored.ankiConnectPort, LEGACY_DEFAULT_ANKI_PORT);
	settings.anki.url = `http://127.0.0.1:${port <= 65535 ? port : LEGACY_DEFAULT_ANKI_PORT}`;
	if (typeof stored.ankiDestinationDeck === 'string' && stored.ankiDestinationDeck.trim()) {
		settings.anki.deckTemplate = stored.ankiDestinationDeck;
	}
	return settings;
}

// This is shared by startup and, later, onExternalSettingsChange. Legacy keys are
// checked even for the current schema: an older computer can sync one back in.
// No disk writes occur here; callers persist settingsData(result) after success.
export function prepareSettings(app: App, value: unknown): PreparedSettings {
	const stored = { ...asRecord(value) };
	checkSettingsVersion(stored);
	const hadStoredFields = Object.keys(stored).length > 0;
	const keyMigration = migrateLegacyApiKey(app, stored);
	const generationMigration = migrateLegacyGenerationOptions(stored);
	const settings = stored.settings_version === SETTINGS_VERSION ? normalizeSettings(stored)
		: hadStoredFields ? migrateOldSettings(stored) : createDefaultSettings();
	const pendingLegacyKey: LegacyKeyFields = {};
	if ('openAiApiKey' in stored) pendingLegacyKey.openAiApiKey = stored.openAiApiKey as LegacyKeyFields['openAiApiKey'];
	if ('openAiApiKeyIdentifier' in stored) pendingLegacyKey.openAiApiKeyIdentifier = stored.openAiApiKeyIdentifier as string;
	return {
		settings, pendingLegacyKey, keyMigration,
		hadCustomSampling: generationMigration.hadCustomSampling,
		migrated: (value !== undefined && value !== null && hadStoredFields && stored.settings_version !== SETTINGS_VERSION)
			|| generationMigration.removed || ['moved', 'kept-keychain', 'cleaned'].includes(keyMigration),
	};
}

export function settingsData(prepared: PreparedSettings): PluginSettings & LegacyKeyFields {
	return { ...normalizeSettings(prepared.settings), ...prepared.pendingLegacyKey };
}

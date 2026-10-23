import type { App } from 'obsidian';
import { PROVIDER_PRESETS } from '../ai/presets';
import { migrateLegacyGenerationOptions } from '../settings';
import { KeyMigrationResult, LegacyKeyFields, migrateLegacyApiKey } from '../utils/api-key';
import { LEGACY_DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_DEFAULT_OPENAI_MODEL } from './legacy-defaults';
import { SettingsV1, checkSettingsVersion, createDefaultSettings, createModelSettings, normalizeSettings } from './model';
import { asRecord, positiveInteger } from '../utils/data';

export interface PreparedSettings {
	settings: SettingsV1;
	// A failed key move is the sole exception to writing no secrets. Keep the original
	// legacy fields on EVERY save until a later load can verify the Keychain write.
	pendingLegacyKey: LegacyKeyFields;
	keyMigration: KeyMigrationResult;
	hadCustomSampling: boolean;
	migrated: boolean;
}

function migrateOldSettings(stored: Record<string, unknown>): SettingsV1 {
	const settings = createDefaultSettings();
	const provider = settings.providers.openai;
	const suggestedId = PROVIDER_PRESETS.openai.suggestedModel;
	const suggested = createModelSettings(suggestedId);
	provider.models.push(suggested);
	settings.defaultModel = { providerId: 'openai', modelId: suggestedId };

	// 0.x → 1.0 intentionally changes the default model. Retain customised settings
	// on the old model so selecting it later is possible, without applying settings
	// intended for that model to a different one.
	const previousId = typeof stored.openAiModel === 'string' && stored.openAiModel.trim() ? stored.openAiModel.trim() : LEGACY_DEFAULT_OPENAI_MODEL;
	const generation = asRecord(stored.generation);
	const previous = createModelSettings(previousId);
	if (PROVIDER_PRESETS.openai.fallbacks.reasoningEfforts.includes(generation.reasoningEffort as typeof previous.reasoningEffort)) {
		previous.reasoningEffort = generation.reasoningEffort as typeof previous.reasoningEffort;
	}
	const oldLimit = positiveInteger(generation.maxOutputTokens, LEGACY_DEFAULT_MAX_OUTPUT_TOKENS);
	if (oldLimit !== LEGACY_DEFAULT_MAX_OUTPUT_TOKENS) previous.maxOutputTokens = oldLimit;
	if (previousId === suggestedId) provider.models[0] = previous;
	else if (previous.reasoningEffort !== 'default' || oldLimit !== LEGACY_DEFAULT_MAX_OUTPUT_TOKENS) provider.models.push(previous);

	const port = positiveInteger(stored.ankiConnectPort, 8765);
	settings.anki.url = `http://127.0.0.1:${port <= 65535 ? port : 8765}`;
	if (typeof stored.ankiDestinationDeck === 'string' && stored.ankiDestinationDeck.trim()) {
		settings.anki.deckTemplate = stored.ankiDestinationDeck;
	}
	return settings;
}

// This is shared by startup and, later, onExternalSettingsChange. Legacy keys are
// checked even for settings_version: 1: an older computer can sync one back in.
// No disk writes occur here; callers persist settingsData(result) after success.
export function prepareSettings(app: App, value: unknown): PreparedSettings {
	const stored = { ...asRecord(value) };
	checkSettingsVersion(stored);
	const hadStoredFields = Object.keys(stored).length > 0;
	const keyMigration = migrateLegacyApiKey(app, stored);
	const generationMigration = migrateLegacyGenerationOptions(stored);
	const settings = stored.settings_version === 1 ? normalizeSettings(stored)
		: hadStoredFields ? migrateOldSettings(stored) : createDefaultSettings();
	const pendingLegacyKey: LegacyKeyFields = {};
	if ('openAiApiKey' in stored) pendingLegacyKey.openAiApiKey = stored.openAiApiKey as LegacyKeyFields['openAiApiKey'];
	if ('openAiApiKeyIdentifier' in stored) pendingLegacyKey.openAiApiKeyIdentifier = stored.openAiApiKeyIdentifier as string;
	return {
		settings, pendingLegacyKey, keyMigration,
		hadCustomSampling: generationMigration.hadCustomSampling,
		migrated: (value !== undefined && value !== null && hadStoredFields && stored.settings_version !== 1)
			|| generationMigration.removed || ['moved', 'kept-keychain', 'cleaned'].includes(keyMigration),
	};
}

export function settingsData(prepared: PreparedSettings): SettingsV1 & LegacyKeyFields {
	return { ...normalizeSettings(prepared.settings), ...prepared.pendingLegacyKey };
}

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS, providerSecretName } from '../src/ai/presets';
import { createDefaultSettings, createModelSettings, normalizeSettings, NewerSettingsVersionError } from '../src/settings/model';
import { getReasoningEffortsForModel } from '../src/ai/model-info';
import { LEGACY_DEFAULT_MAX_OUTPUT_TOKENS, LEGACY_DEFAULT_OPENAI_MODEL } from '../src/settings/legacy-defaults';
import { readProviderModelInfo } from '../src/ai/model-discovery';
import { prepareSettings, settingsData } from '../src/settings/migration';
import { makeKeychain } from './helpers.mjs';

const SECRET = providerSecretName('openai');
const KEY = 'old-openai-test-key';
const SUGGESTED_MODEL = PROVIDER_PRESETS.openai.suggestedModel;
const OLD_MODEL = 'previous-user-selected-model';

function app(keychain = makeKeychain()) {
	return keychain === null ? {} : { secretStorage: keychain };
}

function legacy(overrides = {}) {
	return {
		ankiConnectPort: 8765, ankiDestinationDeck: '', openAiModel: OLD_MODEL,
		generation: { reasoningEffort: 'default', maxOutputTokens: 16000 },
		questionGenerationDefaults: { file: { numQuestions: 5, numAlternatives: 0 }, textSelection: { numQuestions: 1, numAlternatives: 0 } },
		...overrides,
	};
}

describe('1.0 settings defaults and validation', () => {
	test('fresh installs list both providers without declaring a device connected or choosing a model', () => {
		const prepared = prepareSettings(app(), undefined);
		assert.equal(prepared.migrated, false);
		assert.equal(prepared.settings.defaultModel, null);
		assert.deepEqual(Object.values(prepared.settings.providers).map(p => [p.id, p.secretName, p.models]), [
			['openai', SECRET, []], ['anthropic', 'auto-anki-anthropic-api-key', []],
		]);
		assert.equal(prepared.settings.anki.tagCards, true);
		assert.equal(prepared.settings.cards.coverageLevel, 'main-ideas-and-details');
		assert.ok(!('cardWritingInstructions' in prepared.settings.cards));
		assert.ok(!('linkToNote' in prepared.settings.anki));
	});

	for (const invalid of [undefined, null, [], 'text', 3, true]) {
		test(`invalid root (${JSON.stringify(invalid)}) uses defaults`, () => {
			assert.deepEqual(normalizeSettings(invalid), createDefaultSettings());
		});
	}

	test('defaults and normalised values share no nested objects', () => {
		const first = createDefaultSettings();
		const second = createDefaultSettings();
		const loaded = normalizeSettings(first);
		loaded.providers.openai.models.push(createModelSettings('manual-model'));
		loaded.anki.cloze.extraField = 'Extra';
		loaded.cards.extraInstructions = 'Preference';
		assert.deepEqual(first, second);
		first.providers.openai.name = 'Changed';
		assert.equal(second.providers.openai.name, 'OpenAI');
	});

	test('invalid nested fields fall back independently, preserving valid siblings', () => {
		const settings = normalizeSettings({
			settings_version: 1,
			cards: { sendDiagrams: 'yes', coverageLevel: 'invented', extraInstructions: 'British spelling' },
			anki: { url: 'file:///vault/private', questionAnswer: [], cloze: null, deckTemplate: '  ', tagCards: false, tagTemplate: 123 },
		});
		assert.equal(settings.cards.sendDiagrams, true);
		assert.equal(settings.cards.coverageLevel, 'main-ideas-and-details');
		assert.equal(settings.cards.extraInstructions, 'British spelling');
		assert.equal(settings.anki.url, 'http://127.0.0.1:8765');
		assert.equal(settings.anki.deckTemplate, 'Obsidian::{{vault}}');
		assert.equal(settings.anki.tagCards, false);
		assert.equal(settings.anki.tagTemplate, 'auto-anki::{{provider}}::{{model}}');
	});

	test('user mappings and instruction edits survive a round trip exactly', () => {
		const settings = createDefaultSettings();
		settings.cards.cardWritingInstructions = { text: 'My own instructions\n', defaultVersion: '1.0.0' };
		settings.cards.extraInstructions = '## Style\n\n- British spelling\n- Keep answers **short**\r\n\n';
		settings.anki.questionAnswer = { noteType: '基本', questionField: 'Question', answerField: 'Answer' };
		settings.anki.cloze = { noteType: '穴埋め', textField: 'Text', extraField: 'Explanation' };
		settings.anki.url = 'https://my-anki.example/api';
		settings.anki.deckTemplate = 'My deck';
		settings.anki.tagCards = false;
		settings.anki.tagTemplate = '';
		const result = normalizeSettings(JSON.parse(JSON.stringify(settings)));
		assert.deepEqual(result, settings);
		result.cards.cardWritingInstructions.text = 'Changed';
		assert.equal(settings.cards.cardWritingInstructions.text, 'My own instructions\n');
	});

	test('an incomplete instruction override is discarded instead of being treated as a user edit', () => {
		assert.ok(!('cardWritingInstructions' in normalizeSettings({ cards: { cardWritingInstructions: { text: 'lost metadata' } } }).cards));
	});

	test('model IDs are unrestricted, scoped to providers, deduplicated, and validated without version-name rules', () => {
		const saved = createDefaultSettings();
		saved.providers.openai.models = [
			{ ...createModelSettings('future-model-123'), reasoningEffort: 'minimal' },
			createModelSettings('future-model-123'), { id: '' }, null,
		];
		saved.providers.anthropic.models = [{ ...createModelSettings('future-model-123'), reasoningEffort: 'minimal', maxOutputTokens: 4.5 }];
		saved.defaultModel = { providerId: 'anthropic', modelId: 'future-model-123' };
		const settings = normalizeSettings(saved);
		assert.equal(settings.providers.openai.models.length, 1);
		assert.equal(settings.providers.openai.models[0].reasoningEffort, 'minimal');
		assert.equal(settings.providers.anthropic.models[0].reasoningEffort, 'default');
		assert.equal(settings.providers.anthropic.models[0].maxOutputTokens, 25000);
		assert.deepEqual(settings.defaultModel, saved.defaultModel);
	});

	for (const limit of [-1, 0, 1.2, '3000', null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		test(`invalid token limit (${String(limit)}) uses 25000`, () => {
			const saved = createDefaultSettings();
			saved.providers.openai.models.push({ id: 'any', maxOutputTokens: limit });
			assert.equal(normalizeSettings(saved).providers.openai.models[0].maxOutputTokens, 25000);
		});
	}

	test('capabilities and manual overrides remain separate, and malformed learned results are discarded', () => {
		const saved = createDefaultSettings();
		saved.providers.openai.models = [
			{ ...createModelSettings('valid'), outputMode: 'json', acceptsImages: 'no', capabilities: { outputMode: 'json_schema', acceptsImages: true } },
			{ id: 'invalid', outputMode: 'broken', acceptsImages: true, capabilities: { outputMode: 'auto', acceptsImages: true } },
		];
		const [valid, invalid] = normalizeSettings(saved).providers.openai.models;
		assert.equal(valid.outputMode, 'json');
		assert.equal(valid.acceptsImages, 'no');
		assert.deepEqual(valid.capabilities, { outputMode: 'json_schema', acceptsImages: true });
		assert.equal(invalid.outputMode, 'auto');
		assert.equal(invalid.acceptsImages, 'auto');
		assert.deepEqual(invalid.capabilities, { acceptsImages: true });
	});

	test('a missing default-model reference does not silently select a different provider', () => {
		assert.equal(normalizeSettings({ defaultModel: { providerId: 'openai', modelId: 'missing' } }).defaultModel, null);
	});

	test('saved models without a visibility setting stay enabled, while explicit hidden models retain their settings', () => {
		const settings = createDefaultSettings();
		settings.providers.openai.models = [
			{ id: 'previously-saved', maxOutputTokens: 8000 },
			{ ...createModelSettings('hidden'), enabled: false, maxOutputTokens: 6000 },
		];
		settings.defaultModel = { providerId: 'openai', modelId: 'hidden' };
		const result = normalizeSettings(settings);
		assert.equal(result.providers.openai.models[0].enabled, true);
		assert.equal(result.providers.openai.models[0].maxOutputTokens, 8000);
		assert.equal(result.providers.openai.models[1].enabled, false);
		assert.equal(result.providers.openai.models[1].maxOutputTokens, 6000);
		assert.equal(result.defaultModel, null, 'a hidden model cannot remain the default');
		assert.deepEqual(normalizeSettings(result), result);
	});

	test('malformed JSON objects in capability fields cannot throw during validation', () => {
		const saved = createDefaultSettings();
		saved.providers.openai.models.push({ id: 'bad-shape', capabilities: { outputMode: { toString: 123 }, acceptsImages: true } });
		assert.deepEqual(normalizeSettings(saved).providers.openai.models[0].capabilities, { acceptsImages: true });
	});

	test('saved secret names, endpoints, and unknown key fields cannot redirect or leak provider credentials', () => {
		const saved = createDefaultSettings();
		saved.providers.openai = { ...saved.providers.openai, secretName: 'other-plugin-key', baseUrl: 'https://untrusted.example', apiKey: KEY };
		saved.apiKey = KEY;
		const settings = normalizeSettings(saved);
		assert.equal(settings.providers.openai.secretName, SECRET);
		assert.ok(!JSON.stringify(settings).includes(KEY));
		assert.ok(!('baseUrl' in settings.providers.openai));
	});
});

describe('provider-reported model capabilities', () => {
	test('Claude effort levels come from metadata, including a new level absent from the fallback', () => {
		const info = readProviderModelInfo('anthropic', {
			id: 'future-claude', display_name: 'Future Claude',
			capabilities: {
				effort: { supported: true, low: { supported: true }, high: { supported: false }, new_level: { supported: true } },
				image_input: { supported: true }, structured_outputs: { supported: true },
			},
		});
		assert.equal(info.displayName, 'Future Claude');
		assert.deepEqual(info.capabilities, { outputMode: 'json_schema', acceptsImages: true, reasoningEfforts: ['low', 'new_level'] });
		assert.deepEqual(getReasoningEffortsForModel('anthropic', info), ['default', 'low', 'new_level']);
		const saved = createDefaultSettings();
		saved.providers.anthropic.models.push({ ...createModelSettings(info.id), capabilities: info.capabilities, reasoningEffort: 'new_level' });
		const reloaded = normalizeSettings(JSON.parse(JSON.stringify(saved)));
		assert.equal(reloaded.providers.anthropic.models[0].reasoningEffort, 'new_level');
		info.capabilities.reasoningEfforts.push('another_level');
		assert.deepEqual(reloaded.providers.anthropic.models[0].capabilities.reasoningEfforts, ['low', 'new_level']);
	});

	test('Claude explicitly reporting no effort support offers only Model default', () => {
		const info = readProviderModelInfo('anthropic', { id: 'no-reasoning', capabilities: { effort: { supported: false, high: { supported: true } } } });
		assert.deepEqual(getReasoningEffortsForModel('anthropic', info), ['default']);
		const saved = createDefaultSettings();
		saved.providers.anthropic.models.push({ ...createModelSettings(info.id), capabilities: info.capabilities, reasoningEffort: 'high' });
		assert.equal(normalizeSettings(saved).providers.anthropic.models[0].reasoningEffort, 'default');
	});

	test('missing Claude effort metadata uses the fallback without claiming to have discovered it', () => {
		const info = readProviderModelInfo('anthropic', { id: 'metadata-unavailable', capabilities: null });
		assert.ok(!('capabilities' in info));
		assert.deepEqual(getReasoningEffortsForModel('anthropic', info), PROVIDER_PRESETS.anthropic.fallbacks.reasoningEfforts);
	});

	test('unknown or malformed individual capabilities do not invent support', () => {
		const info = readProviderModelInfo('anthropic', {
			id: 'partial', capabilities: { image_input: { supported: false }, structured_outputs: { supported: false }, effort: { supported: true, low: { supported: 'yes' } } },
		});
		assert.deepEqual(info.capabilities, { acceptsImages: false });
		assert.deepEqual(getReasoningEffortsForModel('anthropic', info), PROVIDER_PRESETS.anthropic.fallbacks.reasoningEfforts);
	});

	test('OpenAI model identity has no documented effort metadata, so protocol fallback choices apply', () => {
		const info = readProviderModelInfo('openai', { id: 'future-openai', created: 123, owned_by: 'openai' });
		assert.deepEqual(info, { id: 'future-openai', displayName: 'future-openai' });
		assert.deepEqual(getReasoningEffortsForModel('openai', info), PROVIDER_PRESETS.openai.fallbacks.reasoningEfforts);
	});

	test('malformed provider records and corrupt cached effort lists are safe to read', () => {
		for (const value of [null, [], true, { id: '' }, { id: 1 }]) assert.equal(readProviderModelInfo('anthropic', value), null);
		const saved = createDefaultSettings();
		saved.providers.anthropic.models.push({ id: 'bad-efforts', capabilities: { reasoningEfforts: ['high', 3] } });
		assert.ok(!('capabilities' in normalizeSettings(saved).providers.anthropic.models[0]));
	});
});

describe('0.x → 1.0 settings migration', () => {
	test('0.3 upgrades select the new suggested model even if a different model was selected before', () => {
		const source = legacy();
		const prepared = prepareSettings(app(), source);
		assert.equal(prepared.migrated, true);
		assert.deepEqual(prepared.settings.defaultModel, { providerId: 'openai', modelId: SUGGESTED_MODEL });
		assert.equal(prepared.settings.providers.openai.models[0].maxOutputTokens, 25000);
		assert.ok(!('questionGenerationDefaults' in settingsData(prepared)));
		assert.equal(source.openAiModel, OLD_MODEL, 'migration must not mutate its input');
	});

	test('custom settings stay on their previous model, leaving a different new default at its own defaults', () => {
		const prepared = prepareSettings(app(), legacy({ generation: { reasoningEffort: 'low', maxOutputTokens: 8000 } }));
		const [suggested, previous] = prepared.settings.providers.openai.models;
		assert.equal(suggested.reasoningEffort, 'default');
		assert.equal(suggested.maxOutputTokens, 25000);
		assert.equal(previous.id, OLD_MODEL);
		assert.equal(previous.reasoningEffort, 'low');
		assert.equal(previous.maxOutputTokens, 8000);
	});

	test('custom settings carry over when the previous model is also the suggested model', () => {
		const prepared = prepareSettings(app(), legacy({ openAiModel: SUGGESTED_MODEL, generation: { reasoningEffort: 'high', maxOutputTokens: 9000 } }));
		assert.equal(prepared.settings.providers.openai.models.length, 1);
		assert.equal(prepared.settings.providers.openai.models[0].maxOutputTokens, 9000);
		assert.equal(prepared.settings.providers.openai.models[0].reasoningEffort, 'high');
	});

	test('a missing legacy model is interpreted using its historical default and keeps its custom settings', () => {
		const prepared = prepareSettings(app(), legacy({ openAiModel: undefined, generation: { reasoningEffort: 'low', maxOutputTokens: LEGACY_DEFAULT_MAX_OUTPUT_TOKENS } }));
		const previous = prepared.settings.providers.openai.models.find(model => model.id === LEGACY_DEFAULT_OPENAI_MODEL);
		assert.ok(previous);
		assert.equal(previous.reasoningEffort, 'low');
		assert.equal(previous.maxOutputTokens, 25000);
	});

	for (const port of [-1, 0, 1.5, 65536, '8765']) {
		test(`invalid legacy port (${String(port)}) falls back safely`, () => {
			assert.equal(prepareSettings(app(), legacy({ ankiConnectPort: port })).settings.anki.url, 'http://127.0.0.1:8765');
		});
	}

	test('changed deck and port carry over; counts, alternatives and invalid generation settings are removed', () => {
		const prepared = prepareSettings(app(), legacy({ ankiConnectPort: 9999, ankiDestinationDeck: 'Biology', generation: 'bad' }));
		assert.equal(prepared.settings.anki.url, 'http://127.0.0.1:9999');
		assert.equal(prepared.settings.anki.deckTemplate, 'Biology');
		assert.ok(!('generation' in settingsData(prepared)));
		assert.ok(!('openAiModel' in settingsData(prepared)));
	});

	test('direct 0.1/0.2 upgrade moves the key and drops customised sampling first', () => {
		const keychain = makeKeychain();
		const source = { ...legacy(), openAiApiKey: KEY, openAiApiKeyIdentifier: 'masked', gptAdvancedOptions: { temperature: 0.4 } };
		const prepared = prepareSettings(app(keychain), source);
		assert.equal(prepared.keyMigration, 'moved');
		assert.equal(prepared.hadCustomSampling, true);
		assert.equal(keychain.secrets.get(SECRET), KEY);
		assert.ok(!JSON.stringify(settingsData(prepared)).includes(KEY));
		assert.ok(!('gptAdvancedOptions' in settingsData(prepared)));
		assert.equal(source.openAiApiKey, KEY);
	});

	test('a legacy file containing only a key still gets an OpenAI default after migration', () => {
		assert.equal(prepareSettings(app(), { openAiApiKey: KEY }).settings.defaultModel.modelId, SUGGESTED_MODEL);
	});

	for (const mode of ['ignores-writes', 'throws-on-write', 'throws', 'missing']) {
		test(`Keychain ${mode}: the old key survives settings saves, a restart, and a later successful migration`, () => {
			const device = app(mode === 'missing' ? null : makeKeychain(mode));
			const prepared = prepareSettings(device, { ...legacy(), openAiApiKey: KEY, openAiApiKeyIdentifier: 'masked' });
			assert.equal(prepared.keyMigration, mode === 'missing' ? 'unavailable' : 'failed');
			prepared.settings.cards.extraInstructions = 'Changed in settings';
			const saved = settingsData(prepared);
			assert.equal(saved.openAiApiKey, KEY);
			const restart = prepareSettings(device, JSON.parse(JSON.stringify(saved)));
			assert.equal(settingsData(restart).openAiApiKey, KEY);
			const workingKeychain = makeKeychain();
			const recovered = prepareSettings(app(workingKeychain), settingsData(restart));
			assert.equal(workingKeychain.secrets.get(SECRET), KEY);
			assert.ok(!('openAiApiKey' in settingsData(recovered)));
			assert.equal(recovered.settings.cards.extraInstructions, 'Changed in settings');
		});
	}

	test('a different existing device key wins and is never copied or overwritten', () => {
		const keychain = makeKeychain('ok', { [SECRET]: 'this-device-key' });
		const prepared = prepareSettings(app(keychain), { ...legacy(), openAiApiKey: KEY });
		assert.equal(prepared.keyMigration, 'kept-keychain');
		assert.equal(keychain.calls.set, 0);
		assert.ok(!('openAiApiKey' in settingsData(prepared)));
	});

	test('two computers use their existing secrets under the same name, with no key copying', () => {
		const a = makeKeychain('ok', { [SECRET]: 'device-A-key' });
		const b = makeKeychain('ok', { [SECRET]: 'device-B-key' });
		const sharedData = settingsData(prepareSettings(app(a), legacy()));
		const second = prepareSettings(app(b), sharedData);
		assert.equal(second.migrated, false);
		assert.equal(second.settings.providers.openai.secretName, SECRET);
		assert.equal(a.calls.set + b.calls.set, 0);
		assert.equal(b.secrets.get(SECRET), 'device-B-key');
	});

	test('a legacy key synced back into 1.0 data is migrated without resetting the selected model', () => {
		const saved = createDefaultSettings();
		saved.providers.anthropic.models.push(createModelSettings('new-claude-model'));
		saved.defaultModel = { providerId: 'anthropic', modelId: 'new-claude-model' };
		const prepared = prepareSettings(app(), { ...saved, openAiApiKey: KEY });
		assert.equal(prepared.keyMigration, 'moved');
		assert.deepEqual(prepared.settings.defaultModel, saved.defaultModel);
		assert.ok(!('openAiApiKey' in settingsData(prepared)));
	});

	test('1.0 reloads preserve selected models and are idempotent', () => {
		const first = prepareSettings(app(), legacy());
		first.settings.providers.openai.models.push(createModelSettings('later-model'));
		first.settings.defaultModel = { providerId: 'openai', modelId: 'later-model' };
		const saved = settingsData(first);
		const second = prepareSettings(app(), JSON.parse(JSON.stringify(saved)));
		assert.deepEqual(settingsData(second), saved);
		assert.equal(second.migrated, false);
	});

	test('a newer settings version is rejected before touching the Keychain or producing replacement data', () => {
		const keychain = makeKeychain();
		assert.throws(() => prepareSettings(app(keychain), { settings_version: 2, openAiApiKey: KEY }), NewerSettingsVersionError);
		assert.equal(keychain.calls.get + keychain.calls.set, 0);
	});
});

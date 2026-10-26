// Drive the running plugin through native settings definitions, Keychain and disk.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, settingsIn, buttonsIn } from 'obsidian';
import { createDefaultSettings, createModelSettings } from '../src/settings/model';
import { PROVIDER_PRESETS } from '../src/ai/presets';
import { MODEL_CATALOG_URL } from '../src/ai/model-catalog';
import {
	SECRET_ID, DATA_0_2_2, MANIFEST, makeDisk, makeKeychain, makeDevice, loadPlugin,
	readDataJson, openSettings, openProviderSettings, resetAll, flush, run,
} from './helpers.mjs';

const KEY = 'sk-proj-ENTERED22222222222222222222222222222222zZ99';
const CLAUDE_SECRET = 'auto-anki-anthropic-api-key';
const cachePath = `${MANIFEST.dir}/model-catalog-cache.json`;
const row = (tab, name) => {
	const found = settingsIn(tab.containerEl).find(setting => setting.name === name);
	assert.ok(found, `no setting: ${name}`);
	return found;
};
const control = (tab, name) => row(tab, name).components[0];
const headerButton = (tab, label) => row(tab, 'Your models').components.find(component => component.tooltip === label);
const addScreen = async tab => {
	await headerButton(tab, 'Add models').click();
	return fake.modals.at(-1);
};
const modalRow = (modal, name) => row({ containerEl: modal.contentEl }, name);
const modalButton = (modal, label) => buttonsIn(modal.contentEl).find(button => button.text === label);
const modalRefresh = modal => modalRow(modal, 'Available models').components.find(component => component.tooltip === 'Refresh models');
const saveKey = async (tab, key, provider = 'OpenAI') => {
	const setting = row(tab, `${provider} API key`);
	await setting.components[0].type(key);
	await setting.components.find(component => component.text === 'Save key').click();
};

function configured(providerId = 'openai', modelId = 'saved-model') {
	const settings = createDefaultSettings();
	settings.providers[providerId].models.push(createModelSettings(modelId));
	settings.defaultModel = { providerId, modelId };
	return settings;
}

beforeEach(() => {
	resetAll();
	fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL ? { json: {
		openai: { models: { future: { id: 'future-model', name: 'Future model', modalities: { input: ['text', 'image'] } } } },
	} } : { json: { data: [{ id: 'future-model' }] } };
});

describe('settings startup and sync', () => {
	for (const [label, raw] of [['a string', '"hello"'], ['a number', '42'], ['null', 'null'], ['an empty object', '{}']]) {
		test(`startup with ${label} uses independent defaults`, async () => {
			const plugin = await loadPlugin(makeDevice({ disk: makeDisk(raw) }));
			assert.deepEqual(plugin.settings, createDefaultSettings());
			assert.equal(plugin.settingsStore.canSave, true);
			assert.equal(fake.providerRequests.length, 0);
		});
	}

	test('valid 1.0 settings load without a rewrite or model change', async () => {
		const settings = configured();
		settings.cards.extraInstructions = '# Instructions\n\n- Keep math\n- Use **Markdown**\n';
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		assert.deepEqual(plugin.settings, settings);
		assert.equal(disk.writes, 0);
	});

	test('a sync reloads current settings and preserves multi-line instructions on the next save', async () => {
		const disk = makeDisk(configured());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const incoming = configured('anthropic', 'new-id');
		incoming.cards.extraInstructions = '\n# Important\n\n- A\n- B\n';
		disk.files['data.json'] = JSON.stringify(incoming);
		await plugin.onExternalSettingsChange();
		await plugin.configureModel('openai', 'another-id', false);
		assert.deepEqual(plugin.settings.defaultModel, incoming.defaultModel);
		assert.equal(readDataJson(disk).cards.extraInstructions, incoming.cards.extraInstructions);
	});

	test('an unreadable sync keeps previous settings and never overwrites the broken file', async () => {
		const settings = configured();
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		for (const invalid of ['{broken', 'null', '[]']) {
			disk.files['data.json'] = invalid;
			await plugin.onExternalSettingsChange();
			assert.deepEqual(plugin.settings, settings);
			assert.equal(await plugin.configureModel('openai', 'unsafe', true), false);
			assert.equal(disk.files['data.json'], invalid);
		}
		disk.files['data.json'] = JSON.stringify(settings);
		await plugin.onExternalSettingsChange();
		assert.equal(await plugin.configureModel('openai', 'safe', true), true);
	});

	test('a newer schema disables editing without migrating keys or destroying data', async () => {
		const disk = makeDisk({ settings_version: 999, openAiApiKey: KEY });
		const original = disk.files['data.json'];
		const keychain = makeKeychain();
		const plugin = await loadPlugin(makeDevice({ disk, keychain }));
		assert.equal(plugin.settingsStore.canSave, false);
		assert.equal(keychain.calls.set, 0);
		assert.equal(await plugin.configureModel('openai', 'unsafe', true), false);
		assert.equal(disk.files['data.json'], original);
		assert.match(fake.notices[0], /newer Auto Anki/);
	});

	test('failed key migration retains the original key through every ordinary settings save', async () => {
		const disk = makeDisk(DATA_0_2_2);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ignores-writes') }));
		await plugin.configureModel('openai', 'one', true);
		await plugin.configureModel('anthropic', 'two', false);
		assert.equal(readDataJson(disk).openAiApiKey, DATA_0_2_2.openAiApiKey);
		assert.equal(readDataJson(disk).settings_version, 1);
	});

	test('a key synced back by an old device is migrated on the external-change callback', async () => {
		const disk = makeDisk(configured());
		const keychain = makeKeychain();
		const plugin = await loadPlugin(makeDevice({ disk, keychain }));
		disk.files['data.json'] = JSON.stringify({ ...configured(), openAiApiKey: KEY });
		await plugin.onExternalSettingsChange();
		assert.equal(keychain.secrets.get(SECRET_ID), KEY);
		assert.ok(!('openAiApiKey' in readDataJson(disk)));
	});

	test('concurrent edits are saved in order without losing a model', async () => {
		const disk = makeDisk(configured());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const save = plugin.saveData.bind(plugin);
		let release;
		const blocked = new Promise(resolve => { release = resolve; });
		let calls = 0;
		plugin.saveData = async data => { if (++calls === 1) await blocked; await save(data); };
		const first = plugin.configureModel('openai', 'first', true);
		const second = plugin.configureModel('anthropic', 'second', true);
		await flush();
		assert.equal(calls, 1, 'the second write must wait');
		release();
		assert.deepEqual(await Promise.all([first, second]), [true, true]);
		assert.ok(readDataJson(disk).providers.openai.models.some(model => model.id === 'first'));
		assert.ok(readDataJson(disk).providers.anthropic.models.some(model => model.id === 'second'));
		assert.deepEqual(plugin.settings.defaultModel, { providerId: 'anthropic', modelId: 'second' });
	});

	test('an edit queued behind a sync uses the newly loaded settings', async () => {
		const disk = makeDisk(configured());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const incoming = configured('anthropic', 'synced');
		incoming.cards.extraInstructions = 'Keep this synced preference.\n';
		disk.files['data.json'] = JSON.stringify(incoming);
		await Promise.all([plugin.onExternalSettingsChange(), plugin.configureModel('openai', 'local-edit', false)]);
		assert.equal(readDataJson(disk).cards.extraInstructions, incoming.cards.extraInstructions);
		assert.deepEqual(plugin.settings.defaultModel, incoming.defaultModel);
		assert.ok(plugin.settings.providers.openai.models.some(model => model.id === 'local-edit'));
	});

	test('a failed settings write leaves the saved and displayed selection unchanged', async () => {
		const settings = configured();
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		assert.equal(await plugin.configureModel('anthropic', 'failed', true), false);
		assert.deepEqual(plugin.settings, settings);
		assert.deepEqual(readDataJson(disk), settings);
		assert.equal(control(openSettings(plugin), 'Default model').value, JSON.stringify(settings.defaultModel));
		assert.match(fake.notices.at(-1), /Disk is full/);
		await flush();
	});
});

describe('native provider and model settings', () => {
	test('registration indexes native provider pages without making network requests', async () => {
		const plugin = await loadPlugin(makeDevice());
		const tab = openSettings(plugin);
		assert.deepEqual(tab.settingItems[1].items.map(page => page.name), ['OpenAI', 'Claude']);
		assert.equal(tab.settingItems[1].items[0].status(), 'warning');
		assert.equal(fake.providerRequests.length, 0);
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'));
	});

	for (const provider of ['OpenAI', 'Claude']) {
		test(`${provider} without a key shows setup instead of unusable model controls or discovery errors`, async () => {
			const disk = makeDisk();
			const plugin = await loadPlugin(makeDevice({ disk }));
			const tab = openProviderSettings(plugin, provider);
			assert.ok(row(tab, 'Add your API key to get started'));
			assert.ok(row(tab, `${provider} API key`));
			assert.ok(!settingsIn(tab.containerEl).some(setting => ['Your models', 'Model discovery', 'Default model'].includes(setting.name)));
			assert.equal(settingsIn(tab.containerEl).flatMap(setting => setting.components).filter(component => ['Add models', 'Refresh models'].includes(component.tooltip)).length, 0);
			assert.equal(row(tab, `${provider} API key`).components[1].disabled, true);
			await control(tab, `${provider} API key`).type('   ');
			assert.equal(row(tab, `${provider} API key`).components[1].disabled, true);
			await flush();
			assert.equal(fake.providerRequests.length, 0, 'opening setup must not start provider or public-catalogue requests');
			assert.equal(disk.writes, 0);
		});
	}

	test('saving a key reveals model controls immediately, while typing alone leaves setup unchanged', async () => {
		const plugin = await loadPlugin(makeDevice());
		const tab = openProviderSettings(plugin);
		await control(tab, 'OpenAI API key').type(KEY);
		assert.equal(row(tab, 'OpenAI API key').components[1].disabled, false);
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Your models'));
		assert.equal(fake.providerRequests.length, 0);
		await row(tab, 'OpenAI API key').components[1].click();
		assert.ok(headerButton(tab, 'Add models'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Add your API key to get started'));
		assert.equal(row(tab, 'OpenAI API key').components[1].disabled, true);
		tab.openPage();
		assert.equal(control(tab, 'Default model').value, JSON.stringify(plugin.settings.defaultModel));
		assert.ok(!fake.providerRequests.some(request => request.url.startsWith(PROVIDER_PRESETS.anthropic.baseUrl)), 'one provider key must not activate another provider');
	});

	test('saved models without a key remain editable, but discovery and choosing that provider as default stay hidden', async () => {
		const settings = configured('anthropic', 'saved-claude');
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openSettings(plugin);
		assert.ok(row(tab, 'Selected model needs an API key'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'));
		tab.openPage('Claude');
		assert.ok(row(tab, 'saved-claude'));
		assert.equal(headerButton(tab, 'Add models'), undefined);
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Model discovery'));
		tab.openPage('Claude', 'saved-claude');
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Use as default model'));
		await control(tab, 'Maximum output tokens').type('6000');
		assert.equal(plugin.settings.providers.anthropic.models[0].maxOutputTokens, 6000);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		await flush();
		assert.equal(fake.providerRequests.length, 0);
	});

	test('the default picker offers only providers with keys, preserving a saved default from another device', async () => {
		const settings = configured('anthropic', 'saved-claude');
		settings.providers.openai.models.push(createModelSettings('saved-openai'));
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openSettings(plugin);
		assert.deepEqual(Object.keys(control(tab, 'Default model').options).filter(Boolean).map(value => JSON.parse(value)), [{ providerId: 'openai', modelId: 'saved-openai' }]);
		assert.equal(control(tab, 'Default model').value, '');
		assert.match(row(tab, 'Selected model needs an API key').desc, /Claude/);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		await flush();
		const requestCount = fake.providerRequests.length;
		tab.openPage('Claude');
		await flush();
		assert.equal(headerButton(tab, 'Add models'), undefined);
		assert.equal(fake.providerRequests.length, requestCount, 'opening a provider without its own key must not start discovery');
		assert.equal(disk.writes, 0);
	});

	test('removing a key hides dependent controls without deleting choices, and a stale Add button cannot reopen discovery', async () => {
		const settings = configured();
		const disk = makeDisk(settings);
		const keychain = makeKeychain('ok', { [SECRET_ID]: KEY });
		const plugin = await loadPlugin(makeDevice({ disk, keychain }));
		const tab = openProviderSettings(plugin);
		await flush();
		const oldAdd = headerButton(tab, 'Add models');
		const requestCount = fake.providerRequests.length;
		keychain.secrets.delete(SECRET_ID);
		tab.update();
		assert.equal(headerButton(tab, 'Add models'), undefined);
		await oldAdd.click();
		assert.equal(fake.modals.length, 0);
		tab.openPage();
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'));
		assert.ok(row(tab, 'Selected model needs an API key'));
		await tab.setControlValue('defaultModel', JSON.stringify({ providerId: 'openai', modelId: 'not-configured' }));
		assert.deepEqual(plugin.settings, settings);
		assert.equal(fake.providerRequests.length, requestCount);
		assert.equal(disk.writes, 0);
	});

	test('the key box is a password input, never seeded with the actual key', async () => {
		const keychain = makeKeychain('ok', { [SECRET_ID]: KEY });
		const plugin = await loadPlugin(makeDevice({ keychain }));
		const box = control(openProviderSettings(plugin), 'OpenAI API key');
		assert.equal(box.inputEl.type, 'password');
		assert.equal(box.placeholder, 'Key saved: sk-...zZ99');
		assert.equal(box.value, '');
		await flush();
	});

	test('typing waits for Save key; both providers use their own verified Keychain entries', async () => {
		const keychain = makeKeychain();
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk, keychain }));
		let tab = openProviderSettings(plugin);
		await control(tab, 'OpenAI API key').type(` ${KEY}\n`);
		assert.equal(keychain.calls.set, 0);
		await row(tab, 'OpenAI API key').components[1].click();
		assert.equal(keychain.secrets.get(SECRET_ID), KEY);
		assert.equal(plugin.settings.defaultModel.modelId, PROVIDER_PRESETS.openai.suggestedModel);
		tab.openPage('Claude');
		await saveKey(tab, 'claude-test-key', 'Claude');
		assert.equal(keychain.secrets.get(CLAUDE_SECRET), 'claude-test-key');
		assert.equal(plugin.settings.defaultModel.providerId, 'openai', 'connecting a second provider must not change the default');
		assert.ok(!JSON.stringify(disk.files).includes(KEY));
		assert.ok(!JSON.stringify(disk.files).includes('claude-test-key'));
	});

	test('saving a new key cleans up a previously failed legacy migration', async () => {
		const keychain = makeKeychain('ignores-writes');
		const disk = makeDisk(DATA_0_2_2);
		const app = makeDevice({ disk, keychain });
		const plugin = await loadPlugin(app);
		app.secretStorage = makeKeychain();
		assert.equal(await plugin.connectProvider('openai', KEY), true);
		assert.ok(!('openAiApiKey' in readDataJson(disk)));
	});

	test('empty input never deletes a key or resets a model', async () => {
		const keychain = makeKeychain('ok', { [SECRET_ID]: KEY });
		const plugin = await loadPlugin(makeDevice({ keychain, disk: makeDisk(configured()) }));
		await saveKey(openProviderSettings(plugin), '   ');
		assert.equal(keychain.secrets.get(SECRET_ID), KEY);
		assert.equal(plugin.settings.defaultModel.modelId, 'saved-model');
		await flush();
	});

	test('replacing a key preserves enabled and hidden choices without adding the suggested model again', async () => {
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings(PROVIDER_PRESETS.openai.suggestedModel), enabled: false });
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		assert.equal(await plugin.connectProvider('openai', 'replacement-key'), true);
		assert.deepEqual(plugin.settings, settings);
		assert.equal(disk.writes, 0);
	});

	for (const mode of ['ignores-writes', 'throws-on-write', 'throws']) {
		test(`Keychain ${mode}: a failed save is reported without configuring a provider`, async () => {
			const disk = makeDisk();
			const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain(mode) }));
			await saveKey(openProviderSettings(plugin), KEY);
			assert.equal(plugin.settings.defaultModel, null);
			assert.equal(disk.writes, 0);
			assert.ok(fake.notices.some(notice => /could not be saved/.test(notice)));
			await flush();
		});
	}

	test('opening a provider refreshes once per visit; rebuilding definitions does not loop', async () => {
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		tab.update();
		await flush();
		assert.equal(fake.providerRequests.filter(request => request.url.endsWith('/models')).length, 1);
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Future model'), 'refreshing cannot enable a discovered model');
		assert.equal(modalRow(await addScreen(tab), 'Future model').components[0].disabled, false);
		assert.equal(readDataJson(plugin.app.disk), undefined, 'discovery must not save settings');
		tab.hide();
		openProviderSettings(plugin);
		await flush();
		assert.equal(fake.providerRequests.filter(request => request.url.endsWith('/models')).length, 2);
	});

	test('only Add models has a refresh button, which updates provider and catalogue data without changing enabled choices', async () => {
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		assert.equal(row(tab, 'Your models').components[0].placeholder, 'Search models');
		assert.ok(headerButton(tab, 'Add models'));
		assert.equal(headerButton(tab, 'Refresh models'), undefined, 'the page behind Add models must not show a duplicate refresh button');
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Refresh models' || setting.name === 'Model ID'));
		const modal = await addScreen(tab);
		assert.equal(modalRow(modal, 'Available models').components[0].placeholder, 'Search models');
		assert.equal(settingsIn(modal.contentEl).flatMap(setting => setting.components).filter(component => component.tooltip === 'Refresh models').length, 1);
		await modalRow(modal, 'Future model').components[0].type(true);
		await modalRefresh(modal).click();
		await flush();
		assert.equal(fake.providerRequests.length, 4);
		assert.ok(fake.providerRequests.every(request => request.method === 'GET'));
		assert.equal(modalRow(modal, 'Future model').components[0].value, true, 'refresh preserves staged selections');
		assert.deepEqual(plugin.settings.providers.openai.models, []);
		assert.equal(plugin.settings.defaultModel, null);
		assert.equal(plugin.app.disk.writes, 0);
	});

	test('a manual ID can be configured offline and the selection survives restart without a key', async () => {
		fake.providerHandler = () => { throw new Error('offline'); };
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [CLAUDE_SECRET]: KEY }) }));
		const tab = openProviderSettings(plugin, 'Claude');
		const modal = await addScreen(tab);
		const setting = modalRow(modal, 'Model ID');
		await setting.components[0].type(' future-unlisted-model ');
		await setting.components[1].click();
		assert.equal(disk.writes, 0, 'including an ID is only a staged choice');
		await modalButton(modal, 'Add 1 model').click();
		const restarted = await loadPlugin(makeDevice({ disk, keychain: makeKeychain() }));
		assert.deepEqual(restarted.settings.defaultModel, { providerId: 'anthropic', modelId: 'future-unlisted-model' });
		run(restarted, 'export-current-file-to-anki');
		assert.match(fake.notices.at(-1), /No Claude API key/);
		await flush();
	});

	test('per-model choices remain independent and future reported reasoning levels persist offline', async () => {
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL ? { json: { anthropic: { models: { future: { id: 'future' } } } } } : { json: {
			data: [{ id: 'future', capabilities: { effort: { supported: true, future_level: { supported: true } } } }],
		} };
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [CLAUDE_SECRET]: KEY }) }));
		const tab = openProviderSettings(plugin, 'Claude');
		await flush();
		await plugin.addModels('anthropic', ['future']);
		tab.openPage('Claude', 'future');
		await control(tab, 'Reasoning effort').type('future_level');
		await control(tab, 'Maximum output tokens').type('8000');
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Output mode'));
		tab.openPage('Claude', 'future', 'Advanced');
		await control(tab, 'Output mode').type('tool');
		await control(tab, 'Accepts images').type('no');
		await plugin.configureModel('anthropic', 'second', false);
		const restarted = await loadPlugin(makeDevice({ disk }));
		const [first, second] = restarted.settings.providers.anthropic.models;
		assert.deepEqual([first.reasoningEffort, first.maxOutputTokens, first.outputMode, first.acceptsImages], ['future_level', 8000, 'tool', 'no']);
		assert.deepEqual(second, createModelSettings('second'));
	});

	test('invalid token ceilings are rejected with inline errors, without a save', async () => {
		const disk = makeDisk(configured());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openProviderSettings(plugin);
		tab.openPage('OpenAI', 'saved-model');
		for (const invalid of ['', 'abc', '0', '-1', '1.5', '9007199254740992']) {
			const box = control(tab, 'Maximum output tokens');
			await box.type(invalid);
			assert.match(box.validationError, /positive whole number/);
		}
		assert.equal(disk.writes, 0);
		assert.equal(plugin.settings.providers.openai.models[0].maxOutputTokens, 25000);
		await flush();
	});

	test('hiding the default preserves its preferences, clears the default and survives restart and refresh', async () => {
		const settings = configured();
		settings.providers.openai.models[0].maxOutputTokens = 6000;
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		tab.openPage('OpenAI', 'saved-model');
		await control(tab, 'Show in model picker').type(false);
		assert.equal(plugin.settings.providers.openai.models[0].enabled, false);
		assert.equal(plugin.settings.providers.openai.models[0].maxOutputTokens, 6000);
		assert.equal(plugin.settings.defaultModel, null);
		run(plugin, 'export-current-file-to-anki');
		assert.match(fake.notices.at(-1), /Choose a default model/);
		tab.openPage();
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'));
		const restarted = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const restartedTab = openProviderSettings(restarted);
		await flush();
		const modal = await addScreen(restartedTab);
		await modalRefresh(modal).click();
		await modalButton(modal, 'Cancel').click();
		await flush();
		assert.equal(restarted.settings.providers.openai.models[0].enabled, false);
		restartedTab.openPage('OpenAI', 'saved-model');
		await control(restartedTab, 'Show in model picker').type(true);
		assert.equal(restarted.settings.providers.openai.models[0].enabled, true);
		assert.equal(restarted.settings.providers.openai.models[0].maxOutputTokens, 6000);
		assert.equal(restarted.settings.defaultModel, null, 'showing a model does not silently choose a default');
	});

	test('hiding another model keeps the default, and a failed visibility save leaves both choices unchanged', async () => {
		const settings = configured();
		settings.providers.openai.models.push(createModelSettings('second'));
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openProviderSettings(plugin);
		tab.openPage('OpenAI', 'second');
		await control(tab, 'Show in model picker').type(false);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		const saved = readDataJson(disk);
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		await control(tab, 'Show in model picker').type(true);
		assert.equal(control(tab, 'Show in model picker').value, false);
		assert.deepEqual(plugin.settings, saved);
		assert.deepEqual(readDataJson(disk), saved);
		await flush();
	});

	test('a synced visibility edit changes the picker without deleting per-model settings', async () => {
		const settings = configured();
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openSettings(plugin);
		settings.providers.openai.models[0].enabled = false;
		settings.defaultModel = null;
		disk.files['data.json'] = JSON.stringify(settings);
		await plugin.onExternalSettingsChange();
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'));
		assert.deepEqual(plugin.settings.providers.openai.models, settings.providers.openai.models);
		assert.equal(disk.writes, 0);
		await flush();
	});

	test('Add models enables a hidden model again without resetting its preferences or the current default', async () => {
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings('hidden'), enabled: false, maxOutputTokens: 6000, reasoningEffort: 'low' });
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const modal = await addScreen(openProviderSettings(plugin));
		const hidden = modalRow(modal, 'hidden');
		assert.equal(hidden.components[0].value, false);
		assert.equal(hidden.components[0].disabled, false);
		assert.match(hidden.desc, /Hidden/);
		await hidden.components[0].type(true);
		await modalButton(modal, 'Add 1 model').click();
		assert.equal(disk.writes, 1);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		assert.deepEqual(plugin.settings.providers.openai.models[1], { ...settings.providers.openai.models[1], enabled: true });
		assert.equal(plugin.settings.providers.openai.models.length, 2);
		await flush();
	});

	test('adding an unfamiliar reported model enables it and preserves discovered capabilities', async () => {
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		const selected = { providerId: 'openai', modelId: 'future-model' };
		assert.deepEqual(plugin.settings.providers.openai.models, []);
		const modal = await addScreen(tab);
		await modalRow(modal, 'Future model').components[0].type(true);
		assert.deepEqual(plugin.settings.providers.openai.models, [], 'selection is staged until Add');
		await modalButton(modal, 'Add 1 model').click();
		tab.openPage();
		assert.ok(JSON.stringify(selected) in control(tab, 'Default model').options);
		assert.deepEqual(plugin.settings.defaultModel, selected);
		assert.equal(plugin.settings.providers.openai.models[0].capabilities.acceptsImages, true);
		tab.openPage('OpenAI');
		const models = row(tab, 'Your models').definition;
		const added = models.items.find(model => model.name === 'Future model');
		assert.equal(models.search.match(added, ' Future-model '), true, 'an exact provider ID remains searchable when its display name differs');
		assert.equal(models.search.match(added, 'future model'), true);
		assert.equal(models.search.match(added, 'unrelated'), false);
	});

	test('normal settings list only enabled choices; all newly discovered models remain available in Add models', async () => {
		const ids = Array.from({ length: 300 }, (_, index) => `reported-model-${index}`);
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings('hidden'), enabled: false });
		const disk = makeDisk(settings);
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL
			? { json: { openai: { models: { future: { id: ids[0], name: 'Future model', modalities: { input: ['text', 'image'], output: ['text'] } } } } } }
			: { json: { data: ids.map(id => ({ id })) } };
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openSettings(plugin);
		await flush();
		const choices = control(tab, 'Default model').options;
		assert.deepEqual(Object.keys(choices).filter(Boolean).map(value => JSON.parse(value).modelId), ['saved-model']);
		assert.deepEqual(plugin.settings, settings);
		assert.equal(disk.writes, 0, 'discovery cannot write user preferences');
		assert.equal(fake.providerRequests.filter(request => request.url.endsWith('/models')).length, 1);
		tab.openPage('OpenAI');
		assert.ok(settingsIn(tab.containerEl).some(setting => setting.name === 'hidden'), 'a hidden model keeps its settings page');
		const modal = await addScreen(tab);
		assert.equal(settingsIn(modal.listEl).length, 302);
		const normalModel = modalRow(modal, 'saved-model');
		assert.match(normalModel.desc, /Already enabled/);
		assert.equal(normalModel.components[0].value, true);
		assert.equal(normalModel.components[0].disabled, true);
		await modalRow(modal, 'Future model').components[0].type(true);
		await modalButton(modal, 'Add 1 model').click();
		assert.equal(disk.writes, 1);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		tab.openPage();
		assert.equal(Object.keys(control(tab, 'Default model').options).length, 3, 'only the newly enabled model enters the picker');
	});

	test('a metadata failure leaves enabled choices alone and does not block adding provider-reported models', async () => {
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL
			? { status: 503, json: {} } : { json: { data: [{ id: 'future-model' }] } };
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(configured()), keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openSettings(plugin);
		await flush();
		assert.match(row(tab, 'Your models').desc, /could not be refreshed/);
		assert.deepEqual(Object.keys(control(tab, 'Default model').options).filter(Boolean).map(value => JSON.parse(value).modelId), ['saved-model']);
		tab.openPage('OpenAI');
		const modal = await addScreen(tab);
		assert.equal(modalRow(modal, 'future-model').components[0].disabled, false);
		await modalRow(modal, 'future-model').components[0].type(true);
		await modalButton(modal, 'Add 1 model').click();
		assert.ok(plugin.settings.providers.openai.models.some(model => model.id === 'future-model'));
		assert.equal(plugin.settings.defaultModel.modelId, 'saved-model');
	});

	test('Add models shows the full discovery list, labels unavailable tasks and saves staged manual IDs once', async () => {
		const settings = configured();
		settings.providers.openai.models[0].maxOutputTokens = 6000;
		const disk = makeDisk(settings);
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL ? { json: { openai: { models: {
			one: { id: 'one', name: 'One', release_date: '2026-10-01', modalities: { output: ['text'] } },
			two: { id: 'two', name: 'Two', release_date: '2026-10-20', modalities: { output: ['text'] } },
			image: { id: 'gpt-image-1', modalities: { output: ['image'] } },
			embedding: { id: 'text-embedding-3-small', family: 'text-embedding' },
		} } } } : { json: { data: ['one', 'two', 'one-2026-10-01', 'whisper-1', 'text-embedding-3-small', 'gpt-image-1'].map(id => ({ id })) } };
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		let modal = await addScreen(tab);
		const names = settingsIn(modal.listEl).map(setting => setting.name);
		assert.deepEqual(new Set(names), new Set(['saved-model', 'Two', 'One', 'one-2026-10-01', 'whisper-1', 'text-embedding-3-small', 'gpt-image-1']));
		assert.equal(modalRow(modal, 'One').components[0].disabled, false);
		assert.match(modalRow(modal, 'gpt-image-1').desc, /Not a text-generation model/);
		assert.equal(modalRow(modal, 'gpt-image-1').components[0].disabled, true);
		await modalButton(modal, 'Cancel').click();
		assert.equal(disk.writes, 0);
		modal = await addScreen(tab);
		assert.equal(modalButton(modal, 'Add models').disabled, true);
		for (const id of ['manual-one', 'manual-two']) {
			const manual = modalRow(modal, 'Model ID');
			await manual.components[0].type(id);
			await manual.components[1].click();
		}
		await modalButton(modal, 'Add 2 models').click();
		assert.equal(modal.isOpen, false);
		assert.equal(disk.writes, 1);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		assert.equal(plugin.settings.providers.openai.models[0].maxOutputTokens, 6000);
		assert.deepEqual(plugin.settings.providers.openai.models.map(model => model.id), ['saved-model', 'manual-one', 'manual-two']);
	});

	test('Add models opened during discovery updates when it finishes; dated versions remain searchable', async () => {
		let finish;
		const pending = new Promise(resolve => { finish = resolve; });
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL
			? { json: { openai: { models: { one: { id: 'new-model' } } } } } : pending;
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const modal = await addScreen(openProviderSettings(plugin));
		assert.match(modal.statusEl.textContent, /Refreshing/);
		finish({ json: { data: [{ id: 'new-model' }, { id: 'new-model-2026-10-01' }] } });
		await flush();
		assert.equal(settingsIn(modal.listEl).length, 2);
		await modalRow(modal, 'Available models').components[0].type('2026');
		assert.deepEqual(settingsIn(modal.listEl).map(setting => setting.name), ['new-model-2026-10-01']);
	});

	test('a failed Add models save keeps the screen and original settings for retry', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const modal = await addScreen(openProviderSettings(plugin));
		const manual = modalRow(modal, 'Model ID');
		await manual.components[0].type('future-model');
		await manual.components[1].click();
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		await modalButton(modal, 'Add 1 model').click();
		assert.equal(modal.isOpen, true);
		assert.equal(modalButton(modal, 'Add 1 model').disabled, false);
		assert.deepEqual(plugin.settings.providers.openai.models, []);
		await flush();
	});

	test('replacing a key while discovery is pending uses the new account and ignores the late reply', async () => {
		let finishOld;
		const oldReply = new Promise(resolve => { finishOld = resolve; });
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL
			? { json: { openai: { models: { public: { id: 'public' } } } } }
			: request.headers.Authorization === 'Bearer old-key' ? oldReply : { json: { data: [{ id: 'new-account-model' }] } };
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: 'old-key' }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		await saveKey(tab, 'new-key');
		finishOld({ json: { data: [{ id: 'old-account-model' }] } });
		await flush();
		assert.deepEqual(plugin.discovery.getModels('openai').map(model => model.id), ['new-account-model']);
	});

	test('commands read the current selected model and never send a Claude selection to OpenAI', async () => {
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(configured()), keychain: makeKeychain('ok', { [SECRET_ID]: KEY, [CLAUDE_SECRET]: KEY }) }));
		await plugin.configureModel('openai', 'changed-after-startup', true);
		run(plugin, 'export-current-file-to-anki');
		assert.equal(fake.modals.at(-1).model.id, 'changed-after-startup');
		await fake.modals.at(-1).opened;
		const count = fake.modals.length;
		await plugin.configureModel('anthropic', 'claude-model', true);
		run(plugin, 'export-current-file-to-anki');
		assert.equal(fake.modals.length, count);
		assert.match(fake.notices.at(-1), /Claude generation is not available/);
	});
});

describe('catalogue cache integration', () => {
	test('startup restores a fresh separate cache without network requests or data.json writes', async () => {
		const disk = makeDisk(configured('openai', 'cached'));
		disk.files[cachePath] = JSON.stringify({ fetchedAt: Date.now(), providers: { openai: [{ id: 'cached', displayName: 'Cached label' }] } });
		const plugin = await loadPlugin(makeDevice({ disk }));
		assert.equal(plugin.discovery.getModels('openai', plugin.settings.providers.openai.models)[0].displayName, 'Cached label');
		assert.equal(fake.providerRequests.length, 0);
		assert.equal(disk.writes, 0);
	});

	test('opening settings saves catalogue metadata only to the separate cache file', async () => {
		const disk = makeDisk(configured());
		const original = disk.files['data.json'];
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		openProviderSettings(plugin);
		await flush();
		assert.equal(disk.files['data.json'], original);
		assert.equal(disk.cacheWrites, 1);
		assert.equal(JSON.parse(disk.files[cachePath]).providers.openai[0].displayName, 'Future model');
	});
});

// Drive the running plugin through native settings definitions, Keychain and disk.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, settingsIn, buttonsIn } from 'obsidian';
import { createDefaultSettings, createModelSettings } from '../src/settings/schema';
import { SettingsStore } from '../src/settings/store';
import { ProviderSettings } from '../src/ui/settings/providers';
import { ManageModelsModal } from '../src/ui/settings/manage-models-modal';
import { MODEL_CATALOG_URL } from '../src/ai/models/catalog';
import {
	SECRET_ID, DATA_0_2_2, MANIFEST, makeDisk, makeKeychain, makeDevice, loadPlugin,
	readDataJson, openSettings, openProviderSettings, resetAll, flush, run,
		ankiServer, openai, openAiReply,
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
const manageScreen = async tab => {
	await headerButton(tab, 'Manage models').click();
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
		settings.notes.extraInstructions = '# Instructions\n\n- Keep math\n- Use **Markdown**\n';
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		assert.deepEqual(plugin.settings, settings);
		assert.equal(disk.writes, 0);
	});

	test('a sync reloads current settings and preserves multi-line instructions on the next save', async () => {
		const disk = makeDisk(configured());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const incoming = configured('anthropic', 'new-id');
		incoming.notes.extraInstructions = '\n# Important\n\n- A\n- B\n';
		disk.files['data.json'] = JSON.stringify(incoming);
		await plugin.onExternalSettingsChange();
		await plugin.configureModel('openai', 'another-id', false);
		assert.deepEqual(plugin.settings.defaultModel, incoming.defaultModel);
		assert.equal(readDataJson(disk).notes.extraInstructions, incoming.notes.extraInstructions);
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
		incoming.notes.extraInstructions = 'Keep this synced preference.\n';
		disk.files['data.json'] = JSON.stringify(incoming);
		await Promise.all([plugin.onExternalSettingsChange(), plugin.configureModel('openai', 'local-edit', false)]);
		assert.equal(readDataJson(disk).notes.extraInstructions, incoming.notes.extraInstructions);
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

describe('settings save isolation', () => {
	test('normalizes edits and detaches committed settings from drafts, capabilities and writer payloads', async () => {
		const original = configured();
		const writes = [];
		let release;
		const blocked = new Promise(resolve => { release = resolve; });
		const store = new SettingsStore({}, async () => ({ ...original, openAiApiKey: KEY, openAiApiKeyIdentifier: 'masked' }), async data => {
			writes.push(data);
			if (writes.length === 1) await blocked;
		});
		await store.load();
		const capabilities = { acceptsImages: true, reasoningEfforts: ['low', 'low'], apiKey: 'discard' };
		let draft;
		const saving = store.update(settings => {
			draft = settings;
			settings.notes.extraInstructions = 'Keep\nthese instructions.\n';
			settings.notes.apiKey = 'discard';
			settings.openAiApiKey = 'discard';
			settings.providers.openai.models[0].maxOutputTokens = -1;
			settings.providers.openai.models[0].capabilities = capabilities;
		});
		await flush();
		assert.deepEqual(store.settings, original, 'pending edits must not change live settings');
		assert.equal(writes[0].openAiApiKey, KEY);
		assert.equal(writes[0].openAiApiKeyIdentifier, 'masked');
		assert.ok(!('apiKey' in writes[0].notes));
		assert.deepEqual(writes[0].providers.openai.models[0].capabilities, { acceptsImages: true, reasoningEfforts: ['low'] });
		const expected = structuredClone(writes[0]);
		delete expected.openAiApiKey;
		delete expected.openAiApiKeyIdentifier;
		assert.equal(expected.providers.openai.models[0].maxOutputTokens, 25000);
		draft.notes.extraInstructions = 'Changed draft';
		capabilities.reasoningEfforts.push('high');
		writes[0].notes.extraInstructions = 'Changed by writer';
		writes[0].providers.openai.models[0].capabilities.reasoningEfforts.push('writer');
		release();
		await saving;
		assert.deepEqual(store.settings, expected);
		assert.ok(!('openAiApiKey' in store.settings));
		assert.ok(!('openAiApiKeyIdentifier' in store.settings));
		writes[0].anki.enabledNoteTypes.push('Writer only');
		assert.deepEqual(store.settings, expected, 'retained writer payloads must remain detached');
		await store.update(() => {});
		assert.equal(writes[1].openAiApiKey, KEY, 'subsequent saves must retain the pending key');
		assert.equal(writes[1].openAiApiKeyIdentifier, 'masked');
		assert.deepEqual(store.settings, expected);
	});

	test('a writer that mutates its payload and fails cannot change live settings or prevent retry', async () => {
		const original = configured();
		let fail = true;
		const store = new SettingsStore({}, async () => original, async data => {
			data.providers.openai.models[0].id = 'Writer only';
			data.anki.enabledNoteTypes.length = 0;
			if (fail) throw new Error('Disk is full');
		});
		await store.load();
		const edit = settings => { settings.notes.extraInstructions = 'Edited'; };
		await assert.rejects(store.update(edit), /Disk is full/);
		assert.deepEqual(store.settings, original);
		fail = false;
		await store.update(edit);
		assert.deepEqual(store.settings, { ...original, notes: { ...original.notes, extraInstructions: 'Edited' } });
		assert.deepEqual(original, configured(), 'editing must not mutate the loaded source');
	});
});

describe('native provider and model settings', () => {
	test('registration indexes native provider pages without making network requests', async () => {
		const plugin = await loadPlugin(makeDevice());
		const tab = openSettings(plugin);
		assert.deepEqual(tab.settingItems[1].items.filter(item => item.type === 'page').map(page => page.name), ['OpenAI', 'Claude']);
		assert.equal(tab.settingItems[1].items[0].status(), 'warning');
		assert.deepEqual(tab.settingItems[2].items.map(page => page.name), ['Generation', 'Anki']);
		assert.equal(fake.providerRequests.length, 0);
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'));
	});

	test('the main page refreshes enabled models once when shown, but indexing makes no requests', async () => {
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(configured()), keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = plugin.settingTabs[0];
		tab.getSettingDefinitions();
		await flush();
		assert.equal(fake.providerRequests.length, 0, 'indexing definitions for search must not start discovery');
		openSettings(plugin);
		await flush();
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Your models'), 'models are managed on each provider page');
		assert.equal(fake.providerRequests.filter(request => request.url.endsWith('/models')).length, 1);
		tab.openPage('OpenAI');
		await flush();
		assert.equal(fake.providerRequests.filter(request => request.url.endsWith('/models')).length, 1, 'opening the provider reuses this visit\'s refresh');
	});

	for (const provider of ['OpenAI', 'Claude']) {
		test(`${provider} without a key shows setup instead of unusable model controls or discovery errors`, async () => {
			const disk = makeDisk();
			const plugin = await loadPlugin(makeDevice({ disk }));
			const tab = openProviderSettings(plugin, provider);
			assert.ok(row(tab, 'Add your API key to get started'));
			assert.ok(row(tab, `${provider} API key`));
			assert.ok(!settingsIn(tab.containerEl).some(setting => ['Your models', 'Model discovery', 'Default model'].includes(setting.name)));
			assert.equal(settingsIn(tab.containerEl).flatMap(setting => setting.components).filter(component => ['Manage models', 'Refresh models'].includes(component.tooltip)).length, 0);
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
		assert.ok(headerButton(tab, 'Manage models'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Add your API key to get started'));
		assert.equal(row(tab, 'OpenAI API key').components[1].disabled, true);
		tab.openPage();
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Default model'), 'no default to choose until a model is added');
		assert.ok(!fake.providerRequests.some(request => request.url.startsWith('https://api.anthropic.com')), 'one provider key must not activate another provider');
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
		assert.equal(headerButton(tab, 'Manage models').icon, 'settings-2');
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Model discovery'));
		const modal = await manageScreen(tab);
		assert.equal(modalRow(modal, 'saved-claude').components[0].disabled, false);
		await modalRefresh(modal).click();
		await modalButton(modal, 'Cancel').click();
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
		assert.ok(headerButton(tab, 'Manage models'));
		assert.equal(fake.providerRequests.length, requestCount, 'opening a provider without its own key must not start discovery');
		assert.equal(disk.writes, 0);
	});

	test('removing a key keeps management available without reopening discovery', async () => {
		const settings = configured();
		const disk = makeDisk(settings);
		const keychain = makeKeychain('ok', { [SECRET_ID]: KEY });
		const plugin = await loadPlugin(makeDevice({ disk, keychain }));
		const tab = openProviderSettings(plugin);
		await flush();
		const oldManage = headerButton(tab, 'Manage models');
		const requestCount = fake.providerRequests.length;
		keychain.secrets.delete(SECRET_ID);
		tab.update();
		assert.ok(headerButton(tab, 'Manage models'));
		await oldManage.click();
		assert.equal(fake.modals.length, 1);
		await modalRefresh(fake.modals[0]).click();
		await modalButton(fake.modals[0], 'Cancel').click();
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
		assert.deepEqual(plugin.settings.providers.openai.models, [], 'connecting adds no models');
		assert.equal(plugin.settings.defaultModel, null);
		tab.openPage('Claude');
		await saveKey(tab, 'claude-test-key', 'Claude');
		assert.equal(keychain.secrets.get(CLAUDE_SECRET), 'claude-test-key');
		assert.deepEqual(plugin.settings.providers.anthropic.models, []);
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

	test('replacing a key preserves enabled and hidden choices', async () => {
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings('hidden-model'), enabled: false });
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
		assert.equal(modalRow(await manageScreen(tab), 'Future model').components[0].disabled, false);
		assert.equal(readDataJson(plugin.app.disk), undefined, 'discovery must not save settings');
		tab.hide();
		openProviderSettings(plugin);
		await flush();
		assert.equal(fake.providerRequests.filter(request => request.url.endsWith('/models')).length, 2);
	});

	test('only Manage models has a refresh button, which updates provider and catalogue data without changing enabled choices', async () => {
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		assert.equal(row(tab, 'Your models').components[0].placeholder, 'Search models');
		assert.equal(headerButton(tab, 'Manage models').icon, 'settings-2');
		assert.equal(headerButton(tab, 'Refresh models'), undefined, 'the page behind Manage models must not show a duplicate refresh button');
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Refresh models' || setting.name === 'Model ID'));
		const modal = await manageScreen(tab);
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
		const modal = await manageScreen(tab);
		const setting = modalRow(modal, 'Model ID');
		await setting.components[0].type(' future-unlisted-model ');
		await setting.components[1].click();
		assert.equal(disk.writes, 0, 'including an ID is only a staged choice');
		await modalButton(modal, 'Save changes').click();
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
		await plugin.updateModelSelection('anthropic', new Map([['future', true]]));
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

	test('"Use as default model" is disabled for the current default and enabled for other models', async () => {
		const settings = configured();
		settings.providers.openai.models.push(createModelSettings('other-model'));
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(settings), keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		tab.openPage('OpenAI', 'saved-model');
		const current = row(tab, 'Use as default model');
		assert.equal(current.definition.disabled(), true);
		current.settingEl.onclick();
		await flush();
		assert.equal(plugin.settings.defaultModel.modelId, 'saved-model');
		tab.openPage('OpenAI', 'other-model');
		const other = row(tab, 'Use as default model');
		assert.equal(other.definition.disabled(), false);
		other.settingEl.onclick();
		await flush();
		assert.deepEqual(plugin.settings.defaultModel, { providerId: 'openai', modelId: 'other-model' });
		assert.equal(other.definition.disabled(), true, 'the row becomes disabled once the model is the default');
	});

	test('a saved level the model does not report is kept and marked, and unreported levels cannot be chosen', async () => {
		const settings = configured();
		settings.providers.openai.models[0].reasoningEffort = 'high';
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		tab.openPage('OpenAI', 'saved-model');
		const effort = control(tab, 'Reasoning effort');
		assert.deepEqual(effort.options, { default: 'Model default', high: 'High (not reported for this model)' });
		assert.equal(effort.value, 'high');
		await effort.type('max');
		assert.equal(plugin.settings.providers.openai.models[0].reasoningEffort, 'high');
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(restarted.settings.providers.openai.models[0].reasoningEffort, 'high');
		await effort.type('default');
		tab.openPage('OpenAI', 'saved-model');
		assert.deepEqual(control(tab, 'Reasoning effort').options, { default: 'Model default' });
		assert.equal(control(tab, 'Reasoning effort').value, 'default');
		assert.match(row(tab, 'Reasoning effort').desc, /not known yet/, 'missing metadata is not reported as an unsupported feature');
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

	test('disabling the default warns before save, clears it without replacement and preserves preferences', async () => {
		const settings = configured();
		settings.providers.openai.models[0].maxOutputTokens = 6000;
		settings.providers.openai.models.push(createModelSettings('second'));
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openProviderSettings(plugin);
		tab.openPage('OpenAI', 'saved-model');
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Show in model picker'));
		tab.openPage('OpenAI');
		const modal = await manageScreen(tab);
		await modalRow(modal, 'saved-model').components[0].type(false);
		assert.match(modal.contentEl.textContent, /default model/i);
		assert.match(modal.contentEl.textContent, /clear|choose/i);
		assert.deepEqual(plugin.settings, settings, 'disabling is staged until save');
		assert.equal(disk.writes, 0);
		await modalButton(modal, 'Save changes').click();
		assert.equal(modal.isOpen, false);
		assert.equal(plugin.settings.defaultModel, null, 'another enabled model must not become default automatically');
		assert.deepEqual(plugin.settings.providers.openai.models[0], { ...settings.providers.openai.models[0], enabled: false });
		assert.equal(plugin.settings.providers.openai.models[1].enabled, true);
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'saved-model'));
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.deepEqual(restarted.settings, plugin.settings);
		assert.equal(fake.providerRequests.length, 0, 'keyless management must not discover models');
	});

	test('cancel discards staged disables, including the default', async () => {
		const settings = configured();
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const modal = await manageScreen(openProviderSettings(plugin));
		await modalRow(modal, 'saved-model').components[0].type(false);
		assert.equal(modalRow(modal, 'saved-model').components[0].value, false);
		await modalButton(modal, 'Cancel').click();
		assert.equal(modal.isOpen, false);
		assert.deepEqual(plugin.settings, settings);
		assert.deepEqual(readDataJson(disk), settings);
		assert.equal(disk.writes, 0);
		const reopened = await manageScreen(openProviderSettings(plugin));
		assert.equal(modalRow(reopened, 'saved-model').components[0].value, true);
	});

	test('saving all models disabled retains their settings and allows keyless management afterwards', async () => {
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings('second'), reasoningEffort: 'high' });
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openProviderSettings(plugin);
		const modal = await manageScreen(tab);
		for (const model of settings.providers.openai.models) await modalRow(modal, model.id).components[0].type(false);
		await modalButton(modal, 'Save changes').click();
		assert.deepEqual(plugin.settings.providers.openai.models, settings.providers.openai.models.map(model => ({ ...model, enabled: false })));
		assert.equal(plugin.settings.defaultModel, null);
		assert.equal(disk.writes, 1);
		assert.ok(headerButton(tab, 'Manage models'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => ['saved-model', 'second'].includes(setting.name)));
		const reopened = await manageScreen(tab);
		assert.equal(modalRow(reopened, 'saved-model').components[0].value, false);
		assert.equal(fake.providerRequests.length, 0);
	});

	test('disabling another model keeps the default, and a failed management save keeps settings unchanged for retry', async () => {
		const settings = configured();
		settings.providers.openai.models.push(createModelSettings('second'));
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openProviderSettings(plugin);
		const modal = await manageScreen(tab);
		await modalRow(modal, 'second').components[0].type(false);
		const save = plugin.saveData.bind(plugin);
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		await modalButton(modal, 'Save changes').click();
		assert.equal(modal.isOpen, true);
		assert.equal(modalButton(modal, 'Save changes').disabled, false);
		assert.equal(modalRow(modal, 'second').components[0].value, false);
		assert.deepEqual(plugin.settings, settings);
		assert.deepEqual(readDataJson(disk), settings);
		assert.match(fake.notices.at(-1), /Disk is full/);
		plugin.saveData = save;
		await modalButton(modal, 'Save changes').click();
		assert.equal(modal.isOpen, false);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		assert.equal(plugin.settings.providers.openai.models[1].enabled, false);
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

	test('Manage models enables a hidden model again without resetting its preferences or the current default', async () => {
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings('hidden'), enabled: false, maxOutputTokens: 6000, reasoningEffort: 'low' });
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const modal = await manageScreen(openProviderSettings(plugin));
		const hidden = modalRow(modal, 'hidden');
		assert.equal(hidden.components[0].value, false);
		assert.equal(hidden.components[0].disabled, false);

		await hidden.components[0].type(true);
		await modalButton(modal, 'Save changes').click();
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
		const modal = await manageScreen(tab);
		await modalRow(modal, 'Future model').components[0].type(true);
		assert.deepEqual(plugin.settings.providers.openai.models, [], 'selection is staged until Save changes');
		await modalButton(modal, 'Save changes').click();
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

	test('normal settings list only enabled choices; all newly discovered models remain available in Manage models', async () => {
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
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'hidden'), 'disabled models stay out of the main list');
		const modal = await manageScreen(tab);
		assert.equal(settingsIn(modal.listEl).length, 302);
		const normalModel = modalRow(modal, 'saved-model');
		assert.equal(normalModel.components[0].value, true);
		assert.equal(normalModel.components[0].disabled, false);
		await modalRow(modal, 'Future model').components[0].type(true);
		await modalButton(modal, 'Save changes').click();
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
		assert.equal(tab.settingItems[1].items[0].displayValue(), 'Model information not refreshed');
		assert.equal(tab.settingItems[1].items[0].status(), 'warning');
		assert.deepEqual(Object.keys(control(tab, 'Default model').options).filter(Boolean).map(value => JSON.parse(value).modelId), ['saved-model']);
		tab.openPage('OpenAI');
		const modal = await manageScreen(tab);
		assert.equal(modalRow(modal, 'future-model').components[0].disabled, false);
		await modalRow(modal, 'future-model').components[0].type(true);
		await modalButton(modal, 'Save changes').click();
		assert.ok(plugin.settings.providers.openai.models.some(model => model.id === 'future-model'));
		assert.equal(plugin.settings.defaultModel.modelId, 'saved-model');
	});

	test('a first management save chooses the first enabled change, but disabling a default never replaces it', async () => {
		const settings = createDefaultSettings();
		settings.providers.openai.models.push({ ...createModelSettings('hidden'), enabled: false, maxOutputTokens: 6000 });
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		assert.equal(await plugin.updateModelSelection('openai', new Map([['hidden', false], ['first', true], ['second', true]])), true);
		assert.deepEqual(plugin.settings.defaultModel, { providerId: 'openai', modelId: 'first' });
		assert.equal(await plugin.updateModelSelection('openai', new Map([['first', false], ['new-choice', true]])), true);
		assert.equal(plugin.settings.defaultModel, null, 'even a newly enabled choice must not replace a disabled default');
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'hidden').maxOutputTokens, 6000);
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'second').enabled, true);
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'new-choice').enabled, true);
		assert.equal(disk.writes, 2);
	});

	test('management submits only explicit enable and disable deltas', async () => {
		const settings = configured();
		settings.providers.openai.models.push(createModelSettings('untouched'), { ...createModelSettings('hidden'), enabled: false });
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(settings) }));
		const modal = await manageScreen(openProviderSettings(plugin));
		assert.equal(modalButton(modal, 'Save changes').disabled, true);
		await modalRow(modal, 'saved-model').components[0].type(false);
		await modalRow(modal, 'hidden').components[0].type(true);
		await modalRow(modal, 'Available models').components[0].type('');
		let submitted;
		plugin.updateModelSelection = async (providerId, changes) => {
			assert.equal(providerId, 'openai');
			submitted = new Map(changes);
			return true;
		};
		await modalButton(modal, 'Save changes').click();
		assert.deepEqual(submitted, new Map([['saved-model', false], ['hidden', true]]));
		assert.equal(modal.isOpen, false);
	});

	test('an enabled non-text model can be disabled but cannot be re-enabled', async () => {
		const settings = configured('openai', 'gpt-image-1');
		settings.providers.openai.models[0].maxOutputTokens = 6000;
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL
			? { json: { openai: { models: { image: { id: 'gpt-image-1', modalities: { output: ['image'] } } } } } }
			: { json: { data: [{ id: 'gpt-image-1' }] } };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const tab = openProviderSettings(plugin);
		await flush();
		const modal = await manageScreen(tab);
		assert.equal(modalRow(modal, 'gpt-image-1').components[0].value, true);
		assert.equal(modalRow(modal, 'gpt-image-1').components[0].disabled, false);
		await modalRow(modal, 'gpt-image-1').components[0].type(false);
		assert.equal(modalRow(modal, 'gpt-image-1').components[0].disabled, true);
		await modalRow(modal, 'gpt-image-1').components[0].type(true);
		assert.deepEqual(plugin.settings, settings);
		await modalButton(modal, 'Save changes').click();
		assert.equal(plugin.settings.defaultModel, null);
		assert.deepEqual(plugin.settings.providers.openai.models[0], { ...settings.providers.openai.models[0], enabled: false });
		const reopened = await manageScreen(tab);
		assert.equal(modalRow(reopened, 'gpt-image-1').components[0].disabled, true);
		assert.equal(modalRow(reopened, 'gpt-image-1').components[0].value, false);
	});

	test('Manage models shows the full discovery list, labels unavailable tasks and saves staged manual IDs once', async () => {
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
		let modal = await manageScreen(tab);
		const names = settingsIn(modal.listEl).map(setting => setting.name);
		assert.deepEqual(new Set(names), new Set(['saved-model', 'Two', 'One', 'one-2026-10-01', 'whisper-1', 'text-embedding-3-small', 'gpt-image-1']));
		assert.equal(modalRow(modal, 'One').components[0].disabled, false);
		assert.match(modalRow(modal, 'gpt-image-1').desc, /Not a text-generation model/);
		assert.equal(modalRow(modal, 'gpt-image-1').components[0].disabled, true);
		await modalButton(modal, 'Cancel').click();
		assert.equal(disk.writes, 0);
		modal = await manageScreen(tab);
		assert.equal(modalButton(modal, 'Save changes').disabled, true);
		for (const id of ['manual-one', 'manual-two']) {
			const manual = modalRow(modal, 'Model ID');
			await manual.components[0].type(id);
			await manual.components[1].click();
		}
		await modalButton(modal, 'Save changes').click();
		assert.equal(modal.isOpen, false);
		assert.equal(disk.writes, 1);
		assert.deepEqual(plugin.settings.defaultModel, settings.defaultModel);
		assert.equal(plugin.settings.providers.openai.models[0].maxOutputTokens, 6000);
		assert.deepEqual(plugin.settings.providers.openai.models.map(model => model.id), ['saved-model', 'manual-one', 'manual-two']);
	});

	test('Manage models opened during discovery updates when it finishes; dated versions remain searchable', async () => {
		let finish;
		const pending = new Promise(resolve => { finish = resolve; });
		fake.providerHandler = (_, request) => request.url === MODEL_CATALOG_URL
			? { json: { openai: { models: { one: { id: 'new-model' } } } } } : pending;
		const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const modal = await manageScreen(openProviderSettings(plugin));
		assert.match(modal.statusEl.textContent, /Refreshing/);
		finish({ json: { data: [{ id: 'new-model' }, { id: 'new-model-2026-10-01' }] } });
		await flush();
		assert.equal(settingsIn(modal.listEl).length, 2);
		await modalRow(modal, 'Available models').components[0].type('2026');
		assert.deepEqual(settingsIn(modal.listEl).map(setting => setting.name), ['new-model-2026-10-01']);
	});

	test('a failed Manage models save keeps the screen and original settings for retry', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }) }));
		const modal = await manageScreen(openProviderSettings(plugin));
		const manual = modalRow(modal, 'Model ID');
		await manual.components[0].type('future-model');
		await manual.components[1].click();
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		await modalButton(modal, 'Save changes').click();
		assert.equal(modal.isOpen, true);
		assert.equal(modalButton(modal, 'Save changes').disabled, false);
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
		ankiServer();
		const notes = [{ noteType: 'Basic', fields: { Front: 'What changed?', Back: 'The selected model.' } }];
		openai.handler = () => openAiReply(notes);
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(configured()), keychain: makeKeychain('ok', { [SECRET_ID]: KEY, [CLAUDE_SECRET]: KEY }) }));
		await plugin.configureModel('openai', 'changed-after-startup', true);
		run(plugin, 'export-current-file-to-anki');
		const first = fake.modals.at(-1);
		await first.opened;
		const firstModel = modalRow(first, 'Model').components[0];
		assert.equal(firstModel.options[firstModel.value], 'OpenAI · changed-after-startup');
		await modalButton(first, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		assert.equal(openai.requests[0].body.model, 'changed-after-startup');
		fake.modals.at(-1).close();
		const count = fake.modals.length;
		await plugin.configureModel('anthropic', 'claude-model', true);
		fake.providerHandler = () => ({ json: { type: 'message', role: 'assistant', stop_reason: 'end_turn',
			content: [{ type: 'text', text: JSON.stringify({ notes, note_issues: [] }) }] } });
		run(plugin, 'export-current-file-to-anki');
		assert.equal(fake.modals.length, count + 1);
		const second = fake.modals.at(-1);
		await second.opened;
		const secondModel = modalRow(second, 'Model').components[0];
		assert.equal(secondModel.options[secondModel.value], 'Claude · claude-model');
		await modalButton(second, 'Generate Anki notes').click();
		assert.equal(fake.providerRequests.length, 1);
		assert.equal(fake.providerRequests[0].url, 'https://api.anthropic.com/v1/messages');
		assert.equal(fake.providerRequests[0].body.model, 'claude-model');
		assert.equal(openai.requests.length, 1, 'the Claude run must not send another OpenAI request');
	});
});

describe('settings UI discovery reuse', () => {
	test('definition builds resolve each provider once, retain model preferences and keep callbacks fresh', async () => {
		const settings = configured();
		settings.providers.openai.models = Array.from({ length: 30 }, (_, index) => ({
			...createModelSettings(index ? `saved-${index}` : 'saved-model'),
			enabled: index === 0, maxOutputTokens: 6000, reasoningEffort: 'saved-effort',
			capabilities: { reasoningEfforts: ['reported-effort'] },
		}));
		const keychain = makeKeychain('ok', { [SECRET_ID]: KEY });
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(settings), keychain }));
		const page = new ProviderSettings(plugin.app, plugin, plugin.settingTabs[0]);
		const getModels = plugin.discovery.getModels.bind(plugin.discovery);
		const calls = [];
		plugin.discovery.getModels = (...args) => { calls.push(args[0]); return getModels(...args); };
		const definitions = page.definitions();
		assert.deepEqual(calls, ['openai', 'anthropic']);
		assert.equal(fake.providerRequests.length, 0, 'building definitions must not start discovery requests');
		const models = definitions.find(item => item.name === 'OpenAI').items.find(item => item.heading === 'Your models').items;
		assert.equal(models.length, 1);
		assert.equal(models[0].name, 'saved-model');
		const saved = models[0];
		const effort = saved.items.find(item => item.name === 'Reasoning effort');
		assert.deepEqual(effort.control.options, {
			default: 'Model default', 'reported-effort': 'Reported-effort', 'saved-effort': 'Saved-effort (not reported for this model)',
		});
		assert.equal(page.getValue(saved.items.find(item => item.name === 'Maximum output tokens').control.key), 6000);
		assert.equal(saved.displayValue(), 'Default model');

		plugin.settings = structuredClone(plugin.settings);
		plugin.settings.defaultModel = null;
		plugin.settings.providers.openai.models[0].enabled = false;
		plugin.settings.providers.openai.models[0].maxOutputTokens = 7000;
		plugin.settings.providers.openai.models[0].capabilities.reasoningEfforts = ['new-effort'];
		assert.ok(!saved.items.some(item => item.name === 'Show in model picker'));
		plugin.settings.providers.openai.models[0].enabled = true;
		assert.equal(saved.displayValue(), 'Enabled');
		assert.equal(page.getValue(saved.items.find(item => item.name === 'Maximum output tokens').control.key), 7000);
		plugin.settingsStore.canSave = false;
		assert.equal(effort.control.disabled(), true);
		keychain.secrets.delete(SECRET_ID);
		assert.equal(saved.items.find(item => item.name === 'Use as default model').visible(), false);

		calls.length = 0;
		const rebuilt = page.definitions();
		assert.deepEqual(calls, ['openai', 'anthropic'], 'reuse must be local to each build');
		const rebuiltModels = rebuilt.find(item => item.name === 'OpenAI').items.find(item => item.heading === 'Your models').items;
		const rebuiltEffort = rebuiltModels.find(item => item.name === 'saved-model').items.find(item => item.name === 'Reasoning effort');
		assert.ok('new-effort' in rebuiltEffort.control.options);
		assert.ok(!('reported-effort' in rebuiltEffort.control.options));
	});

	test('Manage models discovers once per render and preserves explicit deltas across concurrent edits', async () => {
		const settings = configured();
		settings.providers.openai.models.push({ ...createModelSettings('hidden'), enabled: false, maxOutputTokens: 6000 });
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(settings) }));
		const getModels = plugin.discovery.getModels.bind(plugin.discovery);
		let calls = 0;
		plugin.discovery.getModels = (...args) => { calls++; return getModels(...args); };
		const modal = new ManageModelsModal(plugin.app, plugin, 'openai', async () => {}, () => undefined);
		modal.open();
		assert.equal(calls, 1);
		assert.deepEqual(settingsIn(modal.listEl).map(setting => setting.name), ['saved-model', 'hidden']);
		assert.equal(modalRow(modal, 'saved-model').components[0].disabled, false);
		assert.equal(modalRow(modal, 'hidden').components[0].disabled, false);
		await modalRow(modal, 'hidden').components[0].type(true);
		const manual = modalRow(modal, 'Model ID');
		await manual.components[0].type('manual-model');
		await manual.components[1].click();
		assert.ok(modalButton(modal, 'Save changes'));

		await plugin.updateSettings(settings => {
			settings.providers.openai.models[0].enabled = false;
			settings.providers.openai.models.push(createModelSettings('manual-model'));
		});
		calls = 0;
		await modalRow(modal, 'Available models').components[0].type('');
		assert.equal(calls, 1);
		assert.equal(modalRow(modal, 'saved-model').components[0].disabled, false);
		assert.equal(modalRow(modal, 'saved-model').components[0].value, false);
		assert.equal(modalRow(modal, 'manual-model').components[0].disabled, false);
		assert.equal(modalRow(modal, 'manual-model').components[0].value, true);
		assert.equal(modalRow(modal, 'hidden').components[0].value, true);
		assert.equal(modalButton(modal, 'Save changes').disabled, false, 'staged choices stay pending even when enabled elsewhere');
		assert.equal(plugin.settings.providers.openai.models[1].maxOutputTokens, 6000);
		await plugin.updateModelSelection('openai', new Map([['manual-model', false], ['unrelated', true]]));
		await modalRow(modal, 'Available models').components[0].type('');
		assert.equal(modalRow(modal, 'manual-model').components[0].value, true, 'an explicit enable must survive an intervening enable and disable');
		await modalButton(modal, 'Save changes').click();
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'manual-model').enabled, true);
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'hidden').enabled, true);
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'saved-model').enabled, false, 'an untouched concurrent disable must survive');
		assert.equal(plugin.settings.providers.openai.models.find(model => model.id === 'unrelated').enabled, true, 'an unrelated concurrent enable must survive');
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

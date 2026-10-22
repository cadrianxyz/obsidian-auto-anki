// Moving the OpenAI API key out of data.json (0.2.x) into Obsidian's Keychain (0.3.0+).
//
// The rules being tested:
// - A key in data.json ends up in this device's Keychain, then leaves data.json.
// - data.json loses the key only once the Keychain is known to hold a key. If the Keychain
//   is missing, ignores writes or throws, the key stays where it was and the user is told.
// - Nothing else in data.json is lost.
// - It happens once: later loads change nothing and show nothing.
// - A synced data.json that still has a key (from a device on 0.2.x) is moved the next time
//   the plugin loads.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { migrateLegacyApiKey } from '../src/utils/api-key';
import { DEFAULT_OPENAI_MODEL } from '../src/settings';
import {
	SECRET_ID, DATA_0_2_1, DATA_0_2_2, DATA_NO_KEY,
	makeDisk, makeKeychain, makeDevice, loadPlugin, readDataJson,
	openSettings, run, resetAll,
} from './helpers.mjs';

const KEY = DATA_0_2_1.openAiApiKey;
const OTHER_KEY = 'sk-proj-NEWKEY1111111111111111111111111111111111aB12';

beforeEach(resetAll);

function noticesMatching(re) {
	return fake.notices.filter((n) => re.test(n));
}

function assertNoKeyInDataJson(disk) {
	const raw = disk.files['data.json'];
	if (raw === undefined) return;
	assert.ok(!raw.includes(KEY) && !raw.includes(OTHER_KEY), 'data.json still contains an API key');
	const data = JSON.parse(raw);
	assert.ok(!('openAiApiKey' in data), 'data.json still has openAiApiKey');
	assert.ok(!('openAiApiKeyIdentifier' in data), 'data.json still has openAiApiKeyIdentifier');
}

describe('migrateLegacyApiKey', () => {
	const app = (keychain) => (keychain === null ? {} : { secretStorage: keychain });

	test('no key fields: nothing to do, data untouched', () => {
		const data = { ankiConnectPort: 8765 };
		const kc = makeKeychain();
		assert.equal(migrateLegacyApiKey(app(kc), data), 'nothing');
		assert.deepEqual(data, { ankiConnectPort: 8765 });
		assert.equal(kc.calls.set, 0);
	});

	for (const [label, fields] of [
		['key never entered (null)', { openAiApiKey: null, openAiApiKeyIdentifier: '' }],
		['empty key', { openAiApiKey: '' }],
		['whitespace key', { openAiApiKey: '   \n' }],
		['only the masked identifier', { openAiApiKeyIdentifier: 'sk-...fEk6' }],
		['key that is not text', { openAiApiKey: 12345 }],
	]) {
		test(`${label}: empty fields removed, Keychain not written`, () => {
			const data = { deck: 'x', ...fields };
			const kc = makeKeychain();
			assert.equal(migrateLegacyApiKey(app(kc), data), 'cleaned');
			assert.deepEqual(data, { deck: 'x' });
			assert.equal(kc.calls.set, 0);
		});
	}

	test('key and an empty Keychain: moved', () => {
		const data = { openAiApiKey: KEY, openAiApiKeyIdentifier: 'sk-...fEk6', deck: 'x' };
		const kc = makeKeychain();
		assert.equal(migrateLegacyApiKey(app(kc), data), 'moved');
		assert.equal(kc.secrets.get(SECRET_ID), KEY);
		assert.deepEqual(data, { deck: 'x' });
	});

	test('key with spaces or a newline around it is stored trimmed', () => {
		const data = { openAiApiKey: `  ${KEY}\n` };
		const kc = makeKeychain();
		assert.equal(migrateLegacyApiKey(app(kc), data), 'moved');
		assert.equal(kc.secrets.get(SECRET_ID), KEY);
	});

	test('Keychain already holds the same key: fields removed', () => {
		const data = { openAiApiKey: KEY };
		const kc = makeKeychain('ok', { [SECRET_ID]: KEY });
		assert.equal(migrateLegacyApiKey(app(kc), data), 'moved');
		assert.deepEqual(data, {});
	});

	test('Keychain holds a different key: Keychain key kept, data.json key removed', () => {
		const data = { openAiApiKey: KEY };
		const kc = makeKeychain('ok', { [SECRET_ID]: OTHER_KEY });
		assert.equal(migrateLegacyApiKey(app(kc), data), 'kept-keychain');
		assert.equal(kc.secrets.get(SECRET_ID), OTHER_KEY);
		assert.deepEqual(data, {});
	});

	test('Keychain holds only whitespace: counts as empty, key moved', () => {
		const data = { openAiApiKey: KEY };
		const kc = makeKeychain('ok', { [SECRET_ID]: '  ' });
		assert.equal(migrateLegacyApiKey(app(kc), data), 'moved');
		assert.equal(kc.secrets.get(SECRET_ID), KEY);
	});

	test('no Keychain (Obsidian older than 1.11.4): data untouched', () => {
		const data = { openAiApiKey: KEY, openAiApiKeyIdentifier: 'x' };
		assert.equal(migrateLegacyApiKey(app(null), data), 'unavailable');
		assert.deepEqual(data, { openAiApiKey: KEY, openAiApiKeyIdentifier: 'x' });
	});

	test('Keychain ignores the write: data untouched', () => {
		const data = { openAiApiKey: KEY };
		assert.equal(migrateLegacyApiKey(app(makeKeychain('ignores-writes')), data), 'failed');
		assert.equal(data.openAiApiKey, KEY);
	});

	test('Keychain throws on write: reported as failed, data untouched', () => {
		const data = { openAiApiKey: KEY };
		assert.equal(migrateLegacyApiKey(app(makeKeychain('throws-on-write')), data), 'failed');
		assert.equal(data.openAiApiKey, KEY);
	});

	test('Keychain throws on every call: reported as failed, data untouched', () => {
		const data = { openAiApiKey: KEY };
		assert.equal(migrateLegacyApiKey(app(makeKeychain('throws')), data), 'failed');
		assert.equal(data.openAiApiKey, KEY);
	});

	test('running it twice: the second run has nothing to do', () => {
		const data = { openAiApiKey: KEY };
		const kc = makeKeychain();
		migrateLegacyApiKey(app(kc), data);
		assert.equal(migrateLegacyApiKey(app(kc), data), 'nothing');
	});
});

describe('loading the plugin', () => {
	test('fresh install: writes nothing, says nothing, touches no Keychain entry', async () => {
		const kc = makeKeychain();
		const app = makeDevice({ keychain: kc });
		const plugin = await loadPlugin(app);
		assert.equal(app.disk.writes, 0);
		assert.deepEqual(fake.notices, []);
		assert.equal(kc.calls.set, 0);
		assert.equal(plugin.settingTabs.length, 1);
		assert.equal(plugin.commands.length, 2);
	});

	for (const [version, data] of [['0.1.0 to 0.2.1', DATA_0_2_1], ['0.2.2', DATA_0_2_2]]) {
		test(`upgrade from ${version}: key moved, every other setting kept`, async () => {
			const kc = makeKeychain();
			const app = makeDevice({ disk: makeDisk(data), keychain: kc });
			await loadPlugin(app);

			assert.equal(kc.secrets.get(SECRET_ID), KEY);
			assertNoKeyInDataJson(app.disk);
			const after = readDataJson(app.disk);
			assert.equal(after.ankiConnectPort, 8765);
			assert.equal(after.ankiDestinationDeck, 'Biology');
			assert.deepEqual(after.questionGenerationDefaults, data.questionGenerationDefaults);
			assert.equal(after.openAiModel, data.openAiModel ?? DEFAULT_OPENAI_MODEL);
			assert.ok(!('gptAdvancedOptions' in after), 'old sampling settings left in data.json');

			assert.equal(noticesMatching(/moved your OpenAI API key/).length, 1);
			assert.equal(noticesMatching(/consider replacing the key/).length, 1);
			// The sliders were at their defaults, so there's nothing to say about them.
			assert.equal(noticesMatching(/temperature/).length, 0);
		});
	}

	test('restart after upgrading: nothing written, nothing shown', async () => {
		const disk = makeDisk(DATA_0_2_2);
		const kc = makeKeychain();
		await loadPlugin(makeDevice({ disk, keychain: kc }));
		const writes = disk.writes;
		const snapshot = disk.files['data.json'];
		resetAll();
		await loadPlugin(makeDevice({ disk, keychain: kc }));
		assert.equal(disk.writes, writes);
		assert.equal(disk.files['data.json'], snapshot);
		assert.deepEqual(fake.notices, []);
	});

	test('upgrade from 0.3.0: nothing to migrate, nothing written, nothing shown', async () => {
		const data030 = {
			ankiConnectPort: 8765,
			ankiDestinationDeck: 'Biology',
			openAiModel: 'gpt-6-luna',
			generation: { reasoningEffort: 'low', maxOutputTokens: 16000 },
			questionGenerationDefaults: { textSelection: { numQuestions: 1, numAlternatives: 0 }, file: { numQuestions: 5, numAlternatives: 0 } },
		};
		const kc = makeKeychain('ok', { [SECRET_ID]: OTHER_KEY });
		const app = makeDevice({ disk: makeDisk(data030), keychain: kc });
		const plugin = await loadPlugin(app);
		assert.equal(app.disk.writes, 0);
		assert.deepEqual(fake.notices, []);
		assert.deepEqual(plugin.settings, data030);
		assert.equal(kc.calls.set, 0);
	});

	test('upgrade where no key was ever entered: empty fields removed, no key notice', async () => {
		const kc = makeKeychain();
		const app = makeDevice({ disk: makeDisk(DATA_NO_KEY), keychain: kc });
		await loadPlugin(app);
		assertNoKeyInDataJson(app.disk);
		assert.equal(kc.calls.set, 0);
		assert.equal(noticesMatching(/API key/).length, 0);
	});

	test('upgrade with the sampling sliders moved: the user is told they were removed', async () => {
		const data = { ...DATA_0_2_2, gptAdvancedOptions: { ...DATA_0_2_2.gptAdvancedOptions, temperature: 0.4 } };
		await loadPlugin(makeDevice({ disk: makeDisk(data) }));
		assert.equal(noticesMatching(/removed its temperature/).length, 1);
	});

	test('unknown fields (from a newer version) survive the migration', async () => {
		const app = makeDevice({ disk: makeDisk({ ...DATA_0_2_2, someFutureSetting: { a: 1 } }) });
		await loadPlugin(app);
		assert.deepEqual(readDataJson(app.disk).someFutureSetting, { a: 1 });
	});

	for (const mode of ['ignores-writes', 'throws-on-write', 'throws']) {
		test(`Keychain that ${mode}: plugin still loads, key stays in data.json, user told each load`, async () => {
			const disk = makeDisk(DATA_0_2_2);
			const app = makeDevice({ disk, keychain: makeKeychain(mode) });
			const plugin = await loadPlugin(app);
			assert.equal(plugin.settingTabs.length, 1);
			assert.equal(plugin.commands.length, 2);
			assert.equal(readDataJson(disk).openAiApiKey, KEY);
			assert.equal(noticesMatching(/could not move your OpenAI API key/).length, 1);

			resetAll();
			await loadPlugin(makeDevice({ disk, keychain: makeKeychain(mode) }));
			assert.equal(readDataJson(disk).openAiApiKey, KEY);
			assert.equal(noticesMatching(/could not move your OpenAI API key/).length, 1);
		});
	}

	test('no Keychain (older Obsidian): plugin loads, key stays, user told, key box disabled', async () => {
		const disk = makeDisk(DATA_0_2_2);
		const plugin = await loadPlugin(makeDevice({ disk, keychain: null }));
		assert.equal(readDataJson(disk).openAiApiKey, KEY);
		assert.equal(noticesMatching(/needs Obsidian 1\.11\.4 or newer/).length, 1);

		const tab = openSettings(plugin);
		const keyBox = tab.containerEl.all().find((e) => e.setting?.name === 'OpenAI API key').setting.components[0];
		assert.equal(keyBox.disabled, true);
	});

	test('Keychain already holds a different key: that one is used, and the user is told', async () => {
		const kc = makeKeychain('ok', { [SECRET_ID]: OTHER_KEY });
		const app = makeDevice({ disk: makeDisk(DATA_0_2_2), keychain: kc });
		await loadPlugin(app);
		assert.equal(kc.secrets.get(SECRET_ID), OTHER_KEY);
		assertNoKeyInDataJson(app.disk);
		assert.equal(noticesMatching(/different key/).length, 1);
	});
});

describe('a synced vault: one data.json, a Keychain per device', () => {
	test('device A upgrades; device B then needs the key once, and asks for it clearly', async () => {
		const disk = makeDisk(DATA_0_2_2);
		const kcA = makeKeychain();
		const kcB = makeKeychain();
		await loadPlugin(makeDevice({ disk, keychain: kcA }));
		assert.equal(kcA.secrets.get(SECRET_ID), KEY);

		resetAll();
		const b = await loadPlugin(makeDevice({ disk, keychain: kcB }));
		assert.deepEqual(fake.notices, [], 'B has nothing to migrate');
		run(b, 'export-current-file-to-anki');
		assert.equal(fake.modals.length, 0);
		assert.match(fake.notices[0], /No OpenAI API key on this device/);

		// B enters the key in the settings: it goes into B's Keychain, never data.json.
		const tab = openSettings(b);
		const keyBox = tab.containerEl.all().find((e) => e.setting?.name === 'OpenAI API key').setting.components[0];
		await keyBox.type(KEY);
		assert.equal(kcB.secrets.get(SECRET_ID), KEY);
		assertNoKeyInDataJson(disk);
	});

	test('a device still on 0.2.x saves a key into the synced data.json: moved here on the next load', async () => {
		const disk = makeDisk();
		const kc = makeKeychain();
		await loadPlugin(makeDevice({ disk, keychain: kc }));
		disk.files['data.json'] = JSON.stringify(DATA_0_2_2); // the sync brings it in
		resetAll();
		await loadPlugin(makeDevice({ disk, keychain: kc })); // Obsidian restarts
		assert.equal(kc.secrets.get(SECRET_ID), KEY);
		assertNoKeyInDataJson(disk);
		assert.equal(noticesMatching(/moved your OpenAI API key/).length, 1);
	});

	test('the same, when this device already has a different key: this device keeps its own', async () => {
		const disk = makeDisk();
		const kc = makeKeychain('ok', { [SECRET_ID]: OTHER_KEY });
		await loadPlugin(makeDevice({ disk, keychain: kc }));
		disk.files['data.json'] = JSON.stringify(DATA_0_2_2);
		resetAll();
		await loadPlugin(makeDevice({ disk, keychain: kc }));
		assert.equal(kc.secrets.get(SECRET_ID), OTHER_KEY);
		assertNoKeyInDataJson(disk);
		assert.equal(noticesMatching(/different key/).length, 1);
	});
});

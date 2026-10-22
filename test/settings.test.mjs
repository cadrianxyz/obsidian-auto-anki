// Reading data.json, and the settings screen (above all the API key box).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { DEFAULT_SETTINGS, DEFAULT_OPENAI_MODEL } from '../src/settings';
import {
	SECRET_ID, DATA_0_2_2,
	makeDisk, makeKeychain, makeDevice, loadPlugin, readDataJson, openSettings, resetAll,
} from './helpers.mjs';

const KEY = 'sk-proj-ENTERED22222222222222222222222222222222zZ99';
const DEFAULTS_SNAPSHOT = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

// Settings as 0.3.x saves them. Tests that change settings start from this rather than from
// a fresh install, so each one gets its own settings to change.
const SAVED_0_3 = Object.freeze({
	ankiConnectPort: 8765,
	ankiDestinationDeck: '',
	openAiModel: DEFAULT_OPENAI_MODEL,
	generation: { reasoningEffort: 'default', maxOutputTokens: 16000 },
	questionGenerationDefaults: { textSelection: { numQuestions: 1, numAlternatives: 0 }, file: { numQuestions: 5, numAlternatives: 0 } },
});

beforeEach(resetAll);

// The settings on the screen, by name; `index` picks between ones with the same name
// (the file and selected-text sections both have "Number of questions").
function control(tab, name, index = 0) {
	const found = tab.containerEl.all().filter((e) => e.setting?.name === name).map((e) => e.setting);
	assert.ok(found[index], `no setting "${name}" #${index}`);
	return found[index].components[0];
}

describe('reading data.json', () => {
	for (const [label, raw] of [
		['a string', '"hello"'],
		['a number', '42'],
		['null', 'null'],
		['an empty object', '{}'],
	]) {
		test(`data.json holding ${label}: defaults are used`, async () => {
			const plugin = await loadPlugin(makeDevice({ disk: makeDisk(raw) }));
			assert.deepEqual(plugin.settings, DEFAULTS_SNAPSHOT);
		});
	}

	test('saved values are kept as they are', async () => {
		const saved = {
			ankiConnectPort: 9999,
			ankiDestinationDeck: 'Spanish::Verbs',
			openAiModel: 'gpt-6-luna-mini',
			generation: { reasoningEffort: 'low', maxOutputTokens: 4000 },
			questionGenerationDefaults: { textSelection: { numQuestions: 2, numAlternatives: 3 }, file: { numQuestions: 10, numAlternatives: 0 } },
		};
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(saved) }));
		assert.deepEqual(plugin.settings, saved);
	});
});

describe('the API key box', () => {
	test('is a password box that says whether this device has a key', async () => {
		const kc = makeKeychain();
		const plugin = await loadPlugin(makeDevice({ keychain: kc }));
		let box = control(openSettings(plugin), 'OpenAI API key');
		assert.equal(box.inputEl.type, 'password');
		assert.equal(box.placeholder, 'No key saved on this device');
		assert.equal(box.value, '', 'the key itself must never be put in the box');

		kc.secrets.set(SECRET_ID, KEY);
		box = control(openSettings(plugin), 'OpenAI API key');
		assert.equal(box.placeholder, 'Key saved: sk-...zZ99');
		assert.equal(box.value, '');
	});

	test('a typed or pasted key goes into the Keychain, trimmed, and never into data.json', async () => {
		const kc = makeKeychain();
		const app = makeDevice({ disk: makeDisk(SAVED_0_3), keychain: kc });
		const plugin = await loadPlugin(app);
		const tab = openSettings(plugin);
		await control(tab, 'OpenAI API key').type(`  ${KEY}\n`);
		assert.equal(kc.secrets.get(SECRET_ID), KEY);
		// Change everything else too, so data.json is written several times.
		await control(tab, 'Anki port').type('8766');
		await control(tab, 'OpenAI model').type('gpt-6-luna-mini');
		await control(tab, 'Default Anki deck').type('Biology');
		await control(tab, 'Number of questions', 0).type('3');
		const raw = app.disk.files['data.json'];
		assert.ok(raw && !raw.includes(KEY), 'data.json contains the key');
		assert.ok(!('openAiApiKey' in JSON.parse(raw)));
	});

	test('clearing the box does not delete the saved key', async () => {
		const kc = makeKeychain('ok', { [SECRET_ID]: KEY });
		const plugin = await loadPlugin(makeDevice({ keychain: kc }));
		await control(openSettings(plugin), 'OpenAI API key').type('   ');
		assert.equal(kc.secrets.get(SECRET_ID), KEY);
	});

	for (const mode of ['ignores-writes', 'throws-on-write', 'throws']) {
		test(`a Keychain that ${mode}: the settings screen still opens, and typing a key doesn't crash`, async () => {
			const plugin = await loadPlugin(makeDevice({ keychain: makeKeychain(mode) }));
			let tab;
			assert.doesNotThrow(() => { tab = openSettings(plugin); });
			const box = control(tab, 'OpenAI API key');
			assert.equal(box.placeholder, 'No key saved on this device');
			await assert.doesNotReject(async () => box.type(KEY));
		});
	}
});

describe('other settings', () => {
	test('saved values are shown; edits are saved to data.json', async () => {
		const app = makeDevice({ disk: makeDisk(DATA_0_2_2) });
		const plugin = await loadPlugin(app);
		const tab = openSettings(plugin);
		assert.equal(control(tab, 'Anki port').value, '8765');
		assert.equal(control(tab, 'OpenAI model').value, 'gpt-6-luna-mini');
		assert.equal(control(tab, 'Default Anki deck').value, 'Biology');
		assert.equal(control(tab, 'Number of questions', 0).value, '7');
		assert.equal(control(tab, 'Number of questions', 1).value, '2');
		assert.equal(control(tab, 'Reasoning effort').value, 'default');

		await control(tab, 'Reasoning effort').type('medium');
		await control(tab, 'Maximum output tokens').type('8000');
		await control(tab, 'Number of alternatives', 1).type('2');
		const saved = readDataJson(app.disk);
		assert.deepEqual(saved.generation, { reasoningEffort: 'medium', maxOutputTokens: 8000 });
		assert.equal(saved.questionGenerationDefaults.textSelection.numAlternatives, 2);
	});

	test('an empty model box means the default model', async () => {
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(SAVED_0_3) }));
		await control(openSettings(plugin), 'OpenAI model').type('  ');
		assert.equal(plugin.settings.openAiModel, DEFAULT_OPENAI_MODEL);
	});

	test('a count that is not a number is refused', async () => {
		const plugin = await loadPlugin(makeDevice({ disk: makeDisk(SAVED_0_3) }));
		const tab = openSettings(plugin);
		resetAll();
		await control(tab, 'Number of questions', 0).type('abc');
		assert.equal(plugin.settings.questionGenerationDefaults.file.numQuestions, 5);
		assert.equal(fake.notices.length, 1);
	});
});

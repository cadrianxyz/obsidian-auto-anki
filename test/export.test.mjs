// The two commands and the export flow: note → OpenAI → pick questions → pick deck → Anki.
//
// Throughout, notes are read-only (the fake vault and editor throw on any change), and
// Anki receives metadata reads and addNote: nothing that edits or deletes existing data.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, buttonsIn, settingsIn } from 'obsidian';
import {
	SECRET_ID, makeDisk, makeKeychain, makeDevice, loadPlugin, openProviderSettings as openSettings, run, isOffered,
	openai, openAiReply, openAiError, ankiServer, ankiActionsSent, resetAll,
	BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE, readDataJson, flush,
} from './helpers.mjs';
import { createDefaultSettings, createModelSettings } from '../src/settings/schema';

const KEY = 'sk-proj-EXPORT3333333333333333333333333333333333cC33';
const NOTES = [
	{ q: 'What is a radix?', a: 'The number of unique digits in a positional system.' },
	{ q: 'Base of binary?', a: '2' },
	{ q: 'Base of hexadecimal?', a: '16' },
];
const FILE = 'export-current-file-to-anki';
const SELECTION = 'export-text-selection-to-anki';

beforeEach(resetAll);

async function device({ settings, keychain = makeKeychain('ok', { [SECRET_ID]: KEY }), activeNote } = {}) {
	return loadPlugin(makeDevice({ disk: makeDisk(settings ?? { openAiModel: 'gpt-6-luna' }), keychain, activeNote }));
}

function button(modal, text) {
	const b = buttonsIn(modal.contentEl).find((x) => x.text === text);
	assert.ok(b, `no "${text}" button; have: ${buttonsIn(modal.contentEl).map((x) => x.text).join(', ')}`);
	return b;
}

function textBox(modal, name) {
	return settingsIn(modal.contentEl).find((s) => s.name === name).components[0];
}

async function waitForPreparation(modal) {
	const dropdown = textBox(modal, 'Model');
	for (let attempt = 0; dropdown.disabled && attempt < 100; attempt++) await flush();
	assert.equal(dropdown.disabled, false, 'model preparation did not reenable controls');
	assert.equal(button(modal, 'Generate Anki notes').disabled, false);
}

async function selectModel(modal, value) {
	await textBox(modal, 'Model').type(value);
	await waitForPreparation(modal);
}

function questionItems(modal) {
	return modal.contentEl.all().filter((e) => e.tagName === 'li' && /question-option/.test(e.className));
}

function deckItems(modal) {
	return modal.contentEl.all().filter((e) => e.tagName === 'li' && /deck-option/.test(e.className));
}

const lastModal = () => fake.modals[fake.modals.length - 1];

// Runs a command and waits for the first window (the one asking how many questions).
async function startExport(plugin, id = FILE) {
	run(plugin, id);
	const modal = lastModal();
	assert.ok(modal, 'no window opened');
	await modal.opened;
	return modal;
}

// From the "how many questions" window to the end, choosing everything offered.
async function exportAll(plugin, { id = FILE, deck } = {}) {
	const ask = await startExport(plugin, id);
	await button(ask, 'Generate Anki notes').click();
	const choose = lastModal();
	assert.notEqual(choose, ask, 'no question window opened');
	for (;;) {
		await button(choose, 'Select all').click();
		const next = buttonsIn(choose.contentEl).find((b) => b.text === 'Next');
		if (!next) break;
		await next.click();
	}
	await button(choose, 'Confirm selection').click();
	const decks = lastModal();
	await decks.opened;
	if (deck) deckItems(decks).find((li) => li.children[0].text === deck).click();
	await button(decks, 'Confirm and export').click();
	return { ask, choose, decks };
}

describe('commands', () => {
	test('both commands are offered with or without a key', async () => {
		for (const keychain of [makeKeychain(), makeKeychain('ok', { [SECRET_ID]: KEY })]) {
			const plugin = await device({ keychain });
			assert.equal(isOffered(plugin, FILE), true);
			assert.equal(isOffered(plugin, SELECTION), true);
		}
	});

	test('"export current file" is not offered without an open note', async () => {
		const plugin = await device({ activeNote: null });
		assert.equal(isOffered(plugin, FILE), false);
	});

	test('without a key: a clear notice, and no window opens', async () => {
		for (const id of [FILE, SELECTION]) {
			resetAll();
			const plugin = await device({ keychain: makeKeychain() });
			run(plugin, id);
			assert.equal(fake.modals.length, 0);
			assert.match(fake.notices[0], /No OpenAI API key on this device/);
		}
	});

	test('a Keychain that throws: commands explain instead of crashing', async () => {
		const plugin = await device({ keychain: makeKeychain('throws') });
		resetAll();
		assert.doesNotThrow(() => run(plugin, FILE));
		assert.equal(fake.modals.length, 0);
		assert.equal(fake.notices.length, 1);
	});

	test('an empty note or no selection: a notice, and nothing is sent anywhere', async () => {
		const plugin = await device({ activeNote: '' });
		run(plugin, FILE);
		run(plugin, SELECTION, '');
		assert.deepEqual(fake.notices, ['There is nothing in the file!', 'No text was selected!']);
		assert.equal(fake.modals.length, 0);
		assert.equal(openai.requests.length, 0);
		assert.equal(fake.ankiRequests.length, 0);
	});

	test('a key added in settings is used straight away, without reloading', async () => {
		const kc = makeKeychain();
		const plugin = await device({ keychain: kc });
		const tab = openSettings(plugin);
		const box = tab.containerEl.all().find((e) => e.setting?.name === 'OpenAI API key').setting.components[0];
		await box.type(KEY);
		await tab.containerEl.all().find(e => e.setting?.name === 'OpenAI API key').setting.components[1].click();
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		await exportAll(plugin);
		assert.equal(openai.requests[0].headers.get('authorization'), `Bearer ${KEY}`);
	});
});

describe('first export screen', () => {
	test('note types and Advanced start collapsed with a plain-text selection summary', async () => {
		ankiServer({ noteTypes: { Basic: BASIC_NOTE_TYPE, Cloze: CLOZE_NOTE_TYPE, Disabled: BASIC_NOTE_TYPE,
			Broken: { ...BASIC_NOTE_TYPE, fields: [] } } });
		const settings = createDefaultSettings();
		settings.anki.enabledNoteTypes = ['Basic', 'Cloze', 'Missing', 'Broken'];
		settings.providers.openai.models = [createModelSettings('first'), { ...createModelSettings('hidden'), enabled: false }, createModelSettings('second')];
		settings.providers.anthropic.models = [createModelSettings('no-local-key')];
		settings.defaultModel = { providerId: 'openai', modelId: 'second' };
		const ask = await startExport(await device({ settings }));
		assert.equal(ask.modalEl.classList.contains('auto-anki-export'), true);
		const disclosures = ask.contentEl.children.filter(element => element.tagName === 'details');
		const [noteTypes, advanced] = disclosures;
		assert.equal(disclosures.length, 2);
		assert.equal(noteTypes.children[0].tagName, 'summary');
		assert.equal(noteTypes.children[0].text, 'Note types: Basic, Cloze');
		assert.equal(noteTypes.children[0].children.length, 0, 'selected names are plain text');
		assert.ok(!noteTypes.open, 'note types start collapsed');
		assert.ok(!advanced.open, 'Advanced starts collapsed');
		assert.ok(advanced, 'Advanced disclosure is missing');
		assert.equal(advanced.children[0].tagName, 'summary');
		assert.equal(advanced.children[0].text, 'Advanced');
		assert.deepEqual(settingsIn(advanced).map(row => row.name), ['Model', 'Reasoning effort', 'Maximum notes', 'Extra instructions']);
				const coverage = settingsIn(ask.contentEl).find(row => row.name === 'Coverage');
				assert.ok(coverage, 'Coverage is missing');
				assert.ok(ask.contentEl.children.includes(coverage.settingEl), 'Coverage must be outside Advanced');
				assert.ok(ask.contentEl.children.indexOf(coverage.settingEl) < ask.contentEl.children.indexOf(noteTypes), 'Coverage must precede Note types');
		assert.deepEqual(textBox(ask, 'Model').options, { 0: 'OpenAI · first', 1: 'OpenAI · second' });
		assert.equal(textBox(ask, 'Model').value, '1');
		const status = ask.contentEl.children.find(element => element.tagName === 'p');
		assert.ok(status);
		assert.match(status.className, /\bsetting-item-description\b/);
		assert.match(status.text, /Sends: the note and 0 diagrams/);
		const padding = noteTypes.children.find(element => element.tagName === 'div' && element.className === 'setting-horizontal-padding');
		assert.ok(padding, 'note-type contents need horizontal padding');
		assert.deepEqual(noteTypes.children, [noteTypes.children[0], padding], 'only the summary sits outside the padded contents');
		const description = padding.children.find(element => element.tagName === 'p');
		assert.ok(description, 'note-type description must be inside the padding');
		assert.match(description.className, /\bsetting-item-description\b/);
		assert.match(description.text, /Choose at least one for this run/);
		const rows = settingsIn(noteTypes);
		assert.deepEqual(settingsIn(padding), rows);
		assert.deepEqual(rows.map(row => row.name), ['Basic', 'Cloze']);
		for (const row of rows) {
			assert.equal(row.components.length, 1);
			assert.equal(row.components[0].value, true);
			assert.equal(row.components[0].disabled, false);
			assert.equal(row.desc, undefined, 'field lists must not appear beneath note types');
		}
		assert.doesNotMatch(ask.contentEl.textContent, /\bFront\b|\bBack Extra\b/);
		assert.equal(openai.requests.length + fake.providerRequests.length, 0);
	});

	test('note-type toggles gate generation and filter the request, review and export without saving', async () => {
		const anki = ankiServer({ noteTypes: { Basic: BASIC_NOTE_TYPE, Cloze: CLOZE_NOTE_TYPE } });
		const settings = createDefaultSettings();
		settings.providers.openai.models = [{ ...createModelSettings('test-model'), outputMode: 'json_schema' }];
		settings.defaultModel = { providerId: 'openai', modelId: 'test-model' };
		const plugin = await device({ settings });
		const before = structuredClone(plugin.settings);
		const diskBefore = plugin.app.disk.files['data.json'];
		const writesBefore = plugin.app.disk.writes;
		openai.handler = () => openAiReply([NOTES[0], { noteType: 'Cloze', fields: { Text: 'Binary uses {{c1::base 2}}.', 'Back Extra': '' } }]);
		const ask = await startExport(plugin);
		const summary = ask.contentEl.children.find(element => element.tagName === 'details').children[0];
		assert.equal(summary.text, 'Note types: Basic, Cloze');
		await textBox(ask, 'Basic').type(false);
		assert.equal(summary.text, 'Note types: Cloze');
		assert.equal(button(ask, 'Generate Anki notes').disabled, false);
		await textBox(ask, 'Cloze').type(false);
		assert.equal(summary.text, 'Note types: none selected');
		assert.equal(button(ask, 'Generate Anki notes').disabled, true);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 0);
		await textBox(ask, 'Cloze').type(true);
		assert.equal(summary.text, 'Note types: Cloze');
		assert.equal(button(ask, 'Generate Anki notes').disabled, false);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		const request = openai.requests[0].body;
		assert.deepEqual(request.text.format.schema.properties.notes.items.anyOf.map(item => item.properties.noteType.enum[0]), ['Cloze']);
		assert.match(request.instructions, /"noteType":"Cloze"/);
		assert.doesNotMatch(request.instructions, /"noteType":"Basic"/);
		const choose = lastModal();
		assert.notEqual(choose, ask);
		assert.equal(questionItems(choose).length, 1, 'a reply using an unselected type is rejected');
		assert.match(choose.contentEl.textContent, /Binary uses/);
		assert.doesNotMatch(choose.contentEl.textContent, /What is a radix/);
		await button(choose, 'Select all').click();
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		await button(decks, 'Confirm and export').click();
		assert.deepEqual(anki.added.map(note => note.modelName), ['Cloze']);
		assert.deepEqual(plugin.settings, before);
		assert.equal(plugin.app.disk.files['data.json'], diskBefore);
		assert.equal(plugin.app.disk.writes, writesBefore);
	});

	test('switching enabled models uses per-model parameters and caches the format on the selected model only', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const settings = createDefaultSettings();
		settings.providers.openai.models = [
			{ ...createModelSettings('default-model'), maxOutputTokens: 1234, reasoningEffort: 'low' },
			{ ...createModelSettings('run-model'), maxOutputTokens: 4321, reasoningEffort: 'high' },
		];
		settings.defaultModel = { providerId: 'openai', modelId: 'default-model' };
		const plugin = await device({ settings });
		const before = structuredClone(plugin.settings);
		const writesBefore = plugin.app.disk.writes;
		const ask = await startExport(plugin);
		assert.equal(textBox(ask, 'Model').value, '0');
		await selectModel(ask, '1');
		assert.deepEqual(plugin.settings, before);
		assert.equal(plugin.app.disk.writes, writesBefore, 'choosing a model must not save it as default');
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		const request = openai.requests[0];
		assert.equal(request.headers.get('authorization'), `Bearer ${KEY}`);
		assert.equal(request.body.model, 'run-model');
		assert.equal(request.body.max_output_tokens, 4321);
		assert.equal(request.body.reasoning.effort, 'high');
		const expected = structuredClone(before);
		expected.providers.openai.models[1].capabilities = { outputMode: 'json_schema' };
		assert.deepEqual(plugin.settings, expected);
		assert.deepEqual(readDataJson(plugin.app.disk), expected);
		lastModal().close();
		const next = await startExport(plugin);
		assert.equal(textBox(next, 'Model').value, '0', 'the next run still starts with the saved default');
	});

	test('switching providers with the same model ID uses the selected key and settings, not the default provider', async () => {
		ankiServer();
		const settings = createDefaultSettings();
		settings.providers.openai.models = [{ ...createModelSettings('shared-id'), maxOutputTokens: 1234, reasoningEffort: 'high' }];
		settings.providers.anthropic.models = [{ ...createModelSettings('shared-id'), maxOutputTokens: 4321, reasoningEffort: 'low' }];
		settings.defaultModel = { providerId: 'openai', modelId: 'shared-id' };
		const claudeKey = 'sk-ant-export-regression';
		const plugin = await device({ settings, keychain: makeKeychain('ok', { [SECRET_ID]: KEY, 'auto-anki-anthropic-api-key': claudeKey }) });
		const before = structuredClone(plugin.settings);
		fake.providerHandler = () => ({ json: { type: 'message', role: 'assistant', stop_reason: 'end_turn',
			content: [{ type: 'text', text: JSON.stringify({ notes: [{ noteType: 'Basic', fields: { Front: NOTES[0].q, Back: NOTES[0].a } }], note_issues: [] }) }] } });
		const ask = await startExport(plugin);
		assert.deepEqual(textBox(ask, 'Model').options, { 0: 'OpenAI · shared-id', 1: 'Claude · shared-id' });
		await selectModel(ask, '1');
		assert.deepEqual(plugin.settings, before);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 0);
		assert.equal(fake.providerRequests.length, 1);
		const request = fake.providerRequests[0];
		assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
		assert.equal(request.headers.authorization, `Bearer ${claudeKey}`);
		assert.equal(request.body.model, 'shared-id');
		assert.equal(request.body.max_tokens, 4321);
		assert.equal(request.body.output_config.effort, 'low');
		const expected = structuredClone(before);
		expected.providers.anthropic.models[0].capabilities = { outputMode: 'json_schema' };
		assert.deepEqual(plugin.settings, expected);
		assert.deepEqual(readDataJson(plugin.app.disk), expected);
		assert.notEqual(lastModal(), ask);
		assert.equal(questionItems(lastModal()).length, 1);
	});

	test('per-run reasoning choices follow each model and rebuild the reported options without saving', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const settings = createDefaultSettings();
		settings.providers.openai.models = [
			{ ...createModelSettings('first'), outputMode: 'json_schema', reasoningEffort: 'low', capabilities: { reasoningEfforts: ['low', 'high'] } },
			{ ...createModelSettings('second'), outputMode: 'json_schema', capabilities: { reasoningEfforts: ['future'] } },
		];
		settings.defaultModel = { providerId: 'openai', modelId: 'first' };
		const plugin = await device({ settings });
		const before = structuredClone(plugin.settings);
		const diskBefore = plugin.app.disk.files['data.json'];
		const writesBefore = plugin.app.disk.writes;
		const ask = await startExport(plugin);
		const effort = textBox(ask, 'Reasoning effort');
		assert.deepEqual(effort.options, { default: 'Model default', low: 'Low', high: 'High' });
		assert.equal(effort.value, 'low');
		await effort.type('high');
		assert.deepEqual(plugin.settings, before, 'editing the initially selected model must use a clone too');
		await selectModel(ask, '1');
		assert.equal(textBox(ask, 'Reasoning effort'), effort, 'rebuild the existing dropdown');
		assert.deepEqual(effort.options, { default: 'Model default', future: 'Future' }, 'old model options must be cleared');
		assert.equal(effort.value, 'default');
		await effort.type('future');
		await selectModel(ask, '0');
		assert.deepEqual(effort.options, { default: 'Model default', low: 'Low', high: 'High' });
		assert.equal(effort.value, 'high');
		await selectModel(ask, '1');
		assert.deepEqual(effort.options, { default: 'Model default', future: 'Future' });
		assert.equal(effort.value, 'future', 'each model retains its choice for this run');
		assert.deepEqual(plugin.settings, before);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		assert.equal(openai.requests[0].body.model, 'second');
		assert.equal(openai.requests[0].body.reasoning.effort, 'future');
		assert.deepEqual(plugin.settings, before);
		assert.equal(plugin.app.disk.files['data.json'], diskBefore);
		assert.equal(plugin.app.disk.writes, writesBefore);
		lastModal().close();
		const next = await startExport(plugin);
		assert.equal(textBox(next, 'Model').value, '0');
		assert.equal(textBox(next, 'Reasoning effort').value, 'low', 'the next run starts with saved effort');
	});

	test('Model default omits reasoning from the request without changing the saved effort', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const settings = createDefaultSettings();
		settings.providers.openai.models = [{ ...createModelSettings('default-effort'), outputMode: 'json_schema', reasoningEffort: 'high', capabilities: { reasoningEfforts: ['high'] } }];
		settings.defaultModel = { providerId: 'openai', modelId: 'default-effort' };
		const plugin = await device({ settings });
		const before = structuredClone(plugin.settings);
		const diskBefore = plugin.app.disk.files['data.json'];
		const writesBefore = plugin.app.disk.writes;
		const ask = await startExport(plugin);
		await textBox(ask, 'Reasoning effort').type('default');
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		assert.equal(Object.hasOwn(openai.requests[0].body, 'reasoning'), false);
		assert.deepEqual(plugin.settings, before);
		assert.equal(plugin.app.disk.files['data.json'], diskBefore);
		assert.equal(plugin.app.disk.writes, writesBefore);
	});

	test('an unreported saved effort stays labelled and usable, but newly choosing an unsupported level is ignored', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const settings = createDefaultSettings();
		settings.providers.openai.models = [{ ...createModelSettings('unreported'), outputMode: 'json_schema', reasoningEffort: 'saved-level' }];
		settings.defaultModel = { providerId: 'openai', modelId: 'unreported' };
		const plugin = await device({ settings });
		const before = structuredClone(plugin.settings);
		const diskBefore = plugin.app.disk.files['data.json'];
		const writesBefore = plugin.app.disk.writes;
		const ask = await startExport(plugin);
		const effort = textBox(ask, 'Reasoning effort');
		assert.deepEqual(effort.options, { default: 'Model default', 'saved-level': 'Saved-level (not reported for this model)' });
		assert.equal(effort.value, 'saved-level');
		await effort.type('not-supported');
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests[0].body.reasoning.effort, 'saved-level', 'invalid input must not replace the saved unsupported level');
		lastModal().close();
		const next = await startExport(plugin);
		await textBox(next, 'Reasoning effort').type('default');
		await textBox(next, 'Reasoning effort').type('saved-level');
		await button(next, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 2);
		assert.equal(Object.hasOwn(openai.requests[1].body, 'reasoning'), false, 'a relinquished unreported level cannot be newly selected');
		assert.deepEqual(plugin.settings, before);
		assert.equal(plugin.app.disk.files['data.json'], diskBefore);
		assert.equal(plugin.app.disk.writes, writesBefore);
	});

	test('reasoning effort is disabled during preparation and generation, and edits while disabled are ignored', async () => {
		ankiServer();
		const settings = createDefaultSettings();
		settings.providers.openai.models = [{ ...createModelSettings('busy-model'), outputMode: 'json_schema', reasoningEffort: 'low', capabilities: { reasoningEfforts: ['low', 'high'] } }];
		settings.defaultModel = { providerId: 'openai', modelId: 'busy-model' };
		const plugin = await device({ settings });
		const before = structuredClone(plugin.settings);
		const writesBefore = plugin.app.disk.writes;
		const ankiHandler = fake.ankiHandler;
		let finishPreparation;
		const preparing = new Promise(resolve => { finishPreparation = resolve; });
		fake.ankiHandler = async body => {
			if (body.action !== 'deckNames') await preparing;
			return ankiHandler(body);
		};
		run(plugin, FILE);
		const ask = lastModal();
		for (let attempt = 0; !settingsIn(ask.contentEl).some(row => row.name === 'Model') && attempt < 100; attempt++) await flush();
		let effort;
		try {
			effort = textBox(ask, 'Reasoning effort');
			assert.equal(effort.disabled, true, 'effort must be a tracked preparation control');
			assert.equal(button(ask, 'Generate Anki notes').disabled, true);
			await effort.type('high');
		} finally {
			finishPreparation();
			await ask.opened;
		}
		await waitForPreparation(ask);
		assert.equal(effort.disabled, false);
		let finishGeneration;
		const generating = new Promise(resolve => { finishGeneration = resolve; });
		openai.handler = async () => { await generating; return openAiReply(NOTES); };
		const pending = button(ask, 'Generate Anki notes').click();
		try {
			assert.equal(effort.disabled, true, 'effort must be a tracked generation control');
			await effort.type('high');
			for (let attempt = 0; !openai.requests.length && attempt < 100; attempt++) await flush();
			assert.equal(openai.requests.length, 1);
			assert.equal(openai.requests[0].body.reasoning.effort, 'low');
		} finally {
			finishGeneration();
			await pending;
		}
		assert.deepEqual(plugin.settings, before);
		assert.equal(plugin.app.disk.writes, writesBefore);
	});

	test('switching models prepares diagrams again and replaces stale image warnings', async () => {
		ankiServer();
		const settings = createDefaultSettings();
		settings.providers.openai.models = [
			{ ...createModelSettings('text-only'), acceptsImages: 'no' },
			{ ...createModelSettings('image-model'), acceptsImages: 'yes' },
		];
		settings.defaultModel = { providerId: 'openai', modelId: 'text-only' };
		const plugin = await device({ settings, activeNote: 'Study this diagram: ![[missing.png]]' });
		const ask = await startExport(plugin);
		assert.match(ask.contentEl.textContent, /selected model does not accept images/);
		await selectModel(ask, '1');
		assert.match(ask.contentEl.textContent, /missing.png: attachment not found/);
		assert.doesNotMatch(ask.contentEl.textContent, /selected model does not accept images/);
		await selectModel(ask, '0');
		assert.match(ask.contentEl.textContent, /selected model does not accept images/);
		assert.doesNotMatch(ask.contentEl.textContent, /attachment not found/);
		assert.equal(button(ask, 'Generate Anki notes').disabled, false);
		assert.equal(openai.requests.length + fake.providerRequests.length, 0);
	});
});

describe('exporting', () => {
	test('opening generation checks connectivity and available decks with one request', async () => {
		ankiServer();
		const ask = await startExport(await device());
		assert.equal(ask.isOpen, true);
		assert.equal(fake.ankiRequests.filter(request => request.body.action === 'deckNames').length, 1);
		assert.equal(openai.requests.length, 0);
	});
	for (const [reply, message] of [
		[{ result: ['Default'], error: 'collection is unavailable' }, /collection is unavailable/],
		[{ result: ['Default', 123], error: null }, /unreadable deck list/],
		[{ result: null, error: null }, /unreadable deck list/],
	]) test(`invalid deck response blocks generation: ${JSON.stringify(reply)}`, async () => {
		fake.ankiHandler = () => ({ json: reply });
		const ask = await startExport(await device());
		assert.equal(ask.isOpen, false);
		assert.match(fake.notices.at(-1), message);
		assert.equal(openai.requests.length, 0);
	});
	test('Anki not running: a notice, the window closes, OpenAI is never called', async () => {
		const plugin = await device();
		const ask = await startExport(plugin);
		assert.equal(ask.isOpen, false);
		assert.match(fake.notices.join('\n'), /Could not connect to Anki/);
		assert.equal(openai.requests.length, 0);
	});

	test('Anki with no decks: a notice, and OpenAI is never called', async () => {
		ankiServer({ decks: [] });
		const plugin = await device();
		const ask = await startExport(plugin);
		assert.equal(ask.isOpen, false);
		assert.match(fake.notices.join('\n'), /no decks/);
		assert.equal(openai.requests.length, 0);
	});

	test('a whole file, start to finish', async () => {
		const anki = ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device({ settings: { ankiDestinationDeck: 'Biology', openAiModel: 'gpt-6-luna-mini' }, activeNote: '# Numbers\nA radix is…' });
		await exportAll(plugin);

		// What was sent to OpenAI.
		assert.equal(openai.requests.length, 1);
		const req = openai.requests[0];
		assert.match(req.url, /\/responses$/);
		assert.equal(req.headers.get('authorization'), `Bearer ${KEY}`);
		assert.equal(req.body.model, 'gpt-6-luna-mini');
		assert.equal(req.body.n, undefined);
		assert.equal(req.body.max_output_tokens, 25000);
		assert.equal(req.body.text.format.type, 'json_schema');
		assert.equal(req.body.text.format.strict, true);
		assert.equal(req.body.store, false);
		for (const absent of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'reasoning', 'messages', 'previous_response_id']) {
			assert.ok(!(absent in req.body), `${absent} should not be sent`);
		}
		assert.match(req.body.input[0].content[0].text, /A radix is…/);
		assert.match(req.body.instructions, /There is no fixed number of Anki notes/);

		// What was added to Anki: one Basic note per generated entry, in the chosen deck.
		assert.deepEqual(anki.added.map((n) => [n.deckName, n.modelName, n.fields.Front, n.fields.Back]),
			NOTES.map((c) => ['Biology', 'Basic', c.q, c.a]));
		assert.deepEqual(anki.added[0].tags, ['auto-gpt-imported']);
		assert.equal(fake.notices.at(-1), 'Successfully exported 3 note(s) to Anki!');
		assert.deepEqual([...new Set(ankiActionsSent())].sort(), ['addNote', 'canAddNotes', 'deckNames', 'modelFieldDescriptions', 'modelFieldNames', 'modelNamesAndIds', 'modelTemplates', 'multi']);
	});

	test('selected text starts with no fixed maximum notes', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES.slice(0, 1));
		const plugin = await device();
		run(plugin, SELECTION, 'Hexadecimal is base 16.');
		const ask = lastModal();
		await ask.opened;
		assert.equal(textBox(ask, 'Maximum notes').value, '');
		await button(ask, 'Generate Anki notes').click();
		assert.match(openai.requests[0].body.input[0].content[0].text, /Hexadecimal is base 16\./);
				assert.match(openai.requests[0].body.instructions, /There is no fixed number of Anki notes/);
	});

	test('a chosen reasoning effort is sent', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device({ settings: { generation: { reasoningEffort: 'low', maxOutputTokens: 5000 } } });
		await exportAll(plugin);
		assert.equal(openai.requests[0].body.reasoning?.effort, 'low');
		assert.equal(openai.requests[0].body.max_output_tokens, 5000);
	});

	test('literal comparisons, code and line breaks are preserved in Anki text fields', async () => {
		const anki = ankiServer();
		openai.handler = () => openAiReply([{ q: 'When does x < y evaluate to true?', a: 'When x is smaller.\nA <T> & B are literal text.' }]);
		await exportAll(await device());
		assert.equal(anki.added[0].fields.Front, 'When does x &lt; y evaluate to true?');
		assert.equal(anki.added[0].fields.Back, 'When x is smaller.<br>A &lt;T&gt; &amp; B are literal text.');
	});

	test('the default deck is preselected; another can be picked', async () => {
		const anki = ankiServer({ decks: ['Default', 'Biology', 'Chemistry'] });
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device({ settings: { ankiDestinationDeck: 'Biology' } });
		const ask = await startExport(plugin);
		await button(ask, 'Generate Anki notes').click();
		const choose = lastModal();
		await button(choose, 'Select all').click();
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		const selected = () => deckItems(decks).filter((li) => /--selected/.test(li.className)).map((li) => li.children[0].text);
		assert.deepEqual(selected(), ['Biology']);
		deckItems(decks).find((li) => li.children[0].text === 'Chemistry').click();
		assert.deepEqual(selected(), ['Chemistry']);
		await button(decks, 'Confirm and export').click();
		assert.ok(anki.added.length === 3 && anki.added.every((n) => n.deckName === 'Chemistry'));
	});

	test('with no default deck, the first deck is preselected', async () => {
		const anki = ankiServer({ decks: ['Languages', 'Default'] });
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device();
		await exportAll(plugin);
		assert.ok(anki.added.every((n) => n.deckName === 'Languages'));
	});

	test('picking some questions exports only those', async () => {
		const anki = ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device();
		const ask = await startExport(plugin);
		await button(ask, 'Generate Anki notes').click();
		const choose = lastModal();
		questionItems(choose)[0].click();
		questionItems(choose)[2].click();
		questionItems(choose)[2].click(); // unpicked again
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		await button(decks, 'Confirm and export').click();
		assert.deepEqual(anki.added.map((n) => n.fields.Front), [NOTES[0].q]);
	});

	test('a per-run maximum limits reviewed and exported notes without changing saved preferences', async () => {
		const anki = ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device();
		const before = structuredClone(plugin.settings.notes);
		const ask = await startExport(plugin);
		await textBox(ask, 'Maximum notes').type('2');
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		assert.match(openai.requests[0].body.instructions, /Return at most 2 notes/);
		const choose = lastModal();
		assert.equal(questionItems(choose).length, 2);
		assert.match(choose.contentEl.textContent, /exceeds the maximum of 2/);
		await button(choose, 'Select all').click();
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		await button(decks, 'Confirm and export').click();
		assert.deepEqual(anki.added.map(note => note.fields.Front), NOTES.slice(0, 2).map(note => note.q));
		assert.deepEqual(plugin.settings.notes, before);
	});

	for (const value of ['0', '-1', 'five', '1.5', 'Infinity', '1e3', '9007199254740992']) {
		test(`invalid maximum ${value}: refused before anything is sent`, async () => {
			ankiServer();
			openai.handler = () => openAiReply(NOTES);
			const plugin = await device();
			const ask = await startExport(plugin);
			await textBox(ask, 'Maximum notes').type(value);
			await button(ask, 'Generate Anki notes').click();
			assert.equal(openai.requests.length, 0);
			assert.match(fake.notices.at(-1), /positive whole number/);
		});
	}

});

describe('what the user is told when something goes wrong', () => {
	async function failingExport(reply) {
		ankiServer();
		openai.handler = typeof reply === 'function' ? reply : () => reply;
		const plugin = await device({ settings: { openAiModel: 'gpt-6-luna-mini' } });
		const ask = await startExport(plugin);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(lastModal(), ask, 'no question window should open after an error');
		return fake.notices.join('\n');
	}

	test('bad key (401)', async () => {
		assert.match(await failingExport(openAiError(401, 'Incorrect API key provided: sk-proj-****cC33.', 'invalid_api_key')), /rejected the API key \(401\)/);
	});
	test('unknown model (404)', async () => {
		assert.match(await failingExport(openAiError(404, 'The model `gpt-6-luna-mini` does not exist', 'model_not_found')), /doesn't know the model "gpt-6-luna-mini" \(404\)/);
	});
	test('rate limit or no credit (429)', async () => {
		assert.match(await failingExport(openAiError(429, 'You exceeded your current quota', 'insufficient_quota')), /rate limit or quota reached \(429\)/);
	});
	test('reasoning effort the model does not accept (400)', async () => {
		assert.match(await failingExport(openAiError(400, "Unsupported value: 'reasoning.effort' does not support 'none' with this model.", 'unsupported_value')), /doesn't accept the chosen reasoning effort/);
	});
	test('any other OpenAI error', async () => {
		assert.match(await failingExport(openAiError(500, 'The server had an error')), /OpenAI returned an error \(500\)/);
	});
	test('no connection to OpenAI', async () => {
		assert.match(await failingExport(() => { throw new TypeError('fetch failed'); }), /Could not connect to OpenAI/);
	});
	test('reply cut off (ran out of tokens)', async () => {
		const reply = openAiReply(NOTES);
		Object.assign(reply.json, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
		assert.match(await failingExport(reply), /ran out of tokens/);
	});
	test('reply that is not the expected JSON', async () => {
		assert.match(await failingExport(openAiReply('Sure! Here are your questions: 1. …')), /wasn't in the expected format/);
		resetAll();
		assert.match(await failingExport(openAiReply('{"notes": []}')), /wasn't in the expected format/);
	});
	test('entries that are not a question and answer are dropped, the rest kept', async () => {
		const anki = ankiServer();
		openai.handler = () => openAiReply([NOTES[0], { q: 'no answer' }, 'junk', null, NOTES[1]]);
		const plugin = await device();
		await exportAll(plugin);
		assert.deepEqual(anki.added.map((n) => n.fields.Front), [NOTES[0].q, NOTES[1].q]);
	});

	test('Anki refuses some notes: how many, and why (each reason once)', async () => {
		const anki = ankiServer({ refuse: (note) => (note.fields.Front === NOTES[1].q ? 'cannot create note because it is a duplicate' : null) });
		openai.handler = () => openAiReply(NOTES);
		await exportAll(await device());
		assert.equal(anki.added.length, 2);
		assert.match(fake.notices.at(-1), /Exported 2 of 3 note\(s\) to Anki\. Anki refused 1:\ncannot create note because it is a duplicate/);
	});

	test('Anki refuses every note for the same reason (e.g. no "Basic" note type): the reason is shown once', async () => {
		ankiServer({ refuse: () => 'model was not found: Basic' });
		openai.handler = () => openAiReply(NOTES);
		await exportAll(await device());
		const notice = fake.notices.at(-1);
		assert.match(notice, /Exported 0 of 3/);
		assert.equal(notice.split('model was not found: Basic').length - 1, 1);
	});

	test('Anki refuses the whole request', async () => {
		ankiServer({ multiResult: () => ({ result: null, error: 'collection is not available' }) });
		openai.handler = () => openAiReply(NOTES);
		await exportAll(await device());
		assert.match(fake.notices.at(-1), /Anki refused the export: collection is not available/);
	});

	test('Anki closed between generating and exporting', async () => {
		ankiServer();
		openai.handler = () => openAiReply(NOTES);
		const plugin = await device();
		const ask = await startExport(plugin);
		await button(ask, 'Generate Anki notes').click();
		const choose = lastModal();
		await button(choose, 'Select all').click();
		fake.ankiHandler = null; // Anki quits
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		assert.match(fake.notices.join('\n'), /Could not connect to Anki/);
		assert.ok(buttonsIn(decks.contentEl).some((b) => b.text === 'Refresh'), 'no way to retry');
	});
});

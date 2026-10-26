// Exercise Claude through the actual plugin commands, settings, review and Anki export.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, buttonsIn, settingsIn } from 'obsidian';
import { makeDevice, makeDisk, makeKeychain, SECRET_ID, loadPlugin, run, resetAll, ankiServer, openai, completion, readDataJson } from './helpers.mjs';
import { createDefaultSettings, createModelSettings } from '../src/settings/model';
import { OutputMode } from '../src/ai/model-info';

beforeEach(resetAll);
const CLAUDE_SECRET = 'auto-anki-anthropic-api-key';
const CLAUDE_KEY = 'sk-ant-FAKE-claude-key';
const OPENAI_KEY = 'sk-FAKE-openai-key';
const CARD = { type: 'basic', front: 'Which item leaves a queue first?', back: 'The earliest item added.' };
const reply = (cards = [CARD], issues = []) => ({ status: 200, json: { type: 'message', role: 'assistant', stop_reason: 'end_turn',
	content: [{ type: 'text', text: JSON.stringify({ cards, note_issues: issues }) }], usage: { input_tokens: 100, output_tokens: 50 },
} });
const error = (status, message) => ({ status, json: { type: 'error', error: { type: 'invalid_request_error', message } } });
const control = (modal, name) => settingsIn(modal.contentEl).find(row => row.name === name).components[0];
const button = (modal, label) => buttonsIn(modal.contentEl).find(item => item.text === label);
const last = () => fake.modals.at(-1);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function settings() {
	const value = createDefaultSettings();
	// The same ID at both services must still use the correct key and model preferences.
	value.providers.openai.models.push({ ...createModelSettings('shared-id'), maxOutputTokens: 1234, reasoningEffort: 'high' });
	value.providers.anthropic.models.push({ ...createModelSettings('shared-id'), maxOutputTokens: 4321, reasoningEffort: 'low' });
	value.defaultModel = { providerId: 'anthropic', modelId: 'shared-id' };
	return value;
}
async function setup(value = settings(), options = {}) {
	const anki = ankiServer();
	fake.providerHandler = () => reply();
	openai.handler = () => completion([{ q: CARD.front, a: CARD.back }]);
	const disk = makeDisk(value);
	const app = makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: OPENAI_KEY, [CLAUDE_SECRET]: CLAUDE_KEY }),
		activeNote: '# Queues\nA queue uses arrival order.', notePath: 'Computing/Queues.md', ...options });
	const plugin = await loadPlugin(app);
	return { plugin, app, disk, anki };
}
async function dialog(plugin, selection) {
	run(plugin, selection === undefined ? 'export-current-file-to-anki' : 'export-text-selection-to-anki', selection);
	const modal = last();
	await modal.opened;
	return modal;
}

describe('Claude through the generation workflow', () => {
	test('opening the dialog makes no AI request; generation uses Claude’s key, model and saved preferences', async () => {
		const value = settings();
		value.cards.cardWritingInstructions = { text: '\r\n# Custom writing rules\r\n\r\nKeep exact spacing.  \r\n', defaultVersion: 'old' };
		value.cards.extraInstructions = '\n# Preferences\n\nUse British spelling.  \n';
		value.cards.coverageLevel = 'everything';
		const { plugin, disk } = await setup(value, { activeNote: '---\nprivate: metadata\n---\nA queue uses arrival order. %%private comment%%' });
		const ask = await dialog(plugin);
		assert.equal(control(ask, 'Coverage').value, 'everything');
		assert.equal(control(ask, 'Maximum cards').value, '');
		assert.match(ask.contentEl.textContent, /Claude · shared-id/);
		assert.equal(fake.providerRequests.length, 0);
		assert.equal(openai.requests.length, 0);
		await button(ask, 'Generate cards').click();
		assert.equal(fake.providerRequests.length, 1);
		const request = fake.providerRequests[0];
		assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
		assert.equal(request.headers['x-api-key'], CLAUDE_KEY);
		assert.ok(!('Authorization' in request.headers));
		assert.equal(request.body.model, 'shared-id');
		assert.equal(request.body.max_tokens, 4321);
		assert.equal(request.body.output_config.effort, 'low');
		assert.ok(request.body.system.startsWith(value.cards.cardWritingInstructions.text));
		assert.ok(request.body.system.includes(value.cards.extraInstructions));
		assert.match(request.body.system, /including smaller useful details/);
		const source = JSON.parse(request.body.messages[0].content[0].text);
		assert.equal(source.title, 'Queues');
		assert.equal(source.folder, 'Computing');
		assert.ok(!source.markdown.includes('private'));
		assert.equal(openai.requests.length, 0);
		const saved = readDataJson(disk);
		assert.equal(saved.providers.anthropic.models[0].capabilities.outputMode, 'json_schema');
		assert.equal(saved.providers.openai.models[0].capabilities, undefined);
		assert.ok(!disk.files['data.json'].includes(CLAUDE_KEY));
		assert.deepEqual(saved.cards, value.cards);
	});
	test('per-run coverage, instructions and card maximum reach Claude without changing saved defaults', async () => {
		const { plugin, disk } = await setup();
		const before = structuredClone(plugin.settings.cards);
		fake.providerHandler = () => reply([CARD, { ...CARD, front: 'Another question?' }]);
		const ask = await dialog(plugin);
		await control(ask, 'Coverage').type('key-ideas');
		await control(ask, 'Maximum cards').type('1');
		const text = '\n# This run\n\nOnly definitions.  \n';
		await control(ask, 'Instructions for this run').type(text);
		await button(ask, 'Generate cards').click();
		assert.ok(fake.providerRequests[0].body.system.includes(text));
		assert.match(fake.providerRequests[0].body.system, /Leave out supporting details/);
		assert.match(fake.providerRequests[0].body.system, /Return at most 1 cards/);
		assert.deepEqual(readDataJson(disk).cards, before);
		assert.equal(last().contentEl.all().filter(element => element.tagName === 'li' && /question-option/.test(element.className)).length, 1);
		assert.match(last().contentEl.textContent, /exceeds the maximum/);
	});
	test('a Claude result can be reviewed, selected and exported to an existing Anki deck', async () => {
		const { plugin, anki } = await setup();
		await button(await dialog(plugin), 'Generate cards').click();
		const review = last();
		assert.match(review.contentEl.textContent, /Which item leaves a queue first/);
		assert.equal(button(review, 'Confirm selection').disabled, true);
		await button(review, 'Select all').click();
		await button(review, 'Confirm selection').click();
		const decks = last(); await decks.opened;
		await button(decks, 'Confirm and export').click();
		assert.equal(anki.added.length, 1);
		assert.deepEqual(anki.added[0].fields, { Front: CARD.front, Back: CARD.back });
		assert.equal(openai.requests.length, 0);
	});
	test('changing the default provider after opening keeps the original request and learned format scoped to Claude', async () => {
		const { plugin } = await setup();
		const ask = await dialog(plugin);
		await plugin.configureModel('openai', 'shared-id', true);
		await button(ask, 'Generate cards').click();
		assert.equal(fake.providerRequests[0].headers['x-api-key'], CLAUDE_KEY);
		assert.equal(plugin.settings.providers.anthropic.models[0].capabilities.outputMode, 'json_schema');
		assert.equal(plugin.settings.providers.openai.models[0].capabilities, undefined);
		assert.deepEqual(plugin.settings.defaultModel, { providerId: 'openai', modelId: 'shared-id' });
		last().close();
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(openai.requests.length, 1);
		assert.equal(openai.requests[0].headers.get('authorization'), `Bearer ${OPENAI_KEY}`);
		assert.equal(fake.providerRequests.length, 1);
	});
	test('a missing Claude key is explained without using an available OpenAI key', async () => {
		const { plugin } = await setup(settings(), { keychain: makeKeychain('ok', { [SECRET_ID]: OPENAI_KEY }) });
		run(plugin, 'export-current-file-to-anki');
		assert.equal(fake.modals.length, 0);
		assert.match(fake.notices.at(-1), /No Claude API key on this device/);
		assert.equal(fake.providerRequests.length, 0);
		assert.equal(openai.requests.length, 0);
		assert.equal(fake.ankiRequests.length, 0);
	});
	test('Anki being unavailable prevents a paid Claude request', async () => {
		const { plugin } = await setup();
		fake.ankiHandler = null;
		const ask = await dialog(plugin);
		assert.equal(ask.isOpen, false);
		assert.equal(fake.providerRequests.length, 0);
	});
	test('empty cards still show source concerns without offering an empty export', async () => {
		const { plugin } = await setup();
		fake.providerHandler = () => reply([], ['Check this definition in your source.']);
		await button(await dialog(plugin), 'Generate cards').click();
		assert.match(last().contentEl.textContent, /Check this definition in your source/);
		assert.match(last().contentEl.textContent, /No cards were generated/);
		assert.equal(button(last(), 'Confirm selection'), undefined);
	});
	test('format fallback is remembered for Claude, without changing the OpenAI model with the same ID', async () => {
		const { plugin, disk } = await setup();
		fake.providerHandler = body => body.output_config?.format ? error(400, 'output_config.format json_schema is not supported')
			: body.tools ? error(400, 'tool_choice is unsupported') : reply();
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(fake.providerRequests.length, 3);
		assert.equal(readDataJson(disk).providers.anthropic.models[0].capabilities.outputMode, 'json');
		assert.equal(readDataJson(disk).providers.openai.models[0].capabilities, undefined);
		last().close();
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(fake.providerRequests.length, 4);
		assert.ok(!fake.providerRequests.at(-1).body.output_config.format);
	});
	test('malformed cards are skipped and malformed overall replies do not trigger format fallback', async () => {
		const { plugin } = await setup();
		fake.providerHandler = () => reply([CARD, null, { type: 'basic', front: '', back: 'Empty' }, { type: 'cloze', front: '{{c1::No}}', back: '' }]);
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(last().contentEl.all().filter(element => element.tagName === 'li' && /question-option/.test(element.className)).length, 1);
		assert.match(last().contentEl.textContent, /Card 2 was skipped/);
		last().close();
		fake.providerHandler = () => ({ ...reply(), json: { ...reply().json, content: [{ type: 'text', text: 'Not JSON.' }] } });
		const ask = await dialog(plugin);
		await button(ask, 'Generate cards').click();
		assert.equal(fake.providerRequests.length, 2);
		assert.equal(last(), ask);
		assert.match(fake.notices.at(-1), /expected format/);
	});
	test('closing while Claude responds prevents a late review or fallback and sends only one request', async () => {
		const { plugin } = await setup();
		const wait = deferred(); const started = deferred();
		fake.providerHandler = async () => { started.resolve(); return wait.promise; };
		const ask = await dialog(plugin);
		const task = button(ask, 'Generate cards').click();
		await started.promise;
		await button(ask, 'Generating…').click();
		assert.equal(fake.providerRequests.length, 1);
		ask.close();
		await task;
		wait.resolve(error(400, 'output_config.format is unsupported'));
		await flush();
		assert.equal(last(), ask);
		assert.equal(fake.providerRequests.length, 1);
		assert.deepEqual(fake.notices, []);
	});
	test('a failed request leaves the same dialog and run instructions available for an explicit retry', async () => {
		const { plugin } = await setup();
		fake.providerHandler = () => error(429, 'Quota reached');
		const ask = await dialog(plugin);
		await control(ask, 'Instructions for this run').type('Keep this for retry.');
		await button(ask, 'Generate cards').click();
		assert.equal(last(), ask);
		assert.equal(button(ask, 'Generate cards').disabled, false);
		assert.equal(control(ask, 'Instructions for this run').value, 'Keep this for retry.');
		assert.equal(fake.providerRequests.length, 1);
		fake.providerHandler = () => reply();
		await button(ask, 'Generate cards').click();
		assert.notEqual(last(), ask);
		assert.equal(fake.providerRequests.length, 2);
	});
	test('selections attach only their embedded diagrams using Claude’s image format', async () => {
		const create = globalThis.createEl; const bitmap = globalThis.createImageBitmap;
		globalThis.createImageBitmap = async () => ({ width: 8, height: 4, close() {} });
		globalThis.createEl = (tag, options) => tag === 'canvas' ? { getContext: () => ({ drawImage() {} }),
			toBlob(callback) { callback(new Blob([new Uint8Array([7])], { type: 'image/png' })); },
		} : create(tag, options);
		try {
			const { plugin } = await setup(settings(), { activeNote: '![[whole-note.png]]', attachments: {
				'Images/whole-note.png': new Uint8Array([1]).buffer, 'Images/selected.png': new Uint8Array([2]).buffer,
			} });
			const ask = await dialog(plugin, 'Arrival order: ![[selected.png]]');
			assert.equal(control(ask, 'Maximum cards').value, '3');
			assert.deepEqual(fake.attachmentReads, ['Images/selected.png']);
			await button(ask, 'Generate cards').click();
			const parts = fake.providerRequests[0].body.messages[0].content;
			assert.equal(parts[1].text, 'Diagram: Images/selected.png');
			assert.deepEqual(parts[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Bw==' } });
			assert.equal(openai.requests.length, 0);
		} finally { globalThis.createEl = create; globalThis.createImageBitmap = bitmap; }
	});
	test('reported lack of image support skips diagrams before reading bytes', async () => {
		const value = settings(); value.providers.anthropic.models[0].capabilities = { acceptsImages: false };
		const { plugin } = await setup(value, { activeNote: 'A queue. ![[a.png]]', attachments: { 'a.png': new Uint8Array([1]).buffer } });
		const ask = await dialog(plugin);
		assert.match(ask.contentEl.textContent, /does not accept images/);
		await button(ask, 'Generate cards').click();
		assert.deepEqual(fake.attachmentReads, []);
		assert.equal(fake.providerRequests[0].body.messages[0].content.length, 1);
	});
});

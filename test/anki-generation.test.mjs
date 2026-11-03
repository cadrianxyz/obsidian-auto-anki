import { generatedNote } from './helpers.mjs';
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, buttonsIn } from 'obsidian';
import { createDefaultSettings, createModelSettings } from '../src/settings/schema';
import { BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE, SECRET_ID, ankiServer, openAiReply, loadPlugin, makeDevice, makeDisk, makeKeychain, openai, resetAll, run } from './helpers.mjs';

beforeEach(resetAll);
const NOTES = [{ type: 'basic', front: 'Which item leaves a queue first?', back: 'The earliest item added.' },
	{ type: 'cloze', front: 'A queue follows {{c1::FIFO::ordering}}.', back: 'First in, first out.' }].map(generatedNote);
const last = () => fake.modals.at(-1);
const button = (modal, text) => {
	const button = buttonsIn(modal.contentEl).find(item => item.text === text);
	assert.ok(button, `no ${text} button`); return button;
};
const entries = modal => modal.contentEl.all().filter(element => element.tagName === 'li' && /question-option/.test(element.className));
function settings(provider = 'openai') {
	const value = createDefaultSettings();
	value.providers[provider].models.push(createModelSettings('test-model'));
	value.defaultModel = { providerId: provider, modelId: 'test-model' };
	return value;
}
async function setup({ provider = 'openai', value = settings(provider), noteTypes = { Basic: BASIC_NOTE_TYPE, Cloze: CLOZE_NOTE_TYPE }, notes = NOTES, refuse } = {}) {
	const server = ankiServer({ noteTypes, refuse });
	openai.handler = () => openAiReply(notes);
	fake.providerHandler = () => ({ json: { type: 'message', role: 'assistant', stop_reason: 'end_turn',
		content: [{ type: 'text', text: JSON.stringify({ notes, note_issues: [] }) }] } });
	const disk = makeDisk(value);
	const plugin = await loadPlugin(makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: 'sk-FAKE', 'auto-anki-anthropic-api-key': 'sk-ant-FAKE' }) }));
	return { plugin, server, disk };
}
async function start(plugin) {
	run(plugin, 'export-current-file-to-anki'); const ask = last(); await ask.opened; return ask;
}
async function review(plugin) {
	const ask = await start(plugin); await button(ask, 'Generate Anki notes').click();
	assert.notEqual(last(), ask); return last();
}
async function selectAll(review) {
	await button(review, 'Select all').click(); await button(review, 'Confirm selection').click();
	const decks = last(); await decks.opened; return decks;
}

describe('verified destinations through generation and export', () => {
	for (const provider of ['openai', 'anthropic']) test(`${provider}: a single run supports question/answer and cloze entries`, async () => {
		const { plugin, server } = await setup({ provider });
		const ask = await start(plugin);
		assert.equal(openai.requests.length + fake.providerRequests.length, 0, 'opening makes no AI request');
		await button(ask, 'Generate Anki notes').click();
		const request = provider === 'openai' ? openai.requests[0].body : fake.providerRequests[0].body;
		const schema = provider === 'openai' ? request.text.format.schema : request.output_config.format.schema;
		assert.deepEqual(schema.properties.notes.items.anyOf.map(item => item.properties.noteType.enum[0]), ['Basic', 'Cloze']);
		const instructions = provider === 'openai' ? request.instructions : request.system;
		assert.match(instructions, /Enabled Anki note types/);
		assert.match(instructions, /All generated deletions must use c1/);
		const choose = last(); assert.equal(entries(choose).length, 2);
		assert.match(choose.contentEl.textContent, /follows \{\{c1::FIFO::ordering\}\}/);
		assert.match(choose.contentEl.textContent, /FIFO/);
		const decks = await selectAll(choose); await button(decks, 'Confirm and export').click();
		assert.deepEqual(server.added.map(note => [note.modelName, note.fields]), [
			['Basic', { Front: NOTES[0].fields.Front, Back: NOTES[0].fields.Back }],
			['Cloze', { Text: NOTES[1].fields.Text, 'Back Extra': NOTES[1].fields['Back Extra'] }],
		]);
		assert.equal(decks.isOpen, false);
	});
	test('cloze-only settings constrain the schema and reject unexpected basic entries', async () => {
		const value = settings(); value.anki.enabledNoteTypes = ['Cloze'];
		const { plugin, server } = await setup({ value });
		const choose = await review(plugin);
		assert.deepEqual(openai.requests[0].body.text.format.schema.properties.notes.items.anyOf.map(item => item.properties.noteType.enum[0]), ['Cloze']);
		assert.match(openai.requests[0].body.instructions, /"noteType":"Cloze"/);
		assert.equal(entries(choose).length, 1);
		assert.match(choose.contentEl.textContent, /Note 1 was skipped/);
		const decks = await selectAll(choose); await button(decks, 'Confirm and export').click();
		assert.equal(server.added[0].modelName, 'Cloze');
	});
	test('custom types generate three native fields and review every field as text', async () => {
		const value = settings(); value.anki.enabledNoteTypes = ['Vocabulary'];
		const fields = { Expression: 'bonjour', Meaning: 'hello', Example: 'Bonjour!\nComment allez-vous?' };
		const { plugin, server } = await setup({ value, notes: [{ noteType: 'Vocabulary', fields }], noteTypes: { Vocabulary: { id: 300,
			fields: Object.keys(fields), descriptions: ['Term to recall', 'Its definition', 'Usage sentence'], templates: {
				Forward: { Front: '{{Expression}}', Back: '{{Meaning}} {{Example}}' }, Reverse: { Front: '{{Meaning}}', Back: '{{Expression}}' },
			} } } });
		const choose = await review(plugin);
		assert.match(openai.requests[0].body.instructions, /Usage sentence/);
		assert.match(choose.contentEl.textContent, /Example/); assert.match(choose.contentEl.textContent, /Comment allez-vous/);
		const decks = await selectAll(choose); await button(decks, 'Confirm and export').click();
		assert.deepEqual(server.added[0].fields, { ...fields, Example: 'Bonjour!<br>Comment allez-vous?' });
		assert.equal(server.added.length, 1, 'one note may create several cards');
		assert.ok(fake.ankiRequests.findIndex(r => r.body.action === 'canAddNotes') < fake.ankiRequests.findIndex(r => r.body.action === 'multi'));
	});
	for (const reason of ['disabled', 'missing']) test(`a ${reason} type prevents a paid request`, async () => {
		const value = settings(); value.anki.enabledNoteTypes = reason === 'disabled' ? [] : ['Deleted'];
		const { plugin } = await setup({ value }); const ask = await start(plugin);
		assert.equal(button(ask, 'Generate Anki notes').disabled, true);
		assert.equal(openai.requests.length, 0);
	});
	test('a template change after opening the dialog prevents generation', async () => {
		const { plugin, server } = await setup(); const ask = await start(plugin);
		server.types.Basic.templates['Card 1'].Back += '<br>';
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 0);
		assert.equal(ask.isOpen, true);
		assert.match(fake.notices.at(-1), /changed since this run/);
	});
	test('settings changes during review cannot silently reroute already generated entries', async () => {
		const { plugin, server } = await setup(); const choose = await review(plugin);
		await plugin.updateSettings(settings => {
			settings.anki.enabledNoteTypes = ['New destination'];
		});
		const decks = await selectAll(choose); await button(decks, 'Confirm and export').click();
		assert.deepEqual(server.added.map(note => note.modelName), ['Basic', 'Cloze']);
	});
	for (const change of ['deleted', 'modified', 'recreated']) test(`a ${change} type during review blocks all additions and keeps entries for recovery`, async () => {
		const { plugin, server } = await setup(); const choose = await review(plugin); const decks = await selectAll(choose);
		if (change === 'deleted') delete server.types.Cloze;
		if (change === 'modified') server.types.Cloze.templates.Cloze.Back += '<hr>';
		if (change === 'recreated') server.types.Cloze.id++;
		await button(decks, 'Confirm and export').click();
		assert.equal(server.added.length, 0);
		assert.equal(decks.isOpen, true);
		await button(decks, 'Back to selection').click();
		assert.equal(entries(last()).length, 2);
	});
	test('partial export retries only entries that Anki refused', async () => {
		let refuse = true;
		const { plugin, server } = await setup({ refuse: note => refuse && note.modelName === 'Cloze' ? 'temporary refusal' : null });
		const decks = await selectAll(await review(plugin));
		await button(decks, 'Confirm and export').click();
		assert.equal(server.added.length, 1); assert.equal(decks.isOpen, true);
		refuse = false; await button(decks, 'Confirm and export').click();
		assert.deepEqual(server.added.map(note => note.modelName), ['Basic', 'Cloze']);
		assert.equal(decks.isOpen, false);
	});
	test('after a partial export, going back shows the unexported notes but not the added ones', async () => {
		const { plugin, server } = await setup({ refuse: note => note.modelName === 'Cloze' ? 'temporary refusal' : null });
		const decks = await selectAll(await review(plugin));
		await button(decks, 'Confirm and export').click();
		assert.equal(server.added.length, 1);
		await button(decks, 'Back to selection').click();
		assert.deepEqual(entries(last()).map(entry => entry.children[0].text), ['Cloze']);
		assert.match(entries(last())[0].className, /--selected/);
	});
	test('disconnecting after review retains the entries, and retry works after Anki returns', async () => {
		const { plugin, server } = await setup(); const decks = await selectAll(await review(plugin));
		const handler = fake.ankiHandler; fake.ankiHandler = null;
		await button(decks, 'Confirm and export').click();
		assert.equal(decks.isOpen, true); assert.equal(server.added.length, 0);
		fake.ankiHandler = handler; await button(decks, 'Confirm and export').click();
		assert.equal(server.added.length, 2); assert.equal(decks.isOpen, false);
	});
});

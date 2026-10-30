import { BASIC_DESTINATIONS, generatedNote } from './helpers.mjs';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, buttonsIn, settingsIn, FakeElement } from 'obsidian';
import { makeDevice, makeDisk, makeKeychain, SECRET_ID, loadPlugin, run, resetAll, ankiServer, openai, openAiReply, openAiError, readDataJson } from './helpers.mjs';
import { createDefaultSettings, createModelSettings } from '../src/settings/schema';
import { OutputMode } from '../src/ai/generation';
import { createGenerationPrompt } from '../src/generate/prompt';
import { parseGeneratedNotes } from '../src/generate/result';
import { DEFAULT_NOTE_WRITING_INSTRUCTIONS } from '../src/generate/note-writing-instructions';

beforeEach(resetAll);
const KEY = 'sk-test-generation';
const PAIRS = [{ q: 'Which item leaves a queue first?', a: 'The earliest item added.' }];
const NOTE = { title: 'Queues', path: 'Computing/Queues.md', markdown: '# Queues\nA queue removes items in arrival order.' };
const control = (modal, name) => settingsIn(modal.contentEl).find(row => row.name === name).components[0];
const button = (modal, label) => buttonsIn(modal.contentEl).find(item => item.text === label);
const last = () => fake.modals.at(-1);
function settings() {
	const value = createDefaultSettings();
	value.providers.openai.models.push(createModelSettings('test-model'));
	value.defaultModel = { providerId: 'openai', modelId: 'test-model' };
	return value;
}
async function setup(value = settings(), options = {}) {
	ankiServer();
	openai.handler = () => openAiReply(PAIRS);
	const disk = makeDisk(value);
	const app = makeDevice({ disk, keychain: makeKeychain('ok', { [SECRET_ID]: KEY }), activeNote: NOTE.markdown, notePath: NOTE.path, ...options });
	const plugin = await loadPlugin(app);
	return { plugin, app, disk };
}
async function dialog(plugin, selection) {
	run(plugin, selection === undefined ? 'export-current-file-to-anki' : 'export-text-selection-to-anki', selection);
	const modal = last();
	await modal.opened;
	return modal;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('the instructions used for generation', () => {
	test('keeps the shared prefix identical across notes and inserts user Markdown verbatim in the planned order', () => {
		const preferences = settings().notes;
		preferences.noteWritingInstructions = { text: '\r\n# My guidance\r\n\r\n- Keep **this**.  \r\n', defaultVersion: 'old' };
		preferences.extraInstructions = '\n# Extras\n\n- Keep spacing.  \n';
		const run = { coverage: 'key-ideas', instructions: '\n# This run\n\nOnly definitions.  \n' };
		const a = createGenerationPrompt(preferences, run, NOTE, [], BASIC_DESTINATIONS);
		const b = createGenerationPrompt(preferences, run, { ...NOTE, title: 'Other', markdown: 'Different note.' }, [], BASIC_DESTINATIONS);
		assert.equal(a.instructions, b.instructions);
		assert.ok(a.instructions.startsWith(preferences.noteWritingInstructions.text));
		assert.ok(!a.instructions.includes(preferences.extraInstructions));
		assert.ok(a.instructions.includes(run.instructions));
		assert.equal(a.instructions.split(run.instructions).length - 1, 1);
		assert.ok(a.instructions.indexOf(run.instructions) < a.instructions.indexOf('## Required response format'));
		assert.ok(!a.instructions.includes('A queue removes'));
		assert.equal(JSON.parse(a.source).folder, 'Computing');
		assert.equal(JSON.parse(a.source).markdown, NOTE.markdown);
	});
	test('uses the current guidance when unset but respects an explicitly empty edited guide', () => {
		const preferences = settings().notes;
		const run = { coverage: preferences.coverageLevel, instructions: '' };
		assert.ok(createGenerationPrompt(preferences, run, NOTE, [], BASIC_DESTINATIONS).instructions.startsWith(DEFAULT_NOTE_WRITING_INSTRUCTIONS));
		preferences.noteWritingInstructions = { text: '', defaultVersion: 'old' };
		const prompt = createGenerationPrompt(preferences, run, NOTE, [], BASIC_DESTINATIONS);
		assert.ok(!prompt.instructions.includes(DEFAULT_NOTE_WRITING_INSTRUCTIONS));
		assert.ok(prompt.instructions.includes('## Required response format'));
	});
	test('each coverage level gives different concrete guidance, and a limit is never a fixed target', () => {
		const preferences = settings().notes;
		const texts = ['key-ideas', 'main-ideas-and-details', 'everything'].map(coverage => createGenerationPrompt(preferences, { coverage, instructions: '' }, NOTE, [], BASIC_DESTINATIONS).instructions);
		assert.equal(new Set(texts).size, 3);
		assert.match(texts[0], /Leave out supporting details/);
		assert.match(texts[1], /details that matter on their own/);
		assert.match(texts[2], /including smaller useful details/);
		assert.match(texts[0], /There is no fixed number of Anki notes/);
		const capped = createGenerationPrompt(preferences, { coverage: 'everything', maximumNotes: 2, instructions: '' }, NOTE, [], BASIC_DESTINATIONS);
		assert.match(capped.instructions, /at most 2 notes.*ceiling, not a target/);
	});
	test('invalid notes are reported, limits apply to valid notes, and zero notes still carries note issues', () => {
		const result = parseGeneratedNotes(JSON.stringify({ notes: [null, { type: 'cloze', front: '{{c1::bad}}', back: '' },
			{ type: 'basic', front: ' ', back: 'x' }, { type: 'basic', front: 'a', back: 'b' },
			{ type: 'basic', front: '{{image:unknown.png}}', back: 'x' }, { type: 'basic', front: 'c', back: 'd' }].map(generatedNote), note_issues: ['Check this source claim.'] }), 1, BASIC_DESTINATIONS);
		assert.deepEqual(result.notes, [generatedNote({ q: 'a', a: 'b' })]);
		assert.equal(result.warnings.length, 5);
		assert.deepEqual(result.noteIssues, ['Check this source claim.']);
		assert.deepEqual(parseGeneratedNotes('{"notes":[],"note_issues":["Concern"]}', undefined, BASIC_DESTINATIONS).notes, []);
		for (const reply of ['not JSON', '{"notes":[]}', '{"notes":[],"note_issues":[4]}']) assert.throws(() => parseGeneratedNotes(reply), /expected format/);
	});
});

describe('saved settings reach the real export commands', () => {
	test('whole-note exports use saved instructions, coverage and a cleaned source, with no fixed count or alternatives', async () => {
		const value = settings();
		value.notes.noteWritingInstructions = { text: '\nMy **custom** writing rules.  \n', defaultVersion: 'old' };
		value.notes.extraInstructions = '\r\n# Preferences\r\n\r\nUse British spelling.  \r\n';
		value.notes.coverageLevel = 'everything';
		const { plugin } = await setup(value, { activeNote: '---\nsecret: frontmatter\n---\nA queue uses arrival order. %%secret comment%%' });
		const ask = await dialog(plugin);
		assert.equal(control(ask, 'Coverage').value, 'everything');
		assert.equal(control(ask, 'Maximum notes').value, '');
		assert.equal(control(ask, 'Extra instructions').value, value.notes.extraInstructions);
		assert.equal(openai.requests.length, 0);
		await button(ask, 'Generate Anki notes').click();
		const request = openai.requests[0].body;
		assert.ok(request.instructions.startsWith(value.notes.noteWritingInstructions.text));
		assert.equal(request.instructions.split(value.notes.extraInstructions).length - 1, 1);
		assert.match(request.instructions, /including smaller useful details/);
		assert.equal(request.n, undefined);
		assert.match(request.instructions, /There is no fixed number of Anki notes/);
		assert.ok(!request.input[0].content[0].text.includes('secret'));
		assert.equal(JSON.parse(request.input[0].content[0].text).title, 'Queues');
	});
	test('coverage and edited extra instructions change only this run, leaving saved defaults untouched', async () => {
		const value = settings();
		value.notes.extraInstructions = 'Saved preferences for every run.';
		const { plugin, disk } = await setup(value);
		const before = structuredClone(plugin.settings.notes);
		const ask = await dialog(plugin);
		await control(ask, 'Coverage').type('key-ideas');
		const instructions = '\n# Only for today\n\n- Explain **why**.  \n';
		assert.equal(control(ask, 'Extra instructions').value, before.extraInstructions);
		await control(ask, 'Extra instructions').type(instructions);
		await button(ask, 'Generate Anki notes').click();
		assert.ok(openai.requests[0].body.instructions.includes(instructions));
		assert.ok(!openai.requests[0].body.instructions.includes(before.extraInstructions));
		assert.match(openai.requests[0].body.instructions, /Leave out supporting details/);
		assert.deepEqual(readDataJson(disk).notes, before);
		last().close();
		const next = await dialog(plugin);
		assert.equal(control(next, 'Coverage').value, before.coverageLevel);
		assert.equal(control(next, 'Extra instructions').value, before.extraInstructions);
	});
	test('OpenAI retains per-run coverage and effort through retry and restores saved defaults next run', async () => {
		const value = settings();
		Object.assign(value.providers.openai.models[0], {
			outputMode: OutputMode.JsonSchema, reasoningEffort: 'low', capabilities: { reasoningEfforts: ['low', 'high'] },
		});
		const { plugin, disk } = await setup(value);
		const before = structuredClone(plugin.settings);
		const diskBefore = disk.files['data.json'];
		const writesBefore = disk.writes;
		const ask = await dialog(plugin);
		assert.equal(control(ask, 'Coverage').value, before.notes.coverageLevel);
		assert.equal(control(ask, 'Reasoning effort').value, 'low');
		await control(ask, 'Coverage').type('everything');
		await control(ask, 'Reasoning effort').type('high');
		openai.handler = () => openAiError(429, 'Quota reached');
		await button(ask, 'Generate Anki notes').click();
		assert.equal(last(), ask);
		assert.equal(control(ask, 'Coverage').value, 'everything');
		assert.equal(control(ask, 'Reasoning effort').value, 'high');
		assert.equal(control(ask, 'Coverage').disabled, false);
		assert.equal(control(ask, 'Reasoning effort').disabled, false);
		openai.handler = () => openAiReply(PAIRS);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 2);
		for (const request of openai.requests) {
			assert.match(request.body.instructions, /Coverage: Everything worth remembering/);
			assert.equal(request.body.reasoning.effort, 'high');
		}
		assert.deepEqual(plugin.settings, before);
		assert.equal(disk.files['data.json'], diskBefore);
		assert.equal(disk.writes, writesBefore);
		last().close();
		const next = await dialog(plugin);
		assert.equal(control(next, 'Coverage').value, before.notes.coverageLevel);
		assert.equal(control(next, 'Reasoning effort').value, 'low');
		await button(next, 'Generate Anki notes').click();
		assert.match(openai.requests[2].body.instructions, /Coverage: Main ideas and important details/);
		assert.equal(openai.requests[2].body.reasoning.effort, 'low');
	});
	test('clearing extra instructions omits saved guidance for this run without saving the change', async () => {
		const value = settings();
		value.notes.extraInstructions = '\r\n# Saved extras\r\n\r\nKeep **these** defaults.  \r\n';
		const { plugin, disk } = await setup(value);
		const before = structuredClone(plugin.settings.notes);
		const ask = await dialog(plugin);
		assert.equal(control(ask, 'Extra instructions').value, before.extraInstructions);
		await control(ask, 'Extra instructions').type('');
		await button(ask, 'Generate Anki notes').click();
		assert.ok(!openai.requests[0].body.instructions.includes(before.extraInstructions));
		assert.deepEqual(readDataJson(disk).notes, before);
		last().close();
		const next = await dialog(plugin);
		assert.equal(control(next, 'Extra instructions').value, before.extraInstructions);
	});
	test('settings changed after opening the dialog affect the next run, not the current snapshot', async () => {
		const { plugin } = await setup();
		const ask = await dialog(plugin);
		await plugin.updateSettings(value => { value.notes.extraInstructions = 'New instructions for next time.'; value.notes.coverageLevel = 'everything'; });
		await button(ask, 'Generate Anki notes').click();
		assert.ok(!openai.requests[0].body.instructions.includes('New instructions for next time.'));
		last().close();
		const next = await dialog(plugin);
		await button(next, 'Generate Anki notes').click();
		assert.ok(openai.requests[1].body.instructions.includes('New instructions for next time.'));
		assert.match(openai.requests[1].body.instructions, /including smaller useful details/);
	});
	test('a source reduced to nothing after removing private metadata makes no paid request', async () => {
		const { plugin } = await setup(settings(), { activeNote: '---\nprivate: data\n---\n%%private comment%%' });
		const ask = await dialog(plugin);
		assert.equal(button(ask, 'Generate Anki notes').disabled, true);
		await button(ask, 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 0);
	});
	test('an empty result and suspected note mistakes remain visible without offering an empty Anki export', async () => {
		const { plugin } = await setup();
		openai.handler = () => openAiReply('{"notes":[],"note_issues":["Check the queue definition in the source."]}');
		const ask = await dialog(plugin);
		await button(ask, 'Generate Anki notes').click();
		assert.match(last().contentEl.textContent, /No Anki notes were generated/);
		assert.match(last().contentEl.textContent, /Check the queue definition/);
		assert.equal(button(last(), 'Confirm selection'), undefined);
		assert.equal(fake.ankiRequests.filter(req => req.body.action === 'multi').length, 0);
	});
	test('double clicks send one request, and closing during generation prevents a late review window', async () => {
		const { plugin } = await setup();
		const wait = deferred();
		const started = deferred();
		openai.handler = async () => { started.resolve(); return wait.promise; };
		const ask = await dialog(plugin);
		const send = button(ask, 'Generate Anki notes').click();
		await started.promise;
		assert.equal(control(ask, 'Coverage').disabled, true);
		await button(ask, 'Generating…').click();
		assert.equal(openai.requests.length, 1);
		ask.close();
		wait.resolve(openAiReply(PAIRS));
		await send;
		assert.equal(last(), ask);
		assert.equal(ask.isOpen, false);
		assert.equal(fake.notices.length, 0);
	});
	test('only selected embeds are attached, labelled by filename, and skipped GIF analysis is explained', async () => {
		const bitmap = globalThis.createImageBitmap;
		const create = globalThis.createEl;
		globalThis.createImageBitmap = async () => ({ width: 8, height: 4, close() {} });
		globalThis.createEl = (tag, options) => tag === 'canvas' ? {
			getContext: () => ({ drawImage() {} }), toBlob(callback) { callback(new Blob([new Uint8Array([7])], { type: 'image/png' })); },
		} : create(tag, options);
		try {
			const { plugin } = await setup(settings(), { activeNote: '![[whole-note.png]]', attachments: {
				'Images/whole-note.png': new Uint8Array([1]).buffer, 'Images/selected.gif': new Uint8Array([2]).buffer,
			} });
			const ask = await dialog(plugin, 'Arrival order: ![[selected.gif]] ![](https://example.com/private.png)');
			assert.match(ask.contentEl.textContent, /first GIF frame/);
			assert.deepEqual(fake.attachmentReads, ['Images/selected.gif']);
			await button(ask, 'Generate Anki notes').click();
			const parts = openai.requests[0].body.input[0].content;
			assert.equal(parts[1].text, 'Diagram: Images/selected.gif');
			assert.deepEqual(parts[2], { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,Bw==' });
			assert.match(last().contentEl.textContent, /first GIF frame/);
			assert.match(last().contentEl.textContent, /only images inside the vault/);
			assert.equal(openai.requests.length, 1);
		} finally { globalThis.createEl = create; globalThis.createImageBitmap = bitmap; }
	});
	test('Send diagrams off reaches the command workflow without reading any attachment', async () => {
		const value = settings(); value.notes.sendDiagrams = false;
		const { plugin } = await setup(value, { activeNote: 'A queue diagram: ![[a.png]]', attachments: { 'a.png': new Uint8Array([1]).buffer } });
		const ask = await dialog(plugin);
		assert.match(ask.contentEl.textContent, /Send diagrams is off/);
		await button(ask, 'Generate Anki notes').click();
		assert.deepEqual(fake.attachmentReads, []);
		assert.deepEqual(openai.requests[0].body.input[0].content.map(part => part.type), ['input_text']);
	});
});

describe('OpenAI structured output with the saved model settings', () => {
	test('Auto steps down only on unsupported formats, remembers the result, and starts there next time', async () => {
		const { plugin, disk } = await setup();
		openai.handler = body => {
			if (body.text?.format?.type === 'json_schema') return openAiError(400, 'text.format json_schema is not supported by this model.');
			if (body.tools) return openAiError(400, 'tool_choice is unsupported by this model.');
			return openAiReply(PAIRS);
		};
		await button(await dialog(plugin), 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 3);
		assert.equal(readDataJson(disk).providers.openai.models[0].capabilities.outputMode, 'json');
		last().close();
		await button(await dialog(plugin), 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 4);
		assert.equal(openai.requests.at(-1).body.text.format.type, 'json_object');
	});
	test('forced tool output reads the named function arguments and the exact model limits', async () => {
		const value = settings();
		Object.assign(value.providers.openai.models[0], { outputMode: OutputMode.Tool, maxOutputTokens: 4321, reasoningEffort: 'low' });
		const { plugin } = await setup(value);
		openai.handler = () => ({ json: { ...openAiReply(PAIRS).json, output: [
			{ type: 'reasoning', id: 'rs-1', summary: [] },
			{ type: 'function_call', id: 'fc-1', call_id: 'call-1', status: 'completed', name: 'submit_notes', arguments: JSON.stringify({ notes: [generatedNote({ q: 'Question', a: 'Answer' })], note_issues: [] }) },
		] } });
		await button(await dialog(plugin), 'Generate Anki notes').click();
		assert.equal(openai.requests[0].body.max_output_tokens, 4321);
		assert.equal(openai.requests[0].body.reasoning?.effort, 'low');
		assert.deepEqual(openai.requests[0].body.tool_choice, { type: 'function', name: 'submit_notes' });
		assert.equal(openai.requests[0].body.tools[0].strict, true);
		assert.match(last().contentEl.textContent, /Question/);
	});
	test('bad credentials, limits, image errors, malformed output, refusals and invalid schemas do not cause fallback', async () => {
		const refusal = openAiReply(PAIRS); refusal.json.output[0].content = [{ type: 'refusal', refusal: 'Cannot help.' }];
		for (const reply of [openAiError(401, 'response_format is unsupported'), openAiError(429, 'Limit reached'),
			openAiError(400, 'image input is unsupported'), openAiError(400, 'Invalid schema for response_format: keyword is not supported'),
			openAiReply('invalid'), refusal]) {
			resetAll();
			const { plugin } = await setup();
			openai.handler = () => reply;
			const ask = await dialog(plugin);
			await button(ask, 'Generate Anki notes').click();
			assert.equal(openai.requests.length, 1);
			assert.equal(last(), ask);
			assert.equal(ask.isOpen, true);
			assert.equal(button(ask, 'Generate Anki notes').disabled, false);
			assert.equal(plugin.settings.providers.openai.models[0].capabilities, undefined);
			assert.equal(fake.notices.length, 1);
		}
	});
	test('an explicitly chosen output mode is never changed after an unsupported-format error', async () => {
		const value = settings(); value.providers.openai.models[0].outputMode = OutputMode.JsonSchema;
		const { plugin } = await setup(value);
		openai.handler = () => openAiError(400, 'response_format json_schema is unsupported');
		await button(await dialog(plugin), 'Generate Anki notes').click();
		assert.equal(openai.requests.length, 1);
		assert.equal(plugin.settings.providers.openai.models[0].capabilities, undefined);
	});

	test('unreadable transport replies produce a useful error and no format retry', async () => {
		const completed = { status: 'completed' };
		for (const json of [{}, completed, { ...completed, output: [null] }, { ...completed, output: [{ type: 'message', content: null }] },
			{ ...completed, output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] }]) {
			resetAll();
			const { plugin } = await setup();
			openai.handler = () => ({ json });
			const ask = await dialog(plugin);
			await button(ask, 'Generate Anki notes').click();
			assert.equal(openai.requests.length, 1);
			assert.equal(last(), ask);
			assert.match(fake.notices[0], /readable generation result|expected format/);
		}
	});
});

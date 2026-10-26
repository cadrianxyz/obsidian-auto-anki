import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, buttonsIn, settingsIn, FakeElement } from 'obsidian';
import { makeDevice, makeDisk, makeKeychain, SECRET_ID, loadPlugin, run, resetAll, ankiServer, openai, completion, openAiError, readDataJson } from './helpers.mjs';
import { createDefaultSettings, createModelSettings } from '../src/settings/model';
import { OutputMode } from '../src/ai/model-info';
import { createGenerationPrompt } from '../src/generate/prompt';
import { parseGeneratedCards } from '../src/generate/result';
import { DEFAULT_CARD_WRITING_INSTRUCTIONS } from '../src/generate/card-writing-instructions';

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
	openai.handler = () => completion(PAIRS);
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
		const cards = settings().cards;
		cards.cardWritingInstructions = { text: '\r\n# My guidance\r\n\r\n- Keep **this**.  \r\n', defaultVersion: 'old' };
		cards.extraInstructions = '\n# Extras\n\n- Keep spacing.  \n';
		const run = { coverage: 'key-ideas', instructions: '\n# This run\n\nOnly definitions.  \n' };
		const a = createGenerationPrompt(cards, run, NOTE, []);
		const b = createGenerationPrompt(cards, run, { ...NOTE, title: 'Other', markdown: 'Different note.' }, []);
		assert.equal(a.instructions, b.instructions);
		assert.ok(a.instructions.startsWith(cards.cardWritingInstructions.text));
		assert.ok(a.instructions.includes(cards.extraInstructions));
		assert.ok(a.instructions.includes(run.instructions));
		assert.ok(a.instructions.indexOf(cards.extraInstructions) < a.instructions.indexOf(run.instructions));
		assert.ok(a.instructions.indexOf(run.instructions) < a.instructions.indexOf('## Required response format'));
		assert.ok(!a.instructions.includes('A queue removes'));
		assert.equal(JSON.parse(a.source).folder, 'Computing');
		assert.equal(JSON.parse(a.source).markdown, NOTE.markdown);
	});
	test('uses the current guidance when unset but respects an explicitly empty edited guide', () => {
		const cards = settings().cards;
		const run = { coverage: cards.coverageLevel, instructions: '' };
		assert.ok(createGenerationPrompt(cards, run, NOTE, []).instructions.startsWith(DEFAULT_CARD_WRITING_INSTRUCTIONS));
		cards.cardWritingInstructions = { text: '', defaultVersion: 'old' };
		const prompt = createGenerationPrompt(cards, run, NOTE, []);
		assert.ok(!prompt.instructions.includes(DEFAULT_CARD_WRITING_INSTRUCTIONS));
		assert.ok(prompt.instructions.includes('## Required response format'));
	});
	test('each coverage level gives different concrete guidance, and a limit is never a fixed target', () => {
		const cards = settings().cards;
		const texts = ['key-ideas', 'main-ideas-and-details', 'everything'].map(coverage => createGenerationPrompt(cards, { coverage, instructions: '' }, NOTE, []).instructions);
		assert.equal(new Set(texts).size, 3);
		assert.match(texts[0], /Leave out supporting details/);
		assert.match(texts[1], /details that matter on their own/);
		assert.match(texts[2], /including smaller useful details/);
		assert.match(texts[0], /There is no fixed number of cards/);
		const capped = createGenerationPrompt(cards, { coverage: 'everything', maximumCards: 2, instructions: '' }, NOTE, []);
		assert.match(capped.instructions, /at most 2 cards.*ceiling, not a target/);
	});
	test('invalid cards are reported, limits apply to valid cards, and zero cards still carries note issues', () => {
		const result = parseGeneratedCards(JSON.stringify({ cards: [null, { type: 'cloze', front: '{{c1::bad}}', back: '' },
			{ type: 'basic', front: ' ', back: 'x' }, { type: 'basic', front: 'a', back: 'b' },
			{ type: 'basic', front: '{{image:unknown.png}}', back: 'x' }, { type: 'basic', front: 'c', back: 'd' }], note_issues: ['Check this source claim.'] }), 1);
		assert.deepEqual(result.cards, [{ q: 'a', a: 'b' }]);
		assert.equal(result.warnings.length, 5);
		assert.deepEqual(result.noteIssues, ['Check this source claim.']);
		assert.deepEqual(parseGeneratedCards('{"cards":[],"note_issues":["Concern"]}').cards, []);
		for (const reply of ['not JSON', '{"cards":[]}', '{"cards":[],"note_issues":[4]}']) assert.throws(() => parseGeneratedCards(reply), /expected format/);
	});
});

describe('saved settings reach the real export commands', () => {
	test('whole-note exports use saved instructions, coverage and a cleaned source, with no fixed count or alternatives', async () => {
		const value = settings();
		value.cards.cardWritingInstructions = { text: '\nMy **custom** writing rules.  \n', defaultVersion: 'old' };
		value.cards.extraInstructions = '\r\n# Preferences\r\n\r\nUse British spelling.  \r\n';
		value.cards.coverageLevel = 'everything';
		const { plugin } = await setup(value, { activeNote: '---\nsecret: frontmatter\n---\nA queue uses arrival order. %%secret comment%%' });
		const ask = await dialog(plugin);
		assert.equal(control(ask, 'Coverage').value, 'everything');
		assert.equal(control(ask, 'Maximum cards').value, '');
		assert.equal(openai.requests.length, 0);
		await button(ask, 'Generate cards').click();
		const request = openai.requests[0].body;
		assert.ok(request.messages[0].content.startsWith(value.cards.cardWritingInstructions.text));
		assert.ok(request.messages[0].content.includes(value.cards.extraInstructions));
		assert.match(request.messages[0].content, /including smaller useful details/);
		assert.equal(request.n, undefined);
		assert.match(request.messages[0].content, /There is no fixed number of cards/);
		assert.ok(!request.messages.at(-1).content.includes('secret'));
		assert.equal(JSON.parse(request.messages.at(-1).content).title, 'Queues');
	});
	test('coverage and multiline one-off instructions change only this run, leaving saved defaults untouched', async () => {
		const { plugin, disk } = await setup();
		const before = structuredClone(plugin.settings.cards);
		const ask = await dialog(plugin);
		await control(ask, 'Coverage').type('key-ideas');
		const instructions = '\n# Only for today\n\n- Explain **why**.  \n';
		await control(ask, 'Instructions for this run').type(instructions);
		await button(ask, 'Generate cards').click();
		assert.ok(openai.requests[0].body.messages[0].content.includes(instructions));
		assert.match(openai.requests[0].body.messages[0].content, /Leave out supporting details/);
		assert.deepEqual(readDataJson(disk).cards, before);
		last().close();
		const next = await dialog(plugin);
		assert.equal(control(next, 'Coverage').value, before.coverageLevel);
		assert.equal(control(next, 'Instructions for this run').value, '');
	});
	test('settings changed after opening the dialog affect the next run, not the current snapshot', async () => {
		const { plugin } = await setup();
		const ask = await dialog(plugin);
		await plugin.updateSettings(value => { value.cards.extraInstructions = 'New instructions for next time.'; value.cards.coverageLevel = 'everything'; });
		await button(ask, 'Generate cards').click();
		assert.ok(!openai.requests[0].body.messages[0].content.includes('New instructions for next time.'));
		last().close();
		const next = await dialog(plugin);
		await button(next, 'Generate cards').click();
		assert.ok(openai.requests[1].body.messages[0].content.includes('New instructions for next time.'));
		assert.match(openai.requests[1].body.messages[0].content, /including smaller useful details/);
	});
	test('a source reduced to nothing after removing private metadata makes no paid request', async () => {
		const { plugin } = await setup(settings(), { activeNote: '---\nprivate: data\n---\n%%private comment%%' });
		const ask = await dialog(plugin);
		assert.equal(button(ask, 'Generate cards').disabled, true);
		await button(ask, 'Generate cards').click();
		assert.equal(openai.requests.length, 0);
	});
	test('an empty result and suspected note mistakes remain visible without offering an empty Anki export', async () => {
		const { plugin } = await setup();
		openai.handler = () => completion('{"cards":[],"note_issues":["Check the queue definition in the source."]}');
		const ask = await dialog(plugin);
		await button(ask, 'Generate cards').click();
		assert.match(last().contentEl.textContent, /No cards were generated/);
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
		const send = button(ask, 'Generate cards').click();
		await started.promise;
		assert.equal(control(ask, 'Coverage').disabled, true);
		await button(ask, 'Generating…').click();
		assert.equal(openai.requests.length, 1);
		ask.close();
		wait.resolve(completion(PAIRS));
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
			await button(ask, 'Generate cards').click();
			const parts = openai.requests[0].body.messages.at(-1).content;
			assert.equal(parts[1].text, 'Diagram: Images/selected.gif');
			assert.equal(parts[2].image_url.url, 'data:image/png;base64,Bw==');
			assert.match(last().contentEl.textContent, /first GIF frame/);
			assert.match(last().contentEl.textContent, /only images inside the vault/);
			assert.equal(openai.requests.length, 1);
		} finally { globalThis.createEl = create; globalThis.createImageBitmap = bitmap; }
	});
	test('Send diagrams off reaches the command workflow without reading any attachment', async () => {
		const value = settings(); value.cards.sendDiagrams = false;
		const { plugin } = await setup(value, { activeNote: 'A queue diagram: ![[a.png]]', attachments: { 'a.png': new Uint8Array([1]).buffer } });
		const ask = await dialog(plugin);
		assert.match(ask.contentEl.textContent, /Send diagrams is off/);
		await button(ask, 'Generate cards').click();
		assert.deepEqual(fake.attachmentReads, []);
		assert.equal(typeof openai.requests[0].body.messages.at(-1).content, 'string');
	});
});

describe('OpenAI structured output with the saved model settings', () => {
	test('Auto steps down only on unsupported formats, remembers the result, and starts there next time', async () => {
		const { plugin, disk } = await setup();
		openai.handler = body => {
			if (body.response_format?.type === 'json_schema') return openAiError(400, 'response_format json_schema is not supported by this model.');
			if (body.tools) return openAiError(400, 'tool_choice is unsupported by this model.');
			return completion(PAIRS);
		};
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(openai.requests.length, 3);
		assert.equal(readDataJson(disk).providers.openai.models[0].capabilities.outputMode, 'json');
		last().close();
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(openai.requests.length, 4);
		assert.equal(openai.requests.at(-1).body.response_format.type, 'json_object');
	});
	test('forced tool output reads the named function arguments and the exact model limits', async () => {
		const value = settings();
		Object.assign(value.providers.openai.models[0], { outputMode: OutputMode.Tool, maxOutputTokens: 4321, reasoningEffort: 'low' });
		const { plugin } = await setup(value);
		openai.handler = () => ({ json: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
			tool_calls: [{ type: 'function', id: 'call-1', function: { name: 'submit_cards', arguments: JSON.stringify({ cards: [{ type: 'basic', front: 'Question', back: 'Answer' }], note_issues: [] }) } }],
		} }] } });
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(openai.requests[0].body.max_completion_tokens, 4321);
		assert.equal(openai.requests[0].body.reasoning_effort, 'low');
		assert.equal(openai.requests[0].body.tool_choice.function.name, 'submit_cards');
		assert.match(last().contentEl.textContent, /Question/);
	});
	test('bad credentials, limits, image errors, malformed output, refusals and invalid schemas do not cause fallback', async () => {
		const refusal = completion(PAIRS); refusal.json.choices[0].message.refusal = 'Cannot help.';
		for (const reply of [openAiError(401, 'response_format is unsupported'), openAiError(429, 'Limit reached'),
			openAiError(400, 'image input is unsupported'), openAiError(400, 'Invalid schema for response_format: keyword is not supported'),
			completion('invalid'), refusal]) {
			resetAll();
			const { plugin } = await setup();
			openai.handler = () => reply;
			const ask = await dialog(plugin);
			await button(ask, 'Generate cards').click();
			assert.equal(openai.requests.length, 1);
			assert.equal(last(), ask);
			assert.equal(ask.isOpen, true);
			assert.equal(button(ask, 'Generate cards').disabled, false);
			assert.equal(plugin.settings.providers.openai.models[0].capabilities, undefined);
			assert.equal(fake.notices.length, 1);
		}
	});
	test('an explicitly chosen output mode is never changed after an unsupported-format error', async () => {
		const value = settings(); value.providers.openai.models[0].outputMode = OutputMode.JsonSchema;
		const { plugin } = await setup(value);
		openai.handler = () => openAiError(400, 'response_format json_schema is unsupported');
		await button(await dialog(plugin), 'Generate cards').click();
		assert.equal(openai.requests.length, 1);
		assert.equal(plugin.settings.providers.openai.models[0].capabilities, undefined);
	});

	test('unreadable transport replies produce a useful error and no format retry', async () => {
		for (const json of [{}, { choices: [null] }, { choices: [{ message: null }] },
			{ choices: [{ finish_reason: 'stop', message: { content: 42 } }] }]) {
			resetAll();
			const { plugin } = await setup();
			openai.handler = () => ({ json });
			const ask = await dialog(plugin);
			await button(ask, 'Generate cards').click();
			assert.equal(openai.requests.length, 1);
			assert.equal(last(), ask);
			assert.match(fake.notices[0], /readable generation result|expected format/);
		}
	});
});

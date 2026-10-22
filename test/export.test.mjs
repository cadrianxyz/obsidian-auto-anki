// The two commands and the export flow: note → OpenAI → pick questions → pick deck → Anki.
//
// Throughout, notes are read-only (the fake vault and editor throw on any change), and
// Anki only ever receives deckNames and addNote: nothing that edits or deletes.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, buttonsIn, settingsIn } from 'obsidian';
import {
	SECRET_ID, makeDisk, makeKeychain, makeDevice, loadPlugin, openSettings, run, isOffered,
	openai, completion, openAiError, ankiServer, ankiActionsSent, resetAll,
} from './helpers.mjs';

const KEY = 'sk-proj-EXPORT3333333333333333333333333333333333cC33';
const CARDS = [
	{ q: 'What is a radix?', a: 'The number of unique digits in a positional system.' },
	{ q: 'Base of binary?', a: '2' },
	{ q: 'Base of hexadecimal?', a: '16' },
];
const FILE = 'export-current-file-to-anki';
const SELECTION = 'export-text-selection-to-anki';

beforeEach(resetAll);

async function device({ settings, keychain = makeKeychain('ok', { [SECRET_ID]: KEY }), activeNote } = {}) {
	return loadPlugin(makeDevice({ disk: makeDisk(settings), keychain, activeNote }));
}

function button(modal, text) {
	const b = buttonsIn(modal.contentEl).find((x) => x.text === text);
	assert.ok(b, `no "${text}" button; have: ${buttonsIn(modal.contentEl).map((x) => x.text).join(', ')}`);
	return b;
}

function textBox(modal, name) {
	return settingsIn(modal.contentEl).find((s) => s.name === name).components[0];
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
	await button(ask, 'Generate cards').click();
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
		ankiServer();
		openai.handler = () => completion(CARDS);
		await exportAll(plugin);
		assert.equal(openai.requests[0].headers.get('authorization'), `Bearer ${KEY}`);
	});
});

describe('exporting', () => {
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
		openai.handler = () => completion(CARDS);
		const plugin = await device({ settings: { ankiDestinationDeck: 'Biology', openAiModel: 'gpt-6-luna-mini' }, activeNote: '# Numbers\nA radix is…' });
		await exportAll(plugin);

		// What was sent to OpenAI.
		assert.equal(openai.requests.length, 1);
		const req = openai.requests[0];
		assert.match(req.url, /\/chat\/completions$/);
		assert.equal(req.headers.get('authorization'), `Bearer ${KEY}`);
		assert.equal(req.body.model, 'gpt-6-luna-mini');
		assert.equal(req.body.n, 1);
		assert.equal(req.body.max_completion_tokens, 16000);
		assert.deepEqual(req.body.response_format, { type: 'json_object' });
		for (const absent of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'reasoning_effort']) {
			assert.ok(!(absent in req.body), `${absent} should not be sent`);
		}
		assert.match(req.body.messages.at(-1).content, /A radix is…/);
		assert.match(req.body.messages[0].content, /list of 5 questions/);

		// What was added to Anki: one Basic note per card, in the chosen deck.
		assert.deepEqual(anki.added.map((n) => [n.deckName, n.modelName, n.fields.Front, n.fields.Back]),
			CARDS.map((c) => ['Biology', 'Basic', c.q, c.a]));
		assert.deepEqual(anki.added[0].tags, ['auto-gpt-imported']);
		assert.equal(fake.notices.at(-1), 'Successfully exported 3 card(s) to Anki!');
		assert.deepEqual([...new Set(ankiActionsSent())].sort(), ['addNote', 'deckNames', 'multi']);
	});

	test('selected text uses the selected-text defaults', async () => {
		ankiServer();
		openai.handler = () => completion(CARDS.slice(0, 1));
		const plugin = await device();
		run(plugin, SELECTION, 'Hexadecimal is base 16.');
		const ask = lastModal();
		await ask.opened;
		assert.equal(textBox(ask, 'Number of questions').value, '1');
		assert.equal(textBox(ask, 'Number of alternatives').value, '0');
		await button(ask, 'Generate cards').click();
		assert.match(openai.requests[0].body.messages.at(-1).content, /Hexadecimal is base 16\./);
	});

	test('a chosen reasoning effort is sent', async () => {
		ankiServer();
		openai.handler = () => completion(CARDS);
		const plugin = await device({ settings: { generation: { reasoningEffort: 'low', maxOutputTokens: 5000 } } });
		await exportAll(plugin);
		assert.equal(openai.requests[0].body.reasoning_effort, 'low');
		assert.equal(openai.requests[0].body.max_completion_tokens, 5000);
	});

	test('the default deck is preselected; another can be picked', async () => {
		const anki = ankiServer({ decks: ['Default', 'Biology', 'Chemistry'] });
		openai.handler = () => completion(CARDS);
		const plugin = await device({ settings: { ankiDestinationDeck: 'Biology' } });
		const ask = await startExport(plugin);
		await button(ask, 'Generate cards').click();
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
		openai.handler = () => completion(CARDS);
		const plugin = await device();
		await exportAll(plugin);
		assert.ok(anki.added.every((n) => n.deckName === 'Languages'));
	});

	test('picking some questions exports only those', async () => {
		const anki = ankiServer();
		openai.handler = () => completion(CARDS);
		const plugin = await device();
		const ask = await startExport(plugin);
		await button(ask, 'Generate cards').click();
		const choose = lastModal();
		questionItems(choose)[0].click();
		questionItems(choose)[2].click();
		questionItems(choose)[2].click(); // unpicked again
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		await button(decks, 'Confirm and export').click();
		assert.deepEqual(anki.added.map((n) => n.fields.Front), [CARDS[0].q]);
	});

	test('alternatives: one window per question, picks from each are exported together', async () => {
		const anki = ankiServer();
		const ALT = CARDS.map((c) => ({ q: `${c.q} (alt)`, a: c.a }));
		openai.handler = () => completion(CARDS, ALT);
		const plugin = await device({ settings: { questionGenerationDefaults: { file: { numQuestions: 3, numAlternatives: 1 }, textSelection: { numQuestions: 1, numAlternatives: 0 } } } });
		const ask = await startExport(plugin);
		await button(ask, 'Generate cards').click();
		assert.equal(openai.requests[0].body.n, 2);

		const choose = lastModal();
		const pickedFronts = [];
		for (let i = 0; i < 3; i++) {
			const items = questionItems(choose);
			assert.equal(items.length, 2, `question ${i + 1} should offer 2 versions`);
			items[i % 2].click();
			pickedFronts.push(items[i % 2].children[0].text);
			if (i < 2) await button(choose, 'Next').click();
		}
		await button(choose, 'Previous').click();
		await button(choose, 'Next').click();
		await button(choose, 'Confirm selection').click();
		const decks = lastModal();
		await decks.opened;
		await button(decks, 'Confirm and export').click();
		assert.deepEqual(anki.added.map((n) => n.fields.Front), pickedFronts);
	});

	for (const [label, values] of [
		['zero questions', ['0', '0']],
		['negative alternatives', ['3', '-1']],
		['text', ['five', '0']],
	]) {
		test(`${label}: refused before anything is sent`, async () => {
			ankiServer();
			openai.handler = () => completion(CARDS);
			const plugin = await device();
			const ask = await startExport(plugin);
			await textBox(ask, 'Number of questions').type(values[0]);
			await textBox(ask, 'Number of alternatives').type(values[1]);
			await button(ask, 'Generate cards').click();
			assert.equal(openai.requests.length, 0);
			assert.match(fake.notices.at(-1), /invalid number/i);
		});
	}
});

describe('what the user is told when something goes wrong', () => {
	async function failingExport(reply) {
		ankiServer();
		openai.handler = typeof reply === 'function' ? reply : () => reply;
		const plugin = await device({ settings: { openAiModel: 'gpt-6-luna-mini' } });
		const ask = await startExport(plugin);
		await button(ask, 'Generate cards').click();
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
		assert.match(await failingExport(openAiError(400, "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", 'unsupported_value')), /doesn't accept the chosen reasoning effort/);
	});
	test('any other OpenAI error', async () => {
		assert.match(await failingExport(openAiError(500, 'The server had an error')), /OpenAI returned an error \(500\)/);
	});
	test('no connection to OpenAI', async () => {
		assert.match(await failingExport(() => { throw new TypeError('fetch failed'); }), /Could not connect to OpenAI/);
	});
	test('reply cut off (ran out of tokens)', async () => {
		const reply = completion(CARDS);
		reply.json.choices[0].finish_reason = 'length';
		assert.match(await failingExport(reply), /ran out of tokens/);
	});
	test('reply that is not the expected JSON', async () => {
		assert.match(await failingExport(completion('Sure! Here are your questions: 1. …')), /wasn't in the expected format/);
		resetAll();
		assert.match(await failingExport(completion('{"cards": []}')), /wasn't in the expected format/);
	});
	test('entries that are not a question and answer are dropped, the rest kept', async () => {
		const anki = ankiServer();
		openai.handler = () => completion([CARDS[0], { q: 'no answer' }, 'junk', null, CARDS[1]]);
		const plugin = await device();
		await exportAll(plugin);
		assert.deepEqual(anki.added.map((n) => n.fields.Front), [CARDS[0].q, CARDS[1].q]);
	});

	test('Anki refuses some cards: how many, and why (each reason once)', async () => {
		const anki = ankiServer({ refuse: (note) => (note.fields.Front === CARDS[1].q ? 'cannot create note because it is a duplicate' : null) });
		openai.handler = () => completion(CARDS);
		await exportAll(await device());
		assert.equal(anki.added.length, 2);
		assert.match(fake.notices.at(-1), /Exported 2 of 3 card\(s\) to Anki\. Anki refused 1:\ncannot create note because it is a duplicate/);
	});

	test('Anki refuses every card for the same reason (e.g. no "Basic" note type): the reason is shown once', async () => {
		ankiServer({ refuse: () => 'model was not found: Basic' });
		openai.handler = () => completion(CARDS);
		await exportAll(await device());
		const notice = fake.notices.at(-1);
		assert.match(notice, /Exported 0 of 3/);
		assert.equal(notice.split('model was not found: Basic').length - 1, 1);
	});

	test('Anki refuses the whole request', async () => {
		ankiServer({ multiResult: () => ({ result: null, error: 'collection is not available' }) });
		openai.handler = () => completion(CARDS);
		await exportAll(await device());
		assert.match(fake.notices.at(-1), /Anki refused the export: collection is not available/);
	});

	test('Anki closed between generating and exporting', async () => {
		ankiServer();
		openai.handler = () => completion(CARDS);
		const plugin = await device();
		const ask = await startExport(plugin);
		await button(ask, 'Generate cards').click();
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

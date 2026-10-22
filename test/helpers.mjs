// Shared set-up for the tests: fake "devices" (an Obsidian app with its own Keychain),
// a shared vault disk (data.json), and fake OpenAI and AnkiConnect servers.
import { fake } from 'obsidian';
// Must come before the plugin: version 4 of the OpenAI SDK keeps whichever fetch exists
// when it first loads.
import { openai } from './fake-openai.mjs';
import AutoAnkiPlugin from '../src/main';

export { openai };

export const SECRET_ID = 'auto-anki-openai-api-key';
export const MANIFEST = { id: 'auto-anki', name: 'Auto Anki', version: 'test', dir: '.obsidian/plugins/auto-anki' };

// ---- The vault on disk. Two devices can share one, like a synced vault. ----

export function makeDisk(dataJson) {
	const disk = { files: {}, writes: 0 };
	if (dataJson !== undefined) disk.files['data.json'] = typeof dataJson === 'string' ? dataJson : JSON.stringify(dataJson);
	return disk;
}

export function readDataJson(disk) {
	const raw = disk.files['data.json'];
	return raw === undefined ? undefined : JSON.parse(raw);
}

// ---- Obsidian's Keychain (app.secretStorage), per device and vault ----
// mode: 'ok' | 'ignores-writes' (setSecret does nothing) | 'throws' (every call throws)
//       | 'throws-on-write'

export function makeKeychain(mode = 'ok', initial = {}) {
	const secrets = new Map(Object.entries(initial));
	const calls = { set: 0, get: 0 };
	return {
		secrets,
		calls,
		setSecret(id, value) {
			calls.set += 1;
			if (mode === 'throws' || mode === 'throws-on-write') throw new Error('Keychain is locked');
			if (mode === 'ignores-writes') return;
			if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid secret ID');
			secrets.set(id, value);
		},
		getSecret(id) {
			calls.get += 1;
			if (mode === 'throws') throw new Error('Keychain is locked');
			return secrets.has(id) ? secrets.get(id) : null;
		},
		listSecrets() {
			if (mode === 'throws') throw new Error('Keychain is locked');
			return [...secrets.keys()];
		},
	};
}

// ---- Notes and editors that fail the test if anything tries to change them ----

const NOTE_WRITERS = ['modify', 'process', 'create', 'delete', 'trash', 'rename', 'append', 'copy', 'createFolder'];
const EDITOR_WRITERS = ['replaceSelection', 'replaceRange', 'setValue', 'setLine', 'transaction'];

function readOnly(name, writers, base = {}) {
	return new Proxy(base, {
		get(target, prop) {
			if (writers.includes(prop)) throw new Error(`Auto Anki tried to change a note: ${name}.${String(prop)}()`);
			return target[prop];
		},
	});
}

export function makeEditor(selection) {
	return readOnly('editor', EDITOR_WRITERS, { getSelection: () => selection, getValue: () => selection });
}

// ---- A device: an Obsidian app with this vault open ----

export function makeDevice({ disk = makeDisk(), keychain = makeKeychain(), activeNote = 'Some note text.' } = {}) {
	const app = {
		disk,
		vault: readOnly('vault', NOTE_WRITERS, { adapter: readOnly('vault.adapter', ['write', 'append', 'remove', 'rename', 'writeBinary', 'process'], {}) }),
		workspace: {
			activeNote,
			getActiveViewOfType() {
				return this.activeNote === null ? null : { data: this.activeNote, editor: makeEditor('') };
			},
		},
	};
	if (keychain !== null) app.secretStorage = keychain;
	return app;
}

// Loads the plugin the way Obsidian does: construct, then onload().
export async function loadPlugin(app) {
	const plugin = new AutoAnkiPlugin(app, MANIFEST);
	await plugin.onload();
	return plugin;
}

export function openSettings(plugin) {
	const tab = plugin.settingTabs[0];
	tab.display();
	return tab;
}

export function command(plugin, id) {
	const cmd = plugin.commands.find((c) => c.id === id);
	if (!cmd) throw new Error(`no command ${id}`);
	return cmd;
}

// Is the command offered in the command palette right now?
export function isOffered(plugin, id, selection = 'selected text') {
	const cmd = command(plugin, id);
	if (cmd.checkCallback) return cmd.checkCallback(true) === true;
	return cmd.editorCheckCallback(true, makeEditor(selection), {}) === true;
}

export function run(plugin, id, selection = 'selected text') {
	const cmd = command(plugin, id);
	if (cmd.checkCallback) return cmd.checkCallback(false);
	return cmd.editorCheckCallback(false, makeEditor(selection), {});
}

// ---- Data.json shapes written by earlier versions ----

// What 0.1.0 to 0.2.1 wrote (they all used the same settings), with a key entered.
export const DATA_0_2_1 = Object.freeze({
	ankiConnectPort: 8765,
	ankiDestinationDeck: 'Biology',
	openAiApiKey: 'sk-proj-OLDKEY0000000000000000000000000000000000fEk6',
	openAiApiKeyIdentifier: 'sk-...fEk6',
	gptAdvancedOptions: { temperature: 1, top_p: 1, frequency_penalty: 0, presence_penalty: 0, max_tokens_per_question: 100 },
	questionGenerationDefaults: { textSelection: { numQuestions: 2, numAlternatives: 1 }, file: { numQuestions: 7, numAlternatives: 0 } },
});

// 0.2.2 added the model setting.
export const DATA_0_2_2 = Object.freeze({ ...DATA_0_2_1, openAiModel: 'gpt-6-luna-mini' });

// A 0.2.x install where no key was ever entered.
export const DATA_NO_KEY = Object.freeze({ ...DATA_0_2_1, openAiApiKey: null, openAiApiKeyIdentifier: '' });

// A successful chat completion, one choice per list of cards.
export function completion(...choices) {
	return {
		json: {
			id: 'chatcmpl-test',
			object: 'chat.completion',
			created: 0,
			model: 'test-model',
			choices: choices.map((cards, index) => ({
				index,
				finish_reason: 'stop',
				message: { role: 'assistant', content: typeof cards === 'string' ? cards : JSON.stringify({ questions_answers: cards }) },
			})),
		},
	};
}

export function openAiError(status, message, code) {
	return { status, json: { error: { message, type: 'invalid_request_error', code: code ?? null } } };
}

// ---- Fake AnkiConnect ----
// Answers like AnkiConnect 6: deckNames, and multi with one addNote per card.

export function ankiServer({ decks = ['Default', 'Biology'], refuse = () => null, multiResult } = {}) {
	const added = [];
	fake.ankiHandler = (body) => {
		if (body.action === 'deckNames') return { json: { result: decks, error: null } };
		if (body.action === 'multi') {
			if (multiResult) return { json: multiResult(body) };
			const result = body.params.actions.map((a) => {
				if (a.action !== 'addNote') return { result: null, error: `unsupported action ${a.action}` };
				const reason = refuse(a.params.note);
				if (reason) return { result: null, error: reason };
				added.push(a.params.note);
				return { result: 1000 + added.length, error: null };
			});
			return { json: { result, error: null } };
		}
		return { json: { result: null, error: `unsupported action ${body.action}` } };
	};
	return { added };
}

// Every AnkiConnect action the plugin sent, sub-actions of `multi` included.
export function ankiActionsSent() {
	return fake.ankiRequests.flatMap((r) => [r.body.action, ...(r.body.action === 'multi' ? r.body.params.actions.map((a) => a.action) : [])]);
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

export function resetAll() {
	fake.reset();
	openai.reset();
}

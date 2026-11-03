// Shared set-up for the tests: fake "devices" (an Obsidian app with its own Keychain),
// a shared vault disk (data.json), and fake OpenAI and AnkiConnect servers.
import { fake } from 'obsidian';
// Must come before the plugin: the SDKs may keep whichever fetch exists
// when it first loads.
import { openai } from './fake-fetch.mjs';
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

export function makeDevice({ disk = makeDisk(), keychain = makeKeychain(), activeNote = 'Some note text.', pluginDirectory = MANIFEST.dir,
	notePath = 'Notes/Example.md', attachments = {} } = {}) {
	const cachePath = `${pluginDirectory}/model-catalog-cache.json`;
	const adapter = readOnly('vault.adapter', ['append', 'remove', 'rename', 'writeBinary', 'process'], {
		async read(path) {
			if (path !== cachePath) throw new Error(`Auto Anki tried to read an unexpected file: ${path}`);
			if (!(path in disk.files)) throw new Error('File does not exist');
			return disk.files[path];
		},
		async write(path, data) {
			if (path !== cachePath) throw new Error(`Auto Anki tried to change an unexpected file: ${path}`);
			disk.files[path] = data;
			disk.cacheWrites = (disk.cacheWrites ?? 0) + 1;
		},
	});
	const app = {
		disk,
		vault: readOnly('vault', NOTE_WRITERS, { adapter,
			async readBinary(file) {
				fake.attachmentReads.push(file.path);
				if (!(file.path in attachments)) throw new Error('Attachment missing');
				return attachments[file.path];
			},
		}),
		metadataCache: { getFirstLinkpathDest(link, sourcePath) {
			const folder = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
			const path = [link, `${folder}${link}`, ...Object.keys(attachments).filter(path => path.endsWith(`/${link}`))].find(path => path in attachments);
			return path ? { path, extension: path.split('.').at(-1), basename: path.split('/').at(-1).replace(/\.[^.]+$/, '') } : null;
		} },
		workspace: {
			activeNote,
			file: { path: notePath, basename: notePath.split('/').at(-1).replace(/\.[^.]+$/, '') },
			getActiveViewOfType() {
				return this.activeNote === null ? null : { data: this.activeNote, editor: makeEditor(''), file: this.file };
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

export function openProviderSettings(plugin, name = 'OpenAI') {
	const tab = openSettings(plugin);
	tab.openPage(name);
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
	return cmd.editorCheckCallback(false, makeEditor(selection), { file: plugin.app.workspace.file });
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

export function generatedNote(value) {
	if (!value || typeof value !== 'object' || value.noteType) return value;
	if ('q' in value) return { noteType: 'Basic', fields: { Front: value.q, Back: value.a } };
	if (value.type === 'basic') return { noteType: 'Basic', fields: { Front: value.front, Back: value.back } };
	if (value.type === 'cloze') return { noteType: 'Cloze', fields: { Text: value.front, 'Back Extra': value.back } };
	return value;
}

export const BASIC_DESTINATIONS = { url: 'http://127.0.0.1:8765', problems: [], types: [{ name: 'Basic', id: 100, fields: ['Front', 'Back'], descriptions: {}, templates: [{ name: 'Card 1', front: '{{Front}}', back: '{{Back}}' }] }] };

// A completed Responses API reply whose final message holds the generated notes,
// or the given text verbatim.
export function openAiReply(notes) {
	return {
		json: {
			id: 'resp_test',
			object: 'response',
			created_at: 0,
			model: 'test-model',
			status: 'completed',
			error: null,
			incomplete_details: null,
			output: [{
				type: 'message', id: 'msg_test', role: 'assistant', status: 'completed',
				content: [{ type: 'output_text', annotations: [], text: typeof notes === 'string' ? notes : JSON.stringify({
					notes: notes.map(note => generatedNote(note)), note_issues: [],
				}) }],
			}],
		},
	};
}

export function openAiError(status, message, code) {
	return { status, json: { error: { message, type: 'invalid_request_error', code: code ?? null } } };
}

// ---- Fake AnkiConnect ----
// Answers like AnkiConnect 6: deckNames, and multi with one addNote per note.

export const BASIC_NOTE_TYPE = { id: 100, fields: ['Front', 'Back'], descriptions: ['', ''], templates: { 'Card 1': { Front: '{{Front}}', Back: '{{FrontSide}}\n<hr id=answer>\n{{Back}}' } } };
export const CLOZE_NOTE_TYPE = { id: 200, fields: ['Text', 'Back Extra'], descriptions: ['', ''], templates: { Cloze: { Front: '{{cloze:Text}}', Back: '{{cloze:Text}}<br>{{Back Extra}}' } } };

// storeMedia answers storeMediaFile: by default it stores the file under the name it was given.
export function ankiServer({ decks = ['Default', 'Biology'], refuse = () => null, multiResult, noteTypes = { Basic: BASIC_NOTE_TYPE }, storeMedia = filename => ({ result: filename, error: null }) } = {}) {
	const added = [];
	const media = [];
	const types = structuredClone(noteTypes);
	fake.ankiHandler = (body) => {
		if (body.action === 'deckNames') return { json: { result: decks, error: null } };
		if (body.action === 'modelNamesAndIds') return { json: { result: Object.fromEntries(Object.entries(types).map(([name, type]) => [name, type.id])), error: null } };
		if (body.action === 'modelNames') return { json: { result: Object.keys(types), error: null } };
		if (['modelFieldNames', 'modelTemplates', 'modelFieldDescriptions'].includes(body.action)) {
			const type = types[body.params.modelName];
			if (!type) return { json: { result: null, error: `model was not found: ${body.params.modelName}` } };
			return { json: { result: body.action === 'modelFieldNames' ? type.fields : body.action === 'modelTemplates' ? type.templates : type.descriptions ?? [], error: null } };
		}
		if (body.action === 'canAddNotes') return { json: { result: body.params.notes.map(() => true), error: null } };
		if (body.action === 'storeMediaFile') {
			const answer = storeMedia(body.params.filename);
			if (!answer.error) media.push({ filename: body.params.filename, data: body.params.data });
			return { json: answer };
		}
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
	return { added, types, media };
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

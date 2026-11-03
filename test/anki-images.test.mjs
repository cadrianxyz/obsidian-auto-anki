// Images in generated notes: Anki file names, storing media, and the export that uses them.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { readNoteType, getDestinations } from '../src/anki/note-types';
import { AnkiClient } from '../src/anki/client';
import { addNotesToAnki } from '../src/anki/export';
import { ankiMediaName, storeAnkiMedia } from '../src/anki/media';
import { createDefaultSettings } from '../src/settings/schema';
import { ankiServer, resetAll } from './helpers.mjs';

beforeEach(resetAll);

const custom = { id: 300, fields: ['Term', 'Meaning'], descriptions: ['', ''], templates: { Recall: { Front: '{{Term}}', Back: '{{Meaning}}' } } };

const encode = bytes => Buffer.from(bytes).toString('base64');

// A diagram as prepareDiagrams returns it. The stored copy is the sent copy unless stored bytes are given.
function diagram(name, bytes = [1, 2, 3], { extension = 'png', stored = bytes } = {}) {
	const base64 = encode(bytes);
	return { path: name, mime: 'image/png', base64, stored: { extension, base64: encode(stored) } };
}

async function setup(options = {}) {
	const server = ankiServer({ noteTypes: { Vocabulary: custom }, ...options });
	const settings = createDefaultSettings().anki;
	settings.enabledNoteTypes = ['Vocabulary'];
	const type = await readNoteType(new AnkiClient(settings.url), 'Vocabulary', 300);
	return { server, snapshot: getDestinations(settings, [type]) };
}

const note = (meaning, term = 'queue') => ({ noteType: 'Vocabulary', fields: { Term: term, Meaning: meaning } });
const storeRequests = () => fake.ankiRequests.filter(request => request.body.action === 'storeMediaFile').map(request => request.body.params);
const actionIndex = action => fake.ankiRequests.findIndex(request => request.body.action === action);

describe('Anki file names for images', () => {
	test('a name has the hash, the file stem and the stored extension', async () => {
		assert.match(await ankiMediaName(diagram('Notes/queue.png')), /^auto-anki-[0-9a-f]{16}-queue\.png$/);
	});

	test('the same bytes get the same hash, wherever the file lives', async () => {
		const first = await ankiMediaName(diagram('Notes/one/queue.png', [9, 9]));
		const second = await ankiMediaName(diagram('Other/queue-copy.png', [9, 9]));
		assert.equal(first.split('-')[2], second.split('-')[2]);
	});

	test('different bytes get different hashes', async () => {
		assert.notEqual(await ankiMediaName(diagram('a.png', [1])), await ankiMediaName(diagram('a.png', [2])));
	});

	test('only characters Anki accepts in a file name are kept, and a GIF keeps its extension', async () => {
		const name = await ankiMediaName(diagram('Notes/My pic (final) é.gif', [1], { extension: 'gif' }));
		assert.match(name, /^[A-Za-z0-9_.-]+$/);
		assert.ok(name.endsWith('.gif'));
	});
});

describe('storing media', () => {
	test('the file goes to Anki with its name and base64 data', async () => {
		ankiServer();
		await storeAnkiMedia(new AnkiClient('http://127.0.0.1:8765'), 'auto-anki-x-a.png', 'AQID');
		assert.deepEqual(storeRequests(), [{ filename: 'auto-anki-x-a.png', data: 'AQID' }]);
	});

	test('a file that Anki stores under another name is an error', async () => {
		ankiServer({ storeMedia: filename => ({ result: `${filename}-1`, error: null }) });
		await assert.rejects(storeAnkiMedia(new AnkiClient('http://127.0.0.1:8765'), 'auto-anki-x-a.png', 'AQID'), /another name/);
	});
});

describe('exporting images', () => {
	test('a used image is stored once, before its notes are added, and each note shows the stored name', async () => {
		const { server, snapshot } = await setup();
		const queue = diagram('Notes/queue.png');
		const name = await ankiMediaName(queue);
		const outcome = await addNotesToAnki([note('Look: {{image:Notes/queue.png}} and again {{image:Notes/queue.png}}')], snapshot, 'Default', [queue], []);
		assert.equal(outcome.added, 1);
		assert.deepEqual(storeRequests(), [{ filename: name, data: queue.base64 }]);
		assert.ok(actionIndex('storeMediaFile') < actionIndex('multi'));
		assert.equal(server.added[0].fields.Meaning, `Look: <img src="${name}" alt="Notes/queue.png"> and again <img src="${name}" alt="Notes/queue.png">`);
	});

	test('only the images a note uses are stored', async () => {
		const { snapshot } = await setup();
		const a = diagram('Notes/a.png', [1]);
		const b = diagram('Notes/b.png', [2]);
		await addNotesToAnki([note('{{image:Notes/a.png}}')], snapshot, 'Default', [a, b], []);
		assert.deepEqual(storeRequests().map(request => request.filename), [await ankiMediaName(a)]);
	});

	test('a note without images stores nothing', async () => {
		const { snapshot } = await setup();
		const outcome = await addNotesToAnki([note('Plain text')], snapshot, 'Default', [diagram('Notes/a.png')], []);
		assert.equal(outcome.added, 1);
		assert.deepEqual(storeRequests(), []);
	});

	test('a note Anki refuses leaves no media behind', async () => {
		const { snapshot } = await setup();
		const handler = fake.ankiHandler;
		fake.ankiHandler = body => body.action === 'canAddNotes' ? { json: { result: [false], error: null } } : handler(body);
		const outcome = await addNotesToAnki([note('{{image:Notes/a.png}}')], snapshot, 'Default', [diagram('Notes/a.png')], []);
		assert.equal(outcome.added, 0);
		assert.equal(outcome.remaining.length, 1);
		assert.deepEqual(storeRequests(), []);
	});

	test('a GIF is stored as the original file, not the still frame that was sent', async () => {
		const { snapshot } = await setup();
		const gif = { path: 'Notes/motion.gif', mime: 'image/png', base64: encode([1]), stored: { extension: 'gif', base64: encode([71, 73, 70]) } };
		const outcome = await addNotesToAnki([note('{{image:Notes/motion.gif}}')], snapshot, 'Default', [gif], []);
		assert.equal(outcome.added, 1);
		assert.match(storeRequests()[0].filename, /^auto-anki-[0-9a-f]{16}-motion\.gif$/);
		assert.equal(storeRequests()[0].data, 'R0lG');
	});

	test('when one image cannot be stored, only the notes that use it fail', async () => {
		const a = diagram('Notes/a.png', [1]);
		const b = diagram('Notes/b.png', [2]);
		const failing = await ankiMediaName(a);
		const { server, snapshot } = await setup({ storeMedia: filename => filename === failing ? { result: null, error: 'disk full' } : { result: filename, error: null } });
		const outcome = await addNotesToAnki([note('{{image:Notes/a.png}}', 'first'), note('{{image:Notes/b.png}}', 'second')], snapshot, 'Default', [a, b], []);
		assert.equal(outcome.added, 1);
		assert.deepEqual(server.added.map(added => added.fields.Term), ['second']);
		assert.deepEqual(outcome.remaining.map(item => item.fields.Term), ['first']);
		assert.match(outcome.errors[0], /disk full/);
	});

	test('a placeholder for a diagram that was not sent stops the export before Anki is called', async () => {
		const { snapshot } = await setup();
		const before = fake.ankiRequests.length;
		await assert.rejects(addNotesToAnki([note('{{image:missing.png}}')], snapshot, 'Default', [diagram('Notes/a.png')], []), /invalid fields/);
		assert.equal(fake.ankiRequests.length, before);
	});
});

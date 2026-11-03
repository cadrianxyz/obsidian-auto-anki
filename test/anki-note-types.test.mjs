import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { AnkiClient } from '../src/anki/client';
import { readNoteTypeNames, readNoteType, verifyNoteType, getDestinations, NoteTypeDiscovery, revalidateDestinations } from '../src/anki/note-types';
import { validCloze } from '../src/anki/validation/cloze';
import { createDefaultSettings, normalizeSettings } from '../src/settings/schema';
import { parseGeneratedNotes } from '../src/generate/result';
import { ankiServer, BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE, resetAll } from './helpers.mjs';

beforeEach(resetAll);
const URL = 'http://127.0.0.1:8765';
const client = () => new AnkiClient(URL);
const result = value => ({ json: { result: value, error: null } });
async function destinations() {
	const names = await readNoteTypeNames(client());
	const types = await Promise.all([...names].map(([name, id]) => readNoteType(client(), name, id)));
	const settings = createDefaultSettings().anki;
	return { settings, types, snapshot: getDestinations(settings, types) };
}

describe('Anki metadata and compatible destinations', () => {
	test('reads identities, fields, templates and descriptions without modifying the collection', async () => {
		ankiServer({ noteTypes: { Basic: { ...BASIC_NOTE_TYPE, descriptions: ['Question to recall', 'Expected answer'] }, Cloze: CLOZE_NOTE_TYPE } });
		const { types, snapshot } = await destinations();
		assert.equal(types[0].id, 100);
		assert.equal(snapshot.types.find(type => type.name === 'Basic').descriptions.Front, 'Question to recall');
		assert.deepEqual(snapshot.types.find(type => type.name === 'Cloze').fields, ['Text', 'Back Extra']);
		assert.ok(fake.ankiRequests.every(request => /^model(?:NamesAndIds|FieldNames|FieldDescriptions|Templates)$/.test(request.body.action)));
	});
	test('older AnkiConnect can omit IDs and descriptions, but unrelated failures are not treated as unsupported actions', async () => {
		ankiServer(); const handler = fake.ankiHandler;
		fake.ankiHandler = body => ['modelNamesAndIds', 'modelFieldDescriptions'].includes(body.action)
			? { json: { result: null, error: 'unsupported action' } } : handler(body);
		const { types, snapshot } = await destinations();
		assert.equal(types[0].id, null);
		assert.deepEqual(types[0].descriptions, {});
		assert.equal(snapshot.types.find(type => type.name === 'Basic').name, 'Basic');
		fake.ankiRequests.length = 0;
		fake.ankiHandler = () => ({ json: { result: null, error: 'collection is not available' } });
		await assert.rejects(readNoteTypeNames(client()), /collection is not available/);
		assert.equal(fake.ankiRequests.length, 1);
	});
	test('unreadable metadata never supplies a verified destination', async () => {
		for (const value of [null, [], { Basic: '100' }, { Basic: -1 }]) {
			fake.ankiHandler = () => result(value);
			await assert.rejects(readNoteTypeNames(client()), /unreadable/);
		}
		ankiServer({ noteTypes: { Basic: { ...BASIC_NOTE_TYPE, fields: ['Front', 'Front'] } } });
		await assert.rejects(readNoteType(client(), 'Basic', 100), /invalid field names/);
		ankiServer({ noteTypes: { Basic: { ...BASIC_NOTE_TYPE, templates: { Broken: { Front: '{{Front}}' } } } } });
		await assert.rejects(readNoteType(client(), 'Basic', 100), /unreadable card template/);
	});
	test('custom types can use multiple fields, reverse templates and optional conditions', async () => {
		ankiServer(); const basic = await readNoteType(client(), 'Basic', 100);
		basic.fields.push('Example'); basic.templates[0].back += '{{#Example}}{{Example}}{{/Example}}';
		basic.templates.push({ name: 'Reverse', front: '{{Back}}', back: '{{Front}}' });
		assert.doesNotThrow(() => verifyNoteType(basic));
		const anki = createDefaultSettings().anki; anki.enabledNoteTypes = [];
		assert.deepEqual(getDestinations(anki, [basic]).types, []);
	});
	test('unknown references and generated media remain unsupported, not additional text fields', async () => {
		ankiServer(); const basic = await readNoteType(client(), 'Basic', 100);
		const broken = structuredClone(basic); broken.templates[0].front = '{{Typo}}';
		assert.throws(() => verifyNoteType(broken), /unknown field/);
		const media = structuredClone(basic); media.templates[0].front = '<img src="{{Front}}">';
		assert.throws(() => verifyNoteType(media), /generated media/);
	});
	test('disconnects retain last known types and preferences but withdraw verification', async () => {
		ankiServer(); const discovery = new NoteTypeDiscovery();
		assert.equal(await discovery.refresh(URL), true);
		fake.ankiHandler = null;
		assert.equal(await discovery.refresh(URL), false);
		assert.equal(discovery.verified, false);
		assert.equal(discovery.types[0].name, 'Basic');
		assert.match(discovery.error, /Could not connect/);
		await discovery.refresh('http://127.0.0.1:9999');
		assert.deepEqual(discovery.types, []);
	});
	for (const change of ['identity', 'fields', 'templates', 'missing']) test(`a changed ${change} blocks reuse of a captured destination`, async () => {
		const server = ankiServer(); const { snapshot } = await destinations();
		if (change === 'identity') server.types.Basic.id++;
		if (change === 'fields') server.types.Basic.fields.reverse();
		if (change === 'templates') server.types.Basic.templates['Card 1'].Back += '<hr>';
		if (change === 'missing') delete server.types.Basic;
		await assert.rejects(revalidateDestinations(snapshot, ['Basic']), /changed|no longer available/);
	});
});

describe('cloze validation', () => {
	test('supports c1 spans, hints, multiple blanks and balanced maths braces', () => {
		const text = 'The derivative of {{c1::$x^{2}$::a power}} is {{c1::$2x$}}.';
		assert.equal(validCloze(text), true);

	});
	test('rejects empty, numbered, nested and incomplete deletions', () => {
		for (const text of ['plain sentence', '{{c1:: }}', '{{c1::::hint}}', '{{c2::answer}}', '{{c1::answer}} {{c2::other}}', '{{c1::unfinished', '{{C1::uppercase}}', '{{c1::outer {{c1::inner}}}}']) assert.equal(validCloze(text), false, text);
	});
	test('multiple cloze fields need one valid deletion and reject malformed deletions in any field', () => {
		const type = { name: 'Multi cloze', fields: ['First', 'Second'], templates: [{ name: 'Cloze', front: '{{cloze:First}} {{cloze:Second}}', back: '{{cloze:First}} {{cloze:Second}}' }] };
		const notes = [
			{ noteType: type.name, fields: { First: 'Plain text', Second: '{{c1::answer}}' } },
			{ noteType: type.name, fields: { First: '{{c1::answer}}', Second: '' } },
			{ noteType: type.name, fields: { First: '{{c1::answer}}', Second: '{{c1::unfinished' } },
			{ noteType: type.name, fields: { First: 'Plain text', Second: '' } },
		];
		const result = parseGeneratedNotes(JSON.stringify({ notes, note_issues: [] }), undefined, { types: [type] });
		assert.deepEqual(result.notes, notes.slice(0, 2));
		assert.equal(result.warnings.length, 2);
	});
	test('the model cannot choose an unavailable format, invent a type or lose an explanation', async () => {
		ankiServer({ noteTypes: { Cloze: { ...CLOZE_NOTE_TYPE, fields: ['Text'], templates: { Cloze: { Front: '{{cloze:Text}}', Back: '{{cloze:Text}}' } } } } });
		const { snapshot } = await destinations();
		const parsed = parseGeneratedNotes(JSON.stringify({ notes: [
			{ noteType: 'Basic', fields: { Front: 'Q?', Back: 'A' } }, { noteType: 'Custom', fields: {} },
			{ noteType: 'Cloze', fields: { Text: '{{c1::answer}}', Extra: 'No field for this' } },
			{ noteType: 'Cloze', fields: { Text: '{{c2::answer}}' } },
			{ noteType: 'Cloze', fields: { Text: 'A queue is {{c1::FIFO}}.' } },
		], note_issues: [] }), undefined, snapshot);
		assert.deepEqual(parsed.notes, [{ noteType: 'Cloze', fields: { Text: 'A queue is {{c1::FIFO}}.' } }]);
		assert.equal(parsed.warnings.length, 4);
	});
});

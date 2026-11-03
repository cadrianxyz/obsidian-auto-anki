import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { readNoteType, getDestinations } from '../src/anki/note-types';
import { AnkiClient } from '../src/anki/client';
import { addNotesToAnki } from '../src/anki/export';
import { noteResponseSchema, validateGeneratedNote, parseGeneratedNotes, imageIdsIn } from '../src/generate/result';
import { createDefaultSettings } from '../src/settings/schema';
import { SAMPLE_NOTE_INFORMATION } from '../sample/sample_note_information';
import { BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE, ankiServer, resetAll } from './helpers.mjs';
beforeEach(resetAll);
const custom = { id: 300, fields: ['Term', 'Meaning', 'Example'], descriptions: ['Word', 'Definition', 'Optional usage'], templates: { Recall: { Front: '{{Term}}', Back: '{{Meaning}}{{#Example}} {{Example}}{{/Example}}' } } };
const note = { noteType: 'Vocabulary', fields: { Term: 'bonjour', Meaning: 'hello', Example: '' } };
async function setup(options = {}) {
 const server = ankiServer({ noteTypes: { Vocabulary: custom }, ...options });
 const settings = createDefaultSettings().anki; settings.enabledNoteTypes = ['Vocabulary'];
 const type = await readNoteType(new AnkiClient(settings.url), 'Vocabulary', 300);
 return { server, snapshot: getDestinations(settings, [type]) };
}
describe('native fields and exact type validation', () => {
 test('schema binds all native fields to their type without extra properties', async () => {
  const { snapshot } = await setup(); const variant = noteResponseSchema(snapshot).properties.notes.items.anyOf[0];
  assert.deepEqual(variant.properties.noteType.enum, ['Vocabulary']);
  assert.deepEqual(variant.properties.fields.required, ['Term', 'Meaning', 'Example']);
  assert.equal(variant.properties.fields.additionalProperties, false);
  assert.deepEqual(validateGeneratedNote(note, snapshot.types, new Set()), note);
 });
 for (const [label, bad] of [
  ['invented type', { ...note, noteType: 'Other' }],
  ['missing field', { ...note, fields: { Term: 'hello', Meaning: 'bonjour' } }],
  ['invented field', { ...note, fields: { ...note.fields, Other: 'value' } }],
  ['wrong value type', { ...note, fields: { ...note.fields, Example: 1 } }],
  ['empty first field', { ...note, fields: { ...note.fields, Term: ' ' } }],
  ['media reference', { ...note, fields: { ...note.fields, Example: '[sound:invented.mp3]' } }],
  ['unexpected deletion', { ...note, fields: { ...note.fields, Meaning: '{{c1::hello}}' } }],
  ['unexpected property', { ...note, deckName: 'Other deck' }],
 ]) test(`rejects ${label}`, async () => { const { snapshot } = await setup(); assert.equal(validateGeneratedNote(bad, snapshot.types, new Set()), null); });
 test('fields named like object properties are data, not prototypes', async () => {
  const { snapshot } = await setup(); snapshot.types[0].fields = ['__proto__', 'constructor'];
  const value = JSON.parse('{"noteType":"Vocabulary","fields":{"__proto__":"term","constructor":"meaning"}}');
  const parsed = validateGeneratedNote(value, snapshot.types, new Set());
  assert.deepEqual(parsed, value); assert.equal(Object.getPrototypeOf(parsed.fields), Object.prototype);
 });
 test('malformed entries do not consume the requested note limit', async () => {
  const { snapshot } = await setup();
  const result = parseGeneratedNotes(JSON.stringify({ notes: [{}, note, note], note_issues: ['Check this claim'] }), 1, snapshot);
  assert.deepEqual(result.notes, [note]); assert.equal(result.warnings.length, 2); assert.deepEqual(result.noteIssues, ['Check this claim']);
 });
 test('the documented sample response is accepted as written', async () => {
  const vocabulary = { ...custom, fields: ['Expression', 'Meaning', 'Example'], templates: { Recall: { Front: '{{Expression}}', Back: '{{Meaning}} {{Example}}' } } };
  ankiServer({ noteTypes: { Basic: BASIC_NOTE_TYPE, Cloze: CLOZE_NOTE_TYPE, Vocabulary: vocabulary } });
  const settings = createDefaultSettings().anki; settings.enabledNoteTypes = ['Basic', 'Cloze', 'Vocabulary'];
  const client = new AnkiClient(settings.url);
  const types = await Promise.all([['Basic', 100], ['Cloze', 200], ['Vocabulary', 300]].map(([name, id]) => readNoteType(client, name, id)));
  const result = parseGeneratedNotes(JSON.stringify({ notes: SAMPLE_NOTE_INFORMATION, note_issues: [] }), undefined, getDestinations(settings, types));
  assert.deepEqual(result.warnings, []); assert.deepEqual(result.notes, SAMPLE_NOTE_INFORMATION);
 });
});
describe('image placeholders', () => {
 test('a placeholder is accepted only for a diagram that was sent', async () => {
  const { snapshot } = await setup(); const sent = new Set(['queue.png']);
  const withImage = { ...note, fields: { ...note.fields, Example: 'See {{image:queue.png}}' } };
  assert.deepEqual(validateGeneratedNote(withImage, snapshot.types, sent), withImage);
  assert.equal(validateGeneratedNote({ ...note, fields: { ...note.fields, Example: '{{image:other.png}}' } }, snapshot.types, sent), null);
 });
 test('other image syntax is refused, even beside a valid placeholder', async () => {
  const { snapshot } = await setup(); const sent = new Set(['queue.png']);
  for (const value of ['{{image:queue.png}} ![x](queue.png)', '{{image:queue.png}} <img src="queue.png">', 'a {{image:queue.png', '{{image:queue.png}} [sound:x.mp3]']) {
   assert.equal(validateGeneratedNote({ ...note, fields: { ...note.fields, Example: value } }, snapshot.types, sent), null, value);
  }
 });
 test('image ids are listed once, in order of first use', () => {
  assert.deepEqual(imageIdsIn({ Term: '{{image:b.png}}', Meaning: '{{image:a.png}} {{image:b.png}}', Example: '' }), ['b.png', 'a.png']);
 });
});

describe('Anki eligibility checks and export results', () => {
 test('only eligible notes are added; failed entries retain their original order', async () => {
  const { snapshot, server } = await setup(); const handler = fake.ankiHandler;
  const notes = [note, { ...note, fields: { ...note.fields, Term: 'salut' } }];
  fake.ankiHandler = body => body.action === 'canAddNotes' ? { json: { result: [false, true], error: null } } : handler(body);
  const outcome = await addNotesToAnki(notes, snapshot, 'Default', [], []);
  assert.equal(outcome.added, 1); assert.deepEqual(outcome.remaining, [note]); assert.match(outcome.errors[0], /duplicate/);
  assert.equal(server.added[0].fields.Term, 'salut');
  assert.deepEqual(fake.ankiRequests.find(r => r.body.action === 'canAddNotes').body.params.notes[1], server.added[0]);
 });
 test('all ineligible notes cause no add operation', async () => {
  const { snapshot, server } = await setup(); const handler = fake.ankiHandler;
  fake.ankiHandler = body => body.action === 'canAddNotes' ? { json: { result: [false], error: null } } : handler(body);
  const outcome = await addNotesToAnki([note], snapshot, 'Default', [], []);
  assert.deepEqual(outcome.remaining, [note]); assert.equal(server.added.length, 0);
  assert.ok(!fake.ankiRequests.some(r => r.body.action === 'multi'));
 });
 for (const bad of [null, [], [true, false], ['true']]) test(`unreadable eligibility response ${JSON.stringify(bad)} adds nothing`, async () => {
  const { snapshot, server } = await setup(); const handler = fake.ankiHandler;
  fake.ankiHandler = body => body.action === 'canAddNotes' ? { json: { result: bad, error: null } } : handler(body);
  await assert.rejects(addNotesToAnki([note], snapshot, 'Default', [], []), /eligibility/); assert.equal(server.added.length, 0);
 });
 test('actual rejection after eligibility succeeds remains available for retry', async () => {
  const { snapshot } = await setup({ refuse: () => 'duplicate created during export' });
  const outcome = await addNotesToAnki([note], snapshot, 'Default', [], []);
  assert.equal(outcome.added, 0); assert.deepEqual(outcome.remaining, [note]); assert.match(outcome.errors[0], /during export/);
 });
 test('each native field is rendered for Anki; the review copy keeps its Markdown for retry', async () => {
  const { snapshot, server } = await setup(); const handler = fake.ankiHandler;
  const marked = { ...note, fields: { Term: 'x', Meaning: '**hello** $a<b$', Example: '' } };
  fake.ankiHandler = body => body.action === 'canAddNotes' ? { json: { result: [false], error: null } } : handler(body);
  const outcome = await addNotesToAnki([marked], snapshot, 'Default', [], []);
  assert.deepEqual(fake.ankiRequests.find(r => r.body.action === 'canAddNotes').body.params.notes[0].fields, { Term: 'x', Meaning: '<strong>hello</strong> \\(a&lt;b\\)', Example: '' });
  assert.deepEqual(outcome.remaining, [marked]); assert.equal(server.added.length, 0);
 });
 test('changed type blocks both eligibility and additions', async () => {
  const { snapshot, server } = await setup(); server.types.Vocabulary.id++;
  await assert.rejects(addNotesToAnki([note], snapshot, 'Default', [], []), /changed/);
  assert.ok(!fake.ankiRequests.some(r => ['canAddNotes', 'multi'].includes(r.body.action)));
 });
});

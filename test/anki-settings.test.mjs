import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, settingsIn, buttonsIn } from 'obsidian';
import { createDefaultSettings } from '../src/settings/schema';
import { BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE, ankiServer, loadPlugin, makeDevice, makeDisk, openSettings, readDataJson, resetAll } from './helpers.mjs';
beforeEach(resetAll);
const control = (tab, name) => settingsIn(tab.containerEl).find(row => row.name === name)?.components[0];
const description = (tab, name) => settingsIn(tab.containerEl).find(row => row.name === name).desc;
const custom = { id: 300, fields: ['Expression', 'Meaning', 'Example'], descriptions: ['Term', 'Definition', 'Usage'], templates: { Recall: { Front: '{{Expression}}', Back: '{{Meaning}} {{#Example}}{{Example}}{{/Example}}' } } };
async function setup(value = createDefaultSettings()) {
 const server = ankiServer({ noteTypes: { Basic: BASIC_NOTE_TYPE, Cloze: CLOZE_NOTE_TYPE, 'Custom.with dots': custom } });
 const disk = makeDisk(value); const plugin = await loadPlugin(makeDevice({ disk })); const tab = openSettings(plugin);
 tab.openPage('Anki'); await plugin.refreshAnkiTypes(); return { plugin, tab, server, disk };
}
describe('Anki note-type checkboxes', () => {
 test('lists all types and their descriptions without mappings or AI requests', async () => {
  const { tab } = await setup();
  assert.equal(control(tab, 'Basic').value, true); assert.equal(control(tab, 'Cloze').value, true);
  assert.equal(control(tab, 'Custom.with dots').value, false);
  assert.match(description(tab, 'Custom.with dots'), /Example: Usage/);
  assert.equal(control(tab, 'Question field'), undefined);
  assert.equal(fake.providerRequests.length, 0);
  assert.equal(buttonsIn(tab.containerEl).filter(button => button.tooltip === 'Refresh note types').length, 1);
 });
 test('note types are searchable by name or field; the plain status line always shows', async () => {
  const { tab } = await setup();
  const group = settingsIn(tab.containerEl).find(row => row.name === 'Note types').definition;
  const shown = query => group.items.filter(item => item.searchable === false || group.search.match(item, query)).map(item => item.name);
  assert.deepEqual(shown('cloze'), ['', 'Cloze']);
  assert.deepEqual(shown('USAGE'), ['', 'Custom.with dots']);
  assert.ok(!settingsIn(tab.containerEl).some(row => row.name === 'Available note types'));
  const status = tab.containerEl.all().find(el => el.className.split(/\s+/).includes('setting-item-description') && el.textContent === 'Enable the note types the AI may generate.');
  assert.ok(status);
 });
 test('custom selections and all-off survive restart and refresh', async () => {
  const { plugin, tab, disk } = await setup();
  await control(tab, 'Custom.with dots').type(true);
  assert.ok(readDataJson(disk).anki.enabledNoteTypes.includes('Custom.with dots'));
  const restarted = await loadPlugin(makeDevice({ disk }));
  assert.deepEqual(restarted.settings.anki.enabledNoteTypes, plugin.settings.anki.enabledNoteTypes);
  for (const name of ['Basic', 'Cloze', 'Custom.with dots']) await control(tab, name).type(false);
  await plugin.refreshAnkiTypes(); assert.deepEqual(plugin.settings.anki.enabledNoteTypes, []);
 });
 test('missing types retain selections; disconnect permits disabling but not enabling', async () => {
  const { plugin, tab, server } = await setup(); delete server.types.Basic; await plugin.refreshAnkiTypes();
  assert.equal(control(tab, 'Basic').value, true); assert.match(description(tab, 'Basic'), /Unavailable/);
  const handler = fake.ankiHandler; fake.ankiHandler = null; await plugin.refreshAnkiTypes();
  assert.equal(control(tab, 'Custom.with dots').disabled, true);
  await control(tab, 'Basic').type(false); assert.ok(!plugin.settings.anki.enabledNoteTypes.includes('Basic'));
  fake.ankiHandler = handler; server.types.Basic = BASIC_NOTE_TYPE; await plugin.refreshAnkiTypes();
  assert.equal(control(tab, 'Basic').value, false);
 });
 test('invented types are rejected and unsupported types show a reason', async () => {
  const { plugin, tab, server } = await setup(); await plugin.setAnkiNoteTypeEnabled('Invented', true);
  assert.ok(!plugin.settings.anki.enabledNoteTypes.includes('Invented'));
  server.types.Media = { ...custom, templates: { Audio: { Front: '[sound:{{Expression}}]', Back: '{{Meaning}}' } } };
  await plugin.refreshAnkiTypes(); assert.equal(control(tab, 'Media').disabled, true); assert.match(description(tab, 'Media'), /media/);
 });
 test('a slow enable cannot undo a newer disable', async () => {
  const { plugin } = await setup(); const handler = fake.ankiHandler;
  let release, started; const blocked = new Promise(r => release = r); const pending = new Promise(r => started = r);
  fake.ankiHandler = async body => { if (body.action === 'modelFieldNames') { started(); await blocked; } return handler(body); };
  const first = plugin.setAnkiNoteTypeEnabled('Custom.with dots', true); await pending;
  await plugin.setAnkiNoteTypeEnabled('Custom.with dots', false); release(); await first;
  assert.ok(!plugin.settings.anki.enabledNoteTypes.includes('Custom.with dots'));
 });
 test('a changed connection rejects a pending enable', async () => {
  const { plugin } = await setup(); const handler = fake.ankiHandler;
  let release, started; const blocked = new Promise(r => release = r); const pending = new Promise(r => started = r);
  fake.ankiHandler = async body => { if (body.action === 'modelFieldNames') { started(); await blocked; } return handler(body); };
  const first = plugin.setAnkiNoteTypeEnabled('Custom.with dots', true); await pending;
  await plugin.updateSettings(s => { s.anki.url = 'http://localhost:9999'; }); release(); await first;
  assert.ok(!plugin.settings.anki.enabledNoteTypes.includes('Custom.with dots'));
 });
 test('newer unreadable settings cannot be overwritten', async () => {
  const { tab, disk } = await setup({ settings_version: 999 });
  assert.equal(control(tab, 'Basic').disabled, true); assert.equal(readDataJson(disk).settings_version, 999);
 });
});

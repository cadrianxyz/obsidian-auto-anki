// Settings → Anki → Tags: saved tag choices, their defaults, and the example line.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsIn } from 'obsidian';
import { createDefaultSettings, createModelSettings, normalizeSettings } from '../src/settings/schema';
import { loadPlugin, makeDevice, makeDisk, openSettings, readDataJson, resetAll } from './helpers.mjs';
beforeEach(resetAll);

const DEFAULT_TAGS = { enabled: false, model: true, reasoningEffort: false, promptVersion: false, prefix: true, extra: '' };
const rows = tab => settingsIn(tab.containerEl);
const row = (tab, name) => rows(tab).find(setting => setting.name === name);
const control = (tab, name) => row(tab, name)?.components[0];
const example = tab => row(tab, 'Example').descEl.textContent;
const OPTIONS = ['Model', 'Reasoning effort', 'Prompt version', 'Prefix tags with auto-anki::', 'Extra tags'];

async function openTags(value = createDefaultSettings()) {
	const disk = makeDisk(value);
	const plugin = await loadPlugin(makeDevice({ disk }));
	const tab = openSettings(plugin);
	tab.openPage('Anki', 'Tags');
	return { plugin, tab, disk };
}

function withDefaultModel(change = () => {}) {
	const settings = createDefaultSettings();
	const model = createModelSettings('claude-haiku-5-5');
	change(settings, model);
	settings.providers.anthropic.models.push(model);
	settings.defaultModel = { providerId: 'anthropic', modelId: model.id };
	return settings;
}

describe('saved tag settings', () => {
	test('a new install tags nothing; Model and the prefix are ready once tagging is on', () => {
		assert.deepEqual(createDefaultSettings().anki.tags, DEFAULT_TAGS);
	});

	test('settings without tags, as 1.0 saves them, get the defaults', () => {
		const settings = createDefaultSettings();
		delete settings.anki.tags;
		assert.deepEqual(normalizeSettings(settings).anki.tags, DEFAULT_TAGS);
	});

	test('invalid values fall back one by one, keeping valid ones', () => {
		const tags = normalizeSettings({ settings_version: 1, anki: { tags: {
			enabled: 'true', model: false, reasoningEffort: 1, promptVersion: true, prefix: null, extra: ['obsidian'], unknown: true,
		} } }).anki.tags;
		assert.deepEqual(tags, { ...DEFAULT_TAGS, model: false, promptVersion: true });
	});

	test('extra tags are saved exactly as typed', () => {
		const settings = createDefaultSettings();
		settings.anki.tags.extra = '  obsidian  uni::cs101 ';
		assert.equal(normalizeSettings(JSON.parse(JSON.stringify(settings))).anki.tags.extra, '  obsidian  uni::cs101 ');
	});
});

describe('the Tags page', () => {
	test('it sits on the Anki page and shows whether tagging is on', async () => {
		const { tab } = await openTags();
		tab.openPage('Anki');
		const entry = row(tab, 'Tags');
		assert.equal(entry.definition.type, 'page');
		assert.equal(entry.definition.displayValue(), 'Off');
	});

	test('a short description comes first, then the main switch', async () => {
		const { tab } = await openTags();
		const names = rows(tab).map(setting => setting.name);
		assert.deepEqual(names.slice(0, 2), ['', 'Tag Anki notes']);
		assert.match(rows(tab)[0].settingEl.textContent, /^Tags record how each Anki note was made/);
	});

	test('while tagging is off, every option is shown but greyed out', async () => {
		const { tab, disk } = await openTags();
		assert.equal(control(tab, 'Tag Anki notes').value, false);
		assert.equal(control(tab, 'Tag Anki notes').disabled, false);
		for (const name of OPTIONS) assert.equal(control(tab, name).disabled, true, name);
		await control(tab, 'Model').type(false);
		assert.equal(readDataJson(disk).anki.tags.model, true);
	});

	test('while tagging is off, the example shows what turning it on would add', async () => {
		const { tab } = await openTags(withDefaultModel());
		assert.match(example(tab), /^Once tagging is on, .*auto-anki::anthropic::claude-haiku-5-5$/);
	});

	test('turning tagging on saves it and shows the options with their defaults', async () => {
		const { tab, disk } = await openTags();
		await control(tab, 'Tag Anki notes').type(true);
		assert.equal(readDataJson(disk).anki.tags.enabled, true);
		for (const name of OPTIONS) assert.equal(control(tab, name).disabled, false, name);
		assert.equal(control(tab, 'Model').value, true);
		assert.equal(control(tab, 'Reasoning effort').value, false);
		assert.equal(control(tab, 'Prompt version').value, false);
		assert.equal(control(tab, 'Prefix tags with auto-anki::').value, true);
		assert.equal(control(tab, 'Extra tags').value, '');
		tab.openPage('Anki');
		assert.equal(row(tab, 'Tags').definition.displayValue(), 'On');
	});

	test('each option is saved on its own and survives a restart', async () => {
		const { tab, disk } = await openTags();
		await control(tab, 'Tag Anki notes').type(true);
		await control(tab, 'Model').type(false);
		await control(tab, 'Reasoning effort').type(true);
		await control(tab, 'Prompt version').type(true);
		await control(tab, 'Prefix tags with auto-anki::').type(false);
		await control(tab, 'Extra tags').type('obsidian uni::cs101');
		const expected = { enabled: true, model: false, reasoningEffort: true, promptVersion: true, prefix: false, extra: 'obsidian uni::cs101' };
		assert.deepEqual(readDataJson(disk).anki.tags, expected);
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.deepEqual(restarted.settings.anki.tags, expected);
	});

	test('the descriptions show the tags without the prefix once it is off', async () => {
		const { tab } = await openTags();
		await control(tab, 'Tag Anki notes').type(true);
		assert.match(row(tab, 'Model').desc, /auto-anki::<provider>::<model>/);
		await control(tab, 'Prefix tags with auto-anki::').type(false);
		assert.match(row(tab, 'Model').desc, /Adds <provider>::<model>/);
	});

	test('the example uses the default model and follows each change', async () => {
		const { tab } = await openTags(withDefaultModel((settings, model) => { model.reasoningEffort = 'high'; }));
		await control(tab, 'Tag Anki notes').type(true);
		assert.match(example(tab), /^Tags one new .*auto-anki::anthropic::claude-haiku-5-5$/);
		await control(tab, 'Reasoning effort').type(true);
		assert.match(example(tab), /auto-anki::anthropic::claude-haiku-5-5 auto-anki::effort::high$/);
		await control(tab, 'Model').type(false);
		await control(tab, 'Reasoning effort').type(false);
		assert.match(example(tab), /: none\. Turn on an option or add extra tags\.$/);
	});

	test('the example and the tag patterns in descriptions are shown as code', async () => {
		const { tab } = await openTags(withDefaultModel(settings => { settings.anki.tags = { ...DEFAULT_TAGS, enabled: true, extra: 'obsidian' }; }));
		const codes = row(tab, 'Example').descEl.all().filter(el => el.tagName === 'code').map(el => el.text);
		assert.deepEqual(codes, ['auto-anki::anthropic::claude-haiku-5-5', 'obsidian']);
		assert.ok(row(tab, 'Example').descEl.all().filter(el => el.tagName === 'code').every(el => el.className === 'auto-anki-tag'), 'styled as code');
		const model = row(tab, 'Model').definition.desc.all().filter(el => el.tagName === 'code').map(el => el.text);
		assert.deepEqual(model, ['auto-anki::<provider>::<model>', 'auto-anki::anthropic::<model>']);
	});

	test('typing extra tags updates the example without redrawing the page', async () => {
		const { tab } = await openTags(withDefaultModel());
		await control(tab, 'Tag Anki notes').type(true);
		const box = control(tab, 'Extra tags');
		await box.type('obsidian  uni::cs101');
		assert.equal(control(tab, 'Extra tags'), box);
		assert.match(example(tab), /auto-anki::anthropic::claude-haiku-5-5 obsidian uni::cs101$/);
	});

	test('the prompt version in the example ends in -edited with your own instructions', async () => {
		const { tab } = await openTags(withDefaultModel(settings => {
			settings.anki.tags = { ...DEFAULT_TAGS, enabled: true, model: false, promptVersion: true };
			settings.notes.noteWritingInstructions = { text: 'My rules', defaultVersion: '1.0.0' };
		}));
		assert.match(example(tab), /auto-anki::prompt::1\.0\.0-edited$/);
	});

	test('without a default model, the example shows placeholders', async () => {
		const settings = createDefaultSettings();
		settings.anki.tags.enabled = true;
		const { tab } = await openTags(settings);
		assert.match(example(tab), /auto-anki::<provider>::<model>$/);
	});

	test('settings from a newer version cannot be changed here', async () => {
		const { tab, disk } = await openTags({ settings_version: 999 });
		for (const name of ['Tag Anki notes', ...OPTIONS]) assert.equal(control(tab, name).disabled, true, name);
		assert.equal(readDataJson(disk).settings_version, 999);
	});
});

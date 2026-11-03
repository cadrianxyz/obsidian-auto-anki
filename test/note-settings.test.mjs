import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, settingsIn, buttonsIn } from 'obsidian';
import { NOTE_WRITING_INSTRUCTIONS_VERSION, DEFAULT_NOTE_WRITING_INSTRUCTIONS } from '../src/generate/note-writing-instructions';
import { COVERAGE_LEVELS, createDefaultSettings } from '../src/settings/schema';
import { loadPlugin, makeDevice, makeDisk, openSettings, readDataJson, resetAll } from './helpers.mjs';

const row = (tab, name) => {
	const setting = settingsIn(tab.containerEl).find(setting => setting.name === name);
	assert.ok(setting, `no setting: ${name}`);
	return setting;
};
const control = (tab, name) => row(tab, name).components[0];
const resetButton = tab => buttonsIn(tab.containerEl).find(button => button.text === 'Reset to default');
const openNotes = (plugin, advanced = false) => {
	const tab = openSettings(plugin);
	tab.openPage('Generation', ...(advanced ? ['Advanced'] : []));
	return tab;
};

beforeEach(() => resetAll());

describe('Generation settings page', () => {
	test('opens without an API key, shows saved defaults, and does not write settings or make requests', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin);
		assert.equal(control(tab, 'Coverage').value, 'main-ideas-and-details');
		assert.equal(control(tab, 'Send diagrams').value, true);
		assert.equal(control(tab, 'Extra instructions').value, '');
		assert.equal(control(tab, 'Extra instructions').inputEl.tagName, 'textarea');
		assert.ok(row(tab, 'Advanced'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Note-writing instructions'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Development preview'));
		assert.equal(disk.writes, 0);
		assert.deepEqual(fake.providerRequests, []);
		assert.deepEqual(fake.ankiRequests, []);
	});

	test('coverage and diagram preferences survive restart without changing other settings', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin);
		for (const level of COVERAGE_LEVELS) {
			await control(tab, 'Coverage').type(level);
			assert.equal(readDataJson(disk).notes.coverageLevel, level);
		}
		await control(tab, 'Send diagrams').type(false);
		const restarted = await loadPlugin(makeDevice({ disk }));
		const defaults = createDefaultSettings();
		assert.deepEqual(restarted.settings.notes, { ...defaults.notes, coverageLevel: 'everything', sendDiagrams: false });
		assert.deepEqual(restarted.settings.providers, defaults.providers);
		assert.deepEqual(restarted.settings.anki, defaults.anki);
		assert.equal(restarted.settings.defaultModel, null);
	});

	test('invalid generation control values cannot overwrite saved preferences', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin);
		for (const value of ['invalid', '', null, 3, {}]) await tab.setControlValue('notes.coverageLevel', value);
		for (const value of ['false', null, 0]) await tab.setControlValue('notes.sendDiagrams', value);
		await tab.setControlValue('notes.extraInstructions', 3);
		await tab.setControlValue('notes.noteWritingInstructions', null);
		assert.deepEqual(plugin.settings, createDefaultSettings());
		assert.equal(disk.writes, 0);
	});

	test('extra instructions keep Markdown, blank lines and whitespace exactly, without remounting the editor', async () => {
		const text = '  # Style\r\n\r\n- Use **British spelling**\r\n- Keep $x^2$\n\n  ';
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin);
		const editor = control(tab, 'Extra instructions');
		await editor.type(text);
		assert.equal(control(tab, 'Extra instructions'), editor);
		assert.equal(readDataJson(disk).notes.extraInstructions, text);
		assert.ok(!('noteWritingInstructions' in readDataJson(disk).notes));
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openNotes(restarted), 'Extra instructions').value, text);
		await editor.type('');
		assert.equal(readDataJson(disk).notes.extraInstructions, '');
	});

	test('opening Advanced displays current built-in guidance without saving a copy or enabling Reset', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		assert.equal(control(tab, 'Note-writing instructions').value, DEFAULT_NOTE_WRITING_INSTRUCTIONS);
		assert.equal(control(tab, 'Note-writing instructions').inputEl.tagName, 'textarea');
		assert.equal(resetButton(tab).disabled, true);
		await resetButton(tab).click();
		assert.ok(!('noteWritingInstructions' in plugin.settings.notes));
		assert.equal(disk.writes, 0);
	});

	test('editing guidance stores exact Markdown and its starting version, and immediately enables Reset', async () => {
		const text = '\n# My guidance\n\n- Ask **why**\n- Keep $\\alpha$\r\n  ';
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		const editor = control(tab, 'Note-writing instructions');
		await editor.type(text);
		assert.equal(control(tab, 'Note-writing instructions'), editor);
		assert.equal(resetButton(tab).disabled, false);
		assert.deepEqual(readDataJson(disk).notes.noteWritingInstructions, { text, defaultVersion: NOTE_WRITING_INSTRUCTIONS_VERSION });
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openNotes(restarted, true), 'Note-writing instructions').value, text);
	});

	test('editing previously customised guidance preserves its original default version, including an explicit empty edit', async () => {
		const settings = createDefaultSettings();
		settings.notes.noteWritingInstructions = { text: 'Older custom text', defaultVersion: 'older-default-version' };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		await control(tab, 'Note-writing instructions').type('');
		assert.deepEqual(readDataJson(disk).notes.noteWritingInstructions, { text: '', defaultVersion: 'older-default-version' });
		assert.equal(resetButton(tab).disabled, false);
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openNotes(restarted, true), 'Note-writing instructions').value, '');
	});

	test('Reset removes only the override, then displays and follows the current built-in guidance after restart', async () => {
		const settings = createDefaultSettings();
		settings.notes = { sendDiagrams: false, coverageLevel: 'everything', extraInstructions: '\nKeep this preference\n',
			noteWritingInstructions: { text: 'Old custom instructions', defaultVersion: 'older-default-version' } };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		await resetButton(tab).click();
		const expected = { ...settings.notes };
		delete expected.noteWritingInstructions;
		assert.deepEqual(readDataJson(disk).notes, expected);
		assert.equal(control(tab, 'Note-writing instructions').value, DEFAULT_NOTE_WRITING_INSTRUCTIONS);
		assert.equal(resetButton(tab).disabled, true);
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openNotes(restarted, true), 'Note-writing instructions').value, DEFAULT_NOTE_WRITING_INSTRUCTIONS);
		assert.deepEqual(restarted.settings.notes, expected);
	});

	test('rapid instruction edits are saved in order and keep the latest text and first default version', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		const save = plugin.saveData.bind(plugin);
		let release;
		let started;
		const blocked = new Promise(resolve => { release = resolve; });
		const saving = new Promise(resolve => { started = resolve; });
		let calls = 0;
		plugin.saveData = async data => { if (++calls === 1) { started(); await blocked; } await save(data); };
		const first = tab.setControlValue('notes.noteWritingInstructions', 'First edit');
		await saving;
		const second = tab.setControlValue('notes.noteWritingInstructions', '# Latest edit\n\n- Keep this\n');
		release();
		await Promise.all([first, second]);
		assert.deepEqual(readDataJson(disk).notes.noteWritingInstructions, { text: '# Latest edit\n\n- Keep this\n', defaultVersion: NOTE_WRITING_INSTRUCTIONS_VERSION });
	});

	test('failed saves restore the previous visible text, and failed Reset preserves the override for retry', async () => {
		const settings = createDefaultSettings();
		settings.notes.noteWritingInstructions = { text: 'Keep my guidance', defaultVersion: 'old' };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		const save = plugin.saveData.bind(plugin);
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		await control(tab, 'Note-writing instructions').type('Unsaved edit');
		assert.equal(control(tab, 'Note-writing instructions').value, 'Keep my guidance');
		await resetButton(tab).click();
		assert.equal(resetButton(tab).disabled, false);
		assert.equal(control(tab, 'Note-writing instructions').value, 'Keep my guidance');
		assert.deepEqual(readDataJson(disk), settings);
		assert.match(fake.notices.at(-1), /Disk is full/);
		plugin.saveData = save;
		await resetButton(tab).click();
		assert.ok(!('noteWritingInstructions' in readDataJson(disk).notes));
	});

	test('synced instructions replace the visible text without rewriting them, and subsequent edits keep their version', async () => {
		const disk = makeDisk(createDefaultSettings());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin, true);
		const incoming = createDefaultSettings();
		incoming.notes.extraInstructions = '\n# Synced preferences\n';
		incoming.notes.noteWritingInstructions = { text: '\n# Synced guidance\n', defaultVersion: 'another-device-default' };
		disk.files['data.json'] = JSON.stringify(incoming);
		await plugin.onExternalSettingsChange();
		assert.equal(control(tab, 'Note-writing instructions').value, incoming.notes.noteWritingInstructions.text);
		assert.equal(resetButton(tab).disabled, false);
		assert.equal(disk.writes, 0);
		await control(tab, 'Note-writing instructions').type('Edited here\n');
		assert.equal(readDataJson(disk).notes.noteWritingInstructions.defaultVersion, 'another-device-default');
		assert.equal(readDataJson(disk).notes.extraInstructions, incoming.notes.extraInstructions);
	});

	test('an unreadable newer settings file disables the Anki notes controls and cannot be overwritten', async () => {
		const disk = makeDisk({ settings_version: 999 });
		const original = disk.files['data.json'];
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openNotes(plugin);
		assert.equal(control(tab, 'Coverage').disabled, true);
		assert.equal(control(tab, 'Send diagrams').disabled, true);
		assert.equal(control(tab, 'Extra instructions').disabled, true);
		tab.openPage('Generation', 'Advanced');
		assert.equal(control(tab, 'Note-writing instructions').disabled, true);
		assert.equal(resetButton(tab).disabled, true);
		await tab.setControlValue('notes.noteWritingInstructions', 'Must not be saved');
		assert.equal(disk.files['data.json'], original);
	});
});

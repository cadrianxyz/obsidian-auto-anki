import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, settingsIn, buttonsIn } from 'obsidian';
import { CARD_WRITING_INSTRUCTIONS_VERSION, DEFAULT_CARD_WRITING_INSTRUCTIONS } from '../src/generate/card-writing-instructions';
import { COVERAGE_LEVELS, createDefaultSettings } from '../src/settings/model';
import { loadPlugin, makeDevice, makeDisk, openSettings, readDataJson, resetAll } from './helpers.mjs';

const row = (tab, name) => {
	const setting = settingsIn(tab.containerEl).find(setting => setting.name === name);
	assert.ok(setting, `no setting: ${name}`);
	return setting;
};
const control = (tab, name) => row(tab, name).components[0];
const resetButton = tab => buttonsIn(tab.containerEl).find(button => button.text === 'Reset to default');
const openCards = (plugin, advanced = false) => {
	const tab = openSettings(plugin);
	tab.openPage('Cards', ...(advanced ? ['Advanced'] : []));
	return tab;
};

beforeEach(() => resetAll());

describe('Cards settings page', () => {
	test('opens without an API key, shows saved defaults, and does not write settings or make requests', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin);
		assert.equal(control(tab, 'Coverage').value, 'main-ideas-and-details');
		assert.equal(control(tab, 'Send diagrams').value, true);
		assert.equal(control(tab, 'Extra instructions').value, '');
		assert.equal(control(tab, 'Extra instructions').inputEl.tagName, 'textarea');
		assert.ok(row(tab, 'Advanced'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Card-writing instructions'));
		assert.ok(!settingsIn(tab.containerEl).some(setting => setting.name === 'Development preview'));
		assert.equal(disk.writes, 0);
		assert.deepEqual(fake.providerRequests, []);
		assert.deepEqual(fake.ankiRequests, []);
	});

	test('coverage and diagram preferences survive restart without changing other settings', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin);
		for (const level of COVERAGE_LEVELS) {
			await control(tab, 'Coverage').type(level);
			assert.equal(readDataJson(disk).cards.coverageLevel, level);
		}
		await control(tab, 'Send diagrams').type(false);
		const restarted = await loadPlugin(makeDevice({ disk }));
		const defaults = createDefaultSettings();
		assert.deepEqual(restarted.settings.cards, { ...defaults.cards, coverageLevel: 'everything', sendDiagrams: false });
		assert.deepEqual(restarted.settings.providers, defaults.providers);
		assert.deepEqual(restarted.settings.anki, defaults.anki);
		assert.equal(restarted.settings.defaultModel, null);
	});

	test('invalid card control values cannot overwrite saved preferences', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin);
		for (const value of ['invalid', '', null, 3, {}]) await tab.setControlValue('cards.coverageLevel', value);
		for (const value of ['false', null, 0]) await tab.setControlValue('cards.sendDiagrams', value);
		await tab.setControlValue('cards.extraInstructions', 3);
		await tab.setControlValue('cards.cardWritingInstructions', null);
		assert.deepEqual(plugin.settings, createDefaultSettings());
		assert.equal(disk.writes, 0);
	});

	test('extra instructions keep Markdown, blank lines and whitespace exactly, without remounting the editor', async () => {
		const text = '  # Style\r\n\r\n- Use **British spelling**\r\n- Keep $x^2$\n\n  ';
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin);
		const editor = control(tab, 'Extra instructions');
		await editor.type(text);
		assert.equal(control(tab, 'Extra instructions'), editor);
		assert.equal(readDataJson(disk).cards.extraInstructions, text);
		assert.ok(!('cardWritingInstructions' in readDataJson(disk).cards));
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openCards(restarted), 'Extra instructions').value, text);
		await editor.type('');
		assert.equal(readDataJson(disk).cards.extraInstructions, '');
	});

	test('opening Advanced displays current built-in guidance without saving a copy or enabling Reset', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		assert.equal(control(tab, 'Card-writing instructions').value, DEFAULT_CARD_WRITING_INSTRUCTIONS);
		assert.equal(control(tab, 'Card-writing instructions').inputEl.tagName, 'textarea');
		assert.equal(resetButton(tab).disabled, true);
		await resetButton(tab).click();
		assert.ok(!('cardWritingInstructions' in plugin.settings.cards));
		assert.equal(disk.writes, 0);
	});

	test('editing guidance stores exact Markdown and its starting version, and immediately enables Reset', async () => {
		const text = '\n# My guidance\n\n- Ask **why**\n- Keep $\\alpha$\r\n  ';
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		const editor = control(tab, 'Card-writing instructions');
		await editor.type(text);
		assert.equal(control(tab, 'Card-writing instructions'), editor);
		assert.equal(resetButton(tab).disabled, false);
		assert.deepEqual(readDataJson(disk).cards.cardWritingInstructions, { text, defaultVersion: CARD_WRITING_INSTRUCTIONS_VERSION });
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openCards(restarted, true), 'Card-writing instructions').value, text);
	});

	test('editing previously customised guidance preserves its original default version, including an explicit empty edit', async () => {
		const settings = createDefaultSettings();
		settings.cards.cardWritingInstructions = { text: 'Older custom text', defaultVersion: 'older-default-version' };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		await control(tab, 'Card-writing instructions').type('');
		assert.deepEqual(readDataJson(disk).cards.cardWritingInstructions, { text: '', defaultVersion: 'older-default-version' });
		assert.equal(resetButton(tab).disabled, false);
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openCards(restarted, true), 'Card-writing instructions').value, '');
	});

	test('Reset removes only the override, then displays and follows the current built-in guidance after restart', async () => {
		const settings = createDefaultSettings();
		settings.cards = { sendDiagrams: false, coverageLevel: 'everything', extraInstructions: '\nKeep this preference\n',
			cardWritingInstructions: { text: 'Old custom instructions', defaultVersion: 'older-default-version' } };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		await resetButton(tab).click();
		const expected = { ...settings.cards };
		delete expected.cardWritingInstructions;
		assert.deepEqual(readDataJson(disk).cards, expected);
		assert.equal(control(tab, 'Card-writing instructions').value, DEFAULT_CARD_WRITING_INSTRUCTIONS);
		assert.equal(resetButton(tab).disabled, true);
		const restarted = await loadPlugin(makeDevice({ disk }));
		assert.equal(control(openCards(restarted, true), 'Card-writing instructions').value, DEFAULT_CARD_WRITING_INSTRUCTIONS);
		assert.deepEqual(restarted.settings.cards, expected);
	});

	test('rapid instruction edits are saved in order and keep the latest text and first default version', async () => {
		const disk = makeDisk();
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		const save = plugin.saveData.bind(plugin);
		let release;
		let started;
		const blocked = new Promise(resolve => { release = resolve; });
		const saving = new Promise(resolve => { started = resolve; });
		let calls = 0;
		plugin.saveData = async data => { if (++calls === 1) { started(); await blocked; } await save(data); };
		const first = tab.setControlValue('cards.cardWritingInstructions', 'First edit');
		await saving;
		const second = tab.setControlValue('cards.cardWritingInstructions', '# Latest edit\n\n- Keep this\n');
		release();
		await Promise.all([first, second]);
		assert.deepEqual(readDataJson(disk).cards.cardWritingInstructions, { text: '# Latest edit\n\n- Keep this\n', defaultVersion: CARD_WRITING_INSTRUCTIONS_VERSION });
	});

	test('failed saves restore the previous visible text, and failed Reset preserves the override for retry', async () => {
		const settings = createDefaultSettings();
		settings.cards.cardWritingInstructions = { text: 'Keep my guidance', defaultVersion: 'old' };
		const disk = makeDisk(settings);
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		const save = plugin.saveData.bind(plugin);
		plugin.saveData = async () => { throw new Error('Disk is full'); };
		await control(tab, 'Card-writing instructions').type('Unsaved edit');
		assert.equal(control(tab, 'Card-writing instructions').value, 'Keep my guidance');
		await resetButton(tab).click();
		assert.equal(resetButton(tab).disabled, false);
		assert.equal(control(tab, 'Card-writing instructions').value, 'Keep my guidance');
		assert.deepEqual(readDataJson(disk), settings);
		assert.match(fake.notices.at(-1), /Disk is full/);
		plugin.saveData = save;
		await resetButton(tab).click();
		assert.ok(!('cardWritingInstructions' in readDataJson(disk).cards));
	});

	test('synced instructions replace the visible text without rewriting them, and subsequent edits keep their version', async () => {
		const disk = makeDisk(createDefaultSettings());
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin, true);
		const incoming = createDefaultSettings();
		incoming.cards.extraInstructions = '\n# Synced preferences\n';
		incoming.cards.cardWritingInstructions = { text: '\n# Synced guidance\n', defaultVersion: 'another-device-default' };
		disk.files['data.json'] = JSON.stringify(incoming);
		await plugin.onExternalSettingsChange();
		assert.equal(control(tab, 'Card-writing instructions').value, incoming.cards.cardWritingInstructions.text);
		assert.equal(resetButton(tab).disabled, false);
		assert.equal(disk.writes, 0);
		await control(tab, 'Card-writing instructions').type('Edited here\n');
		assert.equal(readDataJson(disk).cards.cardWritingInstructions.defaultVersion, 'another-device-default');
		assert.equal(readDataJson(disk).cards.extraInstructions, incoming.cards.extraInstructions);
	});

	test('an unreadable newer settings file disables the Cards controls and cannot be overwritten', async () => {
		const disk = makeDisk({ settings_version: 999 });
		const original = disk.files['data.json'];
		const plugin = await loadPlugin(makeDevice({ disk }));
		const tab = openCards(plugin);
		assert.equal(control(tab, 'Coverage').disabled, true);
		assert.equal(control(tab, 'Send diagrams').disabled, true);
		assert.equal(control(tab, 'Extra instructions').disabled, true);
		tab.openPage('Cards', 'Advanced');
		assert.equal(control(tab, 'Card-writing instructions').disabled, true);
		assert.equal(resetButton(tab).disabled, true);
		await tab.setControlValue('cards.cardWritingInstructions', 'Must not be saved');
		assert.equal(disk.files['data.json'], original);
	});
});

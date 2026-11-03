import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import type AutoAnkiPlugin from '../../main';
import { verifyNoteType } from '../../anki/note-types';
import { DefaultDeckModal } from '../decks/default-deck-modal';
import { ankiUrl, DEFAULT_ANKI_URL } from '../../settings/schema';

/** Anki owns the definitions. Settings only choose which existing types may be generated. */
export class AnkiSettings {
	private opened = false;
	constructor(private readonly plugin: AutoAnkiPlugin) {}
	hide(): void { this.opened = false; }
	owns(key: string): boolean { return key.startsWith('anki.'); }

	getValue(key: string): unknown {
		if (key === 'anki.url') return this.plugin.settings.anki.url;
		return this.plugin.settings.anki.enabledNoteTypes.includes(this.nameFromKey(key));
	}

	private nameFromKey(key: string): string { return decodeURIComponent(key.slice('anki.noteType.'.length)); }

	async setValue(key: string, value: unknown): Promise<void> {
		if (key === 'anki.url') {
			if (typeof value === 'string' && ankiUrl(value, '') === value.trim()) {
				await this.plugin.updateSettings(settings => { settings.anki.url = value.trim(); }, false);
				this.plugin.ankiTypes.verified = false;
				this.opened = false;
			}
		}
		else if (key.startsWith('anki.noteType.') && typeof value === 'boolean') await this.plugin.setAnkiNoteTypeEnabled(this.nameFromKey(key), value);
	}

	definitions(): SettingDefinitionItem[] {
		const discovery = this.plugin.ankiTypes;
		const anki = this.plugin.settings.anki;
		const live = discovery.verified && discovery.url === anki.url;
		const types = discovery.url === anki.url ? discovery.types : [];
		const names = [...new Set([...types.map(type => type.name), ...anki.enabledNoteTypes])];
		return [
			{ name: 'AnkiConnect address', desc: `Anki must be running with AnkiConnect enabled. Default: ${DEFAULT_ANKI_URL}. Refresh note types after changing it.`,
				control: { type: 'text', key: 'anki.url', disabled: () => !this.plugin.settingsStore.canSave } },
			{ name: 'Default deck', desc: `New notes start in this deck in the export dialog. Current: ${anki.defaultDeck}. Anki's Default deck is used if it is missing.`,
				render: setting => { setting.addButton(button => button.setButtonText('Choose deck…').setDisabled(!this.plugin.settingsStore.canSave)
					.onClick(() => new DefaultDeckModal(this.plugin.app, anki.url, this.plugin.settings.anki.defaultDeck, async deck => {
						await this.plugin.updateSettings(settings => { settings.anki.defaultDeck = deck; });
					}).open())); } },
			{ type: 'group', heading: 'Note types',
				search: { placeholder: 'Search note types', match: (definition, query) => {
					const fields = typeof definition.desc === 'string' ? definition.desc : '';
					return `${definition.name} ${fields}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
				} },
				extraButtons: [
					button => button.setIcon('refresh-cw').setTooltip('Refresh note types').setDisabled(discovery.loading)
						.onClick(() => this.plugin.refreshAnkiTypes()),
				],
				items: [
					// Always shown while filtering: it reports loading and errors for the whole list.
					{ name: '', searchable: false, render: setting => {
						if (!this.opened) { this.opened = true; void this.plugin.refreshAnkiTypes(); }
						setting.settingEl.empty();
						setting.settingEl.classList.remove('setting-item');
						const statusEl = setting.settingEl.createDiv({ cls: 'setting-item-description setting-horizontal-padding search-description', attr: { role: 'status' } });
						statusEl.setText(discovery.loading ? 'Reading note types from Anki…' : discovery.error ?? 'Enable the note types the AI may generate. Field and note-type descriptions are written in Anki and read from there.');
					} },
					...names.map((name): SettingDefinition => {
						const type = types.find(type => type.name === name);
						let problem = !live || !type ? 'Unavailable until verified with Anki. Your selection is kept.' : '';
						if (!problem && type) { try { verifyNoteType(type); } catch (error) { problem = error instanceof Error ? error.message : 'Unsupported type.'; } }
						return { name, desc: problem || type!.fields.map(field => `${field}${type!.descriptions[field] ? `: ${type!.descriptions[field]}` : ''}`).join(' · '),
							control: { type: 'toggle', key: `anki.noteType.${encodeURIComponent(name)}`, disabled: () => !this.plugin.settingsStore.canSave || (!!problem && !this.plugin.settings.anki.enabledNoteTypes.includes(name)) } };
					}),
				] },
		];
	}
}

import type { SettingDefinitionItem } from 'obsidian';
import type AutoAnkiPlugin from '../../main';
import { resolveDeckTemplate } from '../../anki/deck-template';
import { DefaultDeckModal } from '../decks/default-deck-modal';

export const DECK_TEMPLATE_KEY = 'anki.deckTemplate';
export const SORT_DECKS_KEY = 'anki.sortDecksByMatch';

export class DeckSettingsPage {
	private exampleEl?: HTMLElement;
	constructor(private readonly plugin: AutoAnkiPlugin) {}
	hide(): void { this.exampleEl = undefined; }

	async setTemplate(value: string): Promise<void> {
		await this.plugin.updateSettings(settings => { settings.anki.deckTemplate = value; }, false);
		this.showExample();
	}

	private showExample(): void {
		if (!this.exampleEl) return;
		const { app, settings } = this.plugin;
		const activeFile = app.workspace.getActiveFile();
		const file = activeFile?.path.toLowerCase().endsWith('.md') ? activeFile : undefined;
		const path = file?.path ?? 'Computer Science/Operating Systems/Scheduling.md';
		const result = resolveDeckTemplate(settings.anki.deckTemplate, { vault: app.vault.getName(), path, title: file?.basename ?? 'Scheduling' });
		const source = file ? 'current file' : 'sample file';
		this.exampleEl.empty();
		this.exampleEl.createDiv({ text: `Example using the ${source} “${path}”` });
		const outcome = this.exampleEl.createDiv({ cls: 'auto-anki-deck-preview-result' });
		if (result.deck) {
			outcome.appendText('Suggested deck: ');
			outcome.createEl('strong', { text: result.deck });
		} else {
			const reason = settings.anki.deckTemplate.trim() ? 'The template resolves to an empty deck name.' : 'No deck template specified.';
			outcome.setText(result.error ?? `${reason} The default deck will be used.`);
		}
	}

	page(): SettingDefinitionItem {
		const { anki } = this.plugin.settings;
		return { type: 'page', name: 'Deck Selection', desc: 'Choose the default deck and optionally suggest a deck based on each note.', items: [
			{ name: 'Default deck', desc: `Default anki deck to export cards. Current: ${anki.defaultDeck}.`,
				render: setting => { setting.addButton(button => button.setButtonText('Choose deck…').setDisabled(!this.plugin.settingsStore.canSave)
					.onClick(() => new DefaultDeckModal(this.plugin.app, anki.url, this.plugin.settings.anki.defaultDeck, async deck => {
						await this.plugin.updateSettings(settings => { settings.anki.defaultDeck = deck; });
					}).open())); } },
			{ name: 'Deck template', desc: 'Use {{vault}}, {{folder}} (full folder path), {{lastFolder}} (immediate parent folder), or {{note}} (note name) with :: between levels. Leave blank to use the default deck.',
				control: { type: 'text', key: DECK_TEMPLATE_KEY, disabled: () => !this.plugin.settingsStore.canSave } },
			{ name: 'Deck template preview', searchable: false, render: setting => {
				this.exampleEl = setting.descEl;
				this.showExample();
			} },
			{ name: 'Sort by name match', desc: 'Sort decks based on how they match the target deck: from the deck template or the default deck.',
				control: { type: 'toggle', key: SORT_DECKS_KEY, disabled: () => !this.plugin.settingsStore.canSave } },
		] };
	}
}

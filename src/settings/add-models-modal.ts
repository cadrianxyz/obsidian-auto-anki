import { Modal, Notice, Setting, type App, type ButtonComponent, type ExtraButtonComponent } from 'obsidian';
import type AutoAnkiPlugin from '../main';
import { PROVIDER_PRESETS, type ProviderId } from '../ai/presets';
import { getPickerModels, isTextGenerationCandidate, sortModelChoices } from '../ai/model-selection';

/** Choose which available models appear in everyday settings; nothing is saved until Add. */
export class AddModelsModal extends Modal {
	private readonly selected = new Set<string>();
	private query = '';
	private busy = false;
	private refreshing = false;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private addButton!: ButtonComponent;
	private cancelButton!: ButtonComponent;
	private refreshButton!: ExtraButtonComponent;
	private searchInput!: HTMLInputElement;

	constructor(
		app: App,
		private readonly plugin: AutoAnkiPlugin,
		private readonly providerId: ProviderId,
		private readonly refresh: () => Promise<void>,
		private readonly getError: () => string | undefined,
		private readonly ready?: Promise<void>,
	) { super(app); }

	onOpen(): void {
		this.titleEl.setText(`Add models · ${PROVIDER_PRESETS[this.providerId].name}`);
		this.modalEl.classList.add('auto-anki-add-models');
		this.contentEl.createEl('p', { text: 'Browse the full provider list and add models to your normal picker. You can also enter an exact model ID if one is missing.' });
		new Setting(this.contentEl).setName('Available models').addSearch(search => {
			this.searchInput = search.inputEl;
			search.setPlaceholder('Search models').onChange(value => { this.query = value; this.renderChoices(); });
		}).addExtraButton(button => {
			this.refreshButton = button;
			button.setIcon('refresh-cw').setTooltip('Refresh models').onClick(() => this.refreshChoices());
		});
		this.statusEl = this.contentEl.createDiv({ cls: 'setting-item-description', attr: { role: 'status' } });
		this.listEl = this.contentEl.createDiv({ cls: 'auto-anki-model-candidates' });

		const advanced = this.contentEl.createEl('details', { cls: 'auto-anki-model-advanced' });
		advanced.createEl('summary', { text: 'Advanced: enter a model ID' });
		const manual = new Setting(advanced).setName('Model ID')
			.setDesc('For a new model or exact version missing from discovery. Use the ID from your provider; an ID does not grant access to it.');
		manual.addText(text => {
			text.setPlaceholder('Exact model ID');
			manual.addButton(button => button.setButtonText('Include in selection').onClick(() => {
				if (this.busy) return;
				const id = text.getValue().trim();
				if (!id || /\s/.test(id)) { new Notice('Enter a model ID without spaces.'); return; }
				const known = this.plugin.discovery.getModels(this.providerId, [], [id]).find(model => model.id === id)!;
				if (!isTextGenerationCandidate(known)) { new Notice('This model is reported as unable to generate text. Choose a text model for flashcards.'); return; }
				if (!this.enabledIds().has(id)) this.selected.add(id);
				text.setValue('');
				this.query = '';
				this.searchInput.value = '';
				this.renderChoices();
			}));
		});
		new Setting(this.contentEl).addButton(button => {
			this.cancelButton = button;
			button.setButtonText('Cancel').onClick(() => this.close());
		}).addButton(button => {
			this.addButton = button;
			button.setCta().onClick(() => this.saveSelection());
		});
		this.renderChoices();
		if (this.ready) {
			this.refreshing = true;
			this.renderChoices();
			void this.ready.then(() => { this.refreshing = false; this.renderChoices(); });
		}
	}

	private enabledIds(): Set<string> {
		return new Set(this.plugin.settings.providers[this.providerId].models.filter(model => model.enabled).map(model => model.id));
	}

	private renderChoices(): void {
		const configured = this.plugin.settings.providers[this.providerId].models;
		const added = new Set(configured.map(model => model.id));
		const inPicker = new Set(getPickerModels(this.plugin.discovery.getModels(this.providerId, configured), configured).map(model => model.id));
		// A sync or another settings edit may have added a staged model in the meantime.
		for (const id of inPicker) this.selected.delete(id);
		const known = this.plugin.discovery.getModels(this.providerId, configured, [...this.selected]);
		const defaultModel = this.plugin.settings.defaultModel;
		const sorted = sortModelChoices(known, defaultModel?.providerId === this.providerId ? defaultModel.modelId : undefined, added);
		const query = this.query.trim().toLocaleLowerCase();
		const matches = sorted.filter(model => `${model.displayName} ${model.id}`.toLocaleLowerCase().includes(query));
		this.statusEl.setText(this.refreshing ? 'Refreshing model information…' : this.getError() ?? `${matches.length} of ${known.length} models. Models reported as unable to generate text cannot be selected for flashcards.`);
		this.listEl.empty();
		if (!matches.length) this.listEl.createEl('p', { text: query ? 'No matching models.' : 'No models found. Save an API key and refresh, or enter an exact ID under Advanced.' });
		for (const model of matches) {
			const textCandidate = isTextGenerationCandidate(model);
			const details = [model.displayName !== model.id ? model.id : '',
				model.id === PROVIDER_PRESETS[this.providerId].suggestedModel ? 'Suggested starting model' : '',
				!textCandidate ? 'Not a text-generation model' : !model.outputModalities?.length ? 'Capabilities not reported' : 'Text output',
				model.releaseDate ? `Released ${model.releaseDate}` : '', inPicker.has(model.id) ? 'Already enabled' : added.has(model.id) ? 'Hidden; adding enables it again with its saved settings' : ''].filter(Boolean);
			new Setting(this.listEl).setName(model.displayName).setDesc(details.join(' · '))
				.addToggle(toggle => toggle.setValue(inPicker.has(model.id) || this.selected.has(model.id)).setDisabled(inPicker.has(model.id) || !textCandidate || this.busy)
					.onChange(value => {
						if (this.busy || inPicker.has(model.id) || !textCandidate) return;
						if (value) this.selected.add(model.id); else this.selected.delete(model.id);
						this.updateButtons();
					}));
		}
		this.updateButtons();
	}

	private updateButtons(): void {
		this.addButton.setButtonText(this.selected.size ? `Add ${this.selected.size} ${this.selected.size === 1 ? 'model' : 'models'}` : 'Add models')
			.setDisabled(this.busy || !this.selected.size || !this.plugin.settingsStore.canSave);
		this.cancelButton.setDisabled(this.busy);
		this.refreshButton.setDisabled(this.busy || this.refreshing);
	}

	private async refreshChoices(): Promise<void> {
		if (this.busy || this.refreshing) return;
		this.refreshing = true;
		this.renderChoices();
		await this.refresh();
		this.refreshing = false;
		this.renderChoices();
	}

	private async saveSelection(): Promise<void> {
		if (this.busy || !this.selected.size) return;
		this.busy = true;
		this.renderChoices();
		if (await this.plugin.addModels(this.providerId, [...this.selected])) this.close();
		else { this.busy = false; this.renderChoices(); }
	}
}

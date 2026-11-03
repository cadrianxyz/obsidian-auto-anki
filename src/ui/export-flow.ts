import { Modal, Notice, Setting, type App, type ButtonComponent, type DropdownComponent, type TextComponent } from 'obsidian';
import type { ModelSettings, PluginSettings } from '../settings/schema';
import { OutputMode, type ResolvedOutputMode } from '../ai/generation';
import { PROVIDER_NAMES, type ProviderId } from '../ai/providers';
import { COVERAGE_LABELS, type RunPreferences } from '../generate/prompt';
import { getReasoningEffortsForModel } from '../ai/models/metadata';
import { generateNotes } from '../generate/run';
import type { GeneratedAnkiNote, GenerationResult } from '../generate/result';
import type { Diagram } from '../source-note/images';
import { cleanNote, embeddedFiles, type SourceNote } from '../source-note/content';
import { prepareDiagrams, resolveImageInputPolicy, type ImageInputPolicy, type PreparedDiagrams } from '../source-note/images';
import { chooseDeck, getAnkiDecks, pinDeck } from '../anki/decks';
import { addNotesToAnki } from '../anki/export';
import type { GenerationStatus } from './generation-status';
import { renderDeckPicker } from './decks/deck-picker';
import { revalidateDestinations, type AnkiDestinations } from '../anki/note-types';
import { noteTags, promptVersionTag, type TagRun, type TagSettings } from '../anki/tags';
import { showTags } from './tags/tag-display';

function showImageInputWarning(container: HTMLElement, policy: ImageInputPolicy, embeddedCount: number, preparedCount: number): void {
	const count = policy.action === 'skip' ? embeddedCount : preparedCount;
	if (!count) return;
	const files = `${count} embedded ${count === 1 ? 'file' : 'files'}`;
	let text: string | undefined;
	if (policy.action === 'skip') text = policy.reason === 'disabled'
		? `${files} will not be sent because image input is disabled in the selected model settings.`
		: `${files} will not be sent because the selected model does not accept images.`;
	else if (policy.warning === 'forced-unsupported') text = `The selected model is reported as not accepting images, but its setting forces ${files} to be sent. The request may fail.`;
	else if (policy.warning === 'support-unknown') text = `Image support has not been reported for the selected model. ${files} will be sent, but the request may fail.`;
	if (text) container.createDiv({ text, cls: 'auto-anki-export-warning', attr: { role: 'status' } });
}

/** What the review needs from a run: its messages, and the diagrams its notes may use. */
type RunFeedback = Pick<GenerationResult, 'noteIssues' | 'warnings'> & { diagrams: readonly Diagram[] };

function showGenerationMessages(container: HTMLElement, result: Pick<GenerationResult, 'noteIssues' | 'warnings'>): void {
	if (result.noteIssues.length) {
		const details = container.createEl('details');
		details.open = true;
		details.createEl('summary', { text: 'Potential issues found' });
		details.createEl('p', { cls: 'setting-item-description', text: 'The model was told to leave these possible mistakes out of the generated notes.' });
		const list = details.createEl('ul', { cls: 'auto-anki-selectable-issues' });
		for (const issue of result.noteIssues) list.createEl('li', { text: issue });
	}
	if (result.warnings.length) {
		const details = container.createEl('details');
		details.createEl('summary', { text: 'Skipped content and diagram notes' });
		const list = details.createEl('ul');
		for (const warning of result.warnings) list.createEl('li', { text: warning });
	}
}

/**
 * The tags for one generated set. The settings and run details are fixed when Generate is
 * pressed; `extra` is the deck step's box, kept when going back to the selection.
 */
interface ExportTags {
	readonly settings: TagSettings;
	readonly run: TagRun;
	extra: string;
}

export interface ExportModel {
	providerId: ProviderId;
	apiKey: string;
	model: ModelSettings;
}

/** Confirm the actual source, diagram handling and per-run preferences before a paid request. */
export class ExportModal extends Modal {
	private readonly run: RunPreferences;
	private maximumText: string;
	private diagrams: PreparedDiagrams = { diagrams: [], warnings: [] };
	private busy = false;
	private closed = false;
	private readonly controller = new AbortController();
	private generateButton?: ButtonComponent;
	private readonly controls: { setDisabled(disabled: boolean): unknown }[] = [];
	private destinations?: AnkiDestinations;
	private readonly selectedNoteTypes = new Set<string>();
	private prepared = false;

	constructor(
		app: App,
		private readonly generationStatus: GenerationStatus,
		private readonly source: SourceNote,
		private selectedModel: ExportModel,
		private readonly models: readonly ExportModel[],
		private readonly address: string,
		private readonly defaultDeck: string,
		private readonly preferences: PluginSettings['notes'],
		private readonly tags: TagSettings,
		/** True when only selected text is sent. Not named `selection`, which Obsidian's Modal uses for its own state. */
		private readonly fromSelection: boolean,
		private readonly prepareDestinations: () => Promise<AnkiDestinations>,
		private readonly rememberOutputMode: (selected: ExportModel, mode: ResolvedOutputMode) => Promise<void>,
	) {
		super(app);
		const snapshot = structuredClone({ selectedModel, models });
		this.selectedModel = snapshot.selectedModel;
		this.models = snapshot.models;
		this.source = { ...source, markdown: cleanNote(source.markdown) };
		this.run = { coverage: preferences.coverageLevel, instructions: preferences.extraInstructions };
		this.maximumText = '';
	}

	async onOpen(): Promise<void> {
		this.modalEl.classList.add('auto-anki-export');
		this.titleEl.setText(this.fromSelection ? `Make Anki notes from a selection in “${this.source.title}”` : `Make Anki notes from “${this.source.title}”`);
		try {
			const decks = await getAnkiDecks(this.address);
			if (!decks.length) throw new Error('Your Anki collection has no decks. Create one in Anki first.');
		}
		catch (error) {
			if (!this.closed) new Notice(error instanceof Error ? error.message : 'Could not read Anki decks.');
			this.generationStatus.setState('error'); this.close(); return;
		}
		if (this.closed) return;
		this.generationStatus.setState('idle');
		const status = this.contentEl.createEl('p', { text: 'Preparing the note and diagrams…', cls: 'setting-item-description', attr: { role: 'status' } });
		new Setting(this.contentEl).setName('Coverage').setDesc('Choose how much detail to turn into Anki notes. This choice applies to this run only.')
			.addDropdown(dropdown => {
				this.controls.push(dropdown);
				for (const [value, label] of Object.entries(COVERAGE_LABELS)) dropdown.addOption(value, label);
				dropdown.setValue(this.run.coverage).onChange(value => {
					if (!this.busy && Object.prototype.hasOwnProperty.call(COVERAGE_LABELS, value)) this.run.coverage = value as RunPreferences['coverage'];
				});
			});
		const noteTypes = this.contentEl.createEl('details', { cls: 'auto-anki-export-options' });
		const noteTypesSummary = noteTypes.createEl('summary', { text: 'Note types' });
		const updateNoteTypesSummary = (): void => {
			const names = this.destinations?.types.filter(type => this.selectedNoteTypes.has(type.name)).map(type => type.name) ?? [];
			noteTypesSummary.setText(`Note types: ${names.length ? names.join(', ') : 'none selected'}`);
		};
		const noteTypeControls = noteTypes.createDiv({ cls: 'setting-horizontal-padding' });
		noteTypeControls.createEl('p', { text: 'Choose at least one for this run. Your saved choices are not changed.', cls: 'setting-item-description search-description' });
		const advanced = this.contentEl.createEl('details', { cls: 'auto-anki-export-options' });
		advanced.createEl('summary', { text: 'Advanced' });
		let effortDropdown: DropdownComponent | undefined;
		const refreshEffort = (): void => {
			if (!effortDropdown) return;
			const model = this.selectedModel.model;
			const reported = getReasoningEffortsForModel(model);
			const efforts = reported.includes(model.reasoningEffort) ? reported : [...reported, model.reasoningEffort];
			effortDropdown.selectEl.empty();
			for (const effort of efforts) {
				const label = effort === 'default' ? 'Model default' : effort.charAt(0).toUpperCase() + effort.slice(1);
				effortDropdown.addOption(effort, label + (reported.includes(effort) ? '' : ' (not reported for this model)'));
			}
			effortDropdown.setValue(model.reasoningEffort);
			effortSetting.setDesc(reported.length > 1
				? 'Choose a reasoning level for this run only. Model default lets the model choose.'
				: model.capabilities?.reasoningEfforts
					? 'This model reports no configurable effort levels. Model default lets the model choose.'
					: 'Effort levels for this model are not known yet; refresh models in settings to load them.');
		};
		new Setting(advanced).setName('Model').setDesc('Choose an enabled model for this run only.')
			.addDropdown(dropdown => {
				this.controls.push(dropdown);
				this.models.forEach((choice, index) => {
					dropdown.addOption(String(index), `${PROVIDER_NAMES[choice.providerId]} · ${choice.model.id}`);
				});
				dropdown.setValue(String(this.models.indexOf(this.selectedModel))).onChange(value => {
					const selected = this.models[Number(value)];
					if (this.busy || !this.prepared || !selected) return;
					this.selectedModel = selected;
					refreshEffort();
					void this.prepareForModel(status, warnings);
				});
			});
		const effortSetting = new Setting(advanced).setName('Reasoning effort').addDropdown(dropdown => {
			effortDropdown = dropdown;
			this.controls.push(dropdown);
			dropdown.onChange(value => {
				if (this.busy || !this.prepared) return;
				const model = this.selectedModel.model;
				if (getReasoningEffortsForModel(model).includes(value)) model.reasoningEffort = value;
			});
		});
		refreshEffort();
		new Setting(advanced).setName('Maximum notes').setDesc('Limit the Anki notes generated in this run. One note may create multiple flashcards. Leave empty for no fixed limit.')
			.addText(text => { this.controls.push(text); text.setValue(this.maximumText).setPlaceholder('No limit').onChange(value => { if (!this.busy) this.maximumText = value; }); });
		const instructions = advanced.createDiv({ cls: 'auto-anki-instructions' });
		new Setting(instructions).setName('Extra instructions').setDesc('Your saved extra instructions. Edit or clear them for this run only; your saved settings stay unchanged.')
			.addTextArea(text => { this.controls.push(text); text.inputEl.rows = 4; text.setValue(this.run.instructions).onChange(value => { if (!this.busy) this.run.instructions = value; }); });
		const warnings = this.contentEl.createDiv();
		new Setting(this.contentEl).addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(button => { this.generateButton = button; button.setButtonText('Generate Anki notes').setCta().setDisabled(true).onClick(() => this.generate()); });
		for (const control of this.controls) control.setDisabled(true);
		try {
			this.destinations = await this.prepareDestinations();
			if (this.closed) return;

			for (const type of this.destinations.types) {
				this.selectedNoteTypes.add(type.name);
				new Setting(noteTypeControls).setName(type.name).addToggle(toggle => {
					this.controls.push(toggle);
					toggle.setValue(true).setDisabled(true).onChange(enabled => {
						if (this.busy || !this.prepared) return;
						if (enabled) this.selectedNoteTypes.add(type.name); else this.selectedNoteTypes.delete(type.name);
						updateNoteTypesSummary();
						this.updateGenerateButton();
					});
				});
			}
			if (this.destinations.types.length) noteTypeControls.createEl('hr', { cls: 'auto-anki-note-types-divider' });
			updateNoteTypesSummary();
			await this.prepareForModel(status, warnings);
		}
		catch (error) {
			if (!this.closed) status.setText(error instanceof Error ? error.message : 'The note could not be prepared. Close this dialog and try again.');
		}
	}

	// --- Per-run preparation ---

	private updateGenerateButton(): void {
		this.generateButton?.setDisabled(this.busy || !this.prepared || !this.selectedNoteTypes.size || (!this.source.markdown.trim() && !this.diagrams.diagrams.length));
	}

	private async prepareForModel(status: HTMLElement, warnings: HTMLElement): Promise<void> {
		this.prepared = false;
		this.updateGenerateButton();
		for (const control of this.controls) control.setDisabled(true);
		status.setText('Preparing the note and diagrams…');
		try {
			const diagrams = await prepareDiagrams(this.app, this.source.markdown, this.source.path, this.preferences.sendDiagrams, this.selectedModel.model);
			if (this.closed) return;
			this.diagrams = diagrams;
			warnings.empty();
			if (this.preferences.sendDiagrams) {
				showImageInputWarning(warnings, resolveImageInputPolicy(this.selectedModel.model), embeddedFiles(this.source.markdown).length, diagrams.diagrams.length);
			}
			showGenerationMessages(warnings, { noteIssues: [], warnings: [...this.destinations!.problems, ...diagrams.warnings] });
			status.setText(`Sends: ${this.fromSelection ? 'selected text' : 'the note'} and ${diagrams.diagrams.length} ${diagrams.diagrams.length === 1 ? 'diagram' : 'diagrams'}. Frontmatter and Obsidian comments are excluded.`);
			if (!this.destinations!.types.length) status.setText('No verified note type is enabled. Open Auto Anki → Anki and enable an existing note type.');
			else if (!this.source.markdown.trim() && !diagrams.diagrams.length) status.setText('There is no study material after removing frontmatter and comments.');
			this.prepared = true;
		}
		catch (error) {
			if (!this.closed) status.setText(error instanceof Error ? error.message : 'The note could not be prepared. Close this dialog and try again.');
		}
		finally {
			if (!this.closed) {
				for (const control of this.controls) control.setDisabled(false);
				this.updateGenerateButton();
			}
		}
	}

	// --- Generation ---

	private async generate(): Promise<void> {
		if (this.busy || this.closed || !this.prepared || !this.destinations || !this.selectedNoteTypes.size) return;
		const destinations = { ...this.destinations, types: this.destinations.types.filter(type => this.selectedNoteTypes.has(type.name)) };
		const { providerId, apiKey, model } = this.selectedModel;
		const maximum = this.maximumText.trim();
		if (maximum && (!/^\d+$/.test(maximum) || !Number.isSafeInteger(Number(maximum)) || Number(maximum) < 1)) {
			new Notice('Enter a positive whole number for maximum notes, or leave it empty.'); return;
		}
		this.run.maximumNotes = maximum ? Number(maximum) : undefined;
		this.busy = true;
		for (const control of this.controls) control.setDisabled(true);
		this.generateButton?.setDisabled(true).setButtonText('Generating…');
		this.generationStatus.setState('running');
		try {
			await revalidateDestinations(destinations, destinations.types.map(type => type.name));
			if (this.closed) return;
			// Captured before the request, so a settings change during review can't alter these notes' tags.
			const tags: ExportTags = {
				settings: structuredClone(this.tags), extra: this.tags.extra,
				run: { providerId, modelId: model.id, reasoningEffort: model.reasoningEffort, promptVersion: promptVersionTag(this.preferences.noteWritingInstructions) },
			};
			const result = await generateNotes(providerId, apiKey, model, this.preferences, this.run, this.source, this.diagrams, destinations, this.controller.signal);
			if (this.closed) return;
			if (model.outputMode === OutputMode.Auto) await this.rememberOutputMode(this.selectedModel, result.outputMode);
			if (this.closed) return;
			this.generationStatus.setState('idle');
			this.close();
			new ChoiceModal(this.app, new NoteSelection(result.notes), this.address, this.defaultDeck, result, destinations, tags).open();
		}
		catch (error) {
			if (!this.closed) { this.generationStatus.setState('error'); new Notice(error instanceof Error ? error.message : 'Anki note generation failed.', 0); }
		}
		finally {
			this.busy = false;
			if (!this.closed) {
				for (const control of this.controls) control.setDisabled(false);
				this.generateButton?.setButtonText('Generate Anki notes');
				this.updateGenerateButton();
			}
		}
	}

	onClose(): void {
		this.closed = true;
		this.controller.abort();
		if (this.busy) this.generationStatus.setState('idle');
		this.contentEl.empty();
	}
}

// --- Review and deck choice ---

/** The generated notes and which ones are chosen. Both review steps share it, so going back keeps every note. */
class NoteSelection {
	readonly chosen = new Set<GeneratedAnkiNote>();
	constructor(public notes: readonly GeneratedAnkiNote[]) {}

	selectedNotes(): GeneratedAnkiNote[] {
		return this.notes.filter(note => this.chosen.has(note));
	}

	/** Drop notes that Anki has added, so they cannot be exported twice. */
	removeAdded(remaining: readonly GeneratedAnkiNote[]): void {
		const added = this.selectedNotes().filter(note => !remaining.includes(note));
		this.notes = this.notes.filter(note => !added.includes(note));
		for (const note of added) this.chosen.delete(note);
	}
}

/** Lets the user pick which generated notes to export. Only the list scrolls; the buttons stay in view. */
export class ChoiceModal extends Modal {
	constructor(app: App, private readonly review: NoteSelection, private readonly address: string, private readonly deck: string,
		private readonly feedback: RunFeedback, private readonly destinations: AnkiDestinations, private readonly tags: ExportTags) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, review } = this;
		this.modalEl.classList.add('auto-anki-picker');
		this.titleEl.setText('Review Anki notes');
		showGenerationMessages(contentEl, this.feedback);
		if (!review.notes.length) {
			contentEl.createEl('p', { text: 'No Anki notes were generated. The source note may not contain enough useful material, or all entries were skipped.' });
			return;
		}
		contentEl.createEl('p', { text: 'Pick the notes you want to export to Anki. One Anki note may create multiple cards.' });

		const shortcuts = contentEl.createDiv({ cls: 'question-options__buttons' });
		const list = contentEl.createEl('ul', { cls: 'question-options-container' });
		const items = review.notes.map(note => {
			const item = list.createEl('li');
			item.createEl('h3', { text: note.noteType });
			for (const [field, value] of Object.entries(note.fields)) {
				item.createEl('strong', { text: field });
				item.createEl('p', { text: value || '(empty)', cls: 'anki-note-field-value' });
			}
			item.onclick = () => {
				if (review.chosen.has(note)) review.chosen.delete(note); else review.chosen.add(note);
				refresh();
			};
			return item;
		});
		let confirm: ButtonComponent | undefined;
		// Restyle the items in place, so choosing a note does not reset the list's scroll position.
		const refresh = (): void => {
			review.notes.forEach((note, index) => { items[index].className = review.chosen.has(note) ? 'question-option --selected' : 'question-option'; });
			confirm?.setDisabled(!review.chosen.size);
		};
		shortcuts.createEl('button', { text: 'Select all' }).onclick = () => {
			for (const note of review.notes) review.chosen.add(note);
			refresh();
		};
		shortcuts.createEl('button', { text: 'Deselect all' }).onclick = () => {
			review.chosen.clear();
			refresh();
		};
		new Setting(contentEl).addButton(button => {
			confirm = button;
			button.setButtonText('Confirm selection').setCta().onClick(() => {
				if (!review.chosen.size) return;
				this.close();
				new AnkiDeckModal(this.app, this.address, this.deck, review, this.destinations, this.feedback, this.tags).open();
			});
		});
		refresh();
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Chooses the deck for the export. Going back to the selection keeps the chosen deck. */
export class AnkiDeckModal extends Modal {
	private decks: string[] = [];
	private loaded = false;
	private query = '';
	/** The deck this dialog started with, when Anki no longer has it. */
	private replacedDeck = '';
	private exporting = false;
	private deckError?: string;
	private readonly buttons: ButtonComponent[] = [];
	private tagBox?: TextComponent;

	constructor(
		app: App,
		private readonly address: string,
		private selectedDeck: string,
		private readonly review: NoteSelection,
		private readonly destinations: AnkiDestinations,
		private readonly feedback: RunFeedback,
		private readonly tags: ExportTags,
	) {
		super(app);
	}

	private async fetchData(): Promise<void> {
		this.deckError = undefined;
		let decks: string[] = [];
		try { decks = await getAnkiDecks(this.address); }
		catch (error) {
			this.deckError = error instanceof Error ? error.message : 'Could not read Anki decks.';
			new Notice(this.deckError);
		}
		this.loaded = true;
		if (!decks.length) { this.decks = []; return; }

		const requested = this.selectedDeck;
		const choice = chooseDeck(decks, requested);
		this.selectedDeck = choice.deck;
		this.replacedDeck = choice.replaced ? requested : '';
		// The starting deck stays first for as long as this dialog is open, even after another deck is chosen.
		this.decks = pinDeck(decks, choice.deck);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.buttons.length = 0;
		this.tagBox = undefined;
		this.titleEl.setText('Anki decks');

		if (!this.loaded) {
			contentEl.createEl('p', { cls: 'setting-item-description', text: 'Loading decks from Anki…' });
		}
		else if (!this.decks.length) {
			const notice = contentEl.createDiv({ cls: 'error-notice' });
			notice.createEl('h4', { text: this.deckError ?? 'Your Anki collection has no decks. Create one in Anki first.' });
			notice.createEl('button', { text: 'Refresh' }).onclick = () => { void this.load(); };
		}
		else {
			contentEl.createEl('p', { text: 'Pick one of the following available Anki decks to export to.' });
			if (this.replacedDeck) {
				contentEl.createEl('p', { cls: 'setting-item-description', text: `“${this.replacedDeck}” is not in Anki, so “${this.selectedDeck}” is selected.` });
			}
			renderDeckPicker(contentEl, this.decks, {
				selected: this.selectedDeck,
				query: this.query,
				onQuery: query => { this.query = query; },
				onSelect: deck => { if (!this.exporting) this.selectedDeck = deck; },
			});
			this.renderTags(contentEl);
		}

		const footer = new Setting(contentEl).addButton(button => {
			this.buttons.push(button);
			button.setButtonText('Back to selection').onClick(() => {
				if (this.exporting) return;
				this.close();
				new ChoiceModal(this.app, this.review, this.address, this.selectedDeck, this.feedback, this.destinations, this.tags).open();
			});
		});
		if (this.decks.length) footer.addButton(button => {
			this.buttons.push(button);
			button.setButtonText('Confirm and export').setCta().onClick(() => this.exportSelection());
		});
		this.updateButtons();
	}

	/** A collapsed Tags section, only while tagging is on. Its title lists the tags, so none are hidden. */
	private renderTags(container: HTMLElement): void {
		const { settings, run } = this.tags;
		if (!settings.enabled) return;
		const section = container.createEl('details', { cls: 'auto-anki-export-options auto-anki-tags' });
		const summary = section.createEl('summary', { text: 'Tags: ' });
		const list = summary.createSpan({ cls: 'auto-anki-tag-list' });
		const update = (): void => showTags(list, noteTags(settings, run, this.tags.extra), 'none');
		new Setting(section).setName('Extra tags for this export')
			.setDesc('Starts with your extra tags. Changes apply to this export only; your settings stay the same.')
			.addText(text => {
				this.tagBox = text;
				text.setPlaceholder('No extra tags').setValue(this.tags.extra).onChange(value => {
					if (this.exporting) return;
					this.tags.extra = value;
					update();
				});
			});
		update();
	}

	private updateButtons(): void {
		for (const button of this.buttons) button.setDisabled(this.exporting);
		this.tagBox?.setDisabled(this.exporting);
	}

	private async load(): Promise<void> {
		this.loaded = false;
		this.render();
		await this.fetchData();
		this.render();
	}

	private async exportSelection(): Promise<void> {
		const notes = this.review.selectedNotes();
		if (!this.selectedDeck || !notes.length || this.exporting) return;
		this.exporting = true;
		this.updateButtons();
		try {
			if (this.address !== this.destinations.url) throw new Error('The Anki address does not match this generation. Return to review.');
			const outcome = await addNotesToAnki(notes, this.destinations, this.selectedDeck, this.feedback.diagrams, noteTags(this.tags.settings, this.tags.run, this.tags.extra));
			this.review.removeAdded(outcome.remaining);
			if (!outcome.errors.length) new Notice(`Successfully exported ${outcome.added} note(s) to Anki!`);
			else {
				const reasons = [...new Set(outcome.errors)].slice(0, 3).join('\n');
				new Notice(`Exported ${outcome.added} of ${notes.length} note(s) to Anki. Anki refused ${outcome.errors.length}:\n${reasons}`, 0);
			}
			if (!outcome.remaining.length) this.close();
		}
		catch (error) {
			new Notice(`ERR: Anki refused the export: ${error instanceof Error ? error.message : 'The destinations could not be verified.'}`, 0);
		}
		finally {
			this.exporting = false;
			this.updateButtons();
		}
	}

	async onOpen(): Promise<void> {
		this.modalEl.classList.add('auto-anki-picker');
		await this.load();
	}

	onClose(): void { this.contentEl.empty(); }
}

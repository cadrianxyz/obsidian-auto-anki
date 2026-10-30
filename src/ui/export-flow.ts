import { Modal, Notice, Setting, type App, type ButtonComponent, type DropdownComponent } from 'obsidian';
import type { ModelSettings, PluginSettings } from '../settings/schema';
import { OutputMode, type ResolvedOutputMode } from '../ai/generation';
import { PROVIDER_NAMES, type ProviderId } from '../ai/providers';
import { COVERAGE_LABELS, type RunPreferences } from '../generate/prompt';
import { getReasoningEffortsForModel } from '../ai/models/metadata';
import { generateNotes } from '../generate/run';
import type { GeneratedAnkiNote, GenerationResult } from '../generate/result';
import { cleanNote, type SourceNote } from '../source-note/content';
import { prepareDiagrams, type PreparedDiagrams } from '../source-note/images';
import { getAnkiDecks } from '../anki/decks';
import { addNotesToAnki } from '../anki/export';
import type { GenerationStatus } from './generation-status';
import { revalidateDestinations, type AnkiDestinations } from '../anki/note-types';

function showGenerationMessages(container: HTMLElement, result: Pick<GenerationResult, 'noteIssues' | 'warnings'>): void {
	if (result.noteIssues.length) {
		container.createEl('p', { text: 'Check these claims in your note. The model was asked to leave suspected mistakes out of the generated notes.' });
		const list = container.createEl('ul');
		for (const issue of result.noteIssues) list.createEl('li', { text: issue });
	}
	if (result.warnings.length) {
		const details = container.createEl('details');
		details.createEl('summary', { text: 'Skipped content and diagram notes' });
		const list = details.createEl('ul');
		for (const warning of result.warnings) list.createEl('li', { text: warning });
	}
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
		private readonly deck: string,
		private readonly preferences: PluginSettings['notes'],
		private readonly selection: boolean,
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
		this.titleEl.setText(this.selection ? `Make Anki notes from a selection in “${this.source.title}”` : `Make Anki notes from “${this.source.title}”`);
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
		const noteTypeControls = noteTypes.createDiv();
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
			showGenerationMessages(warnings, { noteIssues: [], warnings: [...this.destinations!.problems, ...diagrams.warnings] });
			status.setText(`Sends: ${this.selection ? 'selected text' : 'the note'} and ${diagrams.diagrams.length} ${diagrams.diagrams.length === 1 ? 'diagram' : 'diagrams'}. Frontmatter and Obsidian comments are excluded.`);
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
			const result = await generateNotes(providerId, apiKey, model, this.preferences, this.run, this.source, this.diagrams, destinations, this.controller.signal);
			if (this.closed) return;
			if (model.outputMode === OutputMode.Auto) await this.rememberOutputMode(this.selectedModel, result.outputMode);
			if (this.closed) return;
			this.generationStatus.setState('idle');
			this.close();
			new ChoiceModal(this.app, result.notes, this.address, this.deck, result, destinations).open();
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

class QuestionSetWithSelections {
    questions: GeneratedAnkiNote[];
    selected: Set<number>;
    renderFunc: VoidFunction;

    constructor(
        questions: GeneratedAnkiNote[],
        onChangeCallback: VoidFunction,
        selectAllOnInit?: boolean,
    ) {
        this.questions = questions;
        if (selectAllOnInit) this.selected = new Set([...Array(questions.length).keys()])
        else this.selected = new Set([]);

        this.renderFunc = onChangeCallback;
    }

    renderHtmlList() {
        const htmlList = createEl('ul', { cls: 'question-options-container' });

        const convenienceButtons = createDiv({ cls: 'question-options__buttons' });
        const selectAllButton = convenienceButtons.createEl('button', { text: 'Select all' });
        selectAllButton.onclick = (e: MouseEvent) => { this.selectAll() };
        const deselectAllButton = convenienceButtons.createEl('button', { text: 'Deselect all' });
        deselectAllButton.onclick = (e: MouseEvent) => { this.deselectAll() };

        htmlList.appendChild(convenienceButtons);

        this.questions.forEach((q: GeneratedAnkiNote, idx: number) => {
            const htmlQuestion = createEl('li');
            htmlQuestion.createEl('h3', { text: q.noteType });
            for (const [field, value] of Object.entries(q.fields)) {
                htmlQuestion.createEl('strong', { text: field });
                htmlQuestion.createEl('p', { text: value || '(empty)', cls: 'anki-note-field-value' });
            }
            if (this.selected.has(idx)) {
                htmlQuestion.className = 'question-option --selected'
            }
            else {
                htmlQuestion.className = 'question-option'
            }
            htmlQuestion.onclick = () => { this.toggleSelect(idx) };
            htmlList.appendChild(htmlQuestion);
        })

        return htmlList;
    }

    toggleSelect(idx: number) {
        if (this.selected.has(idx)) {
            this.selected.delete(idx);
        }
        else {
            this.selected.add(idx);
        }
        this.renderFunc();
    }

    selectAll() {
        this.questions.forEach((q: GeneratedAnkiNote, idx: number) => {
            if (this.selected.has(idx)) return;
            this.selected.add(idx);
        });
        this.renderFunc();
    }

    deselectAll() {
        this.selected.clear();
        this.renderFunc();
    }

    extractSelectedQuesions() {
        return this.questions.filter((val, idx) => this.selected.has(idx));
    }
}

/** Keep the existing Anki-note selection and deck export while the full review UI is built. */
export class ChoiceModal extends Modal {
	private readonly questions: QuestionSetWithSelections;
	constructor(app: App, notes: GeneratedAnkiNote[], private readonly address: string, private readonly deck: string,
		private readonly feedback: Pick<GenerationResult, 'noteIssues' | 'warnings'>, private readonly destinations: AnkiDestinations) {
		super(app);
		this.questions = new QuestionSetWithSelections(notes, () => this.renderContent());
	}

	private renderContent(): void {
		this.contentEl.empty();
		this.titleEl.setText('Review Anki notes');
		showGenerationMessages(this.contentEl, this.feedback);
		this.contentEl.createEl('p', { text: 'Each selected entry is added as one Anki note. Your chosen type may create more than one flashcard from it.' });

		if (!this.questions.questions.length) {
			this.contentEl.createEl('p', { text: 'No Anki notes were generated. The source note may not contain enough useful material, or all entries were skipped.' });
			return;
		}
		this.contentEl.createEl('p', { text: 'Pick the notes you want to export to Anki.' });
		this.contentEl.appendChild(this.questions.renderHtmlList());
		new Setting(this.contentEl).addButton(button => button.setButtonText('Confirm selection').setCta()
			.setDisabled(this.questions.selected.size === 0).onClick(() => {
				const notes = this.questions.extractSelectedQuesions();
				if (!notes.length) return;
				this.close();
				new AnkiDeckModal(this.app, this.address, this.deck, notes, this.destinations, this.feedback).open();
			}));
	}
	onOpen(): void { this.renderContent(); }
	onClose(): void { this.contentEl.empty(); }
}

export class AnkiDeckModal extends Modal {
    notesToExport: GeneratedAnkiNote[];
    decks: string[] = [];
    selectedDeck: string;
    isDataFetched: boolean;
    private exporting = false;
    private deckError?: string;

    constructor(
        app: App,
        private readonly address: string,
        defaultDeck: string,
        allSelectedNotes: GeneratedAnkiNote[],
        private readonly destinations: AnkiDestinations,
        private readonly feedback: Pick<GenerationResult, 'noteIssues' | 'warnings'>,
    ) {
        super(app);
        this.selectedDeck = defaultDeck;
        this.notesToExport = allSelectedNotes;

        this.isDataFetched = false;
    }

    async fetchData() {
        let fetchedDecks: string[] = [];
        this.deckError = undefined;
        try { fetchedDecks = await getAnkiDecks(this.address); }
        catch (error) {
            this.deckError = error instanceof Error ? error.message : 'Could not read Anki decks.';
            new Notice(this.deckError);
        }
        this.decks = fetchedDecks;
        this.isDataFetched = true;


        // This legacy picker exports only to existing decks. A 1.0 deck template
        // is resolved by the upcoming Anki flow, so never send it literally here.
        if (!fetchedDecks.includes(this.selectedDeck) && fetchedDecks.length > 0) {
            this.selectedDeck = fetchedDecks[0];
        }
    }

    renderHtmlList() {
        const htmlList = createEl('ul', { cls: 'deck-options-container' });
        const convenienceButtons = createDiv({ cls: 'deck-options__buttons' });

        htmlList.appendChild(convenienceButtons);

        this.decks.forEach((d: string) => {
            const htmlDeck = createEl('li');
            htmlDeck.appendChild(createEl('h3', { text: d }));
            if (this.selectedDeck === d) {
                htmlDeck.className = 'deck-option --selected'
            }
            else {
                htmlDeck.className = 'deck-option'
            }
            htmlDeck.onclick = () => {
                if (this.exporting) return;
                this.selectedDeck = d;
                this.renderContent();
            };
            htmlList.appendChild(htmlDeck);
        })

        return htmlList;
    }

    renderContent() {
        const { contentEl } = this;
        contentEl.empty();

        // modal title
        contentEl.createEl('h1', { text: 'Anki decks' });

        if (!this.isDataFetched) {
            const centerContainer = contentEl.createDiv({ cls: 'error-notice' });
            centerContainer.createEl('h4', { text: 'Loading data…' });
            return;
        }

		new Setting(contentEl).addButton(button => button.setButtonText('Back to notes').setDisabled(this.exporting).onClick(() => {
			if (this.exporting) return;
			this.close(); new ChoiceModal(this.app, this.notesToExport, this.address, this.selectedDeck, this.feedback, this.destinations).open();
		}));
        if (this.decks.length === 0) {
            const centerContainer = contentEl.createDiv({ cls: 'error-notice' });
            centerContainer.createEl('h4', { text: this.deckError ?? 'Your Anki collection has no decks. Create one in Anki first.' });
            const refreshButton = centerContainer.createEl('button', { text: 'Refresh' });
            refreshButton.onclick = async () => {
                this.renderContent();
                await this.fetchData();
                this.renderContent();
            }
            return;
        }

        // modal description
        contentEl.createEl('p', { text: 'Pick one of the following available Anki decks to export to.' });

        // get deck list to render
        const htmlList = this.renderHtmlList();
        contentEl.appendChild(htmlList);
        new Setting(contentEl)
            .addButton((btn) =>
                btn
                .setButtonText('Confirm and export')
                .setDisabled(this.selectedDeck === '' || this.exporting)
                .setCta()
                .onClick(async () => {
                    if (this.selectedDeck === '' || this.exporting) return;
                    this.exporting = true;
                    this.renderContent();
                    await this.exportSelection();
                })
        );
    }

    private async exportSelection(): Promise<void> {
        try {
            if (this.address !== this.destinations.url) throw new Error('The Anki address does not match this generation. Return to review.');
            const total = this.notesToExport.length;
            const outcome = await addNotesToAnki(this.notesToExport, this.destinations, this.selectedDeck);
            this.notesToExport = outcome.remaining;
            if (!outcome.errors.length) new Notice(`Successfully exported ${outcome.added} note(s) to Anki!`);
            else {
                const reasons = [...new Set(outcome.errors)].slice(0, 3).join('\n');
                new Notice(`Exported ${outcome.added} of ${total} note(s) to Anki. Anki refused ${outcome.errors.length}:\n${reasons}`, 0);
            }
            if (!outcome.remaining.length) this.close();
        }
        catch (error) {
            new Notice(`ERR: Anki refused the export: ${error instanceof Error ? error.message : 'The destinations could not be verified.'}`, 0);
        }
        finally {
            this.exporting = false;
            if (this.notesToExport.length) this.renderContent();
        }
    }

    async onOpen() {
        this.renderContent();
        await this.fetchData();
        this.renderContent();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

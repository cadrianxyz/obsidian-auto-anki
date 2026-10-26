import { Modal, Notice, Setting, type App, type ButtonComponent } from 'obsidian';
import type { ModelSettings, SettingsV1 } from './settings/model';
import { OutputMode, type ResolvedOutputMode } from './ai/model-info';
import { PROVIDER_PRESETS, type ProviderId } from './ai/presets';
import { COVERAGE_LABELS, type RunPreferences } from './generate/prompt';
import { generateCards } from './generate/run';
import type { CardInformation, GenerationResult } from './generate/result';
import { cleanNote, type SourceNote } from './note/read';
import { prepareDiagrams, type PreparedDiagrams } from './note/images';
import { checkAnkiAvailability, checkAnkiDecksExist, exportToAnki, getAnkiDecks } from './utils/anki';
import type { StatusBarElement } from './utils/cusom-types';

function showGenerationMessages(container: HTMLElement, result: Pick<GenerationResult, 'noteIssues' | 'warnings'>): void {
	if (result.noteIssues.length) {
		container.createEl('p', { text: 'Check these claims in your note. The model was asked to leave suspected mistakes out of the cards.' });
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

	constructor(
		app: App,
		private readonly statusBar: StatusBarElement,
		private readonly source: SourceNote,
		private readonly apiKey: string,
		private readonly providerId: ProviderId,
		private readonly model: ModelSettings,
		private readonly address: string,
		private readonly deck: string,
		private readonly cards: SettingsV1['cards'],
		private readonly selection: boolean,
		private readonly rememberOutputMode: (mode: ResolvedOutputMode) => Promise<void>,
	) {
		super(app);
		this.source = { ...source, markdown: cleanNote(source.markdown) };
		this.run = { coverage: cards.coverageLevel, instructions: '' };
		this.maximumText = selection ? '3' : '';
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(this.selection ? `Make cards from a selection in “${this.source.title}”` : `Make cards from “${this.source.title}”`);
		if (!await checkAnkiAvailability(this.address) || !await checkAnkiDecksExist(this.address)) {
			this.statusBar.doDisplayError?.(); this.close(); return;
		}
		if (this.closed) return;
		this.statusBar.doReset?.();
		const status = this.contentEl.createEl('p', { text: 'Preparing the note and diagrams…', attr: { role: 'status' } });
		this.contentEl.createEl('p', { text: `Model: ${PROVIDER_PRESETS[this.providerId].name} · ${this.model.id}. Cards are generated as text questions and answers. Diagrams provide source material for those answers.` });
		new Setting(this.contentEl).setName('Coverage').setDesc('Choose how much detail to turn into cards. This choice applies to this run only.')
			.addDropdown(dropdown => {
				this.controls.push(dropdown);
				for (const [value, label] of Object.entries(COVERAGE_LABELS)) dropdown.addOption(value, label);
				dropdown.setValue(this.run.coverage).onChange(value => {
					if (!this.busy && Object.prototype.hasOwnProperty.call(COVERAGE_LABELS, value)) this.run.coverage = value as RunPreferences['coverage'];
				});
			});
		const advanced = this.contentEl.createEl('details');
		advanced.createEl('summary', { text: 'Advanced' });
		new Setting(advanced).setName('Maximum cards').setDesc('Optional limit for this run. Leave empty to let the useful material determine the count.')
			.addText(text => { this.controls.push(text); text.setValue(this.maximumText).setPlaceholder('No limit').onChange(value => { if (!this.busy) this.maximumText = value; }); });
		const instructions = advanced.createDiv({ cls: 'auto-anki-instructions' });
		new Setting(instructions).setName('Instructions for this run').setDesc('One-off guidance added after your saved extra instructions. Markdown and line breaks are kept; this text is not saved.')
			.addTextArea(text => { this.controls.push(text); text.inputEl.rows = 4; text.onChange(value => { if (!this.busy) this.run.instructions = value; }); });
		const warnings = this.contentEl.createDiv();
		new Setting(this.contentEl).addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(button => { this.generateButton = button; button.setButtonText('Generate cards').setCta().setDisabled(true).onClick(() => this.generate()); });
		try {
			this.diagrams = await prepareDiagrams(this.app, this.source.markdown, this.source.path, this.cards.sendDiagrams, this.model);
			if (this.closed) return;
			status.setText(`Sends: ${this.selection ? 'selected text' : 'the note'} and ${this.diagrams.diagrams.length} ${this.diagrams.diagrams.length === 1 ? 'diagram' : 'diagrams'}. Frontmatter and Obsidian comments are excluded.`);
			showGenerationMessages(warnings, { noteIssues: [], warnings: this.diagrams.warnings });
			if (!this.source.markdown.trim() && !this.diagrams.diagrams.length) status.setText('There is no study material after removing frontmatter and comments.');
			else this.generateButton?.setDisabled(false);
		}
		catch {
			if (!this.closed) status.setText('The note could not be prepared. Close this dialog and try again.');
		}
	}

	private async generate(): Promise<void> {
		if (this.busy || this.closed) return;
		const maximum = this.maximumText.trim();
		if (maximum && (!/^\d+$/.test(maximum) || !Number.isSafeInteger(Number(maximum)) || Number(maximum) < 1)) {
			new Notice('Enter a positive whole number for maximum cards, or leave it empty.'); return;
		}
		this.run.maximumCards = maximum ? Number(maximum) : undefined;
		this.busy = true;
		for (const control of this.controls) control.setDisabled(true);
		this.generateButton?.setDisabled(true).setButtonText('Generating…');
		this.statusBar.doDisplayRunning?.();
		try {
			const result = await generateCards(this.providerId, this.apiKey, this.model, this.cards, this.run, this.source, this.diagrams, this.controller.signal);
			if (this.closed) return;
			if (this.model.outputMode === OutputMode.Auto) await this.rememberOutputMode(result.outputMode);
			if (this.closed) return;
			this.statusBar.doReset?.();
			this.close();
			new ChoiceModal(this.app, result.cards, this.address, this.deck, result).open();
		}
		catch (error) {
			if (!this.closed) { this.statusBar.doDisplayError?.(); new Notice(error instanceof Error ? error.message : 'Card generation failed.', 0); }
		}
		finally {
			this.busy = false;
			if (!this.closed) {
				for (const control of this.controls) control.setDisabled(false);
				this.generateButton?.setDisabled(false).setButtonText('Generate cards');
			}
		}
	}

	onClose(): void {
		this.closed = true;
		this.controller.abort();
		if (this.busy) this.statusBar.doReset?.();
		this.contentEl.empty();
	}
}

class QuestionSetWithSelections {
    questions: CardInformation[];
    selected: Set<number>;
    renderFunc: VoidFunction;
    
    constructor(
        questions: CardInformation[],
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

        this.questions.forEach((q: CardInformation, idx: number) => {
            const htmlQuestion = createEl('li');
            htmlQuestion.appendChild(createEl('h3', { text: q.q }));
            htmlQuestion.appendChild(createEl('p', { text: q.a }));
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
        this.questions.forEach((q: CardInformation, idx: number) => {
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

/** Keep the existing text-card selection and deck export while the full review UI is built. */
export class ChoiceModal extends Modal {
	private readonly questions: QuestionSetWithSelections;
	constructor(app: App, cards: CardInformation[], private readonly port: number | string, private readonly deck: string,
		private readonly feedback: Pick<GenerationResult, 'noteIssues' | 'warnings'>) {
		super(app);
		this.questions = new QuestionSetWithSelections(cards, () => this.renderContent());
	}

	private renderContent(): void {
		this.contentEl.empty();
		this.titleEl.setText('Review cards');
		showGenerationMessages(this.contentEl, this.feedback);
		if (!this.questions.questions.length) {
			this.contentEl.createEl('p', { text: 'No cards were generated. The note may not contain enough useful material, or all entries were skipped.' });
			return;
		}
		this.contentEl.createEl('p', { text: 'Pick the cards you want to export to Anki.' });
		this.contentEl.appendChild(this.questions.renderHtmlList());
		new Setting(this.contentEl).addButton(button => button.setButtonText('Confirm selection').setCta()
			.setDisabled(this.questions.selected.size === 0).onClick(() => {
				const cards = this.questions.extractSelectedQuesions();
				if (!cards.length) return;
				this.close();
				new AnkiDeckModal(this.app, this.port, this.deck, cards).open();
			}));
	}
	onOpen(): void { this.renderContent(); }
	onClose(): void { this.contentEl.empty(); }
}

export class AnkiDeckModal extends Modal {
    port: number | string;
    cardsToExport: CardInformation[];
    decks: string[] = [];
    selectedDeck: string;
    isDataFetched: boolean;

    constructor(
        app: App,
        port: number | string,
        defaultDeck: string,
        allSelectedCards: CardInformation[],
    ) {
        super(app);
        this.port = port;
        this.selectedDeck = defaultDeck;
        this.cardsToExport = allSelectedCards;

        this.isDataFetched = false;
    }

    async fetchData() {
        const fetchedDecks = await getAnkiDecks(this.port);
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
        
        if (this.decks.length === 0) {
            const centerContainer = contentEl.createDiv({ cls: 'error-notice' });
            centerContainer.createEl('h4', { text: 'Either an error occurred or no Anki decks were found' });
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
                .setDisabled(this.selectedDeck === '')
                .setCta()
                .onClick(async () => {
                    if (this.selectedDeck === '') return;
                
                    this.close();
                    await exportToAnki(
                        this.cardsToExport,
                        this.port,
                        this.selectedDeck,
                    );
                })
        );
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

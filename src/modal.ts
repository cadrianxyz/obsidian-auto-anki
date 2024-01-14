import { App, Modal, Notice, Setting } from 'obsidian';
import { GptAdvancedOptions } from './settings';

import { 
    checkAnkiAvailability,
    checkAnkiDecksExist,
    exportToAnki,
    getAnkiDecks,
} from './utils/anki';
import { CardInformation, checkGpt, convertNotesToFlashcards } from './utils/gpt';
import { StatusBarElement } from './utils/cusom-types';

// import { SAMPLE_CARD_INFORMATION } from 'sample/sample_card_information';

function checkValidNumGreaterThanZero(text: string|number, inclusiveZero?: boolean) {
    if (typeof text == 'string' && text === '') return false;
    if (isNaN(+text)) return false;
    return inclusiveZero ? +text >= 0 : +text > 0;
}
export class ExportModal extends Modal {
    n_q: number;
    n_q_valid: boolean;
    n_alt: number;
    n_alt_valid: boolean;
    data: string;
    apiKey: string;
    port: number;
    deck: string;
    gptAdvancedOptions: GptAdvancedOptions;
    statusBar: StatusBarElement;
    
    constructor(
        app: App,
        statusBar: StatusBarElement,
        data: string,
        openAiApiKey: string,
        ankiConnectPort: number,
        ankiDestinationDeck: string,
        gptAdvancedOptions: GptAdvancedOptions,
        dafaultNumQuestions?: number,
        defaultNumAlternatives?: number,
    ) {
        super(app);
        this.statusBar = statusBar;
        this.data = data;
        this.apiKey = openAiApiKey;
        this.port = ankiConnectPort;
        this.deck = ankiDestinationDeck;
        this.gptAdvancedOptions = gptAdvancedOptions;

        this.n_q = dafaultNumQuestions ?? 5;
        this.n_q_valid = checkValidNumGreaterThanZero(this.n_q);
        this.n_alt = defaultNumAlternatives ?? 3;
        this.n_alt_valid = checkValidNumGreaterThanZero(this.n_alt, true);
    }

    async onOpen() {
        const { contentEl } = this;

        const isAnkiAvailable = await checkAnkiAvailability(this.port);
        // update status bar if error/success
        if (this.statusBar.doDisplayError && !isAnkiAvailable) this.statusBar.doDisplayError();
        if (this.statusBar.doReset && isAnkiAvailable) this.statusBar.doReset();
        if (!isAnkiAvailable) return this.close();

        const ankiCheck = await checkAnkiDecksExist(this.port);
        if (this.statusBar.doDisplayError && !ankiCheck) this.statusBar.doDisplayError();
        if (this.statusBar.doReset && ankiCheck) this.statusBar.doReset();
        if (!ankiCheck) return this.close();

        contentEl.createEl('h1', { text: 'How many questions should be generated?' });

        new Setting(contentEl)
            .setName('Number of Questions')
            .addText((text) => text
                .setValue(String(this.n_q))
                .onChange((value) => {
                    this.n_q_valid = checkValidNumGreaterThanZero(value);
                    this.n_q = Number(value)
                })
            );

        new Setting(contentEl)
            .setName('Number of Alternatives')
            .setDesc('Generate multiple versions of questions and choose your favorite ones!')
            .addText((text) => text
                .setValue(String(this.n_alt))
                .onChange((value) => {
                    this.n_alt_valid = checkValidNumGreaterThanZero(value, true);
                    this.n_alt = Number(value)
                })
            );

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                .setButtonText('Generate Cards')
                .setCta()
                .onClick(async () => {
                    if (!this.n_q_valid || !this.n_alt_valid) {
                        new Notice('An invalid number was entered!');
                        return;
                    }
                    this.close();

                    let isRequestValid = false;
                    isRequestValid = checkGpt(this.apiKey);

                    if (!isRequestValid) return;
                    if (this.statusBar.doDisplayRunning) this.statusBar.doDisplayRunning();
                    const card_sets: Array<CardInformation[]> = await convertNotesToFlashcards(
                        this.apiKey,
                        this.data,
                        this.n_q,
                        this.n_alt+1,
                        this.gptAdvancedOptions,
                    );
                    if (this.statusBar.doReset) this.statusBar.doReset();

                    if (card_sets.length === 0) return;
                    // TODO: add loading indicator somewhere
                    new ChoiceModal(
                        this.app,
                        card_sets,
                        // SAMPLE_CARD_INFORMATION,
                        this.port,
                        this.deck,
                        this.n_q,
                        this.n_alt > 0,
                    ).open();
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
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

        const convenienceButtons = createEl('div', { cls: 'question-options__buttons' });
        const selectAllButton = convenienceButtons.createEl('button', { text: 'Select All' });
        selectAllButton.onclick = (e: MouseEvent) => { this.selectAll() };
        const deselectAllButton = convenienceButtons.createEl('button', { text: 'Deselect All' });
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

export class ChoiceModal extends Modal {
    card_sets: Array<CardInformation[]>;
    question_sets: QuestionSetWithSelections[];
    n_sets: number;
    port: number;
    deck: string;

    curr_set: number;
    
    constructor(
        app: App,
        card_sets: Array<CardInformation[]>,
        port: number,
        deck: string,
        n_q: number,
        has_alternatives: boolean,
    ) {
        super(app);
        this.renderContent  = this.renderContent.bind(this);

        this.card_sets = card_sets;
        this.port = port;
        this.deck = deck;

        // create question sets
        this.curr_set = 0;
        this.question_sets = [];

        if (has_alternatives) {
            this.n_sets = n_q;
            for (let i = 0; i < n_q; i++) {
                const question_choices: CardInformation[] = [];
    
                card_sets.forEach((set) => {
                    if (i < set.length) question_choices.push(set[i]);
                })
                this.question_sets.push(
                    new QuestionSetWithSelections(question_choices, this.renderContent)
                );
            }
        }
        else {
            this.n_sets = 1;
            this.question_sets.push(
                new QuestionSetWithSelections(card_sets[0], this.renderContent)
            );
        }
    }

    renderContent() {
        const { contentEl } = this;
        contentEl.innerHTML = ''; // use innerHTML to reset content

        // modal title, description
        if (this.n_sets === 1) {
            contentEl.createEl('h1', { text: 'Questions List' });
        }
        else {
            contentEl.createEl('h1', { text: `Question Set No. ${this.curr_set+1}` });
        }
        contentEl.createEl('p', { text: 'Pick one or more of the questions below you want to export to Anki.' });

        // get card set to render
        const htmlList = this.question_sets[this.curr_set].renderHtmlList();
        contentEl.appendChild(htmlList);

        // create buttons depending on how many sets there are
        if (this.n_sets > 1) {
            // create buttons in modal footer
            const htmlButtons = createEl('div', { cls: 'modal-buttons' });
            // previous button
            new Setting(htmlButtons)
                .addButton((btn) =>
                    btn
                    .setButtonText('Previous')
                    .setCta()
                    .setClass(this.curr_set === 0 ? 'disabled' : 'enabled')
                    .setDisabled(this.curr_set === 0)
                    .onClick(() => {
                        this.curr_set -= 1;
                        this.renderContent();
                    })
            );
    
            // next/confirm button
            if (this.curr_set < this.n_sets-1){
                new Setting(htmlButtons)
                    .addButton((btn) =>
                        btn
                        .setButtonText('Next')
                        .setCta()
                        .onClick(() => {
                            this.curr_set += 1;
                            this.renderContent();
                        })
                );
            }
            else {
                new Setting(htmlButtons)
                    .addButton((btn) =>
                        btn
                        .setButtonText('Confirm Selection')
                        .setCta()
                        .onClick(async () => {
                            this.close();
                            const allSelectedCards: CardInformation[] = [];
                            this.question_sets.forEach((set) => {
                                const selectedCards = set.extractSelectedQuesions()
                                allSelectedCards.push(...selectedCards);
                            })
                            new AnkiDeckModal(
                                this.app,
                                this.port,
                                this.deck,
                                allSelectedCards,
                            ).open();
                        })
                );
            }
            contentEl.appendChild(htmlButtons);
        } else {
            new Setting(contentEl)
                .addButton((btn) =>
                    btn
                    .setButtonText('Confirm Selection')
                    .setCta()
                    .onClick(async () => {
                        this.close();
                        const allSelectedCards: CardInformation[] = [];
                        this.question_sets.forEach((set) => {
                            const selectedCards = set.extractSelectedQuesions()
                            allSelectedCards.push(...selectedCards);
                        })
                        new AnkiDeckModal(
                            this.app,
                            this.port,
                            this.deck,
                            allSelectedCards,
                        ).open();
                    })
            );
        }
    }

    onOpen() {
        this.renderContent();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class AnkiDeckModal extends Modal {
    port: number;
    cardsToExport: CardInformation[];
    decks: string[];
    selectedDeck: string;
    isDataFetched: boolean;
    isDataError: boolean;

    constructor(
        app: App,
        port: number,
        defaultDeck: string,
        allSelectedCards: CardInformation[],
    ) {
        super(app);
        this.renderContent  = this.renderContent.bind(this);
        this.port = port;
        this.selectedDeck = defaultDeck;
        this.cardsToExport = allSelectedCards;

        this.isDataFetched = false;
    }

    async fetchData() {
        const fetchedDecks = await getAnkiDecks(this.port);
        this.decks = fetchedDecks;
        this.isDataFetched = true;


        if (this.selectedDeck === '' && fetchedDecks.length > 0) {
            this.selectedDeck = fetchedDecks[0];
        }
    }

    renderHtmlList() {
        const htmlList = createEl('ul', { cls: 'deck-options-container' });
        const convenienceButtons = createEl('div', { cls: 'deck-options__buttons' });

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
        contentEl.innerHTML = ''; // use innerHTML to reset content

        // modal title
        contentEl.createEl('h1', { text: 'Anki Decks' });

        if (!this.isDataFetched) {
            const centerContainer = contentEl.createEl('div', { cls: 'error-notice' });
            centerContainer.createEl('h4', { text: 'loading data...' });
            return;
        }
        
        if (this.decks.length === 0) {
            const centerContainer = contentEl.createEl('div', { cls: 'error-notice' });
            centerContainer.createEl('h4', { text: 'Either an error occured or no Anki decks were found' });
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
                .setButtonText('Confirm and Export')
                .setDisabled(this.selectedDeck === '')
                .setCta()
                .onClick(async () => {
                    if (this.selectedDeck === '') return;
                
                    this.close();
                    exportToAnki(
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

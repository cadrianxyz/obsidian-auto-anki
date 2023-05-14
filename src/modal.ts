import { App, Modal, Notice, Setting } from 'obsidian';
import { exportToAnki } from './utils/anki';
import { CardInformation, checkGpt, convertNotesToFlashcards } from './utils/gpt';

// TODO: REMOVE
import { SAMPLE_CARD_INFORMATION } from 'sample_card_information';

function checkValidNumGreaterThanZero(text: string|number) {
    return text != '' && !isNaN(+text) && +text > 0;
}
export class ExportModal extends Modal {
    n_q: number;
    n_q_valid: boolean;
    n_alt: number;
    data: string;
    apiKey: string;
    port: number;
    deck: string;
    
    constructor(
        app: App,
        data: string,
        openAiApiKey: string,
        ankiConnectPort: number,
        ankiDestinationDeck: string,
        dafaultNumQuestions?: number,
        defaultNumAlternatives?: number,
    ) {
        super(app);
        this.data = data;
        this.apiKey = openAiApiKey;
        this.port = ankiConnectPort;
        this.deck = ankiDestinationDeck;

        this.n_q = dafaultNumQuestions ?? 5;
        this.n_q_valid = checkValidNumGreaterThanZero(this.n_q);
        this.n_alt = defaultNumAlternatives ?? 4;
    }

    onOpen() {
        const { contentEl } = this;

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
            .addButton((btn) =>
                btn
                .setButtonText('Export')
                .setCta()
                .onClick(async () => {
                    if (!this.n_q_valid) {
                        new Notice('Not a valid number!');
                        return;
                    }
                    this.close();

                    let isRequestValid = false;
                    isRequestValid = checkGpt(this.apiKey);

                    if (!isRequestValid) return;
                    const card_sets: Array<Array<CardInformation>> = await convertNotesToFlashcards(
                        this.apiKey,
                        this.data,
                        this.n_q,
                        this.n_alt,
                    );
                    new ChoiceModal(
                        this.app,
                        card_sets,
                        // SAMPLE_CARD_INFORMATION,
                        this.port,
                        this.deck,
                        this.n_q,
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
    questions: Array<CardInformation>;
    selected: Set<number>;
    renderFunc: VoidFunction;
    
    constructor(
        questions: Array<CardInformation>,
        onChangeCallback: VoidFunction,
    ) {
        this.questions = questions;
        this.selected = new Set([]);
        
        this.renderFunc = onChangeCallback;
    }

    renderHtmlList() {
        const htmlList = createEl('ul');
        this.questions.forEach((q: CardInformation, idx: number) => {
            const htmlQuestion = createEl('li');
            htmlQuestion.appendChild(createEl('h3', { text: q.question }));
            htmlQuestion.appendChild(createEl('p', { text: q.answer }));
            if (this.selected.has(idx)) {
                htmlQuestion.style.color = 'red';
            }
            else {
                htmlQuestion.style.color = 'black';
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

    extractSelectedQuesions() {
        return this.questions.filter((val, idx) => this.selected.has(idx));
    }
}

export class ChoiceModal extends Modal {
    card_sets: Array<Array<CardInformation>>;
    question_sets: Array<QuestionSetWithSelections>;
    n_q: number;
    port: number;
    deck: string;

    curr_set: number;
    
    constructor(
        app: App,
        card_sets: Array<Array<CardInformation>>,
        port: number,
        deck: string,
        n_q: number,
    ) {
        super(app);
        this.renderContent  = this.renderContent.bind(this);

        this.card_sets = card_sets;
        this.port = port;
        this.deck = deck;

        console.log({ card_sets })

        // create question sets
        this.question_sets = [];
        this.n_q = n_q;
        for (let i = 0; i < n_q; i++) {
            const question_choices: Array<CardInformation> = [];

            card_sets.forEach((set) => {
                if (i < set.length) question_choices.push(set[i]);
            })
            this.question_sets.push(
                new QuestionSetWithSelections(question_choices, this.renderContent)
            );
        }
        this.curr_set = 0;
    }

    renderContent() {
        const { contentEl } = this;
        contentEl.innerHTML = ''; // reset content

        // modal title, description
        contentEl.createEl('h1', { text: `Question Set No. ${this.curr_set+1}` });
        contentEl.createEl('p', { text: 'Pick one or more of the questions below you want to export to Anki.' })

        // get card set to render
        const htmlList = this.question_sets[this.curr_set].renderHtmlList();
        contentEl.appendChild(htmlList);
        
        // create buttons in modal footer
        const htmlButtons = createEl('div');
        htmlButtons.className = 'modal-buttons';

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
        if (this.curr_set < this.n_q-1){
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
                    .setButtonText('Confirm')
                    .setCta()
                    .onClick(async () => {
                        this.close();
                        const allSelectedCards: Array<CardInformation> = [];
                        this.question_sets.forEach((set) => {
                            const selectedCards = set.extractSelectedQuesions()
                            allSelectedCards.push(...selectedCards);
                        })
                        console.log({ allSelectedCards });
                        // exportToAnki(
                        //     cards,
                        //     this.port,
                        //     this.deck,
                        // );
                    })
            );
        }

        contentEl.appendChild(htmlButtons);
    }

    onOpen() {
        this.renderContent();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

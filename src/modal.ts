import { App, Modal, Notice, Setting } from 'obsidian';
import { exportToAnki } from './utils/anki';

function checkValidNumGreaterThanZero(text: string|number) {
    return text != '' && !isNaN(+text) && +text > 0;
}
export class ExportModal extends Modal {
    n_q: number;
    n_q_valid: boolean;
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
    ) {
        super(app);
        this.data = data;
        this.apiKey = openAiApiKey;
        this.port = ankiConnectPort;
        this.deck = ankiDestinationDeck;

        this.n_q = dafaultNumQuestions ?? 5;
        this.n_q_valid = checkValidNumGreaterThanZero(this.n_q);
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h1', { text: 'How many cards should be exported?' });

        new Setting(contentEl)
            .setName('Number of Cards')
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
                .onClick(() => {
                    if (!this.n_q_valid) {
                        new Notice('Not a valid number!');
                        return;
                    }
                    this.close();
                    exportToAnki(
                        this.data,
                        this.apiKey,
                        this.port,
                        this.deck,
                        this.n_q,
                    );
                })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}


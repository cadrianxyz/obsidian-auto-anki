import { App, Modal, Setting } from "obsidian";
import { exportToAnki } from "./utils/anki";

export class ExportModal extends Modal {
    n_q: number;
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
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl("h1", { text: "How many cards should be exported?" });

        new Setting(contentEl)
            .setName("Number of Cards")
            .addText((text) =>
                text.onChange((value) => {
                    this.n_q = Number(value)
                })
            );

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                .setButtonText("Export")
                .setCta()
                .onClick(() => {
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


import { Modal, Notice, type App } from 'obsidian';
import { getAnkiDecks, pinDeck } from '../../anki/decks';
import { renderDeckPicker } from './deck-picker';

/** Picks the default deck from the decks Anki has now. Choosing one saves it and closes the dialog. */
export class DefaultDeckModal extends Modal {
	private decks: string[] = [];
	private query = '';
	private error = '';

	constructor(app: App, private readonly address: string, private readonly current: string,
		private readonly save: (deck: string) => Promise<void>) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.classList.add('auto-anki-picker');
		this.titleEl.setText('Default deck');
		this.contentEl.createEl('p', { cls: 'setting-item-description', text: 'Loading decks from Anki…' });
		try {
			this.decks = pinDeck(await getAnkiDecks(this.address), this.current);
			if (!this.decks.length) this.error = 'Your Anki collection has no decks. Create one in Anki first.';
		}
		catch (error) {
			this.error = error instanceof Error ? error.message : 'Could not read Anki decks.';
			new Notice(this.error);
		}
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		if (!this.decks.length) {
			this.contentEl.createEl('p', { text: this.error });
			return;
		}
		this.contentEl.createEl('p', { text: 'New notes start in this deck in the export dialog. You can still choose another deck there each time.' });
		renderDeckPicker(this.contentEl, this.decks, {
			selected: this.current,
			query: this.query,
			onQuery: query => { this.query = query; },
			onSelect: deck => { void this.choose(deck); },
		});
	}

	private async choose(deck: string): Promise<void> {
		await this.save(deck);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

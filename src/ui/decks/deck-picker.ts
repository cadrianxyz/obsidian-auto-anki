import { filterDecks } from '../../anki/decks';

export interface DeckPickerOptions {
	selected: string;
	/** The search text, kept by the caller so it survives a re-render after a choice. */
	query: string;
	create?: string;
	defaultDeck?: string;
	locked?(): boolean;
	onQuery(query: string): void;
	onSelect(deck: string): void;
}

/** A search box above a scrollable list of decks. Used by the export dialog and the default-deck picker. */
export function renderDeckPicker(parent: HTMLElement, decks: readonly string[], options: DeckPickerOptions): void {
	const search = parent.createEl('input', { cls: 'deck-search' });
	search.type = 'search';
	search.placeholder = 'Search decks';
	search.setAttribute('aria-label', 'Search decks');
	search.value = options.query;
	const choices = options.create ? [options.create, ...decks] : decks;
	const list = parent.createEl('ul', { cls: 'deck-options-container' });
	let selected = options.selected;
	let items = new Map<string, HTMLElement>();

	// Restyle the items in place, so choosing a deck does not reset the list's scroll position.
	const highlight = (): void => {
		for (const [deck, item] of items) item.className = deck === selected ? 'deck-option --selected' : 'deck-option';
	};
	const fill = (query: string): void => {
		list.empty();
		items = new Map();
		const matches = filterDecks(choices, query);
		if (!matches.length) {
			list.createEl('li', { cls: 'deck-search-empty', text: 'No decks match your search.' });
			return;
		}
		for (const deck of matches) {
			const item = list.createEl('li');
			const select = (): void => {
				if (options.locked?.()) return;
				selected = deck;
				highlight();
				options.onSelect(deck);
			};
			item.createEl('h3', { text: deck });
			item.onclick = select;
			const badge = deck === options.create ? 'Create New Deck' : deck === options.defaultDeck ? 'Default' : undefined;
			if (badge) item.createSpan({ cls: 'auto-anki-deck-badge', text: badge });
			items.set(deck, item);
		}
		highlight();
	};
	search.oninput = () => {
		options.onQuery(search.value);
		fill(search.value);
	};
	fill(options.query);
}

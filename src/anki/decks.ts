import { AnkiClient } from './client';

/** Anki's built-in deck. It exists in every collection, so it is the first fallback. */
export const ANKI_DEFAULT_DECK = 'Default';

/** Fetching the deck list also checks the connection and AnkiConnect's response. */
export async function getAnkiDecks(url: string): Promise<string[]> {
	const result = await new AnkiClient(url).invoke('deckNames');
	if (!Array.isArray(result) || result.some(deck => typeof deck !== 'string' || !deck.trim())) {
		throw new Error('Anki returned an unreadable deck list.');
	}
	return result as string[];
}

export interface DeckChoice {
	deck: string;
	/** True when the requested deck is not in Anki, so another deck was chosen instead. */
	replaced: boolean;
}

/** Keep the requested deck when Anki still has it; otherwise use Anki's Default deck, or the first deck. */
export function chooseDeck(decks: readonly string[], requested: string): DeckChoice {
	if (decks.includes(requested)) return { deck: requested, replaced: false };
	const fallback = decks.includes(ANKI_DEFAULT_DECK) ? ANKI_DEFAULT_DECK : (decks[0] ?? '');
	return { deck: fallback, replaced: true };
}

/** Case-insensitive search over the full deck name, so `Biology` finds `Obsidian::Biology::Cells`. */
export function filterDecks(decks: readonly string[], query: string): string[] {
	const search = query.trim().toLocaleLowerCase();
	return search ? decks.filter(deck => deck.toLocaleLowerCase().includes(search)) : [...decks];
}

/** Move one deck to the top and keep the rest in Anki's order. Used once when a picker opens, so the list does not jump. */
export function pinDeck(decks: readonly string[], deck: string): string[] {
	return decks.includes(deck) ? [deck, ...decks.filter(other => other !== deck)] : [...decks];
}

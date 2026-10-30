import { AnkiClient } from './client';

/** Fetching the deck list also checks the connection and AnkiConnect's response. */
export async function getAnkiDecks(url: string): Promise<string[]> {
	const result = await new AnkiClient(url).invoke('deckNames');
	if (!Array.isArray(result) || result.some(deck => typeof deck !== 'string' || !deck.trim())) {
		throw new Error('Anki returned an unreadable deck list.');
	}
	return result as string[];
}

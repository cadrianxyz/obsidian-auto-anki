import { Notice, requestUrl } from 'obsidian';

import {
    CardInformation,
    convertNotesToFlashcards,
} from './gpt';

const ANKI_VERSION = 6;
// const ANKI_DEFAULT_DECK = 'Default';
export const ANKI_CONNECT_DEFAULT_PORT = 8765;

async function getAnkiDeck(ankiPort: number, deck: string) {
    let res;
    try {
        res = await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'deckNames',
                version: ANKI_VERSION,
                params: {},
            }),
            throw: true,
        });
    }
    catch (err) {
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return '';
    }

    const decks = res.json.result as Array<string>;
    // use default deck if not specified
    if (deck === '' && decks.length > 0) {
        new Notice(`Anki deck name not specified in settings. Using existing deck: '${decks[0]}'`);
        return decks[0];
    }

    const hasDeck = decks.some(d => deck.toLowerCase() === d.toLowerCase());
    if (hasDeck) return deck;
    else {
        new Notice("ERR: Specified anki deck not found! Please go to your 'Simple Recall' settings to set an appropriate existing deck.");
        return '';
    }
}

async function addCardsToAnki(ankiPort: number, deck: string, data: Array<CardInformation>) {
    // for anki connect, the request format is (https://foosoft.net/projects/anki-connect/)
    const ankiRequestData = data.map((card) => ({
        'deckName': deck,
        'modelName': 'Basic',
        'fields': {
            'Front': card.question,
            'Back': card.answer,
        },
        'tags': [
            'auto-gpt-imported'
        ],
    }));
    try {
        const res = await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'addNotes',
                version: ANKI_VERSION,
                params: {
                    'notes': ankiRequestData,
                }
        }),
            throw: true,
        });
        return res.json.result ?? [];
    }
    catch (err) {
        new Notice(`ERR: Could not add cards to Anki!\n${err}`);
        return [];
    }
}

export async function exportToAnki(data: string, openAiKey: string, port: number, deck: string, numCards: number) {
    // check anki connection and deck
    const d = await getAnkiDeck(port, deck);
    if (d === '') return false;

    // check gpt api key
    if (openAiKey === '') {
        new Notice("ERR: OpenAI API key not provided! Please go to your 'Simple Recall' settings to set an API key.")
    }

    // turn note into Q&A format using GPT
    const cards: Array<CardInformation> = await convertNotesToFlashcards(openAiKey, data, numCards);
    const ankiRes: Array<number> = await addCardsToAnki(port, d, cards);
    if (ankiRes.length > 0) new Notice(`Successfully exported ${ankiRes.length} cards to Anki!`)
    return true;
}

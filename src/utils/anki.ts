import { Notice, requestUrl } from 'obsidian';

import { CardInformation } from './gpt';

const ANKI_VERSION = 6;
// const ANKI_DEFAULT_DECK = 'Default';
export const ANKI_CONNECT_DEFAULT_PORT = 8765;

export async function checkAnkiAvailability(ankiPort: number) {
    try {
        await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'deckNames',
                version: ANKI_VERSION,
                params: {},
            }),
            throw: true,
        });
        return true;
    }
    catch (err) {
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return false;
    }
}

async function addCardsToAnki(ankiPort: number, deck: string, data: CardInformation[]) {
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
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return [];
    }
}

export async function getAnkiDecks(ankiPort: number) {
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
        return [];
    }
    return res.json.result as string[];
}

export async function checkAnkiDecksExist(ankiPort: number) {
    const decks = await getAnkiDecks(ankiPort);
    if (decks.length == 0) {
        new Notice('Your anki account has no decks. Create a new one before using!')
        return false;
    }

    return true;
}

export async function exportToAnki(cards: CardInformation[], port: number, deck: string) {
    // turn note into Q&A format using GPT
    const ankiRes: number[] = await addCardsToAnki(port, deck, cards);
    if (ankiRes.length > 0) new Notice(`Successfully exported ${ankiRes.length} card(s) to Anki!`)
    return true;
}

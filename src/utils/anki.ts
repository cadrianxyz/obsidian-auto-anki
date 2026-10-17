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

interface AnkiActionResult<T> {
    result: T | null;
    error: string | null;
}

interface AddCardsOutcome {
    added: number;
    errors: string[];
}

// One addNote per card inside a single `multi` request, so every card gets its own
// result. With addNotes, a refused card is either counted as exported (older
// AnkiConnect) or fails the whole batch (newer AnkiConnect).
async function addCardsToAnki(ankiPort: number, deck: string, data: CardInformation[]): Promise<AddCardsOutcome | null> {
    // for anki connect, the request format is (https://foosoft.net/projects/anki-connect/)
    const actions = data.map((card) => ({
        action: 'addNote',
        // Without its own version, a sub-action is answered in the old v4 format.
        version: ANKI_VERSION,
        params: {
            note: {
                'deckName': deck,
                'modelName': 'Basic',
                'fields': {
                    'Front': card.q,
                    'Back': card.a,
                },
                'tags': [
                    'auto-gpt-imported'
                ],
            },
        },
    }));
    let res;
    try {
        res = await requestUrl({
            method: 'POST',
            url: `http://127.0.0.1:${ankiPort}`,
            body: JSON.stringify({
                action: 'multi',
                version: ANKI_VERSION,
                params: { actions },
            }),
            throw: true,
        });
    }
    catch (err) {
        new Notice(`ERR: Could not connect to Anki! Please ensure you have Anki Connect running on port ${ankiPort}.`);
        return null;
    }

    if (res.json?.error) {
        new Notice(`ERR: Anki refused the export: ${res.json.error}`);
        return null;
    }
    const results: Array<AnkiActionResult<number> | number | null> = res.json?.result ?? [];
    const outcome: AddCardsOutcome = { added: 0, errors: [] };
    results.forEach((r) => {
        if (typeof r === 'number') outcome.added += 1;
        else if (r?.error) outcome.errors.push(r.error);
        else if (r?.result != null) outcome.added += 1;
        else outcome.errors.push('unknown error');
    });
    return outcome;
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
    const outcome = await addCardsToAnki(port, deck, cards);
    if (outcome == null) return false;

    const refused = outcome.errors.length;
    if (refused === 0) {
        new Notice(`Successfully exported ${outcome.added} card(s) to Anki!`);
        return true;
    }
    // Same reason for every card (e.g. a missing note type) is shown once.
    const reasons = [...new Set(outcome.errors)].slice(0, 3).join('\n');
    new Notice(`Exported ${outcome.added} of ${cards.length} card(s) to Anki. Anki refused ${refused}:\n${reasons}`, 0);
    return outcome.added > 0;
}

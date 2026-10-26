import { Notice, requestUrl } from 'obsidian';

import type { CardInformation } from '../generate/result';

const ANKI_VERSION = 6;
// const ANKI_DEFAULT_DECK = 'Default';
export const ANKI_CONNECT_DEFAULT_PORT = 8765;

// Legacy callers supply a port; the 1.0 settings store supplies a complete URL.
function ankiConnectUrl(address: number | string): string {
    return typeof address === 'number' ? `http://127.0.0.1:${address}` : address;
}

export async function checkAnkiAvailability(ankiPort: number | string) {
    try {
        await requestUrl({
            method: 'POST',
            url: ankiConnectUrl(ankiPort),
            body: JSON.stringify({
                action: 'deckNames',
                version: ANKI_VERSION,
                params: {},
            }),
            throw: true,
        });
        return true;
    }
    catch {
        new Notice(`ERR: Could not connect to Anki! Please ensure AnkiConnect is running at ${ankiConnectUrl(ankiPort)}.`);
        return false;
    }
}

// Every AnkiConnect reply has this shape. It arrives as untyped JSON, so it's checked
// before use rather than trusted.
interface AnkiConnectReply {
    result?: unknown;
    error?: unknown;
}

function readReply(json: unknown): AnkiConnectReply {
    return json !== null && typeof json === 'object' ? json : {};
}

// AnkiConnect's errors are normally strings, but they arrive untyped.
function describeError(error: unknown): string {
    return typeof error === 'string' ? error : JSON.stringify(error);
}

interface AddCardsOutcome {
    added: number;
    errors: string[];
}

// This export path handles text cards. Preserve literal comparisons/code instead
// of allowing Anki to interpret generated text as raw HTML. Rich Markdown/math
// rendering belongs to the forthcoming Anki renderer.
function textField(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
}

// One addNote per card inside a single `multi` request, so every card gets its own
// result. With addNotes, a refused card is either counted as exported (older
// AnkiConnect) or fails the whole batch (newer AnkiConnect).
async function addCardsToAnki(ankiPort: number | string, deck: string, data: CardInformation[]): Promise<AddCardsOutcome | null> {
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
                    'Front': textField(card.q),
                    'Back': textField(card.a),
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
            url: ankiConnectUrl(ankiPort),
            body: JSON.stringify({
                action: 'multi',
                version: ANKI_VERSION,
                params: { actions },
            }),
            throw: true,
        });
    }
    catch {
        new Notice(`ERR: Could not connect to Anki! Please ensure AnkiConnect is running at ${ankiConnectUrl(ankiPort)}.`);
        return null;
    }

    const reply = readReply(res.json);
    if (reply.error) {
        new Notice(`ERR: Anki refused the export: ${describeError(reply.error)}`);
        return null;
    }
    const results: unknown[] = Array.isArray(reply.result) ? reply.result : [];
    const outcome: AddCardsOutcome = { added: 0, errors: [] };
    results.forEach((r) => {
        // A bare note ID means success (the old reply format); otherwise it's { result, error }.
        if (typeof r === 'number') { outcome.added += 1; return; }
        const item = readReply(r);
        if (item.error) outcome.errors.push(describeError(item.error));
        else if (item.result != null) outcome.added += 1;
        else outcome.errors.push('unknown error');
    });
    return outcome;
}

export async function getAnkiDecks(ankiPort: number | string) {
    let res;
    try {
        res = await requestUrl({
            method: 'POST',
            url: ankiConnectUrl(ankiPort),
            body: JSON.stringify({
                action: 'deckNames',
                version: ANKI_VERSION,
                params: {},
            }),
            throw: true,
        });
    }
    catch {
        new Notice(`ERR: Could not connect to Anki! Please ensure AnkiConnect is running at ${ankiConnectUrl(ankiPort)}.`);
        return [];
    }
    const reply = readReply(res.json);
    return Array.isArray(reply.result)
        ? reply.result.filter((deck): deck is string => typeof deck === 'string')
        : [];
}

export async function checkAnkiDecksExist(ankiPort: number | string) {
    const decks = await getAnkiDecks(ankiPort);
    if (decks.length == 0) {
        new Notice('Your Anki collection has no decks. Create one in Anki first.')
        return false;
    }

    return true;
}

export async function exportToAnki(cards: CardInformation[], port: number | string, deck: string) {
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

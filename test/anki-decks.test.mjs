// Deck choice rules, deck search, and the Default deck picker in settings.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDeck, filterDecks, pinDeck, rankDecks, ANKI_DEFAULT_DECK } from '../src/anki/decks';
import { resolveDeckTemplate } from '../src/anki/deck-template';
import { DefaultDeckModal } from '../src/ui/decks/default-deck-modal';
import { ankiServer, resetAll } from './helpers.mjs';

beforeEach(resetAll);

describe('deck templates and match ranking', () => {
	const source = { vault: 'My Vault', path: 'Computer Science/OS & Tools/Week 1/Scheduling.md', title: 'Scheduling' };

	test('maps only folder path separators when expanding the full folder path', () => {
		assert.deepEqual(resolveDeckTemplate('{{vault}}::{{folder}}::{{note}}', source), {
			deck: 'My Vault::Computer Science::OS & Tools::Week 1::Scheduling',
		});
	});

	test('uses only the immediate parent folder for lastFolder', () => {
		assert.deepEqual(resolveDeckTemplate('{{vault}}::{{lastFolder}}', source), { deck: 'My Vault::Week 1' });
		assert.deepEqual(resolveDeckTemplate('{{lastFolder}}', { ...source, path: 'OS & Tools/Scheduling.md' }), { deck: 'OS & Tools' });
	});

	test('omits an empty root folder level and treats a blank template as off', () => {
		const root = { ...source, path: 'Scheduling.md' };
		assert.deepEqual(resolveDeckTemplate('{{vault}}::{{folder}}::{{note}}', root), { deck: 'My Vault::Scheduling' });
		assert.deepEqual(resolveDeckTemplate('{{folder}}', root), {});
		assert.deepEqual(resolveDeckTemplate('{{vault}}::{{lastFolder}}::{{note}}', root), { deck: 'My Vault::Scheduling' });
		assert.deepEqual(resolveDeckTemplate('{{lastFolder}}', root), {});
		assert.deepEqual(resolveDeckTemplate(' ', source), {});
	});

	test('reports malformed placeholders and empty deck levels', () => {
		assert.match(resolveDeckTemplate('{{author}}', source).error, /Unknown.*author/);
		assert.match(resolveDeckTemplate('{{folder}', source).error, /double braces/);
		assert.match(resolveDeckTemplate('A::::B', source).error, /blank levels/);
		assert.match(resolveDeckTemplate('A\nB', source).error, /control characters/);
	});

	test('ranks distinct whole words case-insensitively with stable ties', () => {
		const decks = ['Operating', 'Systems', 'Operating::Systems', 'Default', 'Activities'];
		assert.deepEqual(rankDecks(decks, 'OPERATING systems, systemS! Reactivities'), [decks[2], decks[0], decks[1], decks[3], decks[4]]);
	});
});

describe('deck choice and search', () => {
	test('a deck Anki still has is kept', () => {
		assert.deepEqual(chooseDeck(['Default', 'Biology'], 'Biology'), { deck: 'Biology', replaced: false });
	});

	test('a missing deck is replaced by Anki\'s Default deck when it exists', () => {
		assert.deepEqual(chooseDeck(['Languages', 'Default'], 'Gone'), { deck: ANKI_DEFAULT_DECK, replaced: true });
	});

	test('without a Default deck, the first deck is used', () => {
		assert.deepEqual(chooseDeck(['Languages', 'Biology'], 'Gone'), { deck: 'Languages', replaced: true });
	});

	test('an empty collection gives no deck', () => {
		assert.deepEqual(chooseDeck([], 'Default'), { deck: '', replaced: true });
	});

	test('pinning moves one deck to the top and keeps the rest in order', () => {
		assert.deepEqual(pinDeck(['Default', 'Biology', 'Chemistry'], 'Chemistry'), ['Chemistry', 'Default', 'Biology']);
		assert.deepEqual(pinDeck(['Default', 'Biology'], 'Gone'), ['Default', 'Biology']);
	});

	test('search is case-insensitive over the full name, and blank search lists everything', () => {
		const decks = ['Default', 'Obsidian::Biology::Cells', 'Languages'];
		assert.deepEqual(filterDecks(decks, ' cells '), ['Obsidian::Biology::Cells']);
		assert.deepEqual(filterDecks(decks, 'OBSIDIAN'), ['Obsidian::Biology::Cells']);
		assert.deepEqual(filterDecks(decks, '  '), decks);
		assert.deepEqual(filterDecks(decks, 'nothing'), []);
	});
});

describe('Default deck picker in settings', () => {
	test('choosing a deck saves it and closes the picker', async () => {
		ankiServer({ decks: ['Default', 'Biology', 'Chemistry'] });
		const saved = [];
		const modal = new DefaultDeckModal({}, 'http://127.0.0.1:8765', 'Default', async deck => { saved.push(deck); });
		modal.open();
		await modal.opened;
		const item = modal.contentEl.all().filter((e) => e.tagName === 'li').find((li) => li.children[0].text === 'Biology');
		item.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(saved, ['Biology']);
		assert.equal(modal.isOpen, false);
	});

	test('when Anki has no decks, the picker says so and saves nothing', async () => {
		ankiServer({ decks: [] });
		const saved = [];
		const modal = new DefaultDeckModal({}, 'http://127.0.0.1:8765', 'Default', async deck => { saved.push(deck); });
		modal.open();
		await modal.opened;
		assert.ok(modal.contentEl.all().some((e) => e.textContent?.includes('no decks')));
		assert.deepEqual(saved, []);
	});
});

import { AnkiClient } from './client';
import { revalidateDestinations, type AnkiDestinations } from './note-types';
import { validateGeneratedNote, type GeneratedAnkiNote } from '../generate/result';
import { asRecord } from '../utils/data';
import { renderAnkiField } from './render';

export interface AnkiExportOutcome { added: number; errors: string[]; remaining: GeneratedAnkiNote[] }

export async function addNotesToAnki(notes: readonly GeneratedAnkiNote[], snapshot: AnkiDestinations, deck: string): Promise<AnkiExportOutcome> {
	if (!notes.length) return { added: 0, errors: [], remaining: [] };
	const payloads = notes.map(note => {
		if (!validateGeneratedNote(note, snapshot.types)) throw new Error('A note has invalid fields or content. Return to review before exporting.');
		return { deckName: deck, modelName: note.noteType, fields: Object.fromEntries(Object.entries(note.fields).map(([name, value]) => [name, renderAnkiField(value)])), tags: ['auto-gpt-imported'] };
	});
	await revalidateDestinations(snapshot, notes.map(note => note.noteType));
	const client = new AnkiClient(snapshot.url);
	const allowed = await client.invoke('canAddNotes', { notes: payloads });
	if (!Array.isArray(allowed) || allowed.length !== notes.length || allowed.some(value => typeof value !== 'boolean')) throw new Error('Anki returned an unreadable eligibility check. No notes were added.');
	const outcome: AnkiExportOutcome = { added: 0, errors: [], remaining: [] };
	const accepted = notes.map((note, index) => ({ note, index })).filter(({ index }) => allowed[index]);
	const failures = new Map<number, string>();
	allowed.forEach((canAdd, index) => { if (!canAdd) failures.set(index, `${notes[index].noteType}: Anki cannot add this note (it may be a duplicate or have an empty required field).`); });
	if (accepted.length) {
		const actions = accepted.map(({ index }) => ({ action: 'addNote', version: 6, params: { note: payloads[index] } }));
		const response = await client.invoke('multi', { actions });
		if (!Array.isArray(response)) throw new Error('Anki returned an unreadable export result. Check Anki before retrying.');
		accepted.forEach(({ index }, position) => {
			const value: unknown = response[position];
			const item = asRecord(value);
			const id = typeof value === 'number' ? value : item.error === null ? item.result : undefined;
			if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) outcome.added++;
			else failures.set(index, typeof item.error === 'string' ? item.error : 'Anki did not confirm that this note was added. Check Anki before retrying.');
		});
	}
	notes.forEach((note, index) => { const error = failures.get(index); if (error) { outcome.remaining.push(note); outcome.errors.push(error); } });
	return outcome;
}

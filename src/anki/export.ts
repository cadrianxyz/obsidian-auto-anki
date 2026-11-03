import { AnkiClient } from './client';
import { revalidateDestinations, type AnkiDestinations } from './note-types';
import { imageIdsIn, validateGeneratedNote, type GeneratedAnkiNote } from '../generate/result';
import { asRecord } from '../utils/data';
import { renderAnkiField } from './render';
import { ankiMediaName, storeAnkiMedia } from './media';
import type { Diagram } from '../source-note/images';

export interface AnkiExportOutcome { added: number; errors: string[]; remaining: GeneratedAnkiNote[] }

/** `tags` are added to every new note, as given; they're built and cleaned in tags.ts. */
export async function addNotesToAnki(notes: readonly GeneratedAnkiNote[], snapshot: AnkiDestinations, deck: string, diagrams: readonly Diagram[], tags: readonly string[]): Promise<AnkiExportOutcome> {
	if (!notes.length) return { added: 0, errors: [], remaining: [] };
	const diagramById = new Map(diagrams.map(diagram => [diagram.path, diagram]));
	const prepared = await Promise.all(notes.map(async note => {
		if (!validateGeneratedNote(note, snapshot.types, new Set(diagramById.keys()))) throw new Error('A note has invalid fields or content. Return to review before exporting.');
		// Each image's file name comes from its bytes, so it is known before anything is stored.
		const files = new Map<string, { name: string; diagram: Diagram }>();
		for (const id of imageIdsIn(note.fields)) {
			const diagram = diagramById.get(id)!;
			files.set(id, { name: await ankiMediaName(diagram), diagram });
		}
		const fields = Object.fromEntries(Object.entries(note.fields).map(([name, value]) => [name, renderAnkiField(value, new Map([...files].map(([id, file]) => [id, file.name])))]));
		return { files, payload: { deckName: deck, modelName: note.noteType, fields, tags: [...tags] } };
	}));
	await revalidateDestinations(snapshot, notes.map(note => note.noteType));
	const client = new AnkiClient(snapshot.url);
	const payloads = prepared.map(item => item.payload);
	const allowed = await client.invoke('canAddNotes', { notes: payloads });
	if (!Array.isArray(allowed) || allowed.length !== notes.length || allowed.some(value => typeof value !== 'boolean')) throw new Error('Anki returned an unreadable eligibility check. No notes were added.');
	const outcome: AnkiExportOutcome = { added: 0, errors: [], remaining: [] };
	const failures = new Map<number, string>();
	allowed.forEach((canAdd, index) => { if (!canAdd) failures.set(index, `${notes[index].noteType}: Anki cannot add this note (it may be a duplicate or have an empty required field).`); });
	// Images are stored only for notes Anki will accept, so a refused note leaves no media behind.
	const storedFiles = new Map<string, string | undefined>();
	for (const [index, canAdd] of allowed.entries()) {
		if (!canAdd) continue;
		for (const { name, diagram } of prepared[index].files.values()) {
			if (!storedFiles.has(name)) {
				try { await storeAnkiMedia(client, name, diagram.stored.base64); storedFiles.set(name, undefined); }
				catch (error) { storedFiles.set(name, error instanceof Error ? error.message : 'Anki could not store the image.'); }
			}
			const problem = storedFiles.get(name);
			if (problem) failures.set(index, `${notes[index].noteType}: ${problem}`);
		}
	}
	const eligible = allowed as boolean[];
	const ready = eligible.map((canAdd, index) => ({ canAdd, index })).filter(({ canAdd, index }) => canAdd && !failures.has(index));
	if (ready.length) {
		const actions = ready.map(({ index }) => ({ action: 'addNote', version: 6, params: { note: payloads[index] } }));
		const response = await client.invoke('multi', { actions });
		if (!Array.isArray(response)) throw new Error('Anki returned an unreadable export result. Check Anki before retrying.');
		ready.forEach(({ index }, position) => {
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

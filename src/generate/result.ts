import { asRecord } from '../utils/data';
import { validCloze } from '../anki/validation/cloze';
import { clozeFields, type AnkiDestinations, type AnkiNoteType } from '../anki/note-types';

/** One generated entry becomes one Anki note; its templates may create multiple cards. */
export interface GeneratedAnkiNote { noteType: string; fields: Record<string, string> }
export interface GenerationResult { notes: GeneratedAnkiNote[]; noteIssues: string[]; warnings: string[] }
export type NoteResponseSchema = Record<string, unknown>;

/** Each alternative binds a permitted type to its exact fields, including intentional blanks. */
export function noteResponseSchema(destinations: AnkiDestinations): NoteResponseSchema {
	return {
		type: 'object', additionalProperties: false,
		properties: {
			notes: { type: 'array', items: { anyOf: destinations.types.map(type => ({
				type: 'object', additionalProperties: false,
				properties: {
					noteType: { type: 'string', enum: [type.name] },
					fields: { type: 'object', additionalProperties: false, properties: Object.fromEntries(type.fields.map(field => [field, { type: 'string' }])), required: type.fields },
				}, required: ['noteType', 'fields'],
			})) } },
			note_issues: { type: 'array', items: { type: 'string' } },
		}, required: ['notes', 'note_issues'],
	};
}

// An image placeholder names one of the diagrams sent with the note.
const IMAGE_PLACEHOLDER = /\{\{image:([^{}\n]+)\}\}/g;

/** The diagram IDs a note's fields use, each listed once. */
export function imageIdsIn(fields: Readonly<Record<string, string>>): string[] {
	return [...new Set(Object.values(fields).flatMap(value => [...value.matchAll(IMAGE_PLACEHOLDER)].map(match => match[1])))];
}

/** True when a field uses an image that was not sent, or any other image syntax. */
function hasUnsupportedImage(value: string, diagramIds: ReadonlySet<string>): boolean {
	for (const [, id] of value.matchAll(IMAGE_PLACEHOLDER)) if (!diagramIds.has(id)) return true;
	return /\{\{image:|!\[|<(?:img|audio|video|source)\b|\[sound:/i.test(value.replace(IMAGE_PLACEHOLDER, ''));
}

/** Validate both provider replies and notes about to be exported, never trusting schema alone. */
export function validateGeneratedNote(value: unknown, types: readonly AnkiNoteType[], diagramIds: ReadonlySet<string>): GeneratedAnkiNote | null {
	const note = asRecord(value);
	if (Object.keys(note).some(key => key !== 'noteType' && key !== 'fields')) return null;
	const type = types.find(type => type.name === note.noteType);
	if (!type) return null;
	const fields = asRecord(note.fields);
	if (Object.keys(fields).length !== type.fields.length || !type.fields.every(field => Object.prototype.hasOwnProperty.call(fields, field) && typeof fields[field] === 'string')) return null;
	const values = type.fields.map(field => fields[field] as string);
	// Anki requires the first field to contain content; other fields may be intentionally blank.
	if (!values[0].trim() || values.some(value => hasUnsupportedImage(value, diagramIds))) return null;
	const cloze = clozeFields(type);
	let hasCloze = false;
	for (const field of type.fields) {
		const value = fields[field] as string;
		if (!/\{\{c/i.test(value)) continue;
		if (!cloze.includes(field) || !validCloze(value)) return null;
		hasCloze = true;
	}
	if (cloze.length && !hasCloze) return null;
	return { noteType: type.name, fields: Object.fromEntries(type.fields.map(field => [field, fields[field] as string])) };
}

/** Invalid entries are reported and excluded; no invented fields or types reach Anki. */
export function parseGeneratedNotes(content: string, maximumNotes: number | undefined, destinations: AnkiDestinations, diagramIds: ReadonlySet<string>): GenerationResult {
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch { throw new Error("The model's reply wasn't in the expected format, so no Anki notes were made. Try again or choose another model."); }
	const root = asRecord(parsed);
	if (Object.keys(root).some(key => key !== 'notes' && key !== 'note_issues') || !Array.isArray(root.notes) || !Array.isArray(root.note_issues) || !root.note_issues.every((issue: unknown) => typeof issue === 'string')) throw new Error("The model's reply wasn't in the expected format, so no Anki notes were made. Try again or choose another model.");
	const result: GenerationResult = { notes: [], noteIssues: root.note_issues, warnings: [] };
	for (const [index, value] of root.notes.entries()) {
		const note = validateGeneratedNote(value, destinations.types, diagramIds);
		if (!note) { result.warnings.push(`Note ${index + 1} was skipped because its type, fields or content are invalid for this run.`); continue; }
		if (maximumNotes !== undefined && result.notes.length >= maximumNotes) { result.warnings.push(`Note ${index + 1} was skipped because it exceeds the maximum of ${maximumNotes}.`); continue; }
		result.notes.push(note);
	}
	return result;
}

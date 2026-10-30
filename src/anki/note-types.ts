import { AnkiClient, AnkiConnectError } from './client';
import { asRecord } from '../utils/data';
import type { PluginSettings } from '../settings/schema';

export interface NoteTemplate { name: string; front: string; back: string }
export interface AnkiNoteType {
	name: string;
	id: number | null;
	fields: string[];
	templates: NoteTemplate[];
	descriptions: Record<string, string>;
	problem?: string;
}
/** Captured for a run; settings edits cannot redirect notes already under review. */
export interface AnkiDestinations {
	url: string;
	types: AnkiNoteType[];
	problems: string[];
}

export async function readNoteTypeNames(client: AnkiClient): Promise<Map<string, number | null>> {
	try {
		const result = await client.invoke('modelNamesAndIds');
		const entries = Object.entries(asRecord(result));
		if (result === null || typeof result !== 'object' || Array.isArray(result) || entries.some(([name, id]) => !name.trim() || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) throw new Error('Anki returned an unreadable note-type list.');
		return new Map(entries as [string, number][]);
	}
	catch (error) {
		if (!(error instanceof AnkiConnectError) || !error.unsupported) throw error;
		const names = await client.invoke('modelNames');
		if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim())) throw new Error('Anki returned an unreadable note-type list.');
		return new Map((names as string[]).map(name => [name, null]));
	}
}

/** Field descriptions are optional on older AnkiConnect installations. */
async function optionalRead(client: AnkiClient, action: string, name: string): Promise<unknown> {
	try { return await client.invoke(action, { modelName: name }); }
	catch (error) { if (error instanceof AnkiConnectError && error.unsupported) return undefined; throw error; }
}

export async function readNoteType(client: AnkiClient, name: string, id: number | null): Promise<AnkiNoteType> {
	const [fields, templates, descriptions] = await Promise.all([
		client.invoke('modelFieldNames', { modelName: name }), client.invoke('modelTemplates', { modelName: name }),
		optionalRead(client, 'modelFieldDescriptions', name),
	]);
	if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string' || !field.trim()) || new Set(fields).size !== fields.length) throw new Error(`${name}: Anki returned invalid field names.`);
	const parsed: NoteTemplate[] = [];
	for (const [templateName, value] of Object.entries(asRecord(templates))) {
		const template = asRecord(value);
		if (typeof template.Front !== 'string' || typeof template.Back !== 'string') throw new Error(`${name}: Anki returned an unreadable card template.`);
		parsed.push({ name: templateName, front: template.Front, back: template.Back });
	}
	if (!parsed.length) throw new Error(`${name}: no readable card templates were found.`);
	const fieldDescriptions: Record<string, string> = Object.fromEntries((fields as string[]).flatMap((field, index) =>
		Array.isArray(descriptions) && typeof descriptions[index] === 'string' ? [[field, descriptions[index]]] : []));
	return { name, id, fields: [...fields as string[]], templates: parsed, descriptions: fieldDescriptions };
}

const SPECIAL_TEMPLATE_FIELDS = new Set(['FrontSide', 'Tags', 'Type', 'Deck', 'Subdeck', 'Card', 'CardFlag']);

/** Check field references, including conditional sections, without assigning field meanings. */
function verifyTemplateFields(template: string, fields: readonly string[]): void {
	for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
		const parts = match[1].replace(/^[#^/]/, '').split(':');
		const name = parts[parts.length - 1];
		if (!fields.includes(name)) {
			if (SPECIAL_TEMPLATE_FIELDS.has(name)) continue;
			throw new Error(`Its template refers to an unknown field, “${name}”. Repair the template in Anki before using this type.`);
		}
	}
}

/** Validate text-generation support without assigning semantic roles to any fields. */
export function verifyNoteType(noteType: AnkiNoteType): void {
	if (noteType.problem) throw new Error(noteType.problem);
	if (!noteType.fields.length || !noteType.templates.length) throw new Error(`${noteType.name}: fields or templates are unavailable.`);
	for (const template of noteType.templates) {
		const source = `${template.front}\n${template.back}`;
		if (/image-occlusion/i.test(source)) throw new Error(`${noteType.name}: image occlusion is not supported yet.`);
		if (/<(?:img|audio|video|source)\b[^>]*(?:src|srcset)\s*=\s*["'][^"']*\{\{|\[sound:[^\]]*\{\{/i.test(source)) throw new Error(`${noteType.name}: this template needs generated media filenames, which are not supported yet.`);
		verifyTemplateFields(template.front, noteType.fields);
		verifyTemplateFields(template.back, noteType.fields);
	}
}

/** Only selected, readable and supported types are sent to the AI. */
export function getDestinations(anki: PluginSettings['anki'], types: readonly AnkiNoteType[]): AnkiDestinations {
	const result: AnkiDestinations = { url: anki.url, types: [], problems: [] };
	for (const name of anki.enabledNoteTypes) {
		try {
			const type = types.find(type => type.name === name);
			if (!type) throw new Error(`${name}: unavailable in Anki. Your selection is kept.`);
			verifyNoteType(type);
			result.types.push(type);
		}
		catch (error) { result.problems.push(error instanceof Error ? error.message : `${name}: could not verify this type.`); }
	}
	return result;
}

/** The fields whose values Anki processes as cloze deletions. */
export function clozeFields(type: AnkiNoteType): string[] {
	return [...new Set(type.templates.flatMap(template => [...`${template.front}\n${template.back}`.matchAll(/\{\{(?:type:)?cloze:([^{}]+)\}\}/gi)].map(match => match[1])))];
}

function fingerprint(type: AnkiNoteType): string {
	return JSON.stringify({ name: type.name, id: type.id, fields: type.fields, templates: [...type.templates].sort((a, b) => a.name.localeCompare(b.name)), descriptions: type.fields.map(field => type.descriptions[field] ?? '') });
}

/** Read selected types afresh before a paid generation and before any addNote operation. */
export async function revalidateDestinations(snapshot: AnkiDestinations, namesToCheck: readonly string[]): Promise<void> {
	const client = new AnkiClient(snapshot.url);
	const names = await readNoteTypeNames(client);
	for (const name of new Set(namesToCheck)) {
		const saved = snapshot.types.find(type => type.name === name);
		if (!saved || !names.has(saved.name)) throw new Error(`The ${name} note type is no longer available in Anki. Your generated notes are kept; restore the type or configure it and generate again.`);
		const live = await readNoteType(client, saved.name, names.get(saved.name)!);
		verifyNoteType(live);
		if (fingerprint(live) !== fingerprint(saved)) throw new Error(`“${live.name}” changed since this run was prepared. Your generated notes are kept. Restore its fields/templates or generate again with the updated configuration.`);
	}
}

/** The list displayed in settings is never proof of availability for a later generation/export. */
export class NoteTypeDiscovery {
	types: AnkiNoteType[] = [];
	url = '';
	verified = false;
	loading = false;
	error?: string;
	private revision = 0;

	async refresh(url: string): Promise<boolean> {
		const revision = ++this.revision;
		if (this.url !== url) this.types = [];
		this.url = url; this.loading = true; this.verified = false; this.error = undefined;
		try {
			const client = new AnkiClient(url);
			const names = [...await readNoteTypeNames(client)];
			const types: AnkiNoteType[] = [];
			// Bound simultaneous local requests even for collections with many imported types.
			for (let offset = 0; offset < names.length; offset += 4) {
				const group = await Promise.all(names.slice(offset, offset + 4).map(async ([name, id]) => {
					try { return await readNoteType(client, name, id); }
					catch (error) { return { name, id, fields: [], templates: [], descriptions: {}, problem: error instanceof Error ? error.message : 'Could not read this type.' }; }
				}));
				if (revision !== this.revision) return false;
				types.push(...group);
			}
			if (revision !== this.revision) return false;
			this.types = types; this.verified = true;
			return true;
		}
		catch (error) { if (revision === this.revision) this.error = error instanceof Error ? error.message : 'Could not read Anki note types.'; return false; }
		finally { if (revision === this.revision) this.loading = false; }
	}
}

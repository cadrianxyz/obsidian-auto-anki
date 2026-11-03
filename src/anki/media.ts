import { diagramFileName, type Diagram } from '../source-note/images';
import type { AnkiClient } from './client';

// --- File names ---

/** Anki file name for a diagram. The hash comes from the stored bytes, so one image has one name and a name never points at other bytes. */
export async function ankiMediaName(diagram: Diagram): Promise<string> {
	const bytes = Uint8Array.from(atob(diagram.stored.base64), char => char.charCodeAt(0));
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	const hash = Array.from(digest.slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
	const stem = diagramFileName(diagram.path).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'image';
	return `auto-anki-${hash}-${stem}.${diagram.stored.extension}`;
}

// --- Storage ---

/** Stores one file in Anki's media folder. AnkiConnect replaces a file with the same name, which holds the same bytes. */
export async function storeAnkiMedia(client: AnkiClient, filename: string, base64: string): Promise<void> {
	const stored = await client.invoke('storeMediaFile', { filename, data: base64 });
	if (stored !== filename) throw new Error('Anki stored the image under another name.');
}

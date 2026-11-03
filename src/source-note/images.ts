import { arrayBufferToBase64, parseLinktext, type App } from 'obsidian';
import type { ModelSettings } from '../settings/schema';
import { embeddedFiles } from './content';

export const MAX_DIAGRAMS = 20;
export const MAX_IMAGE_EDGE = 1568;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_FORMATS: Readonly<Record<string, string>> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
	webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
};

export interface Diagram {
	/** Vault path. It is also the id the model writes in {{image:…}}, so it is unique in a note. */
	path: string;
	mime: string;
	base64: string;
	/** The file Anki keeps. It is the sent copy, except for GIFs, whose original keeps the animation. */
	stored: { extension: string; base64: string };
}

const STORED_EXTENSIONS: Readonly<Record<string, string>> = {
	'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

export interface PreparedDiagrams {
	diagrams: Diagram[];
	/** Shown before sending and again alongside the generated Anki notes. */
	warnings: string[];
}

export interface ImageInputPolicy {
	action: 'send' | 'skip';
	reason?: 'disabled' | 'reported-unsupported';
	warning?: 'support-unknown' | 'forced-unsupported';
}

/** Resolve discovered support and the user's override once for preparation and review. */
export function resolveImageInputPolicy(model: Pick<ModelSettings, 'acceptsImages' | 'capabilities'>): ImageInputPolicy {
	if (model.acceptsImages === 'no') return { action: 'skip', reason: 'disabled' };
	if (model.acceptsImages === 'yes') return model.capabilities?.acceptsImages === false
		? { action: 'send', warning: 'forced-unsupported' } : { action: 'send' };
	if (model.capabilities?.acceptsImages === false) return { action: 'skip', reason: 'reported-unsupported' };
	return model.capabilities?.acceptsImages === true ? { action: 'send' } : { action: 'send', warning: 'support-unknown' };
}

export interface EncodedImage { bytes: ArrayBuffer; mime: string }
export type ImageEncoder = (bytes: ArrayBuffer, mime: string) => Promise<EncodedImage>;

/** Decode locally, downscale, and report the actual encoding produced by the canvas. */
export async function downscaleImage(bytes: ArrayBuffer, mime: string): Promise<EncodedImage> {
	const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
	try {
		const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
		const canvas = createEl('canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
		canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Image resizing is unavailable.');
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		// GIF becomes a still PNG for analysis. This never rewrites the original file.
		const target = mime === 'image/avif' ? 'image/jpeg' : ['image/bmp', 'image/gif'].includes(mime) ? 'image/png' : mime;
		const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed.')), target, 0.9));
		return { bytes: await blob.arrayBuffer(), mime: blob.type };
	}
	finally { bitmap.close(); }
}

/** No remote downloads, and no attachment reads when diagrams or image input are disabled. */
export async function prepareDiagrams(
	app: App, text: string, sourcePath: string, sendDiagrams: boolean,
	model: Pick<ModelSettings, 'acceptsImages' | 'capabilities'>,
	encode: ImageEncoder = downscaleImage,
): Promise<PreparedDiagrams> {
	const result: PreparedDiagrams = { diagrams: [], warnings: [] };
	const policy = resolveImageInputPolicy(model);
	const seen = new Set<string>();
	for (const link of embeddedFiles(text)) {
		if (!sendDiagrams) { result.warnings.push(`${link}: not sent because Send diagrams is off.`); continue; }
		if (policy.action === 'skip') {
			const reason = policy.reason === 'disabled' ? 'image input is disabled in the selected model settings' : 'the selected model does not accept images';
			result.warnings.push(`${link}: ${reason}.`); continue;
		}
		// Reject every URL scheme before asking Obsidian to resolve a vault attachment.
		if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(link)) { result.warnings.push(`${link}: only images inside the vault are sent.`); continue; }
		let path: string;
		try { path = parseLinktext(decodeURIComponent(link)).path; }
		catch { result.warnings.push(`${link}: the attachment link is invalid.`); continue; }
		const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file) { result.warnings.push(`${link}: attachment not found.`); continue; }
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		const mime = IMAGE_FORMATS[file.extension.toLowerCase()];
		if (!mime) { result.warnings.push(`${link}: this file format is not supported for diagrams.`); continue; }
		if (result.diagrams.length >= MAX_DIAGRAMS) { result.warnings.push(`${link}: only the first ${MAX_DIAGRAMS} diagrams are sent.`); continue; }
		try {
			const original = await app.vault.readBinary(file);
			const encoded = await encode(original, mime);
			if (!['image/png', 'image/jpeg', 'image/webp'].includes(encoded.mime)) throw new Error('The image could not be converted to a supported format.');
			if (encoded.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('The resized image exceeds 5 MB.');
			const sent = arrayBufferToBase64(encoded.bytes);
			// A GIF is sent as a still frame, so Anki keeps the file as it was.
			const stored = mime === 'image/gif'
				? { extension: 'gif', base64: arrayBufferToBase64(original) }
				: { extension: STORED_EXTENSIONS[encoded.mime], base64: sent };
			result.diagrams.push({ path: file.path, mime: encoded.mime, base64: sent, stored });
			if (mime === 'image/gif') result.warnings.push(`${link}: only the first GIF frame is analysed; Anki keeps the original GIF file.`);
		}
		catch { result.warnings.push(`${link}: the image could not be read or resized below 5 MB.`); }
	}
	return result;
}

/** The file name part of a vault path, shown to the user in review. */
export function diagramFileName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

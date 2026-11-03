import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, FakeElement } from 'obsidian';
import { makeDevice, resetAll } from './helpers.mjs';
import { cleanNote, embeddedFiles } from '../src/source-note/content';
import { prepareDiagrams, resolveImageInputPolicy, downscaleImage, MAX_IMAGE_EDGE } from '../src/source-note/images';

beforeEach(resetAll);
const bytes = (...values) => new Uint8Array(values).buffer;
const echo = async data => ({ bytes: data, mime: 'image/png' });
const model = { acceptsImages: 'auto' };

describe('reading only the study material', () => {
	test('frontmatter and comments are removed while source links and multiline Markdown remain', () => {
		const source = '\uFEFF---\r\nprivate: do not send\r\n---\r\n# Heading\r\nA %%private\ncomment%% fact. [[Target|label]]\n![[diagram.png]]';
		const cleaned = cleanNote(source);
		assert.ok(!cleaned.includes('private'));
		assert.match(cleaned, /# Heading\r\nA \n fact\. \[\[Target\|label\]\]/);
		assert.deepEqual(embeddedFiles(cleaned), ['diagram.png']);
		assert.equal(source.includes('private: do not send'), true);
	});
	test('comments in code examples stay literal, including fenced code and inline backticks', () => {
		const code = '```markdown\n%%literal%%\n![[not-an-attachment.png]]\n```\n`%%literal%%`\n~~~\n%%literal%%\n~~~\n';
		assert.equal(cleanNote(code), code);
		assert.deepEqual(embeddedFiles(cleanNote(code)), []);
		assert.equal(cleanNote('Keep this. %%unfinished private comment'), 'Keep this. \n');
	});
	test('embedded links are deduplicated in first-occurrence order without merging different link spellings', () => {
			const source = '![[b.png]] ![same](b.png) ![[a.png|300]] ![[b.png]] ![encoded](my%20diagram.png) ![[my diagram.png]] ![[a.png]]';
			assert.deepEqual(embeddedFiles(source), ['b.png', 'a.png', 'my%20diagram.png', 'my diagram.png']);
		});
		test('Markdown and wiki embeds work in lists, but escaped embeds and code do not', () => {
		const source = '- ![[a.png|300]]\n- ![caption](some%20file.png "Title")\n\n![reference][ref]\n\n[ref]: ref.webp\n\n\\![[escaped.png]] `![code](code.jpg)`\n\n```\n![[fenced.png]]\n```';
		assert.deepEqual(embeddedFiles(source), ['a.png', 'some%20file.png', 'ref.webp']);
	});
});

describe('preparing diagrams locally', () => {
	test('resolves image support without losing unknown and explicit override states', () => {
		assert.deepEqual(resolveImageInputPolicy({ acceptsImages: 'auto' }), { action: 'send', warning: 'support-unknown' });
		assert.deepEqual(resolveImageInputPolicy({ acceptsImages: 'auto', capabilities: { acceptsImages: true } }), { action: 'send' });
		assert.deepEqual(resolveImageInputPolicy({ acceptsImages: 'auto', capabilities: { acceptsImages: false } }), { action: 'skip', reason: 'reported-unsupported' });
		assert.deepEqual(resolveImageInputPolicy({ acceptsImages: 'no', capabilities: { acceptsImages: true } }), { action: 'skip', reason: 'disabled' });
		assert.deepEqual(resolveImageInputPolicy({ acceptsImages: 'yes', capabilities: { acceptsImages: false } }), { action: 'send', warning: 'forced-unsupported' });
	});

	test('disabled diagrams and a model without image support never read attachment bytes', async () => {
		const app = makeDevice({ attachments: { 'Images/a.png': bytes(1) } });
		for (const [send, selected] of [[false, model], [true, { acceptsImages: 'no' }], [true, { acceptsImages: 'auto', capabilities: { acceptsImages: false } }]]) {
			const result = await prepareDiagrams(app, '![[a.png]]', 'Notes/Example.md', send, selected, echo);
			assert.equal(result.diagrams.length, 0);
			assert.equal(result.warnings.length, 1);
		}
		assert.deepEqual(fake.attachmentReads, []);
	});
	test('uses Obsidian resolution, decodes spaces, and reads a repeated attachment only once', async () => {
		const app = makeDevice({ attachments: { 'Notes/my diagram.png': bytes(1, 2, 3) } });
		const result = await prepareDiagrams(app, '![[my diagram.png|200]] ![same](my%20diagram.png)', 'Notes/Example.md', true, model, echo);
		assert.deepEqual(result.diagrams, [{ path: 'Notes/my diagram.png', mime: 'image/png', base64: 'AQID', stored: { extension: 'png', base64: 'AQID' } }]);
		assert.deepEqual(fake.attachmentReads, ['Notes/my diagram.png']);
	});
	test('diagrams are identified by vault path, even when file names match', async () => {
		const app = makeDevice({ attachments: { 'a/pic.png': bytes(1), 'b/pic.png': bytes(2), 'c/other.png': bytes(3) } });
		const result = await prepareDiagrams(app, '![[a/pic.png]] ![[b/pic.png]] ![[c/other.png]]', 'Note.md', true, model, echo);
		assert.deepEqual(result.diagrams.map(diagram => diagram.path), ['a/pic.png', 'b/pic.png', 'c/other.png']);
	});
	test('web URLs, missing files, unsupported formats and unreadable images get individual reasons', async () => {
		const app = makeDevice({ attachments: { 'a.svg': bytes(1), 'a.pdf': bytes(1), 'broken.png': bytes(2) } });
		const result = await prepareDiagrams(app, '![](https://example.com/a.png) ![[missing.png]] ![[a.svg]] ![[a.pdf]] ![[broken.png]]', 'Note.md', true, model,
			async () => { throw new Error('decode failed'); });
		assert.equal(result.diagrams.length, 0);
		assert.equal(result.warnings.length, 5);
		assert.match(result.warnings.join('\n'), /only images inside the vault.*\n.*not found.*\n.*not supported.*\n.*not supported.*\n.*could not be read/s);
		assert.deepEqual(fake.attachmentReads, ['broken.png']);
	});
	test('an explicit Yes overrides reported missing image support', async () => {
		const app = makeDevice({ attachments: { 'a.png': bytes(1) } });
		const result = await prepareDiagrams(app, '![[a.png]]', 'Note.md', true, { acceptsImages: 'yes', capabilities: { acceptsImages: false } }, echo);
		assert.equal(result.diagrams.length, 1);
	});
	test('only the first twenty images are read, and oversized or unsupported encodings are omitted', async () => {
		const attachments = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`${i}.png`, bytes(i)]));
		const app = makeDevice({ attachments });
		const source = Object.keys(attachments).map(name => `![[${name}]]`).join('\n');
		const result = await prepareDiagrams(app, source, 'Note.md', true, model, echo);
		assert.equal(result.diagrams.length, 20);
		assert.equal(fake.attachmentReads.length, 20);
		assert.match(result.warnings[0], /21?0.png: only the first 20/);
		for (const encoded of [{ bytes: new ArrayBuffer(5 * 1024 * 1024 + 1), mime: 'image/png' }, { bytes: bytes(1), mime: 'image/bmp' }]) {
			assert.equal((await prepareDiagrams(app, '![[0.png]]', 'Note.md', true, model, async () => encoded)).diagrams.length, 0);
		}
	});
	test('GIF analysis is explicitly a first-frame still, without changing the original', async () => {
		const original = bytes(71, 73, 70);
		const app = makeDevice({ attachments: { 'motion.gif': original } });
		const result = await prepareDiagrams(app, '![[motion.gif]]', 'Note.md', true, model, async (_, mime) => {
			assert.equal(mime, 'image/gif'); return { bytes: bytes(1), mime: 'image/png' };
		});
		assert.equal(result.diagrams[0].mime, 'image/png');
		// Anki keeps the original GIF: "R0lG" is the base64 of the bytes 71, 73, 70.
		assert.deepEqual(result.diagrams[0].stored, { extension: 'gif', base64: 'R0lG' });
		assert.match(result.warnings[0], /first GIF frame/);
		assert.deepEqual([...new Uint8Array(original)], [71, 73, 70]);
		assert.equal(app.disk.writes, 0);
	});
	test('real resizing code preserves aspect ratio and uses the actual blob MIME type', async () => {
		const create = globalThis.createEl;
		const bitmap = globalThis.createImageBitmap;
		let closed = 0;
		const canvas = { getContext: () => ({ drawImage() {} }), toBlob(callback, requested) {
			assert.equal(requested, 'image/webp'); callback(new Blob([bytes(7)], { type: 'image/png' }));
		} };
		globalThis.createEl = tag => { assert.equal(tag, 'canvas'); return canvas; };
		globalThis.createImageBitmap = async () => ({ width: 3136, height: 1568, close() { closed++; } });
		try {
			const encoded = await downscaleImage(bytes(1), 'image/webp');
			assert.equal(canvas.width, MAX_IMAGE_EDGE);
			assert.equal(canvas.height, 784);
			assert.equal(encoded.mime, 'image/png');
			assert.deepEqual([...new Uint8Array(encoded.bytes)], [7]);
			assert.equal(closed, 1);
			canvas.getContext = () => null;
			await assert.rejects(downscaleImage(bytes(1), 'image/png'), /resizing is unavailable/);
			assert.equal(closed, 2);
		} finally { globalThis.createEl = create; globalThis.createImageBitmap = bitmap; }
	});
});

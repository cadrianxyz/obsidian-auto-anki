// Tags for Anki notes: the automatic model, effort and prompt-version tags, and the user's own.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticTags, noteTags, parseExtraTags, promptVersionTag } from '../src/anki/tags';
import { NOTE_WRITING_INSTRUCTIONS_VERSION } from '../src/generate/note-writing-instructions';

const settings = (overrides = {}) => ({
	enabled: true, model: true, reasoningEffort: false, promptVersion: false, prefix: true, extra: '', ...overrides,
});
const run = (overrides = {}) => ({
	providerId: 'anthropic', modelId: 'claude-haiku-5-5', reasoningEffort: 'default', promptVersion: '1.0.0', ...overrides,
});
const allOn = { reasoningEffort: true, promptVersion: true };

describe('automatic tags', () => {
	test('tagging off adds nothing, whatever the options say', () => {
		assert.deepEqual(automaticTags(settings({ enabled: false, ...allOn }), run()), []);
		assert.deepEqual(noteTags(settings({ enabled: false, ...allOn, extra: 'obsidian' }), run(), 'exam-week'), []);
	});

	test('with only the default options on, a card gets the model tag', () => {
		assert.deepEqual(automaticTags(settings(), run()), ['auto-anki::anthropic::claude-haiku-5-5']);
	});

	test('each option adds its own tag, in a fixed order', () => {
		assert.deepEqual(automaticTags(settings(allOn), run({ reasoningEffort: 'high' })), [
			'auto-anki::anthropic::claude-haiku-5-5', 'auto-anki::effort::high', 'auto-anki::prompt::1.0.0',
		]);
		assert.deepEqual(automaticTags(settings({ model: false, promptVersion: true }), run()), ['auto-anki::prompt::1.0.0']);
		assert.deepEqual(automaticTags(settings({ model: false }), run()), []);
	});

	test('the model\'s own default effort is tagged as default', () => {
		assert.deepEqual(automaticTags(settings({ model: false, reasoningEffort: true }), run()), ['auto-anki::effort::default']);
	});

	test('the provider part is the provider ID, for OpenAI too', () => {
		assert.deepEqual(automaticTags(settings(), run({ providerId: 'openai', modelId: 'gpt-6-luna' })), ['auto-anki::openai::gpt-6-luna']);
	});

	test('without the prefix, only the auto-anki part is left out', () => {
		assert.deepEqual(automaticTags(settings({ ...allOn, prefix: false }), run({ reasoningEffort: 'low' })), [
			'anthropic::claude-haiku-5-5', 'effort::low', 'prompt::1.0.0',
		]);
	});

	test('a value cannot add tags or levels: spaces become _ and :: becomes -', () => {
		assert.deepEqual(automaticTags(settings(), run({ modelId: ' my org::model v2 ' })), ['auto-anki::anthropic::my_org-model_v2']);
		assert.deepEqual(automaticTags(settings({ model: false, reasoningEffort: true }), run({ reasoningEffort: 'very\thigh' })), ['auto-anki::effort::very_high']);
	});
});

describe('prompt version', () => {
	test('unedited instructions use the built-in version', () => {
		assert.equal(promptVersionTag(undefined), NOTE_WRITING_INSTRUCTIONS_VERSION);
	});

	test('edited instructions use the version the edit started from, plus -edited', () => {
		assert.equal(promptVersionTag({ text: 'My rules', defaultVersion: '1.0.0' }), '1.0.0-edited');
		assert.equal(promptVersionTag({ text: '', defaultVersion: '0.9.0' }), '0.9.0-edited');
	});
});

describe('extra tags', () => {
	test('tags are separated by any spaces, and empty entries are dropped', () => {
		assert.deepEqual(parseExtraTags('  obsidian \n uni::cs101\t\tlang '), ['obsidian', 'uni::cs101', 'lang']);
		assert.deepEqual(parseExtraTags('   '), []);
	});

	test(':: is kept as the user\'s hierarchy, without empty levels', () => {
		assert.deepEqual(parseExtraTags('uni::cs101 a::::b ::lead trail:: ::'), ['uni::cs101', 'a::b', 'lead', 'trail']);
	});

	test('non-English tags are kept as typed', () => {
		assert.deepEqual(parseExtraTags('日本語::語彙 Ästhetik'), ['日本語::語彙', 'Ästhetik']);
	});
});

describe('tags for one export', () => {
	test('saved extra tags follow the automatic ones, without the prefix', () => {
		assert.deepEqual(noteTags(settings({ extra: 'obsidian uni::cs101' }), run()), [
			'auto-anki::anthropic::claude-haiku-5-5', 'obsidian', 'uni::cs101',
		]);
	});

	test('the export box replaces the saved extra tags for that export', () => {
		const saved = settings({ extra: 'obsidian' });
		assert.deepEqual(noteTags(saved, run(), 'exam-week'), ['auto-anki::anthropic::claude-haiku-5-5', 'exam-week']);
		assert.deepEqual(noteTags(saved, run(), ''), ['auto-anki::anthropic::claude-haiku-5-5']);
		assert.equal(saved.extra, 'obsidian');
	});

	test('extra tags work with every automatic option off', () => {
		assert.deepEqual(noteTags(settings({ model: false, extra: 'obsidian' }), run()), ['obsidian']);
	});

	test('repeats are dropped ignoring case, as Anki does, keeping the first spelling', () => {
		assert.deepEqual(noteTags(settings({ extra: 'Obsidian obsidian AUTO-ANKI::anthropic::claude-haiku-5-5' }), run()), [
			'auto-anki::anthropic::claude-haiku-5-5', 'Obsidian',
		]);
	});
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getEnabledModels, isTextGenerationCandidate, sortModelChoices } from '../src/ai/models/selection';
import { ModelDiscovery } from '../src/ai/models/discovery';
import { MODEL_CATALOG_URL, normalizeModelCatalogCache } from '../src/ai/models/catalog';
import { createModelSettings } from '../src/settings/schema';

const model = (id, details = {}) => ({ id, displayName: id, ...details });

describe('model choices from discovery metadata', () => {
	test('hundreds of discovered models never enter the picker until enabled by the user', () => {
		const models = Array.from({ length: 308 }, (_, index) => model(`model-${index}`));
		const configured = models.slice(0, 8).map(model => createModelSettings(model.id));
		configured.push({ ...createModelSettings('model-8'), enabled: false });
		const result = getEnabledModels(models, configured);
		assert.equal(result.length, 8);
		assert.deepEqual(result.map(model => model.id), configured.filter(model => model.enabled).map(model => model.id));
		models.push(model('newly-introduced-model'));
		assert.deepEqual(getEnabledModels(models, configured), result, 'refreshing discovery cannot change what is enabled');
		configured.push(createModelSettings('newly-introduced-model'));
		assert.equal(getEnabledModels(models, configured).length, 9, 'adding a model enables it');
		assert.equal(models.length, 309, 'the full discovery list remains available for Manage models');
	});

	test('uses reported output formats, keeping unknown and multimodal models while excluding non-text tasks', () => {
		assert.equal(isTextGenerationCandidate(model('unfamiliar')), true);
		assert.equal(isTextGenerationCandidate(model('no-output', { outputModalities: [] })), false);
		assert.equal(isTextGenerationCandidate(model('mixed', { outputModalities: ['text', 'audio'] })), true);
		assert.equal(isTextGenerationCandidate(model('image-generator', { outputModalities: ['image'] })), false);
		assert.equal(isTextGenerationCandidate(model('speech-generator', { outputModalities: ['audio'] })), false);
		assert.equal(isTextGenerationCandidate(model('search-model', { isEmbedding: true, outputModalities: ['text'] })), false);
	});

	test('preserves explicitly saved choices even when current metadata reports an incompatible task', () => {
		const saved = model('saved-model', { outputModalities: ['image'] });
		assert.deepEqual(getEnabledModels([saved], [createModelSettings(saved.id)], saved.id), [saved]);
	});

	test('an empty enabled list stays empty, even when the provider reports suitable models', () => {
		const models = [model('reported', { outputModalities: ['text'] })];
		assert.deepEqual(getEnabledModels(models, []), []);
		assert.deepEqual(getEnabledModels(models, [{ ...createModelSettings('reported'), enabled: false }], 'reported'), []);
	});

	test('orders default and saved choices first, then release dates and stable names without ranking model names', () => {
		const input = [model('z'), model('old', { releaseDate: '2025-01-01' }), model('saved'), model('default'),
			model('b', { releaseDate: '2026-10-01' }), model('a', { releaseDate: '2026-10-01' }), model('y')];
		const expected = ['default', 'saved', 'a', 'b', 'old', 'y', 'z'];
		assert.deepEqual(sortModelChoices(input, 'default', new Set(['saved'])).map(model => model.id), expected);
		assert.deepEqual(sortModelChoices([...input].reverse(), 'default', new Set(['saved'])).map(model => model.id), expected);
		assert.equal(input[0].id, 'z');
	});

	test('release and output metadata survive the separate public cache without sharing mutable arrays', async () => {
		const discovery = new ModelDiscovery(async request => request.url === MODEL_CATALOG_URL ? { status: 200, json: { openai: { models: {
			one: { id: 'one', release_date: '2026-10-01', modalities: { output: ['text'] } },
			embed: { id: 'special', family: 'embedding', modalities: { output: ['text'] } },
			bad: { id: 'bad-date', release_date: '2026-02-31', modalities: { output: [7] } },
			none: { id: 'no-output', modalities: { output: [] } },
		} } } } : assert.fail('Only the catalogue uses send'), undefined, undefined, undefined, async () =>
			new Response(JSON.stringify({ data: [{ id: 'one' }] }), { headers: { 'content-type': 'application/json' } }));
		await discovery.refreshCatalog();
		await discovery.refreshProvider('openai', 'test-key');
		const snapshot = discovery.getCatalogCache();
		const restored = new ModelDiscovery(undefined, undefined, undefined, { load: async () => normalizeModelCatalogCache(snapshot) });
		await restored.restoreCatalog();
		const [one, embed, bad, none] = restored.getModels('openai', [], ['one', 'special', 'bad-date', 'no-output']);
		assert.equal(one.releaseDate, '2026-10-01');
		assert.deepEqual(one.outputModalities, ['text']);
		assert.equal(isTextGenerationCandidate(embed), false);
		assert.equal(bad.releaseDate, undefined);
		assert.equal(bad.outputModalities, undefined);
		assert.deepEqual(none.outputModalities, []);
		assert.equal(isTextGenerationCandidate(none), false);
		one.outputModalities.push('image');
		snapshot.providers.openai[0].outputModalities.push('audio');
		assert.deepEqual(restored.getModels('openai', [], ['one'])[0].outputModalities, ['text']);
	});
});

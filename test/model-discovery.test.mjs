import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fake } from 'obsidian';
import { ModelDiscovery, MODEL_CATALOG_MAX_AGE_MS } from '../src/ai/models/discovery';
import { getProvider } from '../src/ai/registry';
import { MODEL_CATALOG_CACHE_VERSION, MODEL_CATALOG_URL, normalizeModelCatalogCache, parseModelCatalog } from '../src/ai/models/catalog';
import { ModelCatalogCacheFile } from '../src/ai/models/catalog-cache';
import { createDefaultSettings, createModelSettings, normalizeSettings } from '../src/settings/schema';
import { getReasoningEffortsForModel } from '../src/ai/models/metadata';

const reply = data => ({ status: 200, json: { data } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Existing fixtures describe HTTP replies; only tests adapt them to SDK fetch.
function createDiscovery(send, timeoutMs, now, cacheFile) {
	const sdkFetch = async (input, init) => {
		const headers = Object.fromEntries(new Headers(init.headers));
		headers.Authorization = headers.authorization;
		delete headers.authorization;
		const response = await send({ url: String(input), method: init.method, headers, signal: init.signal });
		return new Response(JSON.stringify(response.json), { status: response.status, headers: { 'content-type': 'application/json' } });
	};
	return new ModelDiscovery(send, timeoutMs, now, cacheFile, send ? sdkFetch : undefined);
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function catalog(models, providerId = 'openai') {
	return { [providerId]: { id: providerId, models: Object.fromEntries(models.map(model => [model.id, model])) } };
}

// Exercise the same adapter read/write interface against real files in a temporary vault.
async function createCacheFile(t) {
	const root = await mkdtemp(join(tmpdir(), 'auto-anki-model-cache-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pluginDirectory = '.custom-config/plugins/auto-anki';
	await mkdir(join(root, pluginDirectory), { recursive: true });
	const writes = [];
	const adapter = {
		read: path => readFile(join(root, path), 'utf8'),
		write: async (path, data) => {
			writes.push(path);
			await writeFile(join(root, path), data);
		},
	};
	return { root, pluginDirectory, adapter, writes, file: new ModelCatalogCacheFile(adapter, pluginDirectory) };
}

beforeEach(() => fake.reset());

describe('live provider model discovery', () => {
	test('uses SDK fetch and the fixed provider endpoint, accepting newly introduced IDs', async () => {
		fake.providerHandler = () => reply([{ id: 'brand-new-model' }, { id: 'brand-new-model' }, { id: 7 }]);
		const discovery = createDiscovery(request => {
			fake.providerRequests.push(request);
			return fake.providerHandler(request);
		});
		assert.deepEqual(await discovery.refreshProvider('openai', ' test-key '), { ok: true });
		assert.deepEqual(discovery.getModels('openai'), [{ id: 'brand-new-model', displayName: 'brand-new-model' }]);
		assert.equal(fake.providerRequests[0].url, 'https://api.openai.com/v1/models');
		assert.equal(fake.providerRequests[0].headers.Authorization, 'Bearer test-key');
		assert.equal(fake.providerRequests[0].method, 'GET');
		assert.equal(fake.ankiRequests.length, 0);
	});

	test('Claude discovery follows pagination and retains per-model capabilities', async () => {
		const requests = [];
		const discovery = createDiscovery(async request => {
			requests.push(request);
			return request.url.includes('after_id=') ? reply([{ id: 'second', display_name: 'Second' }]) : {
				status: 200, json: {
					data: [{ id: 'first', max_tokens: 8000, capabilities: { effort: { supported: true, future: { supported: true } } } }],
					has_more: true, last_id: 'cursor/with spaces',
				},
			};
		});
		assert.equal((await discovery.refreshProvider('anthropic', 'claude-key')).ok, true);
		assert.equal(requests.length, 2);
		assert.equal(new URL(requests[1].url).searchParams.get('after_id'), 'cursor/with spaces');
		assert.equal(requests[0].headers.Authorization, 'Bearer claude-key');
		assert.equal(requests[0].headers['anthropic-version'], '2026-10-21');
		assert.equal(requests[0].headers['x-api-key'], undefined);
		assert.equal(discovery.getModels('anthropic')[0].maxOutputTokens, 8000);
		assert.deepEqual(getReasoningEffortsForModel(discovery.getModels('anthropic')[0]), ['default', 'future']);
	});

	test('failed refreshes retain the previous good list and return the provider error', async () => {
		let response = reply([{ id: 'saved-remote' }]);
		const discovery = createDiscovery(async () => response);
		await discovery.refreshProvider('openai', 'key');
		response = { status: 401, json: { error: { message: 'Invalid key' } } };
		const result = await discovery.refreshProvider('openai', 'key');
		assert.equal(result.ok, false);
		assert.match(result.error, /OpenAI.*401/);
		assert.equal(discovery.getModels('openai')[0].id, 'saved-remote');
	});

	test('partial paginated results are not published if a later page fails', async () => {
		let phase = 'initial';
		const discovery = createDiscovery(async request => {
			if (phase === 'initial') return reply([{ id: 'last-good' }]);
			if (request.url.includes('after_id')) return { status: 500, json: {} };
			return { status: 200, json: { data: [{ id: 'partial-new' }], has_more: true, last_id: 'partial-new' } };
		});
		await discovery.refreshProvider('anthropic', 'key');
		phase = 'failed-refresh';
		assert.equal((await discovery.refreshProvider('anthropic', 'key')).ok, false);
		assert.deepEqual(discovery.getModels('anthropic').map(model => model.id), ['last-good']);
	});

	test('repeated or missing pagination cursors are reported instead of looping', async () => {
		for (const cursor of [undefined, 'repeated']) {
			let calls = 0;
			const discovery = createDiscovery(async () => {
				calls++;
				return { status: 200, json: { data: [{ id: 'one' }], has_more: true, last_id: cursor } };
			});
			const result = await discovery.refreshProvider('anthropic', 'key');
			assert.equal(result.ok, false);
			assert.match(result.error, /cursor/);
			assert.ok(calls <= 2);
		}
	});

	test('malformed model-list responses preserve the cache; a valid empty list is allowed', async () => {
		for (const providerId of ['openai', 'anthropic']) {
			let response = reply([{ id: 'last-good' }]);
			const discovery = createDiscovery(async () => response);
			await discovery.refreshProvider(providerId, 'key');
			for (const json of [null, {}, { data: null }, { data: {} }, { data: [{ id: 7 }, null] }]) {
				response = { status: 200, json };
				assert.equal((await discovery.refreshProvider(providerId, 'key')).ok, false);
				assert.equal(discovery.getModels(providerId)[0].id, 'last-good');
			}
			response = reply([]);
			assert.equal((await discovery.refreshProvider(providerId, 'key')).ok, true);
			assert.deepEqual(discovery.getModels(providerId), []);
		}
	});

	test('simultaneous requests share work, while a changed key cannot publish the older response', async () => {
		const oldAccount = deferred();
		const newAccount = deferred();
		let calls = 0;
		const discovery = createDiscovery(async request => {
			calls++;
			return request.headers.Authorization === 'Bearer old-key' ? oldAccount.promise : newAccount.promise;
		});
		const first = discovery.refreshProvider('openai', 'old-key');
		assert.equal(discovery.refreshProvider('openai', 'old-key'), first);
		await tick();
		const second = discovery.refreshProvider('openai', 'new-key');
		await tick();
		newAccount.resolve(reply([{ id: 'new-account-model' }]));
		await second;
		oldAccount.resolve(reply([{ id: 'old-account-model' }]));
		await first;
		assert.equal(calls, 2);
		assert.deepEqual(discovery.getModels('openai').map(model => model.id), ['new-account-model']);
	});

	test('a superseded request cannot publish models or clear its pending replacement', async () => {
		const oldAccount = deferred();
		const newAccount = deferred();
		let calls = 0;
		const discovery = createDiscovery(async request => {
			calls++;
			return request.headers.Authorization === 'Bearer old-key' ? oldAccount.promise : newAccount.promise;
		});
		const first = discovery.refreshProvider('openai', 'old-key');
		await tick();
		const second = discovery.refreshProvider('openai', 'new-key');
		await tick();
		oldAccount.resolve(reply([{ id: 'old-account-model' }]));
		await first;
		assert.deepEqual(discovery.getModels('openai'), []);
		assert.equal(discovery.refreshProvider('openai', 'new-key'), second);
		assert.equal(calls, 2);
		newAccount.resolve(reply([{ id: 'new-account-model' }]));
		assert.deepEqual(await second, { ok: true });
		assert.deepEqual(discovery.getModels('openai').map(model => model.id), ['new-account-model']);
	});

	test('a timeout does not publish a late response or start subsequent pages', async () => {
		const late = deferred();
		let calls = 0;
		const discovery = createDiscovery(async () => { calls++; return late.promise; }, 5);
		const result = await discovery.refreshProvider('anthropic', 'key');
		assert.equal(result.ok, false);
		assert.match(result.error, /timed out/);
		late.resolve({ status: 200, json: { data: [{ id: 'too-late' }], has_more: true, last_id: 'another-page' } });
		await tick();
		assert.equal(calls, 1);
		assert.deepEqual(discovery.getModels('anthropic'), []);
	});

	test('SDK fetch is actually aborted on timeout, key change, and clearProvider', async () => {
		for (const action of ['timeout', 'key-change', 'clear', 'empty-key']) {
			const started = deferred();
			let signal;
			let aborts = 0;
			const discovery = new ModelDiscovery(undefined, action === 'timeout' ? 30 : 1000, undefined, undefined, async (_input, init) => {
				signal = init.signal;
				started.resolve();
				return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
					aborts++;
					reject(signal.reason);
				}, { once: true }));
			});
			const first = discovery.refreshProvider('openai', 'old-key');
			await started.promise;
			let replacement;
			if (action === 'key-change') replacement = discovery.refreshProvider('openai', 'new-key');
			if (action === 'clear') discovery.clearProvider('openai');
			if (action === 'empty-key') await discovery.refreshProvider('openai', ' ');
			const result = await first;
			assert.equal(result.ok, false);
			assert.equal(signal.aborted, true, action);
			assert.equal(aborts, 1, action);
			if (action === 'timeout') assert.match(result.error, /timed out/);
			discovery.clearProvider('openai');
			if (replacement) await replacement;
			assert.deepEqual(discovery.getModels('openai'), []);
		}
	});

	test('one deadline covers all SDK pages and a stalled response body', async () => {
		for (const stalledBody of [false, true]) {
			let calls = 0;
			let aborted = false;
			const discovery = new ModelDiscovery(undefined, 100, undefined, undefined, async (_input, init) => {
				calls++;
				if (calls === 1) {
					await new Promise(resolve => setTimeout(resolve, 60));
					return Response.json({ data: [{ id: 'partial' }], has_more: true, last_id: 'partial' });
				}
				init.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
				if (!stalledBody) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
				return new Response(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"data":['));
						init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
					},
				}), { headers: { 'content-type': 'application/json' } });
			});
			const start = Date.now();
			const result = await discovery.refreshProvider('anthropic', 'key');
			assert.equal(result.ok, false);
			assert.match(result.error, /timed out/);
			assert.equal(calls, 2);
			assert.equal(aborted, true);
			assert.ok(Date.now() - start < 155, 'the second page must not get a fresh deadline');
			assert.deepEqual(discovery.getModels('anthropic'), []);
		}
	});

	test('SDK pages stop at the manual page cap without publishing partial results', async () => {
		let calls = 0;
		const discovery = createDiscovery(async () => ({ status: 200, json: {
			data: [{ id: `model-${++calls}` }], has_more: true, last_id: `cursor-${calls}`,
		} }));
		const result = await discovery.refreshProvider('anthropic', 'key');
		assert.equal(result.ok, false);
		assert.match(result.error, /page limit/);
		assert.equal(calls, 100);
		assert.deepEqual(discovery.getModels('anthropic'), []);
	});

	test('default SDK fetch uses the renderer fetch', async t => {
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			calls++;
			return Response.json({ data: [{ id: 'global-fetch-model' }] });
		});
		const discovery = new ModelDiscovery();
		assert.deepEqual(await discovery.refreshProvider('openai', 'key'), { ok: true });
		assert.equal(discovery.getModels('openai')[0].id, 'global-fetch-model');
		const models = await getProvider('anthropic').fetchModels({ apiKey: 'key', timeoutMs: 1000, signal: new AbortController().signal });
		assert.equal(models[0].id, 'global-fetch-model');
		assert.equal(calls, 2);
	});

	test('factory custom-header rejections stay actionable without leaking header values or sending requests', async () => {
		for (const [providerId, variable] of [['openai', 'OPENAI_CUSTOM_HEADERS'], ['anthropic', 'ANTHROPIC_CUSTOM_HEADERS']]) {
			const previous = process.env[variable];
			try {
				delete process.env[variable];
				let calls = 0;
				const discovery = new ModelDiscovery(undefined, undefined, undefined, undefined, async () => {
					calls++;
					return Response.json({ data: [{ id: 'last-good' }] });
				});
				assert.deepEqual(await discovery.refreshProvider(providerId, 'key'), { ok: true });
				process.env[variable] = 'Authorization: Bearer private-custom-header';
				const result = await discovery.refreshProvider(providerId, 'key');
				assert.equal(result.ok, false);
				assert.match(result.error, new RegExp(`cannot safely create.*${variable}`));
				assert.match(result.error, new RegExp(`Unset ${variable} and restart Obsidian`));
				assert.doesNotMatch(result.error, /private-custom-header|Check your connection/);
				assert.equal(calls, 1, 'the rejected client must not send a request');
				assert.equal(discovery.getModels(providerId)[0].id, 'last-good');
			} finally {
				if (previous === undefined) delete process.env[variable];
				else process.env[variable] = previous;
			}
		}
	});

	test('provider failures are sanitized and SDK requests are never retried', async () => {
		for (const providerId of ['openai', 'anthropic']) {
			let calls = 0;
			const discovery = new ModelDiscovery(undefined, undefined, undefined, undefined, async () => {
				calls++;
				return Response.json({ error: { message: 'Bearer secret-key private request data' } }, { status: 429 });
			});
			const result = await discovery.refreshProvider(providerId, 'secret-key');
			assert.equal(result.ok, false);
			assert.match(result.error, /429/);
			assert.doesNotMatch(result.error, /secret-key|private request data/);
			assert.equal(calls, 1);
		}
	});

	test('a missing API key makes no request and leaves manually entered models usable', async () => {
		const discovery = createDiscovery(async () => { throw new Error('must not request'); });
		assert.equal((await discovery.refreshProvider('openai', ' ')).ok, false);
		assert.deepEqual(discovery.getModels('openai', [], [' new-model ', 'new-model', '']).map(model => model.id), ['new-model']);
	});
});

describe('optional model catalogue metadata', () => {
	test('reads labels, image support and output limits, without inventing exact reasoning levels', () => {
		const parsed = parseModelCatalog(catalog([
			{ id: 'reasoning', name: 'Readable name', reasoning: true, modalities: { input: ['text', 'image'] }, limit: { output: 8000 } },
			{ id: 'plain', reasoning: false, modalities: { input: ['text'] } },
		]));
		assert.deepEqual(parsed.openai.get('reasoning'), { id: 'reasoning', displayName: 'Readable name', capabilities: { acceptsImages: true }, maxOutputTokens: 8000 });
		assert.deepEqual(parsed.openai.get('plain').capabilities, { acceptsImages: false, reasoningEfforts: [] });
		assert.equal(parseModelCatalog({ unknown: { models: { model: { id: 'model' } } } }), null);
	});

	test('reads exact effort levels from reasoning_options; other controls mean no effort levels', () => {
		const parsed = parseModelCatalog(catalog([
			{ id: 'levels', reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['none', 'low', 'high', 'low'] }] },
			{ id: 'budget-only', reasoning: true, reasoning_options: [{ type: 'budget_tokens' }] },
			{ id: 'unreadable', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 3] }] },
			{ id: 'no-values', reasoning: true, reasoning_options: [{ type: 'effort' }] },
		]));
		assert.deepEqual(parsed.openai.get('levels').capabilities, { reasoningEfforts: ['none', 'low', 'high'] });
		assert.deepEqual(parsed.openai.get('budget-only').capabilities, { reasoningEfforts: [] });
		for (const id of ['unreadable', 'no-values']) assert.equal(parsed.openai.get(id).capabilities, undefined, `${id} stays unknown`);
		assert.deepEqual(getReasoningEffortsForModel(parsed.openai.get('levels')), ['default', 'none', 'low', 'high']);
	});

	test('ignores malformed fields and records, preserving an unknown capability as unknown', () => {
		const parsed = parseModelCatalog(catalog([{ id: 'partial', name: 7, reasoning: 'true', modalities: { input: [7] }, limit: { output: -5 } }, { id: '' }]));
		assert.deepEqual([...parsed.openai.values()], [{ id: 'partial', displayName: 'partial' }]);
		assert.equal(parseModelCatalog([]), null);
		assert.equal(parseModelCatalog(null), null);
	});

	test('catalogue requests contain neither keys nor note content, and refreshes share a daily cache', async () => {
		let now = 100;
		const requests = [];
		const discovery = createDiscovery(async request => {
			requests.push(request);
			return { status: 200, json: catalog([{ id: 'one', name: 'One' }]) };
		}, 1000, () => now);
		const first = discovery.refreshCatalog();
		assert.equal(discovery.refreshCatalog(), first);
		await first;
		assert.deepEqual(requests, [{ url: MODEL_CATALOG_URL, method: 'GET', throw: false }]);
		await discovery.refreshCatalog();
		assert.equal(requests.length, 1);
		now += MODEL_CATALOG_MAX_AGE_MS;
		await discovery.refreshCatalog();
		await discovery.refreshCatalog(true);
		assert.equal(requests.length, 3);
	});

	test('failed catalogue refreshes keep the last metadata and never block manual model selection', async () => {
		let response = { status: 200, json: catalog([{ id: 'one', name: 'One' }]) };
		const discovery = createDiscovery(async () => response);
		await discovery.refreshCatalog();
		for (const failure of [{ status: 500, json: {} }, { status: 200, json: [] }]) {
			response = failure;
			assert.equal((await discovery.refreshCatalog(true)).ok, false);
			assert.equal(discovery.getModels('openai', [], ['one'])[0].displayName, 'One');
		}
		assert.equal(discovery.getModels('openai', [], ['brand-new'])[0].id, 'brand-new');
	});

	test('merges saved, live and manual IDs without changing user settings or offering catalogue-only IDs', async () => {
		const settings = createDefaultSettings();
		const selected = { ...createModelSettings('saved'), outputMode: 'json', acceptsImages: 'no', reasoningEffort: 'low', maxOutputTokens: 4000, capabilities: { acceptsImages: false } };
		settings.providers.openai.models.push(selected);
		settings.defaultModel = { providerId: 'openai', modelId: 'saved' };
		const snapshot = JSON.stringify(settings);
		const discovery = createDiscovery(async request => request.url === MODEL_CATALOG_URL ? {
			status: 200, json: catalog([{ id: 'saved', name: 'Saved model', modalities: { input: ['text', 'image'] } }, { id: 'live', name: 'Live model' }, { id: 'catalogue-only' }]),
		} : reply([{ id: 'live' }]));
		await discovery.refreshCatalog();
		await discovery.refreshProvider('openai', 'key');
		const models = discovery.getModels('openai', settings.providers.openai.models, ['manual', 'live']);
		assert.deepEqual(models.map(model => model.id), ['saved', 'live', 'manual']);
		assert.equal(models[0].displayName, 'Saved model');
		assert.equal(models[0].capabilities.acceptsImages, true, 'current catalogue metadata replaces an older saved copy');
		assert.equal(models[0].acceptsImages, undefined, 'the user override stays in settings, not in merged metadata');
		assert.equal(models[1].displayName, 'Live model');
		assert.equal(JSON.stringify(settings), snapshot);
	});

	test('provider capabilities take precedence over catalogue hints, and returned lists share no mutable cache objects', async () => {
		const discovery = createDiscovery(async request => request.url === MODEL_CATALOG_URL ? {
			status: 200, json: catalog([{ id: 'claude', name: 'Catalogue label', reasoning: false, modalities: { input: ['text'] }, limit: { output: 9000 } }], 'anthropic'),
		} : reply([{ id: 'claude', display_name: 'Provider label', max_tokens: 8000, capabilities: { effort: { supported: true, high: { supported: true } }, image_input: { supported: true } } }]));
		await discovery.refreshCatalog();
		await discovery.refreshProvider('anthropic', 'key');
		const model = discovery.getModels('anthropic')[0];
		assert.equal(model.displayName, 'Provider label');
		assert.equal(model.maxOutputTokens, 8000);
		assert.equal(model.capabilities.acceptsImages, true);
		assert.deepEqual(model.capabilities.reasoningEfforts, ['high']);
		model.capabilities.reasoningEfforts.push('bad-mutation');
		model.displayName = 'bad-mutation';
		assert.equal(discovery.getModels('anthropic')[0].displayName, 'Provider label');
		assert.deepEqual(discovery.getModels('anthropic')[0].capabilities.reasoningEfforts, ['high']);
	});

	test('public metadata survives a separate cache file and restart without changing settings or saving account data', async t => {
		const disk = await createCacheFile(t);
		const settingsPath = join(disk.root, disk.pluginDirectory, 'data.json');
		const settingsJson = JSON.stringify(createDefaultSettings());
		await writeFile(settingsPath, settingsJson);
		const first = createDiscovery(async request => request.url === MODEL_CATALOG_URL ? {
			status: 200, json: catalog([{ id: 'public-model', name: 'Public model', reasoning: false }]),
		} : reply([{ id: 'account-only-model' }]), 1000, () => 100, disk.file);
		await first.refreshCatalog();
		await first.refreshProvider('openai', 'secret-test-key');
		const raw = await disk.adapter.read(disk.file.path);
		assert.ok(!raw.includes('secret-test-key'));
		assert.ok(!raw.includes('account-only-model'));
		assert.equal(await readFile(settingsPath, 'utf8'), settingsJson);
		assert.deepEqual(disk.writes, ['.custom-config/plugins/auto-anki/model-catalog-cache.json']);
		let requests = 0;
		const restarted = createDiscovery(async () => { requests++; throw new Error('offline'); }, 1000, () => 101,
			new ModelCatalogCacheFile(disk.adapter, disk.pluginDirectory));
		await restarted.restoreCatalog();
		assert.equal((await restarted.refreshCatalog()).ok, true);
		assert.equal(requests, 0);
		assert.deepEqual(restarted.getModels('openai'), []);
		assert.equal(restarted.getModels('openai', [], ['public-model'])[0].displayName, 'Public model');
		const snapshot = restarted.getCatalogCache();
		snapshot.providers.openai[0].displayName = 'Changed snapshot';
		snapshot.providers.openai[0].capabilities.reasoningEfforts.push('mutation');
		snapshot.providers.openai.push({ id: 'extra', displayName: 'Extra' });
		assert.equal(restarted.getCatalogCache().providers.openai.length, 1);
		assert.equal(restarted.getCatalogCache().providers.openai[0].displayName, 'Public model');
		assert.deepEqual(restarted.getCatalogCache().providers.openai[0].capabilities.reasoningEfforts, []);
	});

	test('a stale restored cache stays available when a refresh fails', async t => {
		const disk = await createCacheFile(t);
		const cache = { fetchedAt: 100, providers: { openai: [{ id: 'one', displayName: 'Cached name' }] } };
		await disk.file.save(cache);
		const discovery = createDiscovery(async () => { throw new Error('offline'); }, 1000, () => 100 + MODEL_CATALOG_MAX_AGE_MS, disk.file);
		assert.equal((await discovery.refreshCatalog()).ok, false);
		assert.equal(discovery.getModels('openai', [], ['one'])[0].displayName, 'Cached name');
		assert.deepEqual(discovery.getCatalogCache(), cache);
		assert.deepEqual(await disk.file.load(), cache);
	});

	test('a restored timestamp in the future does not suppress refresh after a clock change', async t => {
		const disk = await createCacheFile(t);
		let requests = 0;
		const cache = { fetchedAt: 200, providers: { openai: [{ id: 'one', displayName: 'Old name' }] } };
		await disk.file.save(cache);
		const discovery = createDiscovery(async () => { requests++; return { status: 200, json: catalog([{ id: 'one', name: 'New name' }]) }; }, 1000, () => 100, disk.file);
		await discovery.refreshCatalog();
		assert.equal(requests, 1);
		assert.equal(discovery.getModels('openai', [], ['one'])[0].displayName, 'New name');
		assert.equal((await disk.file.load()).providers.openai[0].displayName, 'New name');
	});

	test('a saved capability copy without reasoning levels cannot hide levels reported later', async () => {
		const saved = { ...createModelSettings('gpt-6.1-sol'), capabilities: { acceptsImages: true, reasoningEfforts: [], outputMode: 'json' } };
		const discovery = createDiscovery(async () => ({ status: 200, json: catalog([{ id: 'gpt-6.1-sol', reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] }]) }));
		assert.deepEqual(discovery.getModels('openai', [saved])[0].capabilities.reasoningEfforts, [], 'offline, the saved copy is still used');
		await discovery.refreshCatalog();
		const model = discovery.getModels('openai', [saved])[0];
		assert.deepEqual(getReasoningEffortsForModel(model), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
		assert.equal(model.capabilities.outputMode, 'json', 'a tested format the catalogue does not report is kept');
	});

	test('a fresh cache written by an older parser is downloaded again instead of hiding newer metadata', async t => {
		const disk = await createCacheFile(t);
		// An older parser ignored reasoning_options, so its cache has no reasoning levels.
		await disk.adapter.write(disk.file.path, JSON.stringify({ fetchedAt: 100, providers: {
			openai: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', capabilities: { acceptsImages: true } }],
		} }));
		let requests = 0;
		const discovery = createDiscovery(async () => {
			requests++;
			return { status: 200, json: catalog([{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: true,
				reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] }]) };
		}, 1000, () => 101, disk.file);
		await discovery.restoreCatalog();
		assert.equal(discovery.getModels('openai', [], ['gpt-6.1-sol'])[0].displayName, 'GPT-6.1 Sol', 'the old copy stays usable before a refresh');
		assert.deepEqual(await discovery.refreshCatalog(), { ok: true });
		assert.equal(requests, 1);
		assert.deepEqual(discovery.getModels('openai', [], ['gpt-6.1-sol'])[0].capabilities.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
		assert.equal((await disk.file.load()).version, MODEL_CATALOG_CACHE_VERSION);
		await discovery.refreshCatalog();
		assert.equal(requests, 1, 'the rewritten cache is fresh for the current parser');
	});

	test('saved catalogue validation keeps only public metadata and discards a malformed cache', () => {
		const cached = { fetchedAt: 100, apiKey: 'DO_NOT_SAVE_TEST_KEY', providers: {
			openai: [{ id: 'one', displayName: 'One', apiKey: 'DO_NOT_SAVE_TEST_KEY', baseUrl: 'https://elsewhere.example', capabilities: { outputMode: 'auto', acceptsImages: true, apiKey: 'DO_NOT_SAVE_TEST_KEY' } }],
		} };
		const clean = normalizeModelCatalogCache(cached);
		assert.ok(!JSON.stringify(clean).includes('DO_NOT_SAVE_TEST_KEY'));
		assert.ok(!JSON.stringify(clean).includes('elsewhere.example'));
		assert.deepEqual(clean.providers.openai[0].capabilities, { acceptsImages: true });
		for (const invalid of [null, [], { fetchedAt: -1 }, { fetchedAt: 100, providers: { openai: [{ id: 3 }] } }]) {
			assert.equal(normalizeModelCatalogCache(invalid), undefined);
		}
	});

	test('cache metadata is excluded from settings serialisation', () => {
		const settings = createDefaultSettings();
		settings.modelCatalogCache = { fetchedAt: 100, providers: { openai: [{ id: 'one', displayName: 'One' }] } };
		assert.ok(!('modelCatalogCache' in normalizeSettings(settings)));
	});

	test('a missing, malformed or unreadable cache never prevents discovery', async t => {
		const disk = await createCacheFile(t);
		assert.equal(await disk.file.load(), undefined);
		for (const invalid of ['not JSON', 'null', '{"fetchedAt":-1}']) {
			await disk.adapter.write(disk.file.path, invalid);
			assert.equal(await disk.file.load(), undefined);
		}
		const unreadable = new ModelCatalogCacheFile({
			read: async () => { throw new Error('permission denied'); },
			write: disk.adapter.write,
		}, disk.pluginDirectory);
		const discovery = createDiscovery(async () => ({ status: 200, json: catalog([{ id: 'one', name: 'Fresh name' }]) }), 1000, () => 100, unreadable);
		assert.deepEqual(await discovery.refreshCatalog(), { ok: true });
		assert.equal(discovery.getModels('openai', [], ['one'])[0].displayName, 'Fresh name');
		assert.equal((await disk.file.load()).providers.openai[0].displayName, 'Fresh name');
	});

	test('a failed cache write keeps fresh metadata usable without touching another file', async t => {
		const disk = await createCacheFile(t);
		const writes = [];
		const readOnly = new ModelCatalogCacheFile({
			read: disk.adapter.read,
			write: async path => { writes.push(path); throw new Error('read-only filesystem'); },
		}, disk.pluginDirectory);
		const discovery = createDiscovery(async () => ({ status: 200, json: catalog([{ id: 'one', name: 'Fresh name' }]) }), 1000, () => 100, readOnly);
		assert.deepEqual(await discovery.refreshCatalog(), { ok: true });
		assert.equal(discovery.getModels('openai', [], ['one'])[0].displayName, 'Fresh name');
		assert.deepEqual(writes, ['.custom-config/plugins/auto-anki/model-catalog-cache.json']);
	});

	test('concurrent catalogue refreshes share restoration, download and disk save', async t => {
		const disk = await createCacheFile(t);
		const pending = deferred();
		let downloads = 0;
		const discovery = createDiscovery(async () => { downloads++; return pending.promise; }, 1000, () => 100, disk.file);
		const first = discovery.refreshCatalog();
		assert.equal(discovery.refreshCatalog(true), first);
		pending.resolve({ status: 200, json: catalog([{ id: 'one' }]) });
		await first;
		assert.equal(downloads, 1);
		assert.equal(disk.writes.length, 1);
	});

	test('catalogue connection addresses cannot redirect provider requests', async () => {
		const requests = [];
		const discovery = createDiscovery(async request => {
			requests.push(request);
			return request.url === MODEL_CATALOG_URL ? { status: 200, json: {
				openai: { api: 'https://another-host.example/v1', npm: 'another-sdk', models: { one: { id: 'one' } } },
			} } : reply([{ id: 'one' }]);
		});
		await discovery.refreshCatalog();
		await discovery.refreshProvider('openai', 'key');
		assert.equal(requests[1].url, 'https://api.openai.com/v1/models');
		assert.equal(requests[1].headers.Authorization, 'Bearer key');
	});
});

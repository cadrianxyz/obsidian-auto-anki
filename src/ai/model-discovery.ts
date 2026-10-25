import { requestUrl, type RequestUrlParam } from 'obsidian';
import { MODEL_CATALOG_URL, normalizeModelCatalogCache, readModelCatalog, type ModelCatalog, type ModelCatalogCache } from './model-catalog';
import type { ModelCatalogCacheFile } from './model-catalog-cache';
import { OutputMode, type ModelCapabilities, type ProviderModelInfo } from './model-info';
import { PROVIDER_IDS, PROVIDER_PRESETS, type ProviderId } from './presets';
import { asRecord } from '../utils/data';
import { type ModelSettings } from '../settings/model';

export const MODEL_DISCOVERY_TIMEOUT_MS = 10000;
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MODEL_LIST_PAGES = 100;

interface DiscoveryResponse {
	status: number;
	json: unknown;
}

export type ModelDiscoveryRequest = (request: RequestUrlParam) => Promise<DiscoveryResponse>;
export type ModelRefreshResult = { ok: true } | { ok: false; error: string };

interface ProviderRefresh {
	apiKey: string;
	task: Promise<ModelRefreshResult>;
	cancel: () => void;
}

/**
 * The model picker reads provider IDs plus saved/manual IDs. Catalogue metadata adds
 * labels and hints, but never decides which provider to contact or changes user settings.
 * Public metadata is restored/saved through an optional ModelCatalogCacheFile in the
 * installed plugin folder, separately from settings. In-flight requests and account
 * availability stay in memory: API keys and access may differ across devices.
 * This service makes only metadata GET requests, never card-generation requests.
 * Startup and provider settings use this service; see docs/model-discovery.md.
 */
export class ModelDiscovery {
	private readonly models = new Map<ProviderId, ProviderModelInfo[]>();
	private readonly providerRefreshes = new Map<ProviderId, ProviderRefresh>();
	private catalog: ModelCatalog = {};
	private catalogFetchedAt: number | null = null;
	private catalogRefresh: Promise<ModelRefreshResult> | null = null;
	private catalogRestore: Promise<void> | null = null;

	constructor(
		private readonly send: ModelDiscoveryRequest = requestUrl,
		private readonly timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
		private readonly now: () => number = Date.now,
		private readonly cacheFile?: ModelCatalogCacheFile,
	) {}

	/** Restore disk metadata once, without network access. refreshCatalog also calls this. */
	restoreCatalog(): Promise<void> {
		if (this.catalogRestore) return this.catalogRestore;
		this.catalogRestore = (async () => {
			const cached = await this.cacheFile?.load();
			if (!cached) return;
			if (Object.keys(cached.providers).length) this.catalogFetchedAt = cached.fetchedAt;
			for (const id of PROVIDER_IDS) {
				const models = cached.providers[id];
				if (models) this.catalog[id] = new Map(models.map(model => [model.id, model]));
			}
		})();
		return this.catalogRestore;
	}

	/** Return a detached, JSON-safe snapshot containing only public catalogue metadata. */
	getCatalogCache(): ModelCatalogCache | undefined {
		if (this.catalogFetchedAt === null) return undefined;
		const providers: ModelCatalogCache['providers'] = {};
		for (const id of PROVIDER_IDS) {
			const models = this.catalog[id];
			if (models) providers[id] = [...models.values()];
		}
		return normalizeModelCatalogCache({ fetchedAt: this.catalogFetchedAt, providers });
	}

	/** A key changed in settings; discard the previous account's live list and pending reply. */
	clearProvider(providerId: ProviderId): void {
		this.providerRefreshes.get(providerId)?.cancel();
		this.providerRefreshes.delete(providerId);
		this.models.delete(providerId);
	}

	/** Refresh the live list. A failed refresh leaves the last successful list available. */
	refreshProvider(providerId: ProviderId, key: string): Promise<ModelRefreshResult> {
		const apiKey = key.trim();
		if (!apiKey) return Promise.resolve({ ok: false, error: `Add an API key for ${PROVIDER_PRESETS[providerId].name} before refreshing models.` });
		const pending = this.providerRefreshes.get(providerId);
		if (pending?.apiKey === apiKey) return pending.task;
		pending?.cancel();

		// A key changed during discovery starts a fresh request. An older response must
		// not replace the newer account's model list when it eventually arrives.
		let active = true;
		const task = this.withTimeout(this.fetchProvider(providerId, apiKey, () => active)).then<ModelRefreshResult>(models => {
			if (this.providerRefreshes.get(providerId)?.task === task) this.models.set(providerId, models);
			return { ok: true };
		}).catch((error: unknown): ModelRefreshResult => ({ ok: false, error: this.errorMessage(error) })).finally(() => {
			active = false;
			if (this.providerRefreshes.get(providerId)?.task === task) this.providerRefreshes.delete(providerId);
		});
		this.providerRefreshes.set(providerId, { apiKey, task, cancel: () => { active = false; } });
		return task;
	}

	/** Load optional public metadata at most daily, or immediately on an explicit refresh. */
	refreshCatalog(force = false): Promise<ModelRefreshResult> {
		if (this.catalogRefresh) return this.catalogRefresh;
		const task = this.restoreCatalog().then(async (): Promise<ModelRefreshResult> => {
			const age = this.catalogFetchedAt === null ? null : this.now() - this.catalogFetchedAt;
			if (!force && age !== null && age >= 0 && age < MODEL_CATALOG_MAX_AGE_MS) return { ok: true };
			const response = await this.withTimeout(this.send({ url: MODEL_CATALOG_URL, method: 'GET', throw: false }));
			if (response.status < 200 || response.status >= 300) throw new Error(`Model metadata could not be refreshed (HTTP ${response.status}).`);
			const catalog = readModelCatalog(response.json);
			if (!catalog) throw new Error('The model metadata response was unreadable.');
			for (const providerId of PROVIDER_IDS) {
				const models = catalog[providerId];
				if (models) this.catalog[providerId] = models;
			}
			this.catalogFetchedAt = this.now();
			const snapshot = this.getCatalogCache();
			if (snapshot) await this.cacheFile?.save(snapshot);
			return { ok: true };
		}).catch((error: unknown): ModelRefreshResult => ({ ok: false, error: this.errorMessage(error) })).finally(() => {
			this.catalogRefresh = null;
		});
		this.catalogRefresh = task;
		return task;
	}

	/**
	 * Preserve configured and manually typed IDs even if discovery is offline or omits
	 * them. Metadata precedence is provider response, saved results, then public catalogue.
	 * Explicit user overrides (output mode, images, effort, token limit) remain untouched.
	 */
	getModels(providerId: ProviderId, configured: readonly ModelSettings[] = [], manualIds: readonly string[] = []): ProviderModelInfo[] {
		const saved = new Map(configured.map(model => [model.id, model]));
		const live = new Map((this.models.get(providerId) ?? []).map(model => [model.id, model]));
		const ids = new Set([...saved.keys(), ...live.keys(), ...manualIds.map(id => id.trim()).filter(Boolean)]);
		return [...ids].map(id => {
			const catalog = this.catalog[providerId]?.get(id);
			const remote = live.get(id);
			const capabilities = { ...catalog?.capabilities, ...saved.get(id)?.capabilities, ...remote?.capabilities };
			// API replies sometimes contain only an ID; use a catalogue label in that case.
			const displayName = remote && remote.displayName !== id ? remote.displayName : catalog?.displayName ?? id;
			const model: ProviderModelInfo = { id, displayName };
			if (catalog?.outputModalities) model.outputModalities = [...catalog.outputModalities];
			if (catalog?.isEmbedding) model.isEmbedding = true;
			if (catalog?.releaseDate) model.releaseDate = catalog.releaseDate;
			if (Object.keys(capabilities).length) {
				model.capabilities = { ...capabilities };
				if (capabilities.reasoningEfforts) model.capabilities.reasoningEfforts = [...capabilities.reasoningEfforts];
			}
			const limit = remote?.maxOutputTokens ?? catalog?.maxOutputTokens;
			if (limit !== undefined) model.maxOutputTokens = limit;
			return model;
		});
	}

	private async fetchProvider(providerId: ProviderId, apiKey: string, active: () => boolean): Promise<ProviderModelInfo[]> {
		const preset = PROVIDER_PRESETS[providerId];
		const headers = { ...preset.headers, [preset.apiKeyHeader]: `${preset.apiKeyPrefix}${apiKey}` };
		const models = new Map<string, ProviderModelInfo>();
		const cursors = new Set<string>();
		let after: string | undefined;
		for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
			// requestUrl cannot abort a request already sent. After cancellation or a
			// timeout, prevent that request's late reply from starting further pages.
			if (!active()) throw new Error('Model discovery was superseded or timed out.');
			const url = new URL(`${preset.baseUrl}${preset.modelsPath}`);
			if (after !== undefined) url.searchParams.set('after_id', after);
			const response = await this.send({ url: url.href, method: 'GET', headers, throw: false });
			const body = asRecord(response.json);
			if (response.status < 200 || response.status >= 300) {
				const message = asRecord(body.error).message;
				throw new Error(`${preset.name} could not list models (HTTP ${response.status}).${typeof message === 'string' ? ` ${message}` : ''}`);
			}
			if (!Array.isArray(body.data)) throw new Error(`${preset.name} returned an unreadable model list.`);
			let valid = 0;
			for (const item of body.data) {
				const model = readProviderModelInfo(providerId, item);
				if (model) { models.set(model.id, model); valid++; }
			}
			if (body.data.length && !valid) throw new Error(`${preset.name} returned no readable model entries.`);
			if (providerId !== 'anthropic' || body.has_more !== true) return [...models.values()];
			if (typeof body.last_id !== 'string' || !body.last_id || cursors.has(body.last_id)) {
				throw new Error('Claude returned an invalid model-list cursor.');
			}
			after = body.last_id;
			cursors.add(after);
		}
		throw new Error('The model list exceeded the discovery page limit.');
	}

	private async withTimeout<T>(task: Promise<T>): Promise<T> {
		let timer: number | undefined;
		try {
			return await Promise.race([task, new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error('Model discovery timed out. You can retry or enter a model ID manually.')), this.timeoutMs);
			})]);
		}
		finally {
			window.clearTimeout(timer);
		}
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : 'Model discovery failed.';
	}
}

/**
 * Required translation at the provider-list boundary:
 * fetchProvider() -> raw /models entry -> readProviderModelInfo() -> getModels().
 * The two providers return different field names; this validates them before merging.
 * Common model types and offline reasoning-option selection live in model-info.ts.
 */
export function readProviderModelInfo(providerId: ProviderId, value: unknown): ProviderModelInfo | null {
	const stored = asRecord(value);
	if (typeof stored.id !== 'string' || !stored.id.trim()) return null;
	const id = stored.id.trim();
	const model: ProviderModelInfo = { id, displayName: id };
	if (providerId !== 'anthropic') return model;
	if (typeof stored.display_name === 'string' && stored.display_name.trim()) model.displayName = stored.display_name;
	if (typeof stored.max_tokens === 'number' && Number.isSafeInteger(stored.max_tokens) && stored.max_tokens > 0) {
		model.maxOutputTokens = stored.max_tokens;
	}
	const reported = asRecord(stored.capabilities);
	const capabilities: ModelCapabilities = {};
	const images = asRecord(reported.image_input);
	if (typeof images.supported === 'boolean') capabilities.acceptsImages = images.supported;
	const structured = asRecord(reported.structured_outputs);
	if (structured.supported === true) capabilities.outputMode = OutputMode.JsonSchema;
	const effort = asRecord(reported.effort);
	if (effort.supported === false) capabilities.reasoningEfforts = [];
	else if (effort.supported === true) {
		const levels = Object.entries(effort).filter(([key, value]) => key !== 'supported' && key !== 'default'
			&& typeof asRecord(value).supported === 'boolean');
		if (levels.length) capabilities.reasoningEfforts = levels.filter(([, value]) => asRecord(value).supported === true).map(([key]) => key);
	}
	if (Object.keys(capabilities).length) model.capabilities = capabilities;
	return model;
}

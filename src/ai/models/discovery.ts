import { requestUrl, type RequestUrlParam } from 'obsidian';
import { MODEL_CATALOG_CACHE_VERSION, MODEL_CATALOG_URL, parseModelCatalog, type ModelCatalog, type ModelCatalogCache } from './catalog';
import type { ModelCatalogCacheFile } from './catalog-cache';
import type { ProviderModelInfo } from './metadata';
import { getProvider } from '../registry';
import { ModelListError, SDKConfigurationError } from '../sdk';
import { PROVIDER_IDS, PROVIDER_NAMES, type ProviderId } from '../providers';
import { asRecord } from '../../utils/data';
import { type ModelSettings } from '../../settings/schema';

export const MODEL_DISCOVERY_TIMEOUT_MS = 10000;
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
 * Refresh available models and merge them with saved choices and public metadata.
 * Failed or superseded requests never replace the last successful provider list.
 */
export class ModelDiscovery {
	private readonly models = new Map<ProviderId, ProviderModelInfo[]>();
	private readonly providerRefreshes = new Map<ProviderId, ProviderRefresh>();
	private catalog: ModelCatalog = {};
	private catalogFetchedAt: number | null = null;
	private catalogVersion: number | undefined;
	private catalogRefresh: Promise<ModelRefreshResult> | null = null;
	private catalogRestore: Promise<void> | null = null;

	constructor(
		private readonly send: ModelDiscoveryRequest = requestUrl,
		private readonly timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
		private readonly now: () => number = Date.now,
		private readonly cacheFile?: ModelCatalogCacheFile,
		private readonly sdkFetch?: typeof fetch,
	) {}

	// --- Public catalogue cache ---

	/** Restore disk metadata once, without network access. refreshCatalog also calls this. */
	restoreCatalog(): Promise<void> {
		if (this.catalogRestore) return this.catalogRestore;
		const restore = async (): Promise<void> => {
			const cached = await this.cacheFile?.load();
			if (!cached) return;
			this.catalogFetchedAt = cached.fetchedAt;
			this.catalogVersion = cached.version;
			for (const id of PROVIDER_IDS) {
				const models = cached.providers[id];
				if (models) this.catalog[id] = new Map(models.map(model => [model.id, model]));
			}
		};
		this.catalogRestore = restore();
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
		const cache: ModelCatalogCache = { fetchedAt: this.catalogFetchedAt, providers: structuredClone(providers) };
		if (this.catalogVersion !== undefined) cache.version = this.catalogVersion;
		return cache;
	}

	// --- Provider refreshes ---

	/** A key changed in settings; discard the previous account's live list and pending reply. */
	clearProvider(providerId: ProviderId): void {
		this.providerRefreshes.get(providerId)?.cancel();
		this.providerRefreshes.delete(providerId);
		this.models.delete(providerId);
	}

	/** Refresh the live list. A failed refresh leaves the last successful list available. */
	refreshProvider(providerId: ProviderId, key: string): Promise<ModelRefreshResult> {
		const apiKey = key.trim();
		const pending = this.providerRefreshes.get(providerId);
		if (apiKey && pending?.apiKey === apiKey) return pending.task;
		pending?.cancel();
		if (!apiKey) return Promise.resolve({ ok: false, error: `Add an API key for ${PROVIDER_NAMES[providerId]} before refreshing models.` });

		const controller = new AbortController();
		const cancel = (): void => controller.abort(new Error('Model discovery was superseded or cleared.'));
		let timer: number | undefined;
		const aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener('abort', () => {
				const reason: unknown = controller.signal.reason;
				reject(reason instanceof Error ? reason : new Error('Model discovery was cancelled.'));
			}, { once: true });
			timer = window.setTimeout(() => controller.abort(new Error('Model discovery timed out. You can retry or enter a model ID manually.')), this.timeoutMs);
		});
		const refresh = async (): Promise<ModelRefreshResult> => {
			try {
				const models = await Promise.race([
					getProvider(providerId).fetchModels({ apiKey, timeoutMs: this.timeoutMs, signal: controller.signal, fetch: this.sdkFetch }), aborted,
				]);
				if (!controller.signal.aborted && this.providerRefreshes.get(providerId)?.task === task) this.models.set(providerId, models);
				return { ok: true };
			} catch (error: unknown) {
				// SDK connection errors can wrap validation failures from the fetch boundary.
								const local = [error, asRecord(error).cause].find(value => value instanceof SDKConfigurationError || value instanceof ModelListError);
								if (local instanceof Error) return { ok: false, error: local.message };
				const status = asRecord(error).status;
				// Do not surface SDK messages: they may include credentials, request
				// details, or arbitrary text echoed by a provider or proxy.
				const message = controller.signal.aborted ? this.errorMessage(controller.signal.reason)
					: typeof status === 'number' ? `${PROVIDER_NAMES[providerId]} could not list models (HTTP ${status}). Check your API key and provider access.`
					: `${PROVIDER_NAMES[providerId]} could not list models. Check your connection and retry.`;
				return { ok: false, error: message };
			} finally {
				window.clearTimeout(timer);
				if (this.providerRefreshes.get(providerId)?.task === task) this.providerRefreshes.delete(providerId);
			}
		};
		const task = refresh();
		this.providerRefreshes.set(providerId, { apiKey, task, cancel });
		return task;
	}

	// --- Public catalogue refresh ---

	/** Load optional public metadata at most daily, or immediately on an explicit refresh. */
	refreshCatalog(force = false): Promise<ModelRefreshResult> {
		if (this.catalogRefresh) return this.catalogRefresh;
		const refresh = async (): Promise<ModelRefreshResult> => {
			try {
				await this.restoreCatalog();
				const age = this.catalogFetchedAt === null ? null : this.now() - this.catalogFetchedAt;
				const current = this.catalogVersion === MODEL_CATALOG_CACHE_VERSION;
				if (!force && current && age !== null && age >= 0 && age < MODEL_CATALOG_MAX_AGE_MS) return { ok: true };
				const response = await this.withTimeout(this.send({ url: MODEL_CATALOG_URL, method: 'GET', throw: false }));
				if (response.status < 200 || response.status >= 300) throw new Error(`Model metadata could not be refreshed (HTTP ${response.status}).`);
				const catalog = parseModelCatalog(response.json);
				if (!catalog) throw new Error('The model metadata response was unreadable.');
				for (const providerId of PROVIDER_IDS) {
					const models = catalog[providerId];
					if (models) this.catalog[providerId] = models;
				}
				this.catalogFetchedAt = this.now();
				this.catalogVersion = MODEL_CATALOG_CACHE_VERSION;
				if (this.cacheFile) {
					const snapshot = this.getCatalogCache();
					if (snapshot) await this.cacheFile.save(snapshot);
				}
				return { ok: true };
			} catch (error: unknown) {
				return { ok: false, error: this.errorMessage(error) };
			} finally {
				this.catalogRefresh = null;
			}
		};
		const task = refresh();
		this.catalogRefresh = task;
		return task;
	}

	// --- Model choices ---

	/**
	 * Keep configured and manually entered IDs even when discovery is unavailable or omits them.
	 * Capabilities prefer provider data, then the catalogue, then saved capabilities. Saved
	 * capabilities are an offline copy of earlier discovery, so they must not hide newer
	 * metadata such as added reasoning levels. Labels and token limits prefer provider
	 * data, then the catalogue.
	 * Return merged metadata without changing configured settings or user overrides.
	 */
	getModels(providerId: ProviderId, configured: readonly ModelSettings[] = [], manualIds: readonly string[] = []): ProviderModelInfo[] {
		const saved = new Map(configured.map(model => [model.id, model]));
		const live = new Map((this.models.get(providerId) ?? []).map(model => [model.id, model]));
		const ids = new Set([...saved.keys(), ...live.keys(), ...manualIds.map(id => id.trim()).filter(Boolean)]);
		return [...ids].map(id => {
			const catalog = this.catalog[providerId]?.get(id);
			const remote = live.get(id);
			const capabilities = { ...saved.get(id)?.capabilities, ...catalog?.capabilities, ...remote?.capabilities };
			// API replies sometimes contain only an ID; use a catalogue label in that case.
			const displayName = remote && remote.displayName !== id ? remote.displayName : catalog?.displayName ?? id;
			const model: ProviderModelInfo = { id, displayName };
			if (catalog?.outputModalities) model.outputModalities = [...catalog.outputModalities];
			if (catalog?.isEmbedding) model.isEmbedding = true;
			if (catalog?.releaseDate) model.releaseDate = catalog.releaseDate;
			if (Object.keys(capabilities).length) {
				model.capabilities = capabilities;
				if (capabilities.reasoningEfforts) model.capabilities.reasoningEfforts = [...capabilities.reasoningEfforts];
			}
			const limit = remote?.maxOutputTokens ?? catalog?.maxOutputTokens;
			if (limit !== undefined) model.maxOutputTokens = limit;
			return model;
		});
	}

	// --- Catalogue request deadline ---

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

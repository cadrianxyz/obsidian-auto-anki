import { PROVIDER_IDS, type ProviderId } from '../providers';
import { normalizeModelCapabilities, type ModelCapabilities, type ProviderModelInfo } from './metadata';
import { asRecord } from '../../utils/data';

export const MODEL_CATALOG_URL = 'https://models.dev/api.json';

/** Supplementary labels and capabilities, keyed by the two providers supported in 1.0. */
export type ModelCatalog = Partial<Record<ProviderId, Map<string, ProviderModelInfo>>>;

/**
 * Raise this when parsing extracts new metadata. A cache written by an older parser
 * stays usable offline, but is downloaded again instead of being trusted for a day.
 */
export const MODEL_CATALOG_CACHE_VERSION = 3;

/** Public catalogue snapshot for the separate cache file; no credentials or account access lists. */
export interface ModelCatalogCache {
	fetchedAt: number;
	/** The parser version that wrote the cache. Missing means an unversioned, older cache. */
	version?: number;
	providers: Partial<Record<ProviderId, ProviderModelInfo[]>>;
}

/**
 * models.dev is a public, independently maintained database of AI model names,
 * input formats and token limits (https://models.dev). It supplements the model
 * list returned by the provider; an absent catalogue entry never blocks a model.
 *
 * Parse model metadata only. Ignore connection addresses and SDK package fields
 * so catalogue data cannot redirect authenticated requests.
 */
export function parseModelCatalog(value: unknown): ModelCatalog | null {
	const root = asRecord(value);
	const catalog: ModelCatalog = {};
	for (const providerId of PROVIDER_IDS) {
		const models = asRecord(asRecord(root[providerId]).models);
		const parsed = new Map<string, ProviderModelInfo>();
		for (const value of Object.values(models)) {
			const stored = asRecord(value);
			if (typeof stored.id !== 'string' || !stored.id.trim()) continue;
			const id = stored.id.trim();
			const model: ProviderModelInfo = { id, displayName: typeof stored.name === 'string' && stored.name.trim() ? stored.name : id };
			applySelectionMetadata(stored, model);
			const capabilities: ModelCapabilities = {};
			const input: unknown = asRecord(stored.modalities).input;
			if (Array.isArray(input) && input.length && input.every((item: unknown) => typeof item === 'string')) {
				capabilities.acceptsImages = input.includes('image');
			}
			// reasoning_options lists a model's controls; only an "effort" entry names levels.
			// Without the list the levels are unknown: never infer them from a model's name.
			const options: unknown = stored.reasoning_options;
			if (stored.reasoning === false) capabilities.reasoningEfforts = [];
			else if (Array.isArray(options)) {
				const effort = options.map(asRecord).find(option => option.type === 'effort');
				const levels: unknown = effort?.values;
				if (!effort) capabilities.reasoningEfforts = [];
				else if (Array.isArray(levels) && levels.every((level: unknown) => typeof level === 'string' && level.trim().length > 0)) {
					capabilities.reasoningEfforts = [...new Set((levels as string[]).filter(level => level !== 'default'))];
				}
			}
			if (Object.keys(capabilities).length) model.capabilities = capabilities;
			const limit = asRecord(stored.limit).output;
			if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0) model.maxOutputTokens = limit;
			parsed.set(id, model);
		}
		if (parsed.size) catalog[providerId] = parsed;
	}
	return Object.keys(catalog).length ? catalog : null;
}

/**
 * JSON parsing does not validate types: old or edited caches may contain invalid metadata.
 * Rebuild an allowlisted snapshot so unknown fields are dropped and valid entries survive
 * alongside malformed ones. Return undefined when no usable cache remains.
 */
export function normalizeModelCatalogCache(value: unknown): ModelCatalogCache | undefined {
	const stored = asRecord(value);
	// Without a usable fetch time, cache freshness cannot be determined.
	if (typeof stored.fetchedAt !== 'number' || !Number.isSafeInteger(stored.fetchedAt) || stored.fetchedAt < 0) return undefined;
	const providers: ModelCatalogCache['providers'] = {};
	const savedProviders = asRecord(stored.providers);
	for (const id of PROVIDER_IDS) {
		const entries: unknown = savedProviders[id];
		if (!Array.isArray(entries)) continue;
		const models = new Map<string, ProviderModelInfo>();
		for (const entry of entries) {
			const data = asRecord(entry);
			if (typeof data.id !== 'string' || !data.id.trim()) continue;
			const model: ProviderModelInfo = {
				id: data.id.trim(),
				displayName: typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName : data.id.trim(),
			};
			applySelectionMetadata({
				modalities: { output: data.outputModalities }, release_date: data.releaseDate,
				isEmbedding: data.isEmbedding,
			}, model);
			const capabilities = normalizeModelCapabilities(data.capabilities);
			if (capabilities) model.capabilities = capabilities;
			if (typeof data.maxOutputTokens === 'number' && Number.isSafeInteger(data.maxOutputTokens) && data.maxOutputTokens > 0) {
				model.maxOutputTokens = data.maxOutputTokens;
			}
			models.set(model.id, model);
		}
		if (models.size) providers[id] = [...models.values()];
	}
	if (!Object.keys(providers).length) return undefined;
	const cache: ModelCatalogCache = { fetchedAt: stored.fetchedAt, providers };
	if (typeof stored.version === 'number' && Number.isSafeInteger(stored.version) && stored.version > 0) cache.version = stored.version;
	return cache;
}

/** Apply validated filtering and release-date metadata to a model. */
function applySelectionMetadata(stored: Record<string, unknown>, model: ProviderModelInfo): void {
	const output: unknown = asRecord(stored.modalities).output;
	if (Array.isArray(output) && output.every((item: unknown) => typeof item === 'string' && item.trim())) {
		model.outputModalities = [...new Set(output as string[])];
	}
	// Some entries lack an embedding flag, so also check the model ID and family.
	if (stored.isEmbedding === true || /(^|[-_/.\s])embed(ding)?($|[-_/.\s])/i.test(`${model.id} ${typeof stored.family === 'string' ? stored.family : ''}`)) {
		model.isEmbedding = true;
	}
	if (typeof stored.release_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored.release_date)) {
		const timestamp = Date.parse(stored.release_date);
		// Date.parse can turn February 30 into a March date, so check it still matches.
		if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === stored.release_date) model.releaseDate = stored.release_date;
	}
}

import { PROVIDER_IDS, type ProviderId } from './presets';
import { normalizeModelCapabilities, type ModelCapabilities, type ProviderModelInfo } from './model-info';
import { asRecord } from '../utils/data';

export const MODEL_CATALOG_URL = 'https://models.dev/api.json';

/** Supplementary labels and capabilities, keyed by the two providers supported in 1.0. */
export type ModelCatalog = Partial<Record<ProviderId, Map<string, ProviderModelInfo>>>;

/** Public catalogue snapshot for the separate cache file; no credentials or account access lists. */
export interface ModelCatalogCache {
	fetchedAt: number;
	providers: Partial<Record<ProviderId, ProviderModelInfo[]>>;
}

/**
 * models.dev is a public, independently maintained database of AI model names,
 * input formats and token limits (https://models.dev). It supplements the model
 * list returned by the provider; an absent catalogue entry never blocks a model.
 *
 * The catalogue also describes connection addresses and SDK packages. We do not
 * use those fields: 1.0's two hosted providers use the documented endpoints in
 * presets.ts, so downloading labels cannot change where an API key is sent.
 * SDK package names configure other libraries; this plugin uses requestUrl directly.
 */
export function readModelCatalog(value: unknown): ModelCatalog | null {
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
			readSelectionMetadata(stored, model);
			const capabilities: ModelCapabilities = {};
			const input: unknown = asRecord(stored.modalities).input;
			if (Array.isArray(input) && input.length && input.every((item: unknown) => typeof item === 'string')) {
				capabilities.acceptsImages = input.includes('image');
			}
			// models.dev exposes reasoning support, not the exact effort levels. Do not
			// invent levels from a model's name or assume "reasoning: true" supports all.
			if (stored.reasoning === false) capabilities.reasoningEfforts = [];
			if (Object.keys(capabilities).length) model.capabilities = capabilities;
			const limit = asRecord(stored.limit).output;
			if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0) model.maxOutputTokens = limit;
			parsed.set(id, model);
		}
		if (parsed.size) catalog[providerId] = parsed;
	}
	return Object.keys(catalog).length ? catalog : null;
}

/** Rebuild only the public metadata fields when restoring the cache file. */
export function normalizeModelCatalogCache(value: unknown): ModelCatalogCache | undefined {
	const stored = asRecord(value);
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
			readSelectionMetadata({
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
	return { fetchedAt: stored.fetchedAt, providers };
}

/** Keep only the fields needed for model selection, including when restoring a cache. */
function readSelectionMetadata(stored: Record<string, unknown>, model: ProviderModelInfo): void {
	const output: unknown = asRecord(stored.modalities).output;
	if (Array.isArray(output) && output.length && output.every((item: unknown) => typeof item === 'string' && item.trim())) {
		model.outputModalities = [...new Set(output as string[])];
	}
	if (stored.isEmbedding === true || /(^|[-_/.\s])embed(ding)?($|[-_/.\s])/i.test(`${model.id} ${typeof stored.family === 'string' ? stored.family : ''}`)) {
		model.isEmbedding = true;
	}
	if (typeof stored.release_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored.release_date)) {
		const timestamp = Date.parse(stored.release_date);
		if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === stored.release_date) model.releaseDate = stored.release_date;
	}
}

import { normalizePath, type DataAdapter } from 'obsidian';
import { normalizeModelCatalogCache, type ModelCatalogCache } from './catalog';

export const MODEL_CATALOG_CACHE_FILENAME = 'model-catalog-cache.json';

/**
 * Stores replaceable public metadata beside the installed plugin, separately from
 * data.json. Pass plugin.manifest.dir, so a custom Obsidian config folder works too.
 * Read/write failures are harmless: discovery can use fresh data in memory instead.
 */
export class ModelCatalogCacheFile {
	readonly path: string;

	constructor(private readonly adapter: Pick<DataAdapter, 'read' | 'write'>, pluginDirectory: string) {
		if (!pluginDirectory.trim()) throw new Error('The installed plugin directory is required for the model cache.');
		this.path = normalizePath(`${pluginDirectory}/${MODEL_CATALOG_CACHE_FILENAME}`);
	}

	async load(): Promise<ModelCatalogCache | undefined> {
		try {
			const value: unknown = JSON.parse(await this.adapter.read(this.path));
			return normalizeModelCatalogCache(value);
		}
		catch {
			// A missing, unreadable or malformed cache is equivalent to no cache.
			return undefined;
		}
	}

	async save(value: ModelCatalogCache): Promise<void> {
		// Persist only public cache fields, even if the supplied object has extra runtime properties.
		const cache = normalizeModelCatalogCache(value);
		if (!cache) return;
		try {
			await this.adapter.write(this.path, JSON.stringify(cache));
		}
		catch {
			// Keep downloaded metadata usable even when the cache file cannot be written.
		}
	}
}

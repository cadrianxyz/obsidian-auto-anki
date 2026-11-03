import { createClient } from './client';
import type { FetchModelsRequest } from '../registry';
import { OutputMode } from '../generation';
import type { ModelCapabilities, ProviderModelInfo } from '../models/metadata';
import { ModelListError } from '../sdk';
import { asRecord } from '../../utils/data';

const MAX_MODEL_LIST_PAGES = 100;

/** Fetch and validate model metadata through the Anthropic SDK's models.list(), following its pages. */
export async function fetchModels({ apiKey, timeoutMs, signal, fetch: sdkFetch = window.fetch.bind(window) }: FetchModelsRequest): Promise<ProviderModelInfo[]> {
	// Validate before SDK page normalization can turn missing data into an empty list.
	const validatedFetch: typeof fetch = async (input, init) => {
		const response = await sdkFetch(input, init);
		if (response.ok) {
			const body = asRecord(await response.clone().json());
			if (!Array.isArray(body.data)) throw new ModelListError('Claude returned an unreadable model list.');
		}
		return response;
	};
	let page = await createClient(apiKey, { timeoutMs, fetch: validatedFetch }).models.list({}, { signal });
	const models = new Map<string, ProviderModelInfo>();
	const cursors = new Set<string>();
	for (let count = 0; count < MAX_MODEL_LIST_PAGES; count++) {
		signal.throwIfAborted();
		if (!Array.isArray(page.data)) throw new ModelListError('Claude returned an unreadable model list.');
		let valid = 0;
		for (const item of page.data) {
			const model = parseModel(item);
			if (model) { models.set(model.id, model); valid++; }
		}
		if (page.data.length && !valid) throw new ModelListError('Claude returned no readable model entries.');
		if (page.has_more !== true) return [...models.values()];
		if (typeof page.last_id !== 'string' || !page.last_id.trim() || cursors.has(page.last_id)) {
			throw new ModelListError('Claude returned an invalid model-list cursor.');
		}
		cursors.add(page.last_id);
		if (count + 1 === MAX_MODEL_LIST_PAGES) break;
		page = await page.getNextPage();
	}
	throw new ModelListError('The model list exceeded the discovery page limit.');
}

function parseModel(value: unknown): ProviderModelInfo | null {
	const stored = asRecord(value);
	if (typeof stored.id !== 'string' || !stored.id.trim()) return null;
	const id = stored.id.trim();
	const model: ProviderModelInfo = { id, displayName: id };
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

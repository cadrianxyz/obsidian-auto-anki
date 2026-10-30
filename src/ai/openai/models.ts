import { createClient } from './client';
import type { FetchModelsRequest } from '../registry';
import type { ProviderModelInfo } from '../models/metadata';
import { ModelListError } from '../sdk';
import { asRecord } from '../../utils/data';

/** Fetch and validate model metadata through the OpenAI SDK's models.list() method. */
export async function fetchModels({ apiKey, timeoutMs, signal, fetch: sdkFetch = window.fetch.bind(window) }: FetchModelsRequest): Promise<ProviderModelInfo[]> {
	// Validate before SDK page normalization can turn missing data into an empty list.
	const validatedFetch: typeof fetch = async (input, init) => {
		const response = await sdkFetch(input, init);
		if (response.ok) {
			const body = asRecord(await response.clone().json());
			if (!Array.isArray(body.data)) throw new ModelListError('OpenAI returned an unreadable model list.');
		}
		return response;
	};
	const page = await createClient(apiKey, { timeoutMs, fetch: validatedFetch }).models.list({ signal });
	signal.throwIfAborted();
	if (!Array.isArray(page.data)) throw new ModelListError('OpenAI returned an unreadable model list.');
	const models = new Map<string, ProviderModelInfo>();
	let valid = 0;
	for (const item of page.data) {
		const model = parseModel(item);
		if (model) { models.set(model.id, model); valid++; }
	}
	if (page.data.length && !valid) throw new ModelListError('OpenAI returned no readable model entries.');
	return [...models.values()];
}

function parseModel(value: unknown): ProviderModelInfo | null {
	const stored = asRecord(value);
	if (typeof stored.id !== 'string' || !stored.id.trim()) return null;
	const id = stored.id.trim();
	return { id, displayName: id };
}

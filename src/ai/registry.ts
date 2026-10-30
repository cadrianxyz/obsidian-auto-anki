import type { ProviderId } from './providers';
import type { GenerationConnector } from './generation';
import type { ProviderModelInfo } from './models/metadata';
import { requestNotes as requestOpenAiNotes } from './openai/request';
import { fetchModels as fetchOpenAiModels } from './openai/models';
import { requestNotes as requestAnthropicNotes } from './anthropic/request';
import { fetchModels as fetchAnthropicModels } from './anthropic/models';

// --- Provider operations ---

export interface FetchModelsRequest {
	apiKey: string;
	timeoutMs: number;
	signal: AbortSignal;
	fetch?: typeof fetch;
}

interface ProviderImplementation {
	generate: GenerationConnector;
	fetchModels(request: FetchModelsRequest): Promise<ProviderModelInfo[]>;
}

// --- Provider routing ---

const PROVIDERS: Readonly<Record<ProviderId, ProviderImplementation>> = {
	openai: { generate: requestOpenAiNotes, fetchModels: fetchOpenAiModels },
	anthropic: { generate: requestAnthropicNotes, fetchModels: fetchAnthropicModels },
};

/** Shared workflows select an implementation here, without knowing its SDK or protocol. */
export function getProvider(providerId: ProviderId): ProviderImplementation {
	return PROVIDERS[providerId];
}

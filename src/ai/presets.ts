// Presets describe services, not a fixed list of models. The suggested model is used only
// for initial setup and the explicit 0.x → 1.0 upgrade; model choices come from /models.
export const PROVIDER_IDS = ['openai', 'anthropic'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export type Protocol = 'openai-chat' | 'anthropic-messages';

// OpenAI's model endpoint does not list accepted reasoning levels. Claude's does;
// its fallback is used only when that optional metadata is missing or unavailable.
// These are protocol-wide choices, not a guarantee that every model accepts them.
export const OPENAI_REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ANTHROPIC_REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// New reasoning levels returned by a provider must not require a plugin release.
export type ModelReasoningEffort = string;

export interface ProviderPreset {
	id: ProviderId;
	name: string;
	protocol: Protocol;
	baseUrl: string;
	modelsPath: string;
	apiKeyHeader: string;
	apiKeyPrefix: string;
	headers: Readonly<Record<string, string>>;
	outputTokenParameter: 'max_completion_tokens' | 'max_tokens';
	fallbacks: { reasoningEfforts: readonly ModelReasoningEffort[] };
	// A curated starting choice, not the list of selectable models. Neither model-list
	// endpoint recommends a default for this task; newest alone does not imply suitable.
	suggestedModel: string;
	docs: readonly string[];
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderId, ProviderPreset>> = {
	openai: {
		id: 'openai', name: 'OpenAI', protocol: 'openai-chat',
		baseUrl: 'https://api.openai.com/v1', modelsPath: '/models',
		apiKeyHeader: 'Authorization', apiKeyPrefix: 'Bearer ', headers: {},
		outputTokenParameter: 'max_completion_tokens', fallbacks: { reasoningEfforts: OPENAI_REASONING_EFFORTS },
		suggestedModel: 'gpt-6-luna',
		docs: [
			'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
			'https://developers.openai.com/api/reference/resources/models/methods/list',
			'https://developers.openai.com/api/docs/models/gpt-6-luna',
		],
	},
	anthropic: {
		id: 'anthropic', name: 'Claude', protocol: 'anthropic-messages',
		baseUrl: 'https://api.anthropic.com', modelsPath: '/v1/models',
		apiKeyHeader: 'x-api-key', apiKeyPrefix: '',
		headers: { 'anthropic-version': '2023-06-01' },
		outputTokenParameter: 'max_tokens', fallbacks: { reasoningEfforts: ANTHROPIC_REASONING_EFFORTS },
		suggestedModel: 'claude-haiku-5-5',
		docs: [
			'https://platform.claude.com/docs/en/api/messages',
			'https://platform.claude.com/docs/en/api/models/list',
			'https://platform.claude.com/docs/en/api/models/retrieve',
			'https://platform.claude.com/docs/en/models/haiku-5-5/overview',
		],
	},
};

export function providerSecretName(id: ProviderId): string {
	return `auto-anki-${id}-api-key`;
}

// --- Provider identity ---

export const PROVIDER_IDS = ['openai', 'anthropic'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
	openai: 'OpenAI',
	anthropic: 'Claude',
};

export function providerSecretName(id: ProviderId): string {
	return `auto-anki-${id}-api-key`;
}

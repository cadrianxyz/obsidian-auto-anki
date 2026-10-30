// --- Local SDK errors ---

/** Safe to display: these messages are written locally, not echoed by a remote API. */
export class SDKConfigurationError extends Error {}
export class ModelListError extends Error {}

// --- SDK environment safety ---

/** SDK custom headers can replace authentication and other pinned request headers. */
export function rejectCustomHeaders(variable: 'OPENAI_CUSTOM_HEADERS' | 'ANTHROPIC_CUSTOM_HEADERS'): void {
	const value = typeof process !== 'undefined' ? process.env?.[variable] : undefined;
	if (value?.trim()) {
		throw new SDKConfigurationError(`Auto Anki cannot safely create this API client while ${variable} is set. Unset ${variable} and restart Obsidian to use the API key from Auto Anki settings.`);
	}
}

import OpenAI from 'openai';
import { rejectCustomHeaders } from '../sdk';

// --- Pinned SDK configuration ---

export function createClient(apiKey: string, options: { timeoutMs: number; fetch?: typeof fetch }): OpenAI {
	rejectCustomHeaders('OPENAI_CUSTOM_HEADERS');
	// Desktop environment settings must not redirect credentials or enable logging.
	// No retries: an ambiguous failure must not silently repeat a paid generation.
	return new OpenAI({
		apiKey, baseURL: 'https://api.openai.com/v1', organization: null, project: null, adminAPIKey: null,
		dangerouslyAllowBrowser: true, maxRetries: 0, timeout: options.timeoutMs, logLevel: 'off',
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
}

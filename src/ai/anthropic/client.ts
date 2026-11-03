import Anthropic from '@anthropic-ai/sdk';
import { rejectCustomHeaders } from '../sdk';

export function createClient(apiKey: string, options: { timeoutMs: number; fetch?: typeof fetch }): Anthropic {
	rejectCustomHeaders('ANTHROPIC_CUSTOM_HEADERS');
	// Use the SDK's Bearer authentication without desktop credentials or telemetry.
	// An explicit timeout also permits large non-streaming output limits.
	return new Anthropic({
		apiKey, authToken: null, baseURL: 'https://api.anthropic.com',
		dangerouslyAllowBrowser: true, maxRetries: 0, timeout: options.timeoutMs,
		logLevel: 'off', openTelemetry: false,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
}

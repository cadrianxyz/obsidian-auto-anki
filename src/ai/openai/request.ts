import OpenAI from 'openai';
import type { Response, ResponseCreateParamsNonStreaming, ResponseInputContent } from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import { createClient } from './client';
import type { ModelSettings } from '../../settings/schema';
import type { GenerationPrompt } from '../../generate/prompt';
import { asRecord } from '../../utils/data';
import { generateWithFallback, GENERATION_TIMEOUT_MS, RESPONSE_TOOL, RESPONSE_TOOL_DESCRIPTION, OutputMode, type ResolvedOutputMode, type GenerationConnector } from '../generation';

// --- Request construction ---

// Response-format rules are transport details, not editable writing guidance.
function buildRequest(model: ModelSettings, prompt: GenerationPrompt, mode: ResolvedOutputMode): ResponseCreateParamsNonStreaming {
	const content: ResponseInputContent[] = [
		{ type: 'input_text', text: prompt.source },
		...prompt.diagrams.flatMap((diagram): ResponseInputContent[] => [
			{ type: 'input_text', text: `Diagram: ${diagram.name}` },
			{ type: 'input_image', detail: 'auto', image_url: `data:${diagram.mime};base64,${diagram.base64}` },
		]),
	];
	const body: ResponseCreateParamsNonStreaming = {
		model: model.id, stream: false,
		// Each generation is independent; nothing is continued through previous_response_id.
		store: false,
		instructions: prompt.instructions,
		input: [{ role: 'user', content }],
		max_output_tokens: model.maxOutputTokens,
		// Default means omit the parameter; models without reasoning may reject it.
		...(model.reasoningEffort !== 'default' ? { reasoning: { effort: model.reasoningEffort as ReasoningEffort } } : {}),
	};
	if (mode === OutputMode.JsonSchema) body.text = { format: { type: 'json_schema', name: RESPONSE_TOOL, strict: true, schema: prompt.schema } };
	else if (mode === OutputMode.Tool) {
		body.tools = [{ type: 'function', name: RESPONSE_TOOL, description: RESPONSE_TOOL_DESCRIPTION, parameters: prompt.schema, strict: true }];
		body.tool_choice = { type: 'function', name: RESPONSE_TOOL };
	}
	else body.text = { format: { type: 'json_object' } };
	return body;
}

// --- Error handling ---

/** Only an explicit unsupported-format response permits another format request. */
function isUnsupportedFormat(error: unknown, mode: ResolvedOutputMode): boolean {
	if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
	// A broken schema is our request error, not evidence that the format is unavailable.
	if (/invalid.*schema|schema.*invalid|schema validation/i.test(error.message)) return false;
	const mentionsFormat = mode === OutputMode.JsonSchema ? /text\.format|response_format|json_schema|structured.?outputs/i : /tool_choice|function.call|tools\b/i;
	return mentionsFormat.test(error.message) && /not support|unsupported|not available|not allowed|does not (?:accept|allow)/i.test(error.message);
}

function describeGenerationError(error: unknown, modelId: string): string {
	if (error instanceof OpenAI.APIConnectionTimeoutError) return 'OpenAI generation timed out. Try a smaller selection or lower reasoning effort.';
	if (error instanceof OpenAI.APIError && error.status !== undefined) {
		if (error.status === 401) return 'OpenAI rejected the API key (401). Check the key in the Auto Anki settings.';
		if (error.status === 404) return `OpenAI doesn't know the model "${modelId}" (404). Check the model in the Auto Anki settings.\n${error.message}`;
		if (error.status === 429) return `OpenAI rate limit or quota reached (429).\n${error.message}`;
		if (error.status === 400 && /reasoning[._]effort/.test(error.message)) return `The model "${modelId}" doesn't accept the chosen reasoning effort. Set Reasoning effort to Model default or pick another level.\n${error.message}`;
		if (error.status === 400 && /max_output_tokens/.test(error.message)) return `OpenAI rejected the output-token limit. Lower Maximum output tokens in this model's settings.\n${error.message}`;
		if (error.status === 400 && /image|vision/i.test(error.message)) return `The model could not accept the diagrams. Turn off Send diagrams or choose a model that accepts images.\n${error.message}`;
		return `OpenAI returned an error (${error.status}).\n${error.message}`;
	}
	if (error instanceof SyntaxError) return 'OpenAI returned no readable generation result.';
	return `Could not connect to OpenAI! ${error instanceof Error ? error.message : String(error)}`;
}

// --- Response validation ---

/**
 * Accept only a completed response. output_text alone is not enough: it would also
 * join partial text from an incomplete response or text written around a refusal.
 */
function parseResponse(response: Response, mode: ResolvedOutputMode): string {
	const reply = asRecord(response);
	if (typeof reply.status !== 'string') throw new Error('OpenAI returned no readable generation result.');
	if (reply.status === 'incomplete') {
		const reason = asRecord(reply.incomplete_details).reason;
		if (reason === 'max_output_tokens') throw new Error('The model ran out of tokens before finishing. Raise Maximum output tokens, lower Reasoning effort, or set a smaller maximum number of Anki notes.');
		if (reason === 'content_filter') throw new Error('The model declined to generate Anki notes from this material. Try a different selection or model.');
	}
	if (reply.status !== 'completed') throw new Error('The model did not finish its response, so no Anki notes were made.');
	if (!Array.isArray(reply.output) || !reply.output.length) throw new Error('OpenAI returned no readable generation result.');
	const items = reply.output.map(asRecord);
	// Reasoning items are never shown or treated as Anki note content.
	const allowed = mode === OutputMode.Tool ? ['reasoning', 'message', 'function_call'] : ['reasoning', 'message'];
	if (items.some(item => !allowed.includes(String(item.type)) || item.status === 'incomplete')) throw new Error("The model's reply wasn't in the expected format, so no Anki notes were made.");
	// Commentary is a progress update written before the final answer, not the answer itself.
	const messages = items.filter(item => item.type === 'message' && item.phase !== 'commentary');
	const parts = messages.flatMap(item => Array.isArray(item.content) ? item.content.map(asRecord) : [{}]);
	if (parts.some(part => part.type === 'refusal')) throw new Error('The model declined to generate Anki notes from this material. Try a different selection or model.');
	if (mode === OutputMode.Tool) {
		const calls = items.filter(item => item.type === 'function_call');
		const call = calls.length === 1 ? calls[0] : undefined;
		if (call?.name !== RESPONSE_TOOL || typeof call.arguments !== 'string' || !call.arguments) throw new Error("The model's reply wasn't in the expected function format, so no Anki notes were made.");
		return call.arguments;
	}
	if (parts.some(part => part.type !== 'output_text' || typeof part.text !== 'string')) throw new Error("The model's reply wasn't in the expected format, so no Anki notes were made.");
	const text = parts.map(part => part.text as string).join('');
	if (!text.trim()) throw new Error("The model's reply wasn't in the expected format, so no Anki notes were made.");
	return text;
}

// --- Generation ---
export const requestNotes: GenerationConnector = ({ apiKey, model, prompt, signal }, options = {}) => {
	const client = createClient(apiKey, { timeoutMs: options.timeoutMs ?? GENERATION_TIMEOUT_MS, fetch: options.fetch });
	return generateWithFallback<Response>(model, signal, {
		send: mode => client.responses.create(buildRequest(model, prompt, mode), { signal }),
		parse: parseResponse,
		unsupportedFormat: isUnsupportedFormat,
		describeError: error => describeGenerationError(error, model.id),
	});
};

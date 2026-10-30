import { APIError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import type { Base64ImageSource, Message, MessageCreateParamsNonStreaming, OutputConfig, Tool } from '@anthropic-ai/sdk/resources/messages';
import { createClient } from './client';
import type { ModelSettings } from '../../settings/schema';
import type { GenerationPrompt } from '../../generate/prompt';
import { asRecord } from '../../utils/data';
import { generateWithFallback, GENERATION_TIMEOUT_MS, RESPONSE_TOOL, RESPONSE_TOOL_DESCRIPTION, OutputMode, type ResolvedOutputMode, type GenerationConnector } from '../generation';

// --- Request construction ---
function buildRequest(model: ModelSettings, prompt: GenerationPrompt, mode: ResolvedOutputMode): MessageCreateParamsNonStreaming {
	const schema = prompt.schema;
	const outputConfig: OutputConfig = {};
	// A level reported by the provider may be newer than this SDK's type.
	if (model.reasoningEffort !== 'default') outputConfig.effort = model.reasoningEffort as OutputConfig['effort'];
	if (mode === OutputMode.JsonSchema) outputConfig.format = { type: 'json_schema', schema };
	const body: MessageCreateParamsNonStreaming = {
		model: model.id, max_tokens: model.maxOutputTokens, stream: false,
		system: prompt.instructions,
		messages: [{ role: 'user', content: [
			{ type: 'text', text: prompt.source },
			...prompt.diagrams.flatMap(diagram => [
				{ type: 'text' as const, text: `Diagram: ${diagram.name}` },
				{ type: 'image' as const, source: { type: 'base64' as const, media_type: diagram.mime as Base64ImageSource['media_type'], data: diagram.base64 } },
			]),
		] }],
	};
	if (Object.keys(outputConfig).length) body.output_config = outputConfig;
	if (mode === OutputMode.Tool) {
		body.tools = [{ name: RESPONSE_TOOL, description: RESPONSE_TOOL_DESCRIPTION, input_schema: schema as Tool.InputSchema }];
		body.tool_choice = { type: 'tool', name: RESPONSE_TOOL };
	}
	// Plain JSON uses the fixed prompt instructions, without prefilling an assistant
	// reply. No cache_control for individual notes: creating a cache costs extra and
	// this flow does not reuse it across a folder run.
	return body;
}

// --- Error handling ---

/** The SDK error message includes the whole JSON body; users need only the provider's explanation. */
function errorDetail(error: { error: unknown }): string {
	const detail = asRecord(asRecord(error.error).error).message;
	return typeof detail === 'string' ? detail : 'The provider returned no error details.';
}

function isUnsupportedFormat(error: unknown, mode: ResolvedOutputMode, model: ModelSettings): boolean {
	if (!(error instanceof APIError) || error.status !== 400) return false;
	const message = errorDetail(error);
	if (/\beffort\b|max_tokens|\bimages?\b|\bvision\b/i.test(message)) return false;
	if (/invalid.*schema|schema.*invalid|schema validation/i.test(message)) return false;
	const format = mode === OutputMode.JsonSchema
		? /output_config\.format|output_format|json_schema|structured.?outputs/i
		: /tool_choice|forced tool|tool use|tools\b/i;
	const unsupported = /not support|unsupported|not available|not allowed|not permitted|does not (?:accept|allow)/i.test(message);
	// Older models can reject output_config as a whole. That is unambiguously a
	// format error only when format was its sole member, without a selected effort.
	const formatOnlyConfig = mode === OutputMode.JsonSchema && model.reasoningEffort === 'default' && /output_config/i.test(message);
	return unsupported && (format.test(message) || formatOnlyConfig);
}

function describeGenerationError(error: unknown, modelId: string): string {
	if (error instanceof APIConnectionTimeoutError) return 'Claude generation timed out. Try a smaller selection or lower reasoning effort.';
	if (error instanceof APIError && error.status !== undefined) {
		const message = errorDetail(error);
		if (error.status === 401) return 'Claude rejected the API key (401). Check the key in the Auto Anki settings.';
		if (error.status === 403) return `Claude denied access (403). Check that your API account can use "${modelId}".\n${message}`;
		if (error.status === 404) return `Claude doesn't know the model "${modelId}" (404). Check the model in the Auto Anki settings.\n${message}`;
		if (error.status === 429) return `Claude rate limit or quota reached (429).\n${message}`;
		if (error.status === 529) return `Claude is temporarily overloaded (529). Try again later.\n${message}`;
		if (error.status === 400 && /effort/i.test(message)) return `The model "${modelId}" doesn't accept the chosen reasoning effort. Set Reasoning effort to Model default or pick another level.\n${message}`;
		if (error.status === 400 && /max_tokens/i.test(message)) return `Claude rejected the output-token limit. Lower Maximum output tokens in this model's settings.\n${message}`;
		if (error.status === 400 && /image|vision/i.test(message)) return `The model could not accept the diagrams. Turn off Send diagrams or choose a model that accepts images.\n${message}`;
		return `Claude returned an error (${error.status}).\n${message}`;
	}
	if (error instanceof SyntaxError) return 'Claude returned no readable generation result.';
	return 'Could not connect to Claude. Check your connection and try again.';
}

// --- Response validation ---

/** Extract one complete JSON object from a plain reply, allowing fences or surrounding prose. */
function extractJsonObject(text: string): string {
	const objects: string[] = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (start < 0) {
			if (character === '{') { start = index; depth = 1; }
			continue;
		}
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === '{') depth++;
		else if (character === '}' && --depth === 0) {
			objects.push(text.slice(start, index + 1));
			start = -1;
		}
	}
	if (objects.length !== 1 || start >= 0) throw new Error("Claude's reply wasn't in the expected format, so no Anki notes were made.");
	return objects[0];
}

function parseResponse(value: unknown, mode: ResolvedOutputMode): string {
	const message = asRecord(value);
	if (message.stop_reason === 'refusal') throw new Error('Claude declined to generate Anki notes from this material. Try a different selection or model.');
	if (message.stop_reason === 'max_tokens') throw new Error('Claude ran out of tokens before finishing. Raise Maximum output tokens, lower Reasoning effort, or set a smaller maximum number of Anki notes.');
	if (message.stop_reason === 'model_context_window_exceeded') throw new Error('The note and response exceeded this model’s context limit. Try a smaller selection.');
	if (!Array.isArray(message.content) || !message.content.length) throw new Error('Claude returned no readable generation result.');
	const blocks = message.content.map(asRecord);
	if (blocks.some(block => block.type === 'refusal')) throw new Error('Claude declined to generate Anki notes from this material. Try a different selection or model.');
	if (mode === OutputMode.Tool) {
		const calls = blocks.filter(block => block.type === 'tool_use');
		const call = calls[0];
		if (message.stop_reason !== 'tool_use' || calls.length !== 1 || call.name !== RESPONSE_TOOL || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
			throw new Error("Claude's reply wasn't in the expected function format, so no Anki notes were made.");
		}
		return JSON.stringify(call.input);
	}
	if (message.stop_reason !== 'end_turn') throw new Error('Claude did not finish its response, so no Anki notes were made.');
	// Thinking is never shown or treated as Anki note content. Only final text is parsed.
	if (blocks.some(block => !['text', 'thinking', 'redacted_thinking'].includes(String(block.type)) || (block.type === 'text' && typeof block.text !== 'string'))) {
		throw new Error('Claude returned an unreadable response, so no Anki notes were made.');
	}
	const text = blocks.filter(block => block.type === 'text').map(block => block.text as string).join('');
	if (!text.trim()) throw new Error('Claude returned no readable generation result.');
	return mode === OutputMode.Json ? extractJsonObject(text) : text;
}

// --- Generation ---
export const requestNotes: GenerationConnector = ({ apiKey, model, prompt, signal }, options = {}) => {
	const client = createClient(apiKey, { timeoutMs: options.timeoutMs ?? GENERATION_TIMEOUT_MS, fetch: options.fetch });
	return generateWithFallback<Message>(model, signal, {
		send: mode => client.messages.create(buildRequest(model, prompt, mode), { signal }),
		parse: parseResponse,
		unsupportedFormat: (error, mode) => isUnsupportedFormat(error, mode, model),
		describeError: error => describeGenerationError(error, model.id),
	});
};

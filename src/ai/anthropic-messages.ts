import { requestUrl, type RequestUrlParam } from 'obsidian';
import { getGenerationOutputModes, OutputMode, type ResolvedOutputMode } from './model-info';
import { PROVIDER_PRESETS } from './presets';
import type { ModelSettings } from '../settings/model';
import type { GenerationPrompt } from '../generate/prompt';
import { CARD_RESPONSE_SCHEMA } from '../generate/result';
import { asRecord } from '../utils/data';

export const CLAUDE_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const RESPONSE_TOOL = 'submit_cards';
type ClaudeRequest = (request: RequestUrlParam) => Promise<{ status: number; json: unknown }>;

class ClaudeApiError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

// Request shapes: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// Effort and image content: /effort and /vision in the same documentation section.
function requestBody(model: ModelSettings, prompt: GenerationPrompt, mode: ResolvedOutputMode): Record<string, unknown> {
	const outputConfig: Record<string, unknown> = {};
	if (model.reasoningEffort !== 'default') outputConfig.effort = model.reasoningEffort;
	if (mode === OutputMode.JsonSchema) outputConfig.format = { type: 'json_schema', schema: CARD_RESPONSE_SCHEMA };
	const body: Record<string, unknown> = {
		model: model.id, max_tokens: model.maxOutputTokens, stream: false,
		system: prompt.instructions,
		messages: [{ role: 'user', content: [
			{ type: 'text', text: prompt.source },
			...prompt.diagrams.flatMap(diagram => [
				{ type: 'text', text: `Diagram: ${diagram.name}` },
				{ type: 'image', source: { type: 'base64', media_type: diagram.mime, data: diagram.base64 } },
			]),
		] }],
	};
	if (Object.keys(outputConfig).length) body.output_config = outputConfig;
	if (mode === OutputMode.Tool) {
		body.tools = [{ name: RESPONSE_TOOL, description: 'Return the generated cards and source concerns.', input_schema: CARD_RESPONSE_SCHEMA }];
		body.tool_choice = { type: 'tool', name: RESPONSE_TOOL };
	}
	// Plain JSON uses the fixed prompt instructions, without prefilling an assistant
	// reply. No cache_control for individual notes: creating a cache costs extra and
	// this flow does not reuse it across a folder run.
	return body;
}

/** requestUrl cannot abort the underlying connection. Stop waiting and ignore late replies instead. */
async function sendMessage(request: RequestUrlParam, send: ClaudeRequest, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ status: number; json: unknown }> {
	if (signal?.aborted) throw new Error('Generation cancelled.');
	let timer: number | undefined;
	let cancel: (() => void) | undefined;
	let active = true;
	try {
		return await new Promise((resolve, reject) => {
			cancel = () => { active = false; reject(new Error('Generation cancelled.')); };
			signal?.addEventListener('abort', cancel, { once: true });
			timer = window.setTimeout(() => {
				active = false;
				reject(new Error('Claude generation timed out. Try a smaller selection or lower reasoning effort.'));
			}, timeoutMs);
			// Queue the send so cancellation immediately after Generate can stop it before
			// it starts. Both handlers remain attached to consume a late failure safely.
			void Promise.resolve().then(() => {
				if (!active || signal?.aborted) throw new Error('Generation cancelled.');
				return send(request);
			}).then(resolve, () => reject(new Error('Could not connect to Claude. Check your connection and try again.')));
		});
	}
	finally {
		active = false;
		window.clearTimeout(timer);
		if (cancel) signal?.removeEventListener('abort', cancel);
	}
}

function unsupportedFormat(error: unknown, mode: ResolvedOutputMode, model: ModelSettings): boolean {
	if (!(error instanceof ClaudeApiError) || error.status !== 400) return false;
	if (/\beffort\b|max_tokens|\bimages?\b|\bvision\b/i.test(error.message)) return false;
	if (/invalid.*schema|schema.*invalid|schema validation/i.test(error.message)) return false;
	const format = mode === OutputMode.JsonSchema
		? /output_config\.format|output_format|json_schema|structured.?outputs/i
		: /tool_choice|forced tool|tool use|tools\b/i;
	const unsupported = /not support|unsupported|not available|not allowed|not permitted|does not (?:accept|allow)/i.test(error.message);
	// Older models can reject output_config as a whole. That is unambiguously a
	// format error only when format was its sole member, without a selected effort.
	const formatOnlyConfig = mode === OutputMode.JsonSchema && model.reasoningEffort === 'default' && /output_config/i.test(error.message);
	return unsupported && (format.test(error.message) || formatOnlyConfig);
}

function describeError(error: ClaudeApiError, modelId: string): string {
	if (error.status === 401) return 'Claude rejected the API key (401). Check the key in the Auto Anki settings.';
	if (error.status === 403) return `Claude denied access (403). Check that your API account can use "${modelId}".\n${error.message}`;
	if (error.status === 404) return `Claude doesn't know the model "${modelId}" (404). Check the model in the Auto Anki settings.\n${error.message}`;
	if (error.status === 429) return `Claude rate limit or quota reached (429).\n${error.message}`;
	if (error.status === 529) return `Claude is temporarily overloaded (529). Try again later.\n${error.message}`;
	if (error.status === 400 && /effort/i.test(error.message)) return `The model "${modelId}" doesn't accept the chosen reasoning effort. Set Reasoning effort to Model default or pick another level.\n${error.message}`;
	if (error.status === 400 && /max_tokens/i.test(error.message)) return `Claude rejected the output-token limit. Lower Maximum output tokens in this model's settings.\n${error.message}`;
	if (error.status === 400 && /image|vision/i.test(error.message)) return `The model could not accept the diagrams. Turn off Send diagrams or choose a model that accepts images.\n${error.message}`;
	return `Claude returned an error (${error.status}).\n${error.message}`;
}

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
	if (objects.length !== 1 || start >= 0) throw new Error("Claude's reply wasn't in the expected format, so no cards were made.");
	return objects[0];
}

function readContent(value: unknown, mode: ResolvedOutputMode): string {
	const message = asRecord(value);
	if (message.stop_reason === 'refusal') throw new Error('Claude declined to generate cards from this material. Try a different selection or model.');
	if (message.stop_reason === 'max_tokens') throw new Error('Claude ran out of tokens before finishing. Raise Maximum output tokens, lower Reasoning effort, or set a smaller maximum number of cards.');
	if (message.stop_reason === 'model_context_window_exceeded') throw new Error('The note and response exceeded this model’s context limit. Try a smaller selection.');
	if (!Array.isArray(message.content) || !message.content.length) throw new Error('Claude returned no readable generation result.');
	const blocks = message.content.map(asRecord);
	if (blocks.some(block => block.type === 'refusal')) throw new Error('Claude declined to generate cards from this material. Try a different selection or model.');
	if (mode === OutputMode.Tool) {
		const calls = blocks.filter(block => block.type === 'tool_use');
		const call = calls[0];
		if (message.stop_reason !== 'tool_use' || calls.length !== 1 || call.name !== RESPONSE_TOOL || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
			throw new Error("Claude's reply wasn't in the expected function format, so no cards were made.");
		}
		return JSON.stringify(call.input);
	}
	if (message.stop_reason !== 'end_turn') throw new Error('Claude did not finish its response, so no cards were made.');
	// Thinking is never shown or treated as card content. Only final text is parsed.
	if (blocks.some(block => !['text', 'thinking', 'redacted_thinking'].includes(String(block.type)) || (block.type === 'text' && typeof block.text !== 'string'))) {
		throw new Error('Claude returned an unreadable response, so no cards were made.');
	}
	const text = blocks.filter(block => block.type === 'text').map(block => block.text as string).join('');
	if (!text.trim()) throw new Error('Claude returned no readable generation result.');
	return mode === OutputMode.Json ? extractJsonObject(text) : text;
}

/** One Claude request at a time. Only an explicit unsupported format permits another attempt. */
export async function requestAnthropicCards(apiKey: string, model: ModelSettings, prompt: GenerationPrompt, signal?: AbortSignal,
	options: { send?: ClaudeRequest; timeoutMs?: number } = {}): Promise<{ content: string; outputMode: ResolvedOutputMode }> {
	const preset = PROVIDER_PRESETS.anthropic;
	const modes = getGenerationOutputModes(model);
	for (const [index, mode] of modes.entries()) {
		try {
			const response = await sendMessage({ url: `${preset.baseUrl}/v1/messages`, method: 'POST', contentType: 'application/json',
				headers: { ...preset.headers, [preset.apiKeyHeader]: `${preset.apiKeyPrefix}${apiKey}` },
				body: JSON.stringify(requestBody(model, prompt, mode)), throw: false,
			}, options.send ?? requestUrl, signal, options.timeoutMs ?? CLAUDE_GENERATION_TIMEOUT_MS);
			let body: unknown;
			try { body = response.json; }
			catch { body = undefined; }
			if (response.status < 200 || response.status >= 300) {
				const detail = asRecord(asRecord(body).error).message;
				throw new ClaudeApiError(response.status, typeof detail === 'string' ? detail : 'The provider returned no error details.');
			}
			return { content: readContent(body, mode), outputMode: mode };
		}
		catch (error) {
			if (signal?.aborted) throw new Error('Generation cancelled.');
			if (model.outputMode === OutputMode.Auto && index < modes.length - 1 && unsupportedFormat(error, mode, model)) continue;
			if (error instanceof ClaudeApiError) throw new Error(describeError(error, model.id));
			throw error;
		}
	}
	throw new Error('No supported output format was found for this model.');
}

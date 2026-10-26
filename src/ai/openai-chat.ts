import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getGenerationOutputModes, OutputMode, type ResolvedOutputMode } from './model-info';
import type { ModelSettings } from '../settings/model';
import type { GenerationPrompt } from '../generate/prompt';
import { CARD_RESPONSE_SCHEMA } from '../generate/result';

const RESPONSE_TOOL = 'submit_cards';

/** Keep this separate from writing guidance: transport details are never editable prompt text. */
function requestBody(model: ModelSettings, prompt: GenerationPrompt, mode: ResolvedOutputMode): ChatCompletionCreateParamsNonStreaming {
	const messages: ChatCompletionMessageParam[] = [
		{ role: 'system', content: prompt.instructions },
		{ role: 'user', content: prompt.diagrams.length ? [
			{ type: 'text', text: prompt.source },
			...prompt.diagrams.flatMap(diagram => [
				{ type: 'text' as const, text: `Diagram: ${diagram.name}` },
				{ type: 'image_url' as const, image_url: { url: `data:${diagram.mime};base64,${diagram.base64}` } },
			]),
		] : prompt.source },
	];
	const body: ChatCompletionCreateParamsNonStreaming = {
		model: model.id, messages, stream: false,
		max_completion_tokens: model.maxOutputTokens,
		// Default means omit the parameter; models without reasoning may reject it.
		...(model.reasoningEffort !== 'default' ? { reasoning_effort: model.reasoningEffort as ChatCompletionCreateParamsNonStreaming['reasoning_effort'] } : {}),
	};
	if (mode === OutputMode.JsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: RESPONSE_TOOL, strict: true, schema: CARD_RESPONSE_SCHEMA } };
	else if (mode === OutputMode.Tool) {
		body.tools = [{ type: 'function', function: { name: RESPONSE_TOOL, description: 'Return the generated cards and source concerns.', parameters: CARD_RESPONSE_SCHEMA } }];
		body.tool_choice = { type: 'function', function: { name: RESPONSE_TOOL } };
	}
	else body.response_format = { type: 'json_object' };
	return body;
}

/** Only an explicit unsupported-format response permits another format request. */
function unsupportedFormat(error: unknown, mode: ResolvedOutputMode): boolean {
	if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
	// A broken schema is our request error, not evidence that the format is unavailable.
	if (/invalid.*schema|schema.*invalid|schema validation/i.test(error.message)) return false;
	const mentionsFormat = mode === OutputMode.JsonSchema ? /response_format|json_schema|structured.?outputs/i : /tool_choice|function.call|tools\b/i;
	return mentionsFormat.test(error.message) && /not support|unsupported|not available|not allowed|does not (?:accept|allow)/i.test(error.message);
}

function describeError(error: unknown, modelId: string): string {
	if (error instanceof OpenAI.APIError && error.status !== undefined) {
		if (error.status === 401) return 'OpenAI rejected the API key (401). Check the key in the Auto Anki settings.';
		if (error.status === 404) return `OpenAI doesn't know the model "${modelId}" (404). Check the model in the Auto Anki settings.\n${error.message}`;
		if (error.status === 429) return `OpenAI rate limit or quota reached (429).\n${error.message}`;
		if (error.status === 400 && /reasoning_effort/.test(error.message)) return `The model "${modelId}" doesn't accept the chosen reasoning effort. Set Reasoning effort to Model default or pick another level.\n${error.message}`;
		if (error.status === 400 && /image|vision/i.test(error.message)) return `The model could not accept the diagrams. Turn off Send diagrams or choose a model that accepts images.\n${error.message}`;
		return `OpenAI returned an error (${error.status}).\n${error.message}`;
	}
	return `Could not connect to OpenAI! ${error instanceof Error ? error.message : String(error)}`;
}

/** One generation, with no speculative capability tests or automatic paid alternatives. */
export async function requestOpenAiCards(apiKey: string, model: ModelSettings, prompt: GenerationPrompt, signal?: AbortSignal): Promise<{ content: string; outputMode: ResolvedOutputMode }> {
	// Retries here are limited to recognised format errors. An ambiguous network failure
	// must not silently send the same generation a second time.
	const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
	const modes = getGenerationOutputModes(model);
	for (const [index, mode] of modes.entries()) {
		try {
			const response = await client.chat.completions.create(requestBody(model, prompt, mode), { signal });
			const choice = response && Array.isArray(response.choices) ? response.choices[0] : undefined;
			if (!choice?.message) throw new Error('OpenAI returned no readable generation result.');
			if (choice.finish_reason === 'length') throw new Error('The model ran out of tokens before finishing. Raise Maximum output tokens, lower Reasoning effort, or set a smaller maximum number of cards.');
			if (choice.message.refusal || choice.finish_reason === 'content_filter') throw new Error('The model declined to generate cards from this material. Try a different selection or model.');
			if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') throw new Error('The model did not finish its response, so no cards were made.');
			let content = choice.message.content;
			if (mode === OutputMode.Tool) {
				const calls = choice.message.tool_calls;
				const call = calls?.length === 1 ? calls[0] : undefined;
				content = call?.type === 'function' && call.function.name === RESPONSE_TOOL ? call.function.arguments : null;
			}
			if (typeof content !== 'string' || !content) throw new Error("The model's reply wasn't in the expected format, so no cards were made.");
			return { content, outputMode: mode };
		}
		catch (error) {
			if (signal?.aborted) throw new Error('Generation cancelled.');
			if (model.outputMode === OutputMode.Auto && index < modes.length - 1 && unsupportedFormat(error, mode)) continue;
			if (error instanceof OpenAI.APIError || error instanceof OpenAI.APIConnectionError) throw new Error(describeError(error, model.id));
			throw error;
		}
	}
	throw new Error('No supported output format was found for this model.');
}

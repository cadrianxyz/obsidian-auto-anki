import type { ModelCapabilities } from './models/metadata';
import type { ModelSettings } from '../settings/schema';
import type { GenerationPrompt } from '../generate/prompt';

// --- Output modes ---

/** Output formats understood by the adapters. String values also form the saved-data format. */
export enum OutputMode {
	Auto = 'auto',
	JsonSchema = 'json_schema',
	Tool = 'tool',
	Json = 'json',
}

export type ResolvedOutputMode = Exclude<OutputMode, OutputMode.Auto>;
export const OUTPUT_MODES = Object.values(OutputMode);
export const RESOLVED_OUTPUT_MODES = OUTPUT_MODES.filter((mode): mode is ResolvedOutputMode => mode !== OutputMode.Auto);

// --- Connector contract ---

/** One generation with an immutable settings snapshot. */
export interface GenerationRequest {
	apiKey: string;
	model: ModelSettings;
	prompt: GenerationPrompt;
	signal?: AbortSignal;
}

/** Generated text for downstream parsing and validation; connectors never create Anki notes. */
export interface GenerationReply {
	content: string;
	outputMode: ResolvedOutputMode;
}

/** Test seams. Plugin code relies on the SDK's fetch and the shared timeout. */
export interface ConnectorOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export type GenerationConnector = (request: GenerationRequest, options?: ConnectorOptions) => Promise<GenerationReply>;

// --- Shared request settings ---

/** The same limit for every provider, set explicitly rather than inherited from SDK defaults. */
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
export const GENERATION_CANCELLED = 'Generation cancelled.';
/** Name of the forced function in tool mode and of the JSON schema. */
export const RESPONSE_TOOL = 'submit_notes';
export const RESPONSE_TOOL_DESCRIPTION = 'Return the generated Anki notes and source concerns.';

// --- Generation policy ---

/** Explicit choices never fall back. Providers may supply a different supported order. */
export function getGenerationOutputModes(model: { outputMode: OutputMode; capabilities?: ModelCapabilities }, order: readonly ResolvedOutputMode[] = RESOLVED_OUTPUT_MODES): readonly ResolvedOutputMode[] {
	if (model.outputMode !== OutputMode.Auto) return [model.outputMode];
	const initial = model.capabilities?.outputMode;
	const start = initial === undefined ? 0 : order.indexOf(initial);
	return order.slice(start < 0 ? 0 : start);
}

/** The provider-specific parts of a generation; request bodies and errors stay with each connector. */
export interface ProviderCall<Response> {
	send(mode: ResolvedOutputMode): Promise<Response>;
	/** Return final content only from a complete, well-formed response; otherwise throw. */
	parse(response: Response, mode: ResolvedOutputMode): string;
	/** True only for an explicit provider error saying this output format is unavailable. */
	unsupportedFormat(error: unknown, mode: ResolvedOutputMode): boolean;
	/** A user-facing message for a failed request. */
	describeError(error: unknown): string;
}

/**
 * Shared request policy. One request per output format, in the order from
 * getGenerationOutputModes(). Auto may step to the next format only after an explicit
 * unsupported-format error; any other failure, including an ambiguous network error,
 * ends the run so the same paid generation is never sent twice. Cancellation is checked
 * before every request and wins over any error or late reply.
 */
export async function generateWithFallback<Response>(model: ModelSettings, signal: AbortSignal | undefined, call: ProviderCall<Response>, order: readonly ResolvedOutputMode[] = RESOLVED_OUTPUT_MODES): Promise<GenerationReply> {
	const modes = getGenerationOutputModes(model, order);
	for (const [index, mode] of modes.entries()) {
		if (signal?.aborted) throw new Error(GENERATION_CANCELLED);
		let response: Response;
		try {
			response = await call.send(mode);
		}
		catch (error) {
			if (signal?.aborted) throw new Error(GENERATION_CANCELLED);
			if (model.outputMode === OutputMode.Auto && index < modes.length - 1 && call.unsupportedFormat(error, mode)) continue;
			throw new Error(call.describeError(error));
		}
		if (signal?.aborted) throw new Error(GENERATION_CANCELLED);
		return { content: call.parse(response, mode), outputMode: mode };
	}
	throw new Error('No supported output format was found for this model.');
}

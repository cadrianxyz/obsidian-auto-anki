// Historical values used to interpret 0.3 data.json. Keep them fixed when 1.x's
// defaults change, or the same old file would migrate differently.
export const LEGACY_DEFAULT_OPENAI_MODEL = 'gpt-6-luna';
export const LEGACY_DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const LEGACY_DEFAULT_ANKI_PORT = 8765;

// 0.2.x kept temperature, top_p, frequency_penalty, presence_penalty and
// max_tokens_per_question under gptAdvancedOptions. Current OpenAI models only accept the
// defaults for the first four, and the per-question token count no longer maps onto how
// reasoning models spend tokens, so all five are dropped rather than carried over.
export interface LegacyGenerationFields {
	gptAdvancedOptions?: {
		temperature?: number;
		top_p?: number;
		frequency_penalty?: number;
		presence_penalty?: number;
		max_tokens_per_question?: number;
	};
}

// Mutates `data`. Returns whether anything was removed, and whether the user had moved
// any of the sampling sliders off their defaults (worth telling them about).
export function migrateLegacyGenerationOptions(data: LegacyGenerationFields) {
	if (!('gptAdvancedOptions' in data)) return { removed: false, hadCustomSampling: false };
	const old = data.gptAdvancedOptions ?? {};
	const hadCustomSampling =
		(old.temperature ?? 1) !== 1 ||
		(old.top_p ?? 1) !== 1 ||
		(old.frequency_penalty ?? 0) !== 0 ||
		(old.presence_penalty ?? 0) !== 0;
	delete data.gptAdvancedOptions;
	return { removed: true, hadCustomSampling };
}

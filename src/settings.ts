import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';

// OpenAI's reasoning_effort levels offered in settings. Which levels a model accepts varies
// by model, and models without reasoning reject the parameter altogether, so 'default'
// (the setting a new install starts with) means it isn't sent.
export const REASONING_EFFORT_OPTIONS = ['default', 'none', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = typeof REASONING_EFFORT_OPTIONS[number];

export interface GenerationOptions {
	reasoningEffort: ReasoningEffort;
	// Cap on tokens per request (OpenAI's max_completion_tokens), reasoning included.
	maxOutputTokens: number;
}

export interface QuestionGenerationDefaults {
	textSelection: {
		numQuestions: number,
		numAlternatives: number,
	},
	file: {
		numQuestions: number,
		numAlternatives: number,
	},
}

export interface PluginSettings {
	ankiConnectPort: number;
	ankiDestinationDeck: string;
	// The API key is not a setting: it lives in Obsidian's Keychain (see utils/api-key.ts).
	openAiModel: string;
	generation: GenerationOptions;
	questionGenerationDefaults: QuestionGenerationDefaults;
}

// 0.2.1 hard-coded 'gpt-3.5-turbo-1106', which OpenAI shut down on 2026-09-28.
// The model is now a setting; this is only the value a new install starts with.
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectPort: ANKI_CONNECT_DEFAULT_PORT,
	ankiDestinationDeck: '',
	openAiModel: DEFAULT_OPENAI_MODEL,
	generation: {
		reasoningEffort: 'default',
		maxOutputTokens: 16000,
	},
	questionGenerationDefaults: {
		textSelection: {
			numQuestions: 1,
			numAlternatives: 0,
		},
		file: {
			numQuestions: 5,
			numAlternatives: 0,
		},
	},
}

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

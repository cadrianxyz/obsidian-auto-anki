import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';

export interface GptAdvancedOptions {
	temperature: number;
	top_p: number;
	frequency_penalty: number;
	presence_penalty: number;
	max_tokens_per_question: number;
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
	openAiApiKey: Buffer | null;
	openAiApiKeyIdentifier: string;
	gptAdvancedOptions: GptAdvancedOptions;
	questionGenerationDefaults: QuestionGenerationDefaults;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectPort: ANKI_CONNECT_DEFAULT_PORT,
	ankiDestinationDeck: '',
	openAiApiKey: null,
	openAiApiKeyIdentifier: '',
	gptAdvancedOptions: {
		temperature: 1,
		top_p: 1.0,
		frequency_penalty: 0.0,
		presence_penalty: 0.0,
		max_tokens_per_question: 100,
	},
	questionGenerationDefaults: {
		textSelection: {
			numQuestions: 1,
			numAlternatives: 1,
		},
		file: {
			numQuestions: 5,
			numAlternatives: 2,
		},
	},
}

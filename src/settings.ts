import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';
export interface PluginSettings {
	ankiConnectPort: number;
	ankiDestinationDeck: string;
	openAiApiKey: Buffer | null;
	openAiApiKeyIdentifier: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectPort: ANKI_CONNECT_DEFAULT_PORT,
	ankiDestinationDeck: '',
	openAiApiKey: null,
	openAiApiKeyIdentifier: ''
}

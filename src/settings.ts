export interface PluginSettings {
	ankiConnectPort: number;
	ankiDestinationDeck: string;
	openAiApiKey: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectPort: 8765,
	ankiDestinationDeck: '',
	openAiApiKey: '',
}

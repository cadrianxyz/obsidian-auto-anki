import {
	App,
	Editor,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting
} from 'obsidian';

import {
	PluginSettings,
	DEFAULT_SETTINGS,
} from './settings';

import { ExportModal } from './modal';
import {
    electronEncrypt,
    electronDecrypt,
} from './utils/enc';
import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';

export default class AutoAnkiPlugin extends Plugin {
	settings: PluginSettings;
	leafId: string;
	
	async onload() {
		await this.loadSettings();
				
		this.addSettingTab(new AutoAnkiSettingTab(this.app, this));

		this.addCommand({
			id: 'export-current-file-to-anki',
			name: 'Export Current File to Anki',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
				if (this.settings.openAiApiKey != null && view.data.length > 0) {
					if (!checking) {
                        const apiKey = electronDecrypt(this.settings.openAiApiKey);
                        const port = this.settings.ankiConnectPort || ANKI_CONNECT_DEFAULT_PORT;
						new ExportModal(
							this.app,
							view.data,
							apiKey,
							port,
							this.settings.ankiDestinationDeck,
							5,
						).open();
					}
					return true
				}
				return false;
			},
		});

		this.addCommand({
			id: 'export-text-selection-to-anki',
			name: 'Export Current Text Selection to Anki',
			editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
				const currTextSelection = editor.getSelection();
				if (this.settings.openAiApiKey != null && currTextSelection.length > 0) {
					if (!checking) {
                        const apiKey = electronDecrypt(this.settings.openAiApiKey);
                        const port = this.settings.ankiConnectPort || ANKI_CONNECT_DEFAULT_PORT;
						new ExportModal(
							this.app,
							currTextSelection,
							apiKey,
							port,
							this.settings.ankiDestinationDeck,
							2,
						).open();
					}
					return true;
				}
				return false;
			},
		});
	}
	
	onunload() {
	}
	
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AutoAnkiSettingTab extends PluginSettingTab {
	plugin: AutoAnkiPlugin;
	maxFilesSetting: Setting;
	
	constructor(app: App, plugin: AutoAnkiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	display(): void {
		const { containerEl } = this;
		
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Auto Anki Settings.' });

		const ankiDescription = document.createElement('div');
		ankiDescription.innerHTML = '<p><a href="https://apps.ankiweb.net/">Anki</a> is an open-source flashcard program that is popular for spaced repetition. This plugin has only been tested on desktop, and requires <a href="https://foosoft.net/projects/anki-connect/">Anki Connect</a> to be installed alongside the main Anki program.</p><p>Enabling this plugin will add commands to automatically generate Question-Answer-style flashcards into the Anki system using OpenAI\'s AI models.</p>';
        const desc = containerEl.createEl('div')
        desc.appendChild(ankiDescription)
		
		new Setting(containerEl)
			.setName('Anki Port')
			.setDesc('The port number used to host Anki Connect')
			.addText(textComponent => textComponent
				.setPlaceholder('Anki Connect Default: 8765')
				.setValue(String(this.plugin.settings.ankiConnectPort))
				.onChange(async (value) => {
					this.plugin.settings.ankiConnectPort = Number(value);
					await this.plugin.saveSettings();
				})
			);
		
		new Setting(containerEl)
			.setName('Anki Deck Name')
			.setDesc('The name of the deck in Anki you want to export flashcards to')
			.addText(textComponent => textComponent
				.setPlaceholder('Default')
				.setValue(String(this.plugin.settings.ankiDestinationDeck))
				.onChange(async (value) => {
					this.plugin.settings.ankiDestinationDeck = value;
					await this.plugin.saveSettings();
				})
			);
		
		const openAiDescription = new DocumentFragment();
		const openAiDescHtml = document.createElement('p');
		openAiDescHtml.innerHTML = 'The API Key associated with your OpenAI account, used for querying GPT. Go <a href="https://platform.openai.com/account/api-keys">here</a> to obtain one.';
		openAiDescription.appendChild(openAiDescHtml);

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc(openAiDescription)
			.addText(textComponent => textComponent
				.setPlaceholder(this.plugin.settings.openAiApiKeyIdentifier ?? 'sk-xxx')
				.onChange(async (value) => {
					this.plugin.settings.openAiApiKey = electronEncrypt(value);
                    let identifier = 'xxxx';
                    if (value.length >= 7) {
                        identifier = `${value.slice(0,3)}...${value.slice(-4)}`
                    }
                    this.plugin.settings.openAiApiKeyIdentifier = identifier;
					await this.plugin.saveSettings();
				})
			);
	}
}

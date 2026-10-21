import {
	App,
	Editor,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	setIcon,
} from 'obsidian';

import {
	PluginSettings,
	DEFAULT_SETTINGS,
	DEFAULT_OPENAI_MODEL,
	LegacyGenerationFields,
	REASONING_EFFORT_OPTIONS,
	ReasoningEffort,
	migrateLegacyGenerationOptions,
} from './settings';

import { ExportModal } from './modal';
import {
	KeyMigrationResult,
	LegacyKeyFields,
	getOpenAiApiKey,
	isKeychainAvailable,
	maskApiKey,
	migrateLegacyApiKey,
	setOpenAiApiKey,
} from './utils/api-key';
import { ANKI_CONNECT_DEFAULT_PORT } from './utils/anki';
import { isNumeric } from './utils/validations';
import { StatusBarElement } from './utils/cusom-types';

export default class AutoAnkiPlugin extends Plugin {
	// Assigned in onload(), which Obsidian always calls before anything else uses them.
	settings!: PluginSettings;
	statusBar!: StatusBarElement;
	statusBarIcon!: HTMLElement;
	
	async onload() {
		await this.loadSettings();
				
		this.addSettingTab(new AutoAnkiSettingTab(this.app, this));
        const defaults = this.settings.questionGenerationDefaults;
        const { textSelection: defaultsTextSelection, file: defaultsFile } = defaults;

		this.statusBar = this.addStatusBarItem();
		this.statusBar.className = 'status-bar-auto-anki'
		this.statusBarIcon = this.statusBar.createEl('span', { cls: 'status-bar-icon' });
		this.statusBar.createEl('div', { text: 'auto-anki' });
		this.statusBar.doReset = () => {
			setIcon(this.statusBarIcon, 'check-circle-2');
			this.statusBar.classList.remove('--running');
			this.statusBar.classList.remove('--error');
		};
		this.statusBar.doDisplayError = () => {
			setIcon(this.statusBarIcon, 'alert-circle');
			this.statusBar.classList.remove('--running');
			this.statusBar.classList.add('--error');
			
		}
		this.statusBar.doDisplayRunning = () => {
			setIcon(this.statusBarIcon, 'refresh-cw');
			this.statusBar.classList.remove('--error');
			this.statusBar.classList.add('--running');
		};
		this.statusBar.doReset();

		this.addCommand({
			id: 'export-current-file-to-anki',
			name: 'Export Current File to Anki',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view == null) {
					return false;
				}

				if (!checking) {
					if (view.data.length <= 0) {
						new Notice('There is nothing in the file!');
						return;
					}

					const apiKey = this.requireApiKey();
					if (apiKey == null) return;
					const port = this.settings.ankiConnectPort || ANKI_CONNECT_DEFAULT_PORT;
					new ExportModal(
						this.app,
						this.statusBar,
						view.data,
						apiKey,
						this.settings.openAiModel || DEFAULT_OPENAI_MODEL,
						port,
						this.settings.ankiDestinationDeck,
						this.settings.generation,
						defaultsFile.numQuestions,
						defaultsFile.numAlternatives,
					).open();
				}

				return true;
			},
		});

		this.addCommand({
			id: 'export-text-selection-to-anki',
			name: 'Export Highlighted Text to Anki',
			editorCheckCallback: (checking: boolean, editor: Editor) => {
				const currTextSelection = editor.getSelection();

				if (!checking) {
					if (currTextSelection.length == 0) {
						new Notice('No text was selected!');
						return;
					}

					const apiKey = this.requireApiKey();
					if (apiKey == null) return;
					const port = this.settings.ankiConnectPort || ANKI_CONNECT_DEFAULT_PORT;
					new ExportModal(
						this.app,
						this.statusBar,
						currTextSelection,
						apiKey,
						this.settings.openAiModel || DEFAULT_OPENAI_MODEL,
						port,
						this.settings.ankiDestinationDeck,
						this.settings.generation,
						defaultsTextSelection.numQuestions,
						defaultsTextSelection.numAlternatives,
					).open();
				}

				return true;
			},
		});
	}
	
	onunload() {
	}
	
	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		const migration = migrateLegacyApiKey(this.app, data as LegacyKeyFields);
		const generationMigration = migrateLegacyGenerationOptions(data as LegacyGenerationFields);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Nested, so merged separately: a stored object would otherwise replace every default.
		this.settings.generation = Object.assign({}, DEFAULT_SETTINGS.generation, data.generation);
		if (migration === 'moved' || migration === 'kept-keychain' || migration === 'cleaned' || generationMigration.removed) {
			// Rewrite data.json now, so the key is gone from the vault straight away.
			await this.saveSettings();
		}
		this.reportKeyMigration(migration);
		if (generationMigration.hadCustomSampling) {
			new Notice('Auto Anki removed its Temperature, Top P and penalty settings, and the values you had set: current OpenAI models only accept their defaults. To trade speed and cost against quality, use Reasoning Effort in the Auto Anki settings.', 0);
		}
	}

	reportKeyMigration(result: KeyMigrationResult) {
		const replaceAdvice = 'Older copies of your vault (synced, backed up or in git) may still contain it, so consider replacing the key at OpenAI.';
		if (result === 'moved') {
			new Notice(`Auto Anki moved your OpenAI API key out of your vault and into Obsidian's Keychain (Settings → Keychain). It is no longer stored in the plugin's data.json. ${replaceAdvice}`, 0);
		}
		else if (result === 'kept-keychain') {
			new Notice(`Auto Anki removed an OpenAI API key from the plugin's data.json. This device's Keychain already held a different key, and that one is now used. ${replaceAdvice}`, 0);
		}
		else if (result === 'unavailable') {
			new Notice('Auto Anki needs Obsidian 1.11.4 or newer to keep your OpenAI API key in the Keychain. Your key is still in the plugin\'s data.json; update Obsidian to move it.', 0);
		}
		else if (result === 'failed') {
			new Notice('Auto Anki could not move your OpenAI API key into Obsidian\'s Keychain, so it is still in the plugin\'s data.json. Try re-entering it in the Auto Anki settings.', 0);
		}
	}

	// The key is read from the Keychain each time, so a key added or changed in
	// Settings → Keychain is picked up without reloading the plugin.
	requireApiKey(): string | null {
		const apiKey = getOpenAiApiKey(this.app);
		if (apiKey == null) {
			new Notice('No OpenAI API key on this device. Add one in Settings → Auto Anki. Keys are kept in Obsidian\'s Keychain, which does not sync with your vault, so each device needs the key once.');
		}
		return apiKey;
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AutoAnkiSettingTab extends PluginSettingTab {
	plugin: AutoAnkiPlugin;
	
	constructor(app: App, plugin: AutoAnkiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	display(): void {
		const { containerEl } = this;
		
		containerEl.empty();

		const ankiDescription = document.createElement('div');
        // use innerHTML for harcoded description
		ankiDescription.innerHTML = '<p><a href="https://apps.ankiweb.net/">Anki</a> is an open-source flashcard program that is popular for spaced repetition. This plugin has only been tested on desktop, and requires <a href="https://foosoft.net/projects/anki-connect/">Anki Connect</a> to be installed alongside the main Anki program.</p><p>Enabling this plugin will add commands to automatically generate Question-Answer-style flashcards into the Anki system using OpenAI\'s AI models.</p><p>For information on usage, see <a href="https://github.com/cadrianxyz/obsidian-auto-anki#readme">the instructions</a> online.</p>';
        containerEl.appendChild(ankiDescription)
		
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
		
		const openAiDescription = new DocumentFragment();
		const openAiDescHtml = document.createElement('p');
        // use innerHTML for harcoded description
		openAiDescHtml.innerHTML = 'The API Key associated with your OpenAI account, used for querying GPT. Go <a href="https://platform.openai.com/account/api-keys">here</a> to obtain one. It is saved in Obsidian\'s Keychain on this device (Settings → Keychain), not in your vault, so each device needs it once.';
		openAiDescription.appendChild(openAiDescHtml);

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc(openAiDescription)
			.addText(textComponent => {
				const savedKey = getOpenAiApiKey(this.app);
				textComponent.inputEl.type = 'password';
				textComponent
					.setPlaceholder(!isKeychainAvailable(this.app)
						? 'Needs Obsidian 1.11.4 or newer'
						: savedKey ? `key saved: ${maskApiKey(savedKey)}` : 'No key saved on this device')
					.setDisabled(!isKeychainAvailable(this.app))
					.onChange((value) => {
						// An empty box never deletes a saved key; remove keys in Settings → Keychain.
						if (value.trim() === '') return;
						setOpenAiApiKey(this.app, value);
					});
			});

		new Setting(containerEl)
			.setName('OpenAI Model')
			.setDesc(`The OpenAI model used to generate questions, e.g. ${DEFAULT_OPENAI_MODEL}. Any model your API key can use with Chat Completions works.`)
			.addText(textComponent => textComponent
				.setPlaceholder(DEFAULT_OPENAI_MODEL)
				.setValue(this.plugin.settings.openAiModel)
				.onChange(async (value) => {
					this.plugin.settings.openAiModel = value.trim() || DEFAULT_OPENAI_MODEL;
					await this.plugin.saveSettings();
				})
			);

        containerEl.createEl('h2', { text: 'Default Options for Exporting' });
		
		new Setting(containerEl)
			.setName('Anki Default Deck Name')
			.setDesc('The name of the deck in Anki you want to export flashcards to, by default')
			.addText(textComponent => textComponent
				.setPlaceholder('Default')
				.setValue(String(this.plugin.settings.ankiDestinationDeck))
				.onChange(async (value) => {
					this.plugin.settings.ankiDestinationDeck = value;
					await this.plugin.saveSettings();
				})
			);

        containerEl.createEl('p', { text: '--> For exporting full files' });
        
		new Setting(containerEl)
            .setName('Number of Questions')
            .setDesc('The number of questions to generate from the file.')
            .addText(textComponent => textComponent
                .setValue(String(this.plugin.settings.questionGenerationDefaults.file.numQuestions))
                .onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.file.numQuestions = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.file.numQuestions = Number(value);
						await this.plugin.saveSettings();
					}
                })
            );

		new Setting(containerEl)
			.setName('Number of Alternatives')
			.setDesc('The number of alternatives to generate for each question. Zero means no alternatives. Each alternative is a full extra generation, so it adds to the cost.')
			.addText(textComponent => textComponent
				.setValue(String(this.plugin.settings.questionGenerationDefaults.file.numAlternatives))
				.onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.file.numAlternatives = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.file.numAlternatives = Number(value);
						await this.plugin.saveSettings();
					}
				})
			);

        containerEl.createEl('p', { text: '--> For exporting selected text' });
        
		new Setting(containerEl)
            .setName('Number of Questions')
            .setDesc('The number of questions to generate from the selected text.')
            .addText(textComponent => textComponent
                .setValue(String(this.plugin.settings.questionGenerationDefaults.textSelection.numQuestions))
                .onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.textSelection.numQuestions = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.textSelection.numQuestions = Number(value);
						await this.plugin.saveSettings();
					}
                })
            );

		new Setting(containerEl)
			.setName('Number of Alternatives')
			.setDesc('The number of alternatives to generate for each question. Zero means no alternatives. Each alternative is a full extra generation, so it adds to the cost.')
			.addText(textComponent => textComponent
				.setValue(String(this.plugin.settings.questionGenerationDefaults.textSelection.numAlternatives))
				.onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.questionGenerationDefaults.textSelection.numAlternatives = 0;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						this.plugin.settings.questionGenerationDefaults.textSelection.numAlternatives = Number(value);
						await this.plugin.saveSettings();
					}
				})
			);

        containerEl.createEl('h2', { text: 'Advanced Options' });

		// Reasoning effort replaced the Temperature, Top P and penalty sliders of 0.2.x:
		// current OpenAI models only accept the defaults for those.
		const effortLabels: Record<ReasoningEffort, string> = {
			default: 'Model default (recommended)',
			none: 'None (fastest; not every model allows it)',
			low: 'Low',
			medium: 'Medium',
			high: 'High',
		};
		new Setting(containerEl)
			.setName('Reasoning Effort')
			.setDesc('How much the model thinks before writing questions. More effort can give better questions but is slower and costs more. Only reasoning models (such as gpt-6-luna) use this, and not every model accepts every level. Models without reasoning reject it, so keep "Model default" for those.')
			.addDropdown(dropdown => {
				for (const option of REASONING_EFFORT_OPTIONS) dropdown.addOption(option, effortLabels[option]);
				dropdown
					.setValue(this.plugin.settings.generation.reasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.generation.reasoningEffort = value as ReasoningEffort;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Maximum Output Tokens')
			.setDesc(`The most tokens the model may use for one request, including its reasoning. It's a ceiling, not a target: you're only charged for tokens actually used. Raise it if generation stops with "ran out of tokens". (Default = ${DEFAULT_SETTINGS.generation.maxOutputTokens})`)
			.addText(textComponent => textComponent
				.setValue(String(this.plugin.settings.generation.maxOutputTokens))
				.onChange(async (value) => {
					if (value == '') {
						this.plugin.settings.generation.maxOutputTokens = DEFAULT_SETTINGS.generation.maxOutputTokens;
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value) || Number(value) <= 0) {
						new Notice('The value you entered is not a positive number');
					}
					else {
						this.plugin.settings.generation.maxOutputTokens = Number(value);
						await this.plugin.saveSettings();
					}
				})
			);
	}
}

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

// What data.json may contain: current settings, plus fields older versions kept there.
type StoredSettings = Partial<PluginSettings> & LegacyKeyFields & LegacyGenerationFields;

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
		this.statusBarIcon = this.statusBar.createSpan({ cls: 'status-bar-icon' });
		this.statusBar.createDiv({ text: 'Auto Anki' });
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
			name: 'Export current file to Anki',
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
			name: 'Export highlighted text to Anki',
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
		// data.json can hold anything (an older version's settings, or nothing on a fresh
		// install), so it's read as unknown and narrowed, rather than trusted as PluginSettings.
		const stored: unknown = await this.loadData();
		const data = (stored !== null && typeof stored === 'object' ? stored : {}) as StoredSettings;
		const migration = migrateLegacyApiKey(this.app, data);
		const generationMigration = migrateLegacyGenerationOptions(data);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Nested, so merged separately: a stored object would otherwise replace every default.
		this.settings.generation = Object.assign({}, DEFAULT_SETTINGS.generation, data.generation);
		if (migration === 'moved' || migration === 'kept-keychain' || migration === 'cleaned' || generationMigration.removed) {
			// Rewrite data.json now, so the key is gone from the vault straight away.
			await this.saveSettings();
		}
		this.reportKeyMigration(migration);
		if (generationMigration.hadCustomSampling) {
			new Notice('Auto Anki removed its temperature, top-p and penalty settings, and the values you had set: current OpenAI models only accept their defaults. To trade speed and cost against quality, use the reasoning effort setting instead.', 0);
		}
	}

	reportKeyMigration(result: KeyMigrationResult) {
		const replaceAdvice = 'Older copies of your vault (synced, backed up or in Git) may still contain it, so consider replacing the key at OpenAI.';
		if (result === 'moved') {
			new Notice(`Auto Anki moved your OpenAI API key out of your vault and into Obsidian's Keychain. It's no longer stored in the plugin's data.json. ${replaceAdvice}`, 0);
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
			new Notice('No OpenAI API key on this device. Add one in the Auto Anki settings. Keys are kept in Obsidian\'s Keychain, which doesn\'t sync with your vault, so each device needs the key once.');
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

	// Obsidian 1.13+ prefers declarative settings (getSettingDefinitions), which also makes
	// them searchable; the linter warns about this. 0.3.0 still supports Obsidian 1.11.4,
	// which doesn't have them, so the tab is built here instead. Phase 1 rebuilds this screen.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Introduction, built with Obsidian's element helpers rather than an HTML string.
		const intro = containerEl.createDiv();
		const about = intro.createEl('p');
		about.createEl('a', { text: 'Anki', href: 'https://apps.ankiweb.net/' });
		about.appendText(' is an open-source flashcard program that is popular for spaced repetition. This plugin only works on desktop, and needs the ');
		about.createEl('a', { text: 'AnkiConnect', href: 'https://ankiweb.net/shared/info/2055492159' });
		about.appendText(' add-on installed in Anki.');
		intro.createEl('p', { text: 'It adds commands that turn a note, or the text you select, into question-and-answer flashcards in Anki, using OpenAI models.' });
		intro.createEl('p').createEl('a', { text: 'How to use Auto Anki', href: 'https://github.com/cadrianxyz/obsidian-auto-anki#readme' });

		new Setting(containerEl)
			.setName('Anki port')
			.setDesc('The port AnkiConnect listens on.')
			.addText(textComponent => textComponent
				.setPlaceholder('AnkiConnect default: 8765')
				.setValue(String(this.plugin.settings.ankiConnectPort))
				.onChange(async (value) => {
					this.plugin.settings.ankiConnectPort = Number(value);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('OpenAI API key')
			.setDesc(createFragment(frag => {
				frag.appendText('The API key for your OpenAI account. You can create one in the ');
				frag.createEl('a', { text: 'OpenAI dashboard', href: 'https://platform.openai.com/account/api-keys' });
				frag.appendText(". It's saved in Obsidian's Keychain on this device, not in your vault, so each device needs it once.");
			}))
			.addText(textComponent => {
				const savedKey = getOpenAiApiKey(this.app);
				textComponent.inputEl.type = 'password';
				textComponent
					.setPlaceholder(!isKeychainAvailable(this.app)
						? 'Needs Obsidian 1.11.4 or newer'
						: savedKey ? `Key saved: ${maskApiKey(savedKey)}` : 'No key saved on this device')
					.setDisabled(!isKeychainAvailable(this.app))
					.onChange((value) => {
						// An empty box never deletes a saved key; keys are removed in Obsidian's Keychain settings.
						if (value.trim() === '') return;
						setOpenAiApiKey(this.app, value);
					});
			});

		new Setting(containerEl)
			.setName('OpenAI model')
			.setDesc(`The OpenAI model that writes the questions, for example ${DEFAULT_OPENAI_MODEL}. Any OpenAI chat model your API key can use works.`)
			.addText(textComponent => textComponent
				.setPlaceholder(DEFAULT_OPENAI_MODEL)
				.setValue(this.plugin.settings.openAiModel)
				.onChange(async (value) => {
					this.plugin.settings.openAiModel = value.trim() || DEFAULT_OPENAI_MODEL;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Default Anki deck')
			.setDesc('The Anki deck that flashcards are exported to, unless you pick another one when exporting.')
			.addText(textComponent => textComponent
				.setPlaceholder('Default')
				.setValue(String(this.plugin.settings.ankiDestinationDeck))
				.onChange(async (value) => {
					this.plugin.settings.ankiDestinationDeck = value;
					await this.plugin.saveSettings();
				})
			);

		const defaults = this.plugin.settings.questionGenerationDefaults;
		const alternativesDesc = 'How many alternative versions of each question to generate, to choose from. Zero means none. Each alternative is a full extra generation, so it adds to the cost.';

		new Setting(containerEl).setName('Exporting a whole file').setHeading();
		this.addCountSetting('Number of questions', 'How many questions to generate from the file.',
			() => defaults.file.numQuestions, (n) => { defaults.file.numQuestions = n; });
		this.addCountSetting('Number of alternatives', alternativesDesc,
			() => defaults.file.numAlternatives, (n) => { defaults.file.numAlternatives = n; });

		new Setting(containerEl).setName('Exporting selected text').setHeading();
		this.addCountSetting('Number of questions', 'How many questions to generate from the selected text.',
			() => defaults.textSelection.numQuestions, (n) => { defaults.textSelection.numQuestions = n; });
		this.addCountSetting('Number of alternatives', alternativesDesc,
			() => defaults.textSelection.numAlternatives, (n) => { defaults.textSelection.numAlternatives = n; });

		new Setting(containerEl).setName('Advanced').setHeading();

		// Reasoning effort replaced the temperature, top-p and penalty sliders of 0.2.x:
		// current OpenAI models only accept the defaults for those.
		const effortLabels: Record<ReasoningEffort, string> = {
			default: 'Model default (recommended)',
			none: 'None (fastest; not every model allows it)',
			low: 'Low',
			medium: 'Medium',
			high: 'High',
		};
		new Setting(containerEl)
			.setName('Reasoning effort')
			.setDesc('How much the model thinks before writing questions. More effort can give better questions but is slower and costs more. Only reasoning models use this (most current OpenAI models are), and not every model accepts every level. Models without reasoning reject it, so leave those on the model default.')
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
			.setName('Maximum output tokens')
			.setDesc(`The most tokens the model may use for one request, including its reasoning. It's a ceiling, not a target: you're only charged for tokens actually used. Raise it if generation stops with "ran out of tokens". (Default: ${DEFAULT_SETTINGS.generation.maxOutputTokens})`)
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

	// A text box holding a whole number: empty means 0, anything else non-numeric is refused.
	private addCountSetting(name: string, desc: string, get: () => number, set: (value: number) => void) {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText(textComponent => textComponent
				.setValue(String(get()))
				.onChange(async (value) => {
					if (value == '') {
						set(0);
						await this.plugin.saveSettings();
					}
					else if (!isNumeric(value)) {
						new Notice('The value you entered is not a number value');
					}
					else {
						set(Number(value));
						await this.plugin.saveSettings();
					}
				})
			);
	}
}

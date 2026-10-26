import { Editor, MarkdownView, Notice, Plugin, setIcon } from 'obsidian';
import { ModelDiscovery } from './ai/model-discovery';
import { ModelCatalogCacheFile } from './ai/model-catalog-cache';
import { PROVIDER_PRESETS, type ProviderId } from './ai/presets';
import { AutoAnkiSettingTab } from './settings-tab';
import { SettingsStore } from './settings/store';
import { createModelSettings, normalizeSettings, type SettingsV1 } from './settings/model';
import type { SourceNote } from './note/read';
import { ExportModal } from './modal';
import { getProviderApiKey, setProviderApiKey, type KeyMigrationResult } from './utils/api-key';
import type { StatusBarElement } from './utils/cusom-types';

export default class AutoAnkiPlugin extends Plugin {
	settingsStore!: SettingsStore;
	discovery!: ModelDiscovery;
	private settingsTab?: AutoAnkiSettingTab;
	settings!: SettingsV1;
	statusBar!: StatusBarElement;
	statusBarIcon!: HTMLElement;

	async onload(): Promise<void> {
		// Obsidian knows where this plugin's data.json lives. Give the store these
		// two functions so it can read/save settings without choosing a file path itself.
		const readSettingsFile = (): Promise<unknown> => this.loadData();
		const writeSettingsFile = (settings: SettingsV1): Promise<void> => this.saveData(settings);
		this.settingsStore = new SettingsStore(this.app, readSettingsFile, writeSettingsFile);
		const cache = this.manifest.dir ? new ModelCatalogCacheFile(this.app.vault.adapter, this.manifest.dir) : undefined;
		this.discovery = new ModelDiscovery(undefined, undefined, undefined, cache);
		await Promise.all([this.loadSettings(), this.discovery.restoreCatalog()]);
		this.settingsTab = new AutoAnkiSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.setupStatusBar();
		this.addCommand({
			id: 'export-current-file-to-anki', name: 'Export current file to Anki',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (!checking) {
					if (!view.data.length) { new Notice('There is nothing in the file!'); return; }
					this.openExport(view.data, false, view.file?.path, view.file?.basename);
				}
				return true;
			},
		});
		this.addCommand({
			id: 'export-text-selection-to-anki', name: 'Export highlighted text to Anki',
			editorCheckCallback: (checking: boolean, editor: Editor, view) => {
				if (!checking) {
					const text = editor.getSelection();
					if (!text.length) { new Notice('No text was selected!'); return; }
					this.openExport(text, true, view.file?.path, view.file?.basename);
				}
				return true;
			},
		});
	}

	async loadSettings(external = false): Promise<boolean> {
		try {
			const prepared = await this.settingsStore.load(external);
			this.reportKeyMigration(prepared.keyMigration);
			if (prepared.hadCustomSampling) {
				new Notice('Auto Anki removed its temperature, top-p and penalty settings, and the values you had set. Use the per-model reasoning effort setting instead.', 0);
			}
			return true;
		}
		catch (error) {
			new Notice(error instanceof Error ? error.message : 'Auto Anki could not load its settings.', 0);
			return false;
		}
		finally {
			this.settings = this.settingsStore.settings;
			this.settingsTab?.update();
		}
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings(true);
	}

	async updateSettings(change: (settings: SettingsV1) => void, refreshUI = true): Promise<boolean> {
		try {
			await this.settingsStore.update(change);
			this.settings = this.settingsStore.settings;
			if (refreshUI) this.settingsTab?.update();
			return true;
		}
		catch (error) {
			new Notice(error instanceof Error ? error.message : 'Auto Anki could not save its settings.', 0);
			this.settingsTab?.update();
			return false;
		}
	}

	async saveSettings(): Promise<void> {
		await this.updateSettings(() => {});
	}

	async connectProvider(providerId: ProviderId, value: string): Promise<boolean> {
		if (!this.settingsStore.canSave) return false;
		if (!setProviderApiKey(this.app, providerId, value)) {
			new Notice('The API key could not be saved in the Keychain. Check that the Keychain is available and try again.');
			return false;
		}
		this.discovery.clearProvider(providerId);
		// Retry any pending legacy key cleanup against the newly verified Keychain.
		if (!await this.loadSettings()) return false;
		// Changing a key must not add models or undo the user's visibility choices.
		if (this.settings.providers[providerId].models.length) return true;
		const suggested = PROVIDER_PRESETS[providerId].suggestedModel;
		return this.configureModel(providerId, suggested, this.settings.defaultModel === null);
	}

	async configureModel(providerId: ProviderId, modelId: string, makeDefault: boolean): Promise<boolean> {
		const id = modelId.trim();
		if (!id) return false;
		const known = this.discovery.getModels(providerId, this.settings.providers[providerId].models, [id]).find(model => model.id === id);
		return this.updateSettings(settings => {
			let model = settings.providers[providerId].models.find(model => model.id === id);
			if (!model) {
				model = createModelSettings(id);
				settings.providers[providerId].models.push(model);
			}
			if (known?.capabilities) model.capabilities = known.capabilities;
			model.enabled = true;
			if (makeDefault) settings.defaultModel = { providerId, modelId: id };
		});
	}

	/** Add a whole selection in one save, keeping existing preferences and the default. */
	async addModels(providerId: ProviderId, modelIds: readonly string[]): Promise<boolean> {
		const ids = [...new Set(modelIds.map(id => id.trim()).filter(id => id && !/\s/.test(id)))];
		if (!ids.length) return false;
		const known = new Map(this.discovery.getModels(providerId, this.settings.providers[providerId].models, ids).map(model => [model.id, model]));
		return this.updateSettings(settings => {
			for (const id of ids) {
				const existing = settings.providers[providerId].models.find(model => model.id === id);
				if (existing) { existing.enabled = true; continue; }
				const model = createModelSettings(id);
				if (known.get(id)?.capabilities) model.capabilities = known.get(id)!.capabilities;
				settings.providers[providerId].models.push(model);
			}
			if (!settings.defaultModel) settings.defaultModel = { providerId, modelId: ids[0] };
		});
	}

	private openExport(text: string, selection: boolean, path = '', title = 'Untitled note'): void {
		const reference = this.settings.defaultModel;
		if (!reference) { new Notice('Choose a default model in the Auto Anki settings first.'); return; }
		const key = getProviderApiKey(this.app, reference.providerId);
		if (!key) {
			new Notice(`No ${PROVIDER_PRESETS[reference.providerId].name} API key on this device. Add one in the Auto Anki settings. Keys stay in this device’s Keychain.`);
			return;
		}
		// The existing export flow remains OpenAI-only until both protocol adapters and
		// the new review dialog are built. Never send a Claude selection to OpenAI.
		if (reference.providerId !== 'openai') {
			new Notice('Claude generation is not available in this development build yet.');
			return;
		}
		const model = this.settings.providers.openai.models.find(model => model.id === reference.modelId);
		if (!model?.enabled) return;
		// An open dialog keeps its own snapshot. A sync or settings edit must not change
		// the source, instructions or model halfway through a generation/review cycle.
		const snapshot = normalizeSettings(this.settings);
		const selectedModel = snapshot.providers.openai.models.find(saved => saved.id === model.id)!;
		const discovered = this.discovery.getModels('openai', snapshot.providers.openai.models).find(known => known.id === model.id);
		if (discovered?.capabilities) selectedModel.capabilities = discovered.capabilities;
		const source: SourceNote = { markdown: text, path, title };
		new ExportModal(this.app, this.statusBar, source, key, selectedModel,
			snapshot.anki.url, snapshot.anki.deckTemplate, snapshot.cards, selection, async mode => {
				const current = this.settings.providers.openai.models.find(saved => saved.id === model.id);
				if (!current || current.capabilities?.outputMode === mode) return;
				await this.updateSettings(settings => {
					const saved = settings.providers.openai.models.find(saved => saved.id === model.id);
					if (saved) saved.capabilities = { ...saved.capabilities, outputMode: mode };
				}, false);
			}).open();
	}

	private setupStatusBar(): void {
		this.statusBar = this.addStatusBarItem();
		this.statusBar.className = 'status-bar-auto-anki';
		this.statusBarIcon = this.statusBar.createSpan({ cls: 'status-bar-icon' });
		this.statusBar.createDiv({ text: 'Auto Anki' });
		this.statusBar.doReset = () => {
			setIcon(this.statusBarIcon, 'check-circle-2');
			this.statusBar.classList.remove('--running'); this.statusBar.classList.remove('--error');
		};
		this.statusBar.doDisplayError = () => {
			setIcon(this.statusBarIcon, 'alert-circle');
			this.statusBar.classList.remove('--running'); this.statusBar.classList.add('--error');
		};
		this.statusBar.doDisplayRunning = () => {
			setIcon(this.statusBarIcon, 'refresh-cw');
			this.statusBar.classList.remove('--error'); this.statusBar.classList.add('--running');
		};
		this.statusBar.doReset();
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

}

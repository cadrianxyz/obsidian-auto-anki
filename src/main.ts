import { Editor, MarkdownView, Notice, Plugin } from 'obsidian';
import { ModelDiscovery } from './ai/models/discovery';
import { ModelCatalogCacheFile } from './ai/models/catalog-cache';
import { PROVIDER_IDS, PROVIDER_NAMES, type ProviderId } from './ai/providers';
import { AutoAnkiSettingTab } from './ui/settings/tab';
import { SettingsStore } from './settings/store';
import { createModelSettings, type PluginSettings } from './settings/schema';
import type { SourceNote } from './source-note/content';
import { AnkiClient } from './anki/client';
import { getDestinations, verifyNoteType, NoteTypeDiscovery, readNoteType, readNoteTypeNames, type AnkiDestinations } from './anki/note-types';
import { ExportModal, type ExportModel } from './ui/export-flow';
import { getProviderApiKey, setProviderApiKey, type KeyMigrationResult } from './utils/api-key';
import { GenerationStatus } from './ui/generation-status';

export default class AutoAnkiPlugin extends Plugin {
	settingsStore!: SettingsStore;
	discovery!: ModelDiscovery;
	readonly ankiTypes = new NoteTypeDiscovery();
	private readonly noteTypeSelections = new Map<string, number>();
	private settingsTab?: AutoAnkiSettingTab;
	settings!: PluginSettings;
	private generationStatus!: GenerationStatus;

	async onload(): Promise<void> {
		// Obsidian knows where this plugin's data.json lives. Give the store these
		// two functions so it can read/save settings without choosing a file path itself.
		const readSettingsFile = (): Promise<unknown> => this.loadData();
		const writeSettingsFile = (settings: PluginSettings): Promise<void> => this.saveData(settings);
		this.settingsStore = new SettingsStore(this.app, readSettingsFile, writeSettingsFile);
		const cache = this.manifest.dir ? new ModelCatalogCacheFile(this.app.vault.adapter, this.manifest.dir) : undefined;
		this.discovery = new ModelDiscovery(undefined, undefined, undefined, cache);
		await Promise.all([this.loadSettings(), this.discovery.restoreCatalog()]);
		this.settingsTab = new AutoAnkiSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.generationStatus = new GenerationStatus(this.addStatusBarItem());
		this.addCommand({
			id: 'export-current-file-to-anki', name: 'Generate notes from current file',
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
			id: 'export-text-selection-to-anki', name: 'Generate notes from highlighted text',
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

	async updateSettings(change: (settings: PluginSettings) => void, refreshUI = true): Promise<boolean> {
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

	// --- Anki note-type discovery and selection ---

	/** Discovery never deletes selections when Anki is disconnected. */
	async refreshAnkiTypes(): Promise<void> {
		await this.ankiTypes.refresh(this.settings.anki.url);
		this.settingsTab?.update();
	}

	async prepareAnkiDestinations(anki: PluginSettings['anki']): Promise<AnkiDestinations> {
		const client = new AnkiClient(anki.url);
		const names = await readNoteTypeNames(client);
		const types = [];
		for (const name of anki.enabledNoteTypes) {
			if (!names.has(name)) continue;
			try { types.push(await readNoteType(client, name, names.get(name)!)); }
			catch (error) { types.push({ name, id: names.get(name)!, fields: [], templates: [], descriptions: {}, problem: error instanceof Error ? error.message : 'Could not verify this type.' }); }
		}
		return getDestinations(anki, types);
	}

	/** Turning off always works; enabling requires a fresh read from the same collection. */
	async setAnkiNoteTypeEnabled(name: string, enabled: boolean): Promise<void> {
		const url = this.settings.anki.url;
		const revision = (this.noteTypeSelections.get(name) ?? 0) + 1;
		this.noteTypeSelections.set(name, revision);
		try {
			if (enabled) {
				const client = new AnkiClient(url);
				const names = await readNoteTypeNames(client);
				if (!names.has(name)) throw new Error('This note type is no longer available in Anki. Refresh the list.');
				verifyNoteType(await readNoteType(client, name, names.get(name)!));
			}
			await this.updateSettings(settings => {
				if (this.noteTypeSelections.get(name) !== revision) return;
				if (settings.anki.url !== url) throw new Error('The Anki address changed. Refresh the list and try again.');
				const selected = new Set(settings.anki.enabledNoteTypes);
				if (enabled) selected.add(name); else selected.delete(name);
				settings.anki.enabledNoteTypes = [...selected];
			});
		}
		catch (error) { new Notice(error instanceof Error ? error.message : 'Could not verify this note type.'); this.settingsTab?.update(); }
	}

	// --- AI provider connections and model selection ---

	async connectProvider(providerId: ProviderId, value: string): Promise<boolean> {
		if (!this.settingsStore.canSave) return false;
		if (!setProviderApiKey(this.app, providerId, value)) {
			new Notice('The API key could not be saved in the Keychain. Check that the Keychain is available and try again.');
			return false;
		}
		this.discovery.clearProvider(providerId);
		// Retry any pending legacy key cleanup against the newly verified Keychain.
		// Connecting adds no models: the user chooses them under Manage models.
		return this.loadSettings();
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

	/** Apply only edited choices in one save, keeping preferences and unrelated changes. */
	async updateModelSelection(providerId: ProviderId, changes: ReadonlyMap<string, boolean>): Promise<boolean> {
		const entries = [...changes].filter(([id]) => id && id === id.trim() && !/\s/.test(id));
		if (!entries.length) return false;
		const known = new Map(this.discovery.getModels(providerId, this.settings.providers[providerId].models,
			entries.map(([id]) => id)).map(model => [model.id, model]));
		return this.updateSettings(settings => {
			const hadDefault = !!settings.defaultModel;
			for (const [id, enabled] of entries) {
				let model = settings.providers[providerId].models.find(model => model.id === id);
				if (!model) {
					if (!enabled) continue;
					model = createModelSettings(id);
					if (known.get(id)?.capabilities) model.capabilities = known.get(id)!.capabilities;
					settings.providers[providerId].models.push(model);
				}
				model.enabled = enabled;
				if (!enabled && settings.defaultModel?.providerId === providerId && settings.defaultModel.modelId === id) {
					settings.defaultModel = null;
				}
			}
			const firstEnabled = entries.find(([, enabled]) => enabled)?.[0];
			if (!hadDefault && firstEnabled) settings.defaultModel = { providerId, modelId: firstEnabled };
		});
	}

	// --- Export flow ---

	private openExport(text: string, selection: boolean, path = '', title = 'Untitled note'): void {
		const reference = this.settings.defaultModel;
		if (!reference) { new Notice('Choose a default model in the Auto Anki settings first.'); return; }
		const key = getProviderApiKey(this.app, reference.providerId);
		if (!key) {
			new Notice(`No ${PROVIDER_NAMES[reference.providerId]} API key on this device. Add one in the Auto Anki settings. Keys stay in this device’s Keychain.`);
			return;
		}
		const providerId = reference.providerId;
		const model = this.settings.providers[providerId].models.find(model => model.id === reference.modelId);
		if (!model?.enabled) return;
		// An open dialog keeps its own snapshot. A sync or settings edit must not change
		// the source, instructions or model halfway through a generation/review cycle.
		const snapshot = structuredClone(this.settings);
		const models: ExportModel[] = [];
		for (const id of PROVIDER_IDS) {
			const apiKey = id === providerId ? key : getProviderApiKey(this.app, id);
			if (!apiKey) continue;
			const provider = snapshot.providers[id];
			const discovered = this.discovery.getModels(id, provider.models);
			for (const model of provider.models.filter(model => model.enabled)) {
				const known = discovered.find(known => known.id === model.id);
				if (known?.capabilities) model.capabilities = known.capabilities;
				models.push({ providerId: id, apiKey, model });
			}
		}
		const selectedModel = models.find(choice => choice.providerId === providerId && choice.model.id === model.id)!;
		const source: SourceNote = { markdown: text, path, title };
		new ExportModal(this.app, this.generationStatus, source, selectedModel, models,
			snapshot.anki.url, snapshot.anki.defaultDeck, snapshot.notes, selection, () => this.prepareAnkiDestinations(snapshot.anki), async ({ providerId, model }, mode) => {
				const current = this.settings.providers[providerId].models.find(saved => saved.id === model.id);
				if (!current || current.capabilities?.outputMode === mode) return;
				await this.updateSettings(settings => {
					const saved = settings.providers[providerId].models.find(saved => saved.id === model.id);
					if (saved) saved.capabilities = { ...saved.capabilities, outputMode: mode };
				}, false);
			}).open();
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

import { PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
import type AutoAnkiPlugin from '../../main';
import { ProviderSettings } from './providers';
import { GenerationSettings } from './generation';
import { AnkiSettings } from './anki';

/** Lays out the top level and routes each control key to the page that owns it. */
export class AutoAnkiSettingTab extends PluginSettingTab {
	private readonly providers: ProviderSettings;
	private readonly generation: GenerationSettings;
	private readonly anki: AnkiSettings;

	constructor(app: App, private readonly plugin: AutoAnkiPlugin) {
		super(app, plugin);
		this.providers = new ProviderSettings(app, plugin, this);
		this.generation = new GenerationSettings(plugin);
		this.anki = new AnkiSettings(plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Settings unavailable', desc: 'Auto Anki could not load the settings file. The previous settings are kept; editing is disabled until the file can be loaded.', visible: () => !this.plugin.settingsStore.canSave },
			{ type: 'group', heading: 'AI providers', items: this.providers.definitions() },
			{ type: 'group', items: [
				{ type: 'page', name: 'Generation', desc: 'Coverage, diagrams and instructions for writing your Anki notes.', items: this.generation.definitions() },
				{ type: 'page', name: 'Anki', desc: 'The AnkiConnect address, note types, default deck and tags.', items: this.anki.definitions() },
			] },
		];
	}

	getControlValue(key: string): unknown {
		return this.pageFor(key)?.getValue(key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const page = this.pageFor(key);
		if (!page) return;
		await page.setValue(key, value);
		// An address edit invalidates the displayed collection without remounting its text box.
		if (page === this.anki) this.refreshDomState();
	}

	hide(): void {
		super.hide();
		this.providers.hide();
		this.generation.hide();
		this.anki.hide();
	}

	private pageFor(key: string) {
		return [this.providers, this.generation, this.anki].find(page => page.owns(key));
	}
}

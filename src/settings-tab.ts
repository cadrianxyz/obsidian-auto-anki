import { PluginSettingTab, type App, type ButtonComponent, type SettingDefinitionItem } from 'obsidian';
import type AutoAnkiPlugin from './main';
import { PROVIDER_IDS, PROVIDER_PRESETS, type ProviderId } from './ai/presets';
import { getReasoningEffortsForModel, OUTPUT_MODES, OutputMode } from './ai/model-info';
import { COVERAGE_LEVELS, createModelSettings, type CoverageLevel, type ModelReference, type ModelSettings } from './settings/model';
import { CARD_WRITING_INSTRUCTIONS_VERSION, DEFAULT_CARD_WRITING_INSTRUCTIONS } from './generate/card-writing-instructions';
import { getProviderApiKey, isKeychainAvailable, maskApiKey } from './utils/api-key';
import { asRecord } from './utils/data';
import { getPickerModels, sortModelChoices } from './ai/model-selection';
import { AddModelsModal } from './settings/add-models-modal';

const OUTPUT_LABELS: Record<OutputMode, string> = {
	[OutputMode.Auto]: 'Auto', [OutputMode.JsonSchema]: 'JSON schema',
	[OutputMode.Tool]: 'Tool call', [OutputMode.Json]: 'Plain JSON',
};
const MODEL_FIELDS = ['enabled', 'reasoningEffort', 'maxOutputTokens', 'outputMode', 'acceptsImages'] as const;
type ModelField = typeof MODEL_FIELDS[number];

/** Native provider and model pages, with a separate screen for adding model choices. */
export class AutoAnkiSettingTab extends PluginSettingTab {
	private readonly openedProviders = new Set<ProviderId>();
	private readonly refreshing = new Set<ProviderId>();
	private readonly errors = new Map<ProviderId, string>();
	private readonly refreshVersions = new Map<ProviderId, number>();
	private readonly refreshTasks = new Map<ProviderId, Promise<void>>();
	private resetInstructionsButton?: ButtonComponent;

	constructor(app: App, private readonly plugin: AutoAnkiPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const connected = PROVIDER_IDS.filter(id => getProviderApiKey(this.app, id));
		const selected = this.plugin.settings.defaultModel;
		const choices: Record<string, string> = { '': 'Choose a model' };
		for (const providerId of connected) {
			for (const model of this.pickerModels(providerId)) {
				choices[JSON.stringify({ providerId, modelId: model.id })] = `${model.displayName} · ${PROVIDER_PRESETS[providerId].name}`;
			}
		}
		return [
			{ name: 'Settings unavailable', desc: 'Auto Anki could not load the settings file. The previous settings are kept; editing is disabled until the file can be loaded.', visible: () => !this.plugin.settingsStore.canSave },
			{ type: 'list', heading: 'AI providers', items: PROVIDER_IDS.map(id => ({
				type: 'page', name: PROVIDER_PRESETS[id].name,
				displayValue: () => getProviderApiKey(this.app, id) ? 'API key saved' : 'No key on this device',
				status: () => getProviderApiKey(this.app, id) ? null : 'warning',
				items: this.providerSettings(id),
			})) },
			{ name: 'Selected model needs an API key',
				desc: selected ? `Add your ${PROVIDER_PRESETS[selected.providerId].name} API key on this device to use the saved default model. Your model settings are kept.` : '',
				visible: () => !!selected && !getProviderApiKey(this.app, selected.providerId) },
			{ name: 'Your models', visible: () => connected.length > 0, render: setting => {
				// A render callback runs when this row is shown. Indexing definitions for
				// settings search must not start account requests in the background.
				for (const providerId of PROVIDER_IDS) {
					if (!this.openedProviders.has(providerId) && getProviderApiKey(this.app, providerId)) {
						this.openedProviders.add(providerId);
						void this.refreshProvider(providerId);
					}
				}
				setting.setDesc(connected.some(id => this.refreshing.has(id)) ? 'Refreshing model lists…' : connected.some(id => this.errors.has(id))
					? 'Some model information could not be refreshed. Saved and cached choices remain available; open the provider page for details.'
					: `${Object.keys(choices).length - 1} enabled models. Open a provider and use Add models to choose more. Refreshing never enables models.`);
			} },
			{ name: 'Default model', desc: 'Choose a starting model from your enabled models. Open a provider and use Add models to choose more.',
				visible: () => Object.keys(choices).length > 1,
				control: { type: 'dropdown', key: 'defaultModel', options: choices, disabled: () => !this.plugin.settingsStore.canSave } },
			{ type: 'page', name: 'Cards', desc: 'Coverage, diagrams and instructions for writing your cards.', items: this.cardSettings() },
		];
	}

	getControlValue(key: string): unknown {
		switch (key) {
			case 'cards.sendDiagrams': return this.plugin.settings.cards.sendDiagrams;
			case 'cards.coverageLevel': return this.plugin.settings.cards.coverageLevel;
			case 'cards.extraInstructions': return this.plugin.settings.cards.extraInstructions;
			case 'cards.cardWritingInstructions': return this.plugin.settings.cards.cardWritingInstructions?.text ?? DEFAULT_CARD_WRITING_INSTRUCTIONS;
		}
		if (key === 'defaultModel') {
			const selected = this.plugin.settings.defaultModel;
			return selected && getProviderApiKey(this.app, selected.providerId) ? JSON.stringify(selected) : '';
		}
		const reference = this.readModelKey(key);
		if (!reference) return undefined;
		return this.model(reference.providerId, reference.modelId)[reference.field];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case 'cards.sendDiagrams':
				if (typeof value === 'boolean') await this.plugin.updateSettings(settings => { settings.cards.sendDiagrams = value; }, false);
				return;
			case 'cards.coverageLevel':
				if (COVERAGE_LEVELS.includes(value as CoverageLevel)) {
					await this.plugin.updateSettings(settings => { settings.cards.coverageLevel = value as CoverageLevel; }, false);
				}
				return;
			case 'cards.extraInstructions':
				if (typeof value === 'string') await this.plugin.updateSettings(settings => { settings.cards.extraInstructions = value; }, false);
				return;
			case 'cards.cardWritingInstructions':
				if (typeof value !== 'string') return;
				await this.plugin.updateSettings(settings => {
					const edited = settings.cards.cardWritingInstructions;
					if (!edited && value === DEFAULT_CARD_WRITING_INSTRUCTIONS) return;
					// Read the version inside the queued edit: rapid typing or a synced
					// override must keep the version of the guidance the edit began with.
					settings.cards.cardWritingInstructions = { text: value, defaultVersion: edited?.defaultVersion ?? CARD_WRITING_INSTRUCTIONS_VERSION };
				}, false); // Keep the text area and cursor in place while typing.
				this.resetInstructionsButton?.setDisabled(!this.plugin.settingsStore.canSave || !this.plugin.settings.cards.cardWritingInstructions);
				return;
		}
		if (key === 'defaultModel') {
			if (value === '') {
				await this.plugin.updateSettings(settings => { settings.defaultModel = null; });
				return;
			}
			const reference = this.readReference(value);
			if (reference && getProviderApiKey(this.app, reference.providerId)) await this.plugin.configureModel(reference.providerId, reference.modelId, true);
			return;
		}
		const reference = this.readModelKey(key);
		if (!reference) return;
		const { providerId, modelId, field } = reference;
		const available = this.model(providerId, modelId);
		if (field === 'enabled' && typeof value !== 'boolean') return;
		if (field === 'maxOutputTokens' && this.tokenError(value)) return;
		if (field === 'reasoningEffort' && !getReasoningEffortsForModel(providerId, available).includes(value as string)) return;
		if (field === 'outputMode' && !OUTPUT_MODES.includes(value as OutputMode)) return;
		if (field === 'acceptsImages' && !['auto', 'yes', 'no'].includes(value as string)) return;
		await this.plugin.updateSettings(settings => {
			let model = settings.providers[providerId].models.find(model => model.id === modelId);
			if (!model) {
				model = createModelSettings(modelId);
				settings.providers[providerId].models.push(model);
			}
			// Save discovered levels alongside a choice, so it also validates offline after restart.
			if (available.capabilities) model.capabilities = available.capabilities;
			if (field === 'enabled') {
				model.enabled = value as boolean;
				if (!model.enabled && settings.defaultModel?.providerId === providerId && settings.defaultModel.modelId === modelId) {
					settings.defaultModel = null;
				}
			}
			else if (field === 'maxOutputTokens') model.maxOutputTokens = value as number;
			else if (field === 'reasoningEffort') model.reasoningEffort = value as string;
			else if (field === 'outputMode') model.outputMode = value as OutputMode;
			else model.acceptsImages = value as ModelSettings['acceptsImages'];
		}, field === 'enabled'); // Keep the active control mounted while the user types a number.
	}

	hide(): void {
		super.hide();
		this.openedProviders.clear();
		this.resetInstructionsButton = undefined;
	}

	private cardSettings(): SettingDefinitionItem[] {
		const disabled = () => !this.plugin.settingsStore.canSave;
		return [
			{ name: 'Send diagrams', desc: 'Include supported images embedded in the note when the selected model accepts images.',
				control: { type: 'toggle', key: 'cards.sendDiagrams', disabled } },
			{ name: 'Coverage', desc: 'Choose how much detail to turn into cards. More detail usually means more cards.',
				control: { type: 'dropdown', key: 'cards.coverageLevel', disabled, options: {
					'key-ideas': 'Key ideas only',
					'main-ideas-and-details': 'Main ideas and important details',
					'everything': 'Everything worth remembering',
				} } },
			{ type: 'group', cls: 'auto-anki-instructions', items: [
				{ name: 'Extra instructions', desc: 'Preferences added to every run, such as "Use British spelling". Use Markdown and multiple lines; your spacing and line breaks are kept.',
					control: { type: 'textarea', key: 'cards.extraInstructions', rows: 5, placeholder: 'Add your preferences here…', disabled } },
			] },
			{ type: 'page', name: 'Advanced', desc: 'Edit the guidance for writing cards, or reset it to the built-in version.', items: [
				{ type: 'group', cls: 'auto-anki-instructions', items: [
					{ name: 'Card-writing instructions', desc: 'Editing replaces the built-in writing guidance and keeps your version through updates. For small additions, use Extra instructions instead. Required response-format rules are separate and cannot be edited here.',
						control: { type: 'textarea', key: 'cards.cardWritingInstructions', rows: 18, disabled } },
				] },
				{ name: 'Built-in guidance', desc: 'Reset discards your edited guidance and follows the current built-in instructions, including future improvements.', render: setting => {
					setting.addButton(button => {
						this.resetInstructionsButton = button;
						button.setButtonText('Reset to default').setDisabled(disabled() || !this.plugin.settings.cards.cardWritingInstructions)
							.onClick(async () => {
								button.setDisabled(true);
								await this.plugin.updateSettings(settings => { delete settings.cards.cardWritingInstructions; });
							});
					});
				} },
			] },
		];
	}

	private providerSettings(providerId: ProviderId): SettingDefinitionItem[] {
		const preset = PROVIDER_PRESETS[providerId];
		const configured = this.plugin.settings.providers[providerId].models;
		const configuredIds = new Set(configured.map(model => model.id));
		const selected = this.plugin.settings.defaultModel;
		const hasKey = () => !!getProviderApiKey(this.app, providerId);
		const editable = () => !this.plugin.settingsStore.canSave;
		return [
			// API key is the only supported connection method for now.
			// { name: 'Connect with', desc: 'API key. Keys stay in the Keychain on this device; add the key once on each computer.' },
			{ name: 'Add your API key to get started', desc: 'Save a key to browse and add models from this provider. Any saved model preferences are kept and can still be edited.', visible: () => !hasKey() },
			{ name: `${preset.name} API key`, desc: 'Keys stay in the Keychain on this device; add the key once on each computer.', render: setting => {
				setting.addText(text => {
					const key = getProviderApiKey(this.app, providerId);
					text.inputEl.type = 'password';
					text.setPlaceholder(key ? `Key saved: ${maskApiKey(key)}` : 'No key saved on this device')
						.setDisabled(editable() || !isKeychainAvailable(this.app));
					setting.addButton(button => {
						button.setButtonText('Save key').setDisabled(true);
						text.onChange(value => button.setDisabled(editable() || !isKeychainAvailable(this.app) || !value.trim()));
						button.onClick(async () => {
							const value = text.getValue();
							text.setValue('');
							button.setDisabled(true);
							if (!value.trim()) return;
							if (await this.plugin.connectProvider(providerId, value)) await this.refreshProvider(providerId, false, true);
						});
					});
				});
				// Rendering happens on opening the page, not while Obsidian indexes definitions.
				// Refresh once per settings visit; update() may rebuild the row after a reply.
				if (hasKey() && !this.openedProviders.has(providerId)) {
					this.openedProviders.add(providerId);
					void this.refreshProvider(providerId);
				}
			} },
			{ name: 'Model discovery', desc: this.errors.get(providerId) ?? 'Refreshing model information…',
				visible: () => hasKey() && (this.refreshing.has(providerId) || this.errors.has(providerId)) },
			{ type: 'list', heading: 'Your models', emptyState: 'Use Add models to choose which models appear in your picker.',
				visible: () => hasKey() || configured.length > 0,
				search: { placeholder: 'Search models', match: (definition, query) => {
					const id = typeof definition.desc === 'string' ? definition.desc : '';
					return `${definition.name} ${id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
				} },
				extraButtons: hasKey() ? [
					button => button.setIcon('plus').setTooltip('Add models').setDisabled(editable()).onClick(() => {
						if (!hasKey()) return;
						new AddModelsModal(this.app, this.plugin, providerId, () => this.refreshProvider(providerId, true),
							() => this.errors.get(providerId), this.refreshTasks.get(providerId)).open();
					}),
				] : [],
				items: sortModelChoices(this.plugin.discovery.getModels(providerId, configured).filter(model => configuredIds.has(model.id)),
					selected?.providerId === providerId ? selected.modelId : undefined).map(model => ({
					type: 'page', name: model.displayName, desc: model.displayName === model.id ? undefined : model.id,
					displayValue: () => this.plugin.settings.defaultModel?.providerId === providerId && this.plugin.settings.defaultModel.modelId === model.id
						? 'Default model' : this.model(providerId, model.id).enabled ? 'Enabled' : 'Hidden from picker',
					items: this.modelSettings(providerId, model.id),
				})) },
		];
	}

	private modelSettings(providerId: ProviderId, modelId: string): SettingDefinitionItem[] {
		const key = (field: ModelField) => `model:${JSON.stringify([providerId, modelId, field])}`;
		const disabled = () => !this.plugin.settingsStore.canSave;
		const efforts = getReasoningEffortsForModel(providerId, this.model(providerId, modelId));
		return [
			{ name: 'Show in model picker', desc: 'Turn off to hide this model while keeping its settings. Hiding your default clears that selection; choose another default before generating cards.',
				control: { type: 'toggle', key: key('enabled'), disabled } },
			{ name: 'Use as default model', visible: () => !!getProviderApiKey(this.app, providerId),
				action: () => { if (getProviderApiKey(this.app, providerId)) void this.plugin.configureModel(providerId, modelId, true); }, disabled },
			{ name: 'Reasoning effort', desc: 'Model default lets the model choose. Other levels vary by model; fallback options are not guaranteed to work for every model.',
				visible: () => efforts.length > 1,
				control: { type: 'dropdown', key: key('reasoningEffort'), disabled,
					options: Object.fromEntries(efforts.map(effort => [effort, effort === 'default' ? 'Model default' : effort.charAt(0).toUpperCase() + effort.slice(1)])) } },
			{ name: 'Maximum output tokens', desc: 'A per-request ceiling, including reasoning where applicable. You pay only for tokens used.',
				control: { type: 'number', key: key('maxOutputTokens'), min: 1, step: 1, validate: value => this.tokenError(value), disabled } },
			{ type: 'page', name: 'Advanced', desc: 'Troubleshooting options. Auto works for ordinary use.', items: [
				{ name: 'Output mode', desc: 'Auto chooses a supported card format. Override this only for troubleshooting.',
					control: { type: 'dropdown', key: key('outputMode'), options: OUTPUT_LABELS, disabled } },
				{ name: 'Accepts images', desc: 'Auto uses discovered image support. Override this if a model reports its capabilities incorrectly.',
					control: { type: 'dropdown', key: key('acceptsImages'), options: { auto: 'Auto', yes: 'Yes', no: 'No' }, disabled } },
			] },
		];
	}

	private refreshProvider(providerId: ProviderId, force = false, restart = false): Promise<void> {
		const pending = this.refreshTasks.get(providerId);
		if (pending && !restart) return pending;
		const task = this.fetchModels(providerId, force);
		this.refreshTasks.set(providerId, task);
		return task;
	}

	private async fetchModels(providerId: ProviderId, force: boolean): Promise<void> {
		const apiKey = getProviderApiKey(this.app, providerId);
		if (!apiKey) return;
		const version = (this.refreshVersions.get(providerId) ?? 0) + 1;
		this.refreshVersions.set(providerId, version);
		this.refreshing.add(providerId);
		this.errors.delete(providerId);
		this.refreshDomState();
		try {
			const results = await Promise.all([
				this.plugin.discovery.refreshProvider(providerId, apiKey),
				this.plugin.discovery.refreshCatalog(force),
			]);
			const errors = results.filter(result => !result.ok).map(result => result.ok ? '' : result.error);
			if (errors.length && this.refreshVersions.get(providerId) === version) this.errors.set(providerId, errors.join(' '));
		}
		finally {
			if (this.refreshVersions.get(providerId) === version) {
				this.refreshing.delete(providerId);
				this.refreshTasks.delete(providerId);
				this.update();
			}
		}
	}

	private pickerModels(providerId: ProviderId) {
		const configured = this.plugin.settings.providers[providerId].models;
		const models = this.plugin.discovery.getModels(providerId, configured);
		const selected = this.plugin.settings.defaultModel;
		return getPickerModels(models, configured, selected?.providerId === providerId ? selected.modelId : undefined);
	}

	private model(providerId: ProviderId, modelId: string): ModelSettings {
		const configured = this.plugin.settings.providers[providerId].models;
		const saved = configured.find(model => model.id === modelId) ?? createModelSettings(modelId);
		const known = this.plugin.discovery.getModels(providerId, configured, [modelId]).find(model => model.id === modelId);
		return { ...saved, capabilities: known?.capabilities ?? saved.capabilities };
	}

	private tokenError(value: unknown): string | undefined {
		return typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ? 'Enter a positive whole number.' : undefined;
	}

	private readReference(value: unknown): ModelReference | null {
		if (typeof value !== 'string') return null;
		try {
			const parsed = asRecord(JSON.parse(value));
			if (PROVIDER_IDS.includes(parsed.providerId as ProviderId) && typeof parsed.modelId === 'string' && parsed.modelId.trim()) {
				return { providerId: parsed.providerId as ProviderId, modelId: parsed.modelId.trim() };
			}
		}
		catch { /* Ignore a malformed control value. */ }
		return null;
	}

	private readModelKey(key: string): (ModelReference & { field: ModelField }) | null {
		if (!key.startsWith('model:')) return null;
		try {
			const parsed: unknown = JSON.parse(key.slice('model:'.length));
			if (Array.isArray(parsed) && parsed.length === 3 && PROVIDER_IDS.includes(parsed[0] as ProviderId)
				&& typeof parsed[1] === 'string' && parsed[1].trim() && MODEL_FIELDS.includes(parsed[2] as ModelField)) {
				return { providerId: parsed[0] as ProviderId, modelId: parsed[1], field: parsed[2] as ModelField };
			}
		}
		catch { /* Ignore a malformed control key. */ }
		return null;
	}
}

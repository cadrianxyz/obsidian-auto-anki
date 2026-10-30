import type { App, PluginSettingTab, SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import type AutoAnkiPlugin from '../../main';
import { PROVIDER_IDS, PROVIDER_NAMES, type ProviderId } from '../../ai/providers';
import { getReasoningEffortsForModel, type ProviderModelInfo } from '../../ai/models/metadata';
import { OUTPUT_MODES, OutputMode } from '../../ai/generation';
import { createModelSettings, DEFAULT_MAX_OUTPUT_TOKENS, type ModelReference, type ModelSettings } from '../../settings/schema';
import { getProviderApiKey, isKeychainAvailable, maskApiKey } from '../../utils/api-key';
import { asRecord } from '../../utils/data';
import { getEnabledModels, sortModelChoices } from '../../ai/models/selection';
import { ManageModelsModal } from './manage-models-modal';

const OUTPUT_LABELS: Record<OutputMode, string> = {
	[OutputMode.Auto]: 'Auto', [OutputMode.JsonSchema]: 'JSON schema',
	[OutputMode.Tool]: 'Tool call', [OutputMode.Json]: 'Plain JSON',
};
const MODEL_FIELDS = ['reasoningEffort', 'maxOutputTokens', 'outputMode', 'acceptsImages'] as const;
type ModelField = typeof MODEL_FIELDS[number];

/** Provider pages with their models, the default model picker, and model discovery. */
export class ProviderSettings {
	private readonly openedProviders = new Set<ProviderId>();
	private readonly refreshing = new Set<ProviderId>();
	private readonly errors = new Map<ProviderId, string>();
	private readonly refreshVersions = new Map<ProviderId, number>();
	private readonly refreshTasks = new Map<ProviderId, Promise<void>>();

	constructor(private readonly app: App, private readonly plugin: AutoAnkiPlugin, private readonly tab: PluginSettingTab) {}
	hide(): void { this.openedProviders.clear(); }
	owns(key: string): boolean { return key === 'defaultModel' || key.startsWith('model:'); }

	definitions(): SettingGroupItem[] {
		const connected = PROVIDER_IDS.filter(id => getProviderApiKey(this.app, id));
		const selected = this.plugin.settings.defaultModel;
		const modelsByProvider = new Map(PROVIDER_IDS.map(id => [id, this.plugin.discovery.getModels(id, this.plugin.settings.providers[id].models)]));
		const choices: Record<string, string> = { '': 'Choose a model' };
		for (const providerId of connected) {
			for (const model of getEnabledModels(modelsByProvider.get(providerId)!, this.plugin.settings.providers[providerId].models,
				selected?.providerId === providerId ? selected.modelId : undefined)) {
				choices[JSON.stringify({ providerId, modelId: model.id })] = `${model.displayName} · ${PROVIDER_NAMES[providerId]}`;
			}
		}
		return [
			...PROVIDER_IDS.map(id => ({
				type: 'page' as const, name: PROVIDER_NAMES[id],
				displayValue: () => !getProviderApiKey(this.app, id) ? 'No key on this device'
					: this.errors.has(id) ? 'Model information not refreshed' : 'API key saved',
				status: () => getProviderApiKey(this.app, id) && !this.errors.has(id) ? null : 'warning' as const,
				items: this.providerSettings(id, modelsByProvider.get(id)!),
			})),
			{ name: 'Selected model needs an API key',
				desc: selected ? `Add your ${PROVIDER_NAMES[selected.providerId]} API key on this device to use the saved default model. Your model settings are kept.` : '',
				visible: () => !!selected && !getProviderApiKey(this.app, selected.providerId) },
			{ name: 'Default model', desc: 'Choose a starting model from your enabled models. Open a provider and use Manage models to enable or disable models.',
				visible: () => Object.keys(choices).length > 1, render: setting => {
					// A render callback runs when this row is shown. Indexing definitions for
					// settings search must not start account requests in the background.
					for (const providerId of connected) {
						if (!this.openedProviders.has(providerId) && getProviderApiKey(this.app, providerId)) {
							this.openedProviders.add(providerId);
							void this.refreshProvider(providerId);
						}
					}
					setting.addDropdown(dropdown => dropdown.addOptions(choices).setValue(this.getValue('defaultModel') as string)
						.setDisabled(!this.plugin.settingsStore.canSave)
						.onChange(value => this.setValue('defaultModel', value)));
				} },
		];
	}

	getValue(key: string): unknown {
		if (key === 'defaultModel') {
			const selected = this.plugin.settings.defaultModel;
			return selected && getProviderApiKey(this.app, selected.providerId) ? JSON.stringify(selected) : '';
		}
		const reference = this.parseModelKey(key);
		if (!reference) return undefined;
		return this.model(reference.providerId, reference.modelId)[reference.field];
	}

	async setValue(key: string, value: unknown): Promise<void> {
		if (key === 'defaultModel') {
			if (value === '') {
				await this.plugin.updateSettings(settings => { settings.defaultModel = null; });
				return;
			}
			const reference = this.parseReference(value);
			if (reference && getProviderApiKey(this.app, reference.providerId)) await this.plugin.configureModel(reference.providerId, reference.modelId, true);
			return;
		}
		const reference = this.parseModelKey(key);
		if (!reference) return;
		const { providerId, modelId, field } = reference;
		const available = this.model(providerId, modelId);
		if (field === 'maxOutputTokens' && this.tokenError(value)) return;
		if (field === 'reasoningEffort' && value !== available.reasoningEffort && !getReasoningEffortsForModel(available).includes(value as string)) return;
		if (field === 'outputMode' && !OUTPUT_MODES.includes(value as OutputMode)) return;
		if (field === 'acceptsImages' && !['auto', 'yes', 'no'].includes(value as string)) return;
		await this.plugin.updateSettings(settings => {
			let model = settings.providers[providerId].models.find(model => model.id === modelId);
			if (!model) {
				model = createModelSettings(modelId);
				settings.providers[providerId].models.push(model);
			}
			// Save discovered levels alongside a choice, so they are offered offline after restart.
			if (available.capabilities) model.capabilities = available.capabilities;
			if (field === 'maxOutputTokens') model.maxOutputTokens = value as number;
			else if (field === 'reasoningEffort') model.reasoningEffort = value as string;
			else if (field === 'outputMode') model.outputMode = value as OutputMode;
			else model.acceptsImages = value as ModelSettings['acceptsImages'];
		}, false); // Keep the active control mounted while the user types a number.
	}

	private providerSettings(providerId: ProviderId, models: readonly ProviderModelInfo[]): SettingDefinitionItem[] {
		const providerName = PROVIDER_NAMES[providerId];
		const configured = this.plugin.settings.providers[providerId].models;
		const configuredById = new Map(configured.map(model => [model.id, model]));
		const selected = this.plugin.settings.defaultModel;
		const hasKey = () => !!getProviderApiKey(this.app, providerId);
		const editable = () => !this.plugin.settingsStore.canSave;
		return [
			// API key is the only supported connection method for now.
			// { name: 'Connect with', desc: 'API key. Keys stay in the Keychain on this device; add the key once on each computer.' },
			{ name: 'Add your API key to get started', desc: 'Save a key to browse and enable models from this provider. Any saved model preferences are kept and can still be edited.', visible: () => !hasKey() },
			{ name: `${providerName} API key`, desc: 'Keys stay in the Keychain on this device; add the key once on each computer.', render: setting => {
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
			{ type: 'list', heading: 'Your models', emptyState: 'Use Manage models to enable models for your picker.',
				visible: () => hasKey() || configured.length > 0,
				search: { placeholder: 'Search models', match: (definition, query) => {
					const id = typeof definition.desc === 'string' ? definition.desc : '';
					return `${definition.name} ${id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
				} },
				extraButtons: hasKey() || configured.length > 0 ? [
					button => button.setIcon('settings-2').setTooltip('Manage models').setDisabled(editable()).onClick(() => {
						new ManageModelsModal(this.app, this.plugin, providerId, () => this.refreshProvider(providerId, true),
							() => this.errors.get(providerId), this.refreshTasks.get(providerId)).open();
					}),
				] : [],
				items: sortModelChoices(models.filter(model => configuredById.get(model.id)?.enabled),
					selected?.providerId === providerId ? selected.modelId : undefined).map(model => {
					const saved = configuredById.get(model.id)!;
					return {
						type: 'page', name: model.displayName, desc: model.displayName === model.id ? undefined : model.id,
						displayValue: () => this.plugin.settings.defaultModel?.providerId === providerId && this.plugin.settings.defaultModel.modelId === model.id
							? 'Default model' : 'Enabled',
						items: this.modelSettings(providerId, { ...saved, capabilities: model.capabilities ?? saved.capabilities }),
					};
				}) },
		];
	}

	private modelSettings(providerId: ProviderId, current: ModelSettings): SettingDefinitionItem[] {
		const modelId = current.id;
		const key = (field: ModelField) => `model:${JSON.stringify([providerId, modelId, field])}`;
		const disabled = () => !this.plugin.settingsStore.canSave;
		const isDefault = () => this.plugin.settings.defaultModel?.providerId === providerId && this.plugin.settings.defaultModel.modelId === modelId;

		const reported = getReasoningEffortsForModel(current);
		// A saved level stays visible even when the model no longer reports it.
		const efforts = reported.includes(current.reasoningEffort) ? reported : [...reported, current.reasoningEffort];
		const effortLabel = (effort: string) => (effort === 'default' ? 'Model default' : effort.charAt(0).toUpperCase() + effort.slice(1))
			+ (reported.includes(effort) ? '' : ' (not reported for this model)');
		return [
			{ name: 'Use as default model', visible: () => !!getProviderApiKey(this.app, providerId),
				action: () => { if (getProviderApiKey(this.app, providerId) && !isDefault()) void this.plugin.configureModel(providerId, modelId, true); },
				disabled: () => disabled() || isDefault() },
			// Unknown levels (no metadata) differ from a model that reports none.
			{ name: 'Reasoning effort', desc: reported.length > 1
				? 'Model default lets the model choose. Other levels are the ones reported for this model.'
				: current.capabilities?.reasoningEfforts
					? 'Model default lets the model choose. This model reports no configurable effort levels.'
					: 'Model default lets the model choose. Effort levels for this model are not known yet; refresh models to load them.',
				control: { type: 'dropdown', key: key('reasoningEffort'), disabled,
					options: Object.fromEntries(efforts.map(effort => [effort, effortLabel(effort)])) } },
			{ name: 'Maximum output tokens', desc: `A per-request ceiling, including reasoning where applicable. You pay only for tokens used. Default: ${DEFAULT_MAX_OUTPUT_TOKENS}.`,
				control: { type: 'number', key: key('maxOutputTokens'), min: 1, step: 1, validate: value => this.tokenError(value), disabled } },
			{ type: 'page', name: 'Advanced', desc: 'Troubleshooting options. Auto works for ordinary use.', items: [
				{ name: 'Output mode', desc: 'Auto chooses a supported response format for receiving data from the AI. Override this only for troubleshooting.',
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
		this.tab.refreshDomState();
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
				this.tab.update();
			}
		}
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

	private parseReference(value: unknown): ModelReference | null {
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

	private parseModelKey(key: string): (ModelReference & { field: ModelField }) | null {
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

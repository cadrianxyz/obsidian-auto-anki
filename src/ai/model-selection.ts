import type { ProviderModelInfo } from './model-info';
import type { ModelSettings } from '../settings/model';

/** Unknown capabilities remain selectable. Only reported incompatibility excludes a model. */
export function isTextGenerationCandidate(model: ProviderModelInfo): boolean {
	return !model.isEmbedding && (!model.outputModalities?.length || model.outputModalities.includes('text'));
}

/** Discovery never enables a model. Only the user's saved, enabled choices enter the picker. */
export function getPickerModels(models: readonly ProviderModelInfo[], configured: readonly ModelSettings[], defaultId?: string): ProviderModelInfo[] {
	const enabledIds = new Set(configured.filter(model => model.enabled).map(model => model.id));
	return sortModelChoices(models.filter(model => enabledIds.has(model.id)), defaultId);
}

/** Default and saved choices first, then reported release date and name. This is not a quality ranking. */
export function sortModelChoices(models: readonly ProviderModelInfo[], defaultId?: string, savedIds: ReadonlySet<string> = new Set()): ProviderModelInfo[] {
	const priority = (id: string) => id === defaultId ? 0 : savedIds.has(id) ? 1 : 2;
	return [...models].sort((a, b) => priority(a.id) - priority(b.id)
		|| (b.releaseDate ? Date.parse(b.releaseDate) : 0) - (a.releaseDate ? Date.parse(a.releaseDate) : 0)
		|| a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' })
		|| a.id.localeCompare(b.id));
}

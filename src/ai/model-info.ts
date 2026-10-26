import { PROVIDER_PRESETS, type ModelReasoningEffort, type ProviderId } from './presets';
import { asRecord } from '../utils/data';

/** Output formats understood by the adapters. String values also form the saved-data format. */
export enum OutputMode {
	Auto = 'auto',
	JsonSchema = 'json_schema',
	Tool = 'tool',
	Json = 'json',
}

export type ResolvedOutputMode = Exclude<OutputMode, OutputMode.Auto>;
export const OUTPUT_MODES = Object.values(OutputMode);
export const RESOLVED_OUTPUT_MODES = OUTPUT_MODES.filter((mode): mode is ResolvedOutputMode => mode !== OutputMode.Auto);

/** Provider-reported or tested abilities, kept separate from the user's overrides. */
export interface ModelCapabilities {
	/** A supported output format. Missing means unknown; Auto is a user choice, not an ability. */
	outputMode?: ResolvedOutputMode;
	/** Missing means unknown, whereas false means images are explicitly unsupported. */
	acceptsImages?: boolean;
	/** Exact reported levels. Empty means none; absent uses the protocol fallback. */
	reasoningEfforts?: ModelReasoningEffort[];
}

/** Both protocols use the same order; an explicit user choice permits no format fallback. */
export function getGenerationOutputModes(model: { outputMode: OutputMode; capabilities?: ModelCapabilities }): readonly ResolvedOutputMode[] {
	if (model.outputMode !== OutputMode.Auto) return [model.outputMode];
	const initial = model.capabilities?.outputMode ?? OutputMode.JsonSchema;
	return RESOLVED_OUTPUT_MODES.slice(RESOLVED_OUTPUT_MODES.indexOf(initial));
}

/** Shared model information used by discovery, catalogue hints and settings. No HTTP calls here. */
export interface ProviderModelInfo {
	id: string;
	displayName: string;
	capabilities?: ModelCapabilities;
	/** Public catalogue metadata used to filter and order the Add models list. */
	outputModalities?: string[];
	isEmbedding?: boolean;
	releaseDate?: string;
	/** A reported model limit, not the user-selected output ceiling. */
	maxOutputTokens?: number;
}

/** Validate abilities loaded from saved settings or a saved catalogue cache. */
export function normalizeModelCapabilities(value: unknown): ModelCapabilities | undefined {
	const stored = asRecord(value);
	const capabilities: ModelCapabilities = {};
	if (typeof stored.outputMode === 'string' && RESOLVED_OUTPUT_MODES.includes(stored.outputMode as ResolvedOutputMode)) {
		capabilities.outputMode = stored.outputMode as ResolvedOutputMode;
	}
	if (typeof stored.acceptsImages === 'boolean') capabilities.acceptsImages = stored.acceptsImages;
	const efforts: unknown = stored.reasoningEfforts;
	if (Array.isArray(efforts) && efforts.every((effort: unknown) => typeof effort === 'string' && effort.trim().length > 0)) {
		capabilities.reasoningEfforts = [...new Set((efforts as string[]).filter(effort => effort !== 'default'))];
	}
	return Object.keys(capabilities).length ? capabilities : undefined;
}

/**
 * Resolve settings choices without fetching: loading saved settings must work offline.
 * Reported levels win; an explicit empty list offers only Model default. The same
 * selection can be used by the forthcoming settings dropdown after a model-list refresh.
 */
export function getReasoningEffortsForModel(providerId: ProviderId, model: { capabilities?: ModelCapabilities }): readonly ModelReasoningEffort[] {
	const reported = model.capabilities?.reasoningEfforts;
	return reported === undefined ? PROVIDER_PRESETS[providerId].fallbacks.reasoningEfforts : ['default', ...reported];
}

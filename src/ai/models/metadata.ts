import { asRecord } from '../../utils/data';
import { RESOLVED_OUTPUT_MODES, type ResolvedOutputMode } from '../generation';

// --- Model metadata ---

// Levels come from the provider (Claude) or models.dev (OpenAI), never a list in the plugin,
// so new reasoning levels do not require a plugin release.
export type ModelReasoningEffort = string;

/** Provider-reported or tested abilities, kept separate from the user's overrides. */
export interface ModelCapabilities {
	/** A supported output format. Missing means unknown; Auto is a user choice, not an ability. */
	outputMode?: ResolvedOutputMode;
	/** Missing means unknown, whereas false means images are explicitly unsupported. */
	acceptsImages?: boolean;
	/** Exact reported levels. Empty means none; absent means not reported. */
	reasoningEfforts?: ModelReasoningEffort[];
}

/** Normalized model details shared by provider lists, catalogue metadata, and settings. */
export interface ProviderModelInfo {
	id: string;
	displayName: string;
	capabilities?: ModelCapabilities;
	/** Public catalogue output types. Missing means unknown; empty means explicitly none. */
	outputModalities?: string[];
	isEmbedding?: boolean;
	releaseDate?: string;
	/** A reported model limit, not the user-selected output ceiling. */
	maxOutputTokens?: number;
}

// --- Capability validation ---

/**
 * Persisted capability hints are not guaranteed to match the current types. Keep only
 * usable values; omit invalid hints so malformed data is not treated as a known ability.
 */
export function normalizeModelCapabilities(value: unknown): ModelCapabilities | undefined {
	const stored = asRecord(value);
	const capabilities: ModelCapabilities = {};
	if (typeof stored.outputMode === 'string' && RESOLVED_OUTPUT_MODES.includes(stored.outputMode as ResolvedOutputMode)) {
		capabilities.outputMode = stored.outputMode as ResolvedOutputMode;
	}
	if (typeof stored.acceptsImages === 'boolean') capabilities.acceptsImages = stored.acceptsImages;
	// Missing levels mean unknown; an empty list means none. Preserve that distinction,
	// and accept new provider-defined levels without requiring a hard-coded enum update.
	const efforts: unknown = stored.reasoningEfforts;
	if (Array.isArray(efforts) && efforts.every((effort: unknown) => typeof effort === 'string' && effort.trim().length > 0)) {
		capabilities.reasoningEfforts = [...new Set((efforts as string[]).filter(effort => effort !== 'default'))];
	}
	return Object.keys(capabilities).length ? capabilities : undefined;
}

// --- Reasoning choices ---

/** The levels that may be newly chosen: Model default plus any reported for the model. */
export function getReasoningEffortsForModel(model: { capabilities?: ModelCapabilities }): readonly ModelReasoningEffort[] {
	return ['default', ...model.capabilities?.reasoningEfforts ?? []];
}

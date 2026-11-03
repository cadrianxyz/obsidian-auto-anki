import type { ModelSettings, PluginSettings } from '../settings/schema';
import type { SourceNote } from '../source-note/content';
import type { Diagram, PreparedDiagrams } from '../source-note/images';
import { getProvider } from '../ai/registry';
import type { ProviderId } from '../ai/providers';
import { createGenerationPrompt, type RunPreferences } from './prompt';
import { parseGeneratedNotes, type GenerationResult } from './result';
import type { ResolvedOutputMode } from '../ai/generation';
import type { AnkiDestinations } from '../anki/note-types';

/** Apply one immutable settings snapshot to the note being reviewed. No settings writes here. */
export async function generateNotes(providerId: ProviderId, apiKey: string, model: ModelSettings, preferences: PluginSettings['notes'], run: RunPreferences,
	note: SourceNote, diagrams: PreparedDiagrams, destinations: AnkiDestinations, signal?: AbortSignal): Promise<GenerationResult & { outputMode: ResolvedOutputMode; diagrams: Diagram[] }> {
	if (!destinations.types.length) throw new Error('No verified Anki destination is available. Enable an existing note type in Auto Anki → Anki.');
	const prompt = createGenerationPrompt(preferences, run, note, diagrams.diagrams, destinations);
	const reply = await getProvider(providerId).generate({ apiKey, model, prompt, signal });
	// The diagrams travel with the result so that export can store the ones each note uses.
	const result = parseGeneratedNotes(reply.content, run.maximumNotes, destinations, new Set(diagrams.diagrams.map(diagram => diagram.path)));
	return { ...result, outputMode: reply.outputMode, diagrams: diagrams.diagrams, warnings: [...diagrams.warnings, ...result.warnings] };
}

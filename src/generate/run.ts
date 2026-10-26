import type { ModelSettings, SettingsV1 } from '../settings/model';
import type { SourceNote } from '../note/read';
import type { PreparedDiagrams } from '../note/images';
import { requestOpenAiCards } from '../ai/openai-chat';
import { createGenerationPrompt, type RunPreferences } from './prompt';
import { parseGeneratedCards, type GenerationResult } from './result';
import type { ResolvedOutputMode } from '../ai/model-info';

/** Apply one immutable settings snapshot to the note being reviewed. No settings writes here. */
export async function generateCards(apiKey: string, model: ModelSettings, cards: SettingsV1['cards'], run: RunPreferences,
	note: SourceNote, diagrams: PreparedDiagrams, signal?: AbortSignal): Promise<GenerationResult & { outputMode: ResolvedOutputMode }> {
	const reply = await requestOpenAiCards(apiKey, model, createGenerationPrompt(cards, run, note, diagrams.diagrams), signal);
	const result = parseGeneratedCards(reply.content, run.maximumCards);
	return { ...result, outputMode: reply.outputMode, warnings: [...diagrams.warnings, ...result.warnings] };
}

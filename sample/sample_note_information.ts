import type { GeneratedAnkiNote } from '../src/generate/result';

/** Illustrative response entries; the chosen types and fields must exist in the user's Anki collection. */
export const SAMPLE_NOTE_INFORMATION: GeneratedAnkiNote[] = [
	{ noteType: 'Basic', fields: {
		Front: 'What does a confusion matrix summarize?',
		Back: 'Predicted versus actual classes for a classification model.',
	} },
	{ noteType: 'Cloze', fields: {
		Text: 'A false positive is also called a {{c1::type I error}}.',
		'Back Extra': '',
	} },
	{ noteType: 'Vocabulary', fields: {
		Expression: 'bonjour',
		Meaning: 'hello',
		Example: 'Bonjour, comment allez-vous ?',
	} },
];

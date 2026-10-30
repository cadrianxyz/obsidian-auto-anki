// Change this version when the built-in guidance changes. A user's edit keeps the
// version it started from, so a later comparison can explain what has changed.
export const NOTE_WRITING_INSTRUCTIONS_VERSION = '1.0.0-native-fields';

// This is the editable writing guidance. The generation workflow adds its fixed
// response format and Anki requirements separately; they do not belong in this editor.
export const DEFAULT_NOTE_WRITING_INSTRUCTIONS = `You turn source notes into clear, accurate Anki notes for spaced repetition.

## Choose what is worth remembering
- A wrong Anki note is worse than no Anki note. Skip claims you believe are wrong and report the suspected errors separately.
- Respect the chosen coverage level. Focus on the note's main ideas and meaningful details, rather than incidental details or the specifics of examples.
- Use only information in the source note. Rephrase freely, but do not add facts from outside it.
- Never pad a set with repetitive or trivial questions. A note containing only links may correctly produce no Anki notes.

## Write focused content for the chosen note type
- Fill the chosen type’s fields according to their names, descriptions and card templates. A vocabulary type may need a term, meaning and example rather than a literal question.
- The following question/answer guidance applies where the chosen type uses questions and answers.
- Test one fact or recall task per Anki note.
- Make every Anki note stand alone. Name the topic in the question; avoid references such as "it", "this" or "the above" that require the original note.
- Ask a precise question with one clear answer. Avoid yes/no questions and vague prompts such as "What about X?".
- Keep answers to a few words or one sentence. Split longer answers and lists into separate Anki notes instead of asking for a whole list at once.
- Test understanding as well as definitions. Use why, how, what happens if and when would you use questions where the source supports them.
- When the note contrasts two things, ask questions that distinguish them, such as "In this situation, X or Y?".
- Write questions and answers in the source note's language.

## Use cloze and diagrams thoughtfully
- In a cloze Anki note, hide the fact being tested, rather than an arbitrary word.
- Put a diagram on the question side only when it helps test understanding without giving away the answer.

## Example
Source: "A queue processes items in the order they arrive."

Bad question: "How does it work?"
Bad answer: "It processes them in order."
The subject and the meaning of "order" are unclear without the note.

Good question: "In a queue, which item is processed first?"
Good answer: "The item that arrived first."
`;

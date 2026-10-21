import OpenAI from 'openai';
import type {
    ChatCompletion,
    ChatCompletionCreateParams,
    ChatCompletionMessageParam,
} from 'openai/resources';
import logger from '../logger';
import { GenerationOptions } from '../settings';

export interface CardInformation {
    q: string;
    a: string;
}

export function checkGpt(openAiKey: string) {
    // check gpt api key
    if (openAiKey === '') {
        logger.log({
            level: 'error',
            message: "OpenAI API key not provided! Please go to your 'Auto Anki' settings to set an API key."
        });
        return false;
    }
    return true;
}

const SAMPLE_NOTE = `A numeral system is a writing system for expressing numbers. It is a mathematical notation for representing numbers of a given set, using digits or other symbols in a consistent manner.

Ideally, a numeral system will:
- represent a useful set of numbers (eg: integers, rational numbers)
- give every number represented a unique representation
- reflect the algebraic and arithmetic structure of the numbers

#### Positional Notation
> also known as the "place-value notation"

Uses a **radix**/**base** (eg: base 10) to indicate the number of unique *digits* that are used to represent numbers in a position until the position of the digit is used to signify a power of the *base* number.

- Positional Systems with Base 2: [[Binary Numeral System]]
- Positional Systems with Base 8: Octal Numeral System
- Positional Systems with Base 10: Decimal Numeral System
- Positional Systems with Base 12: Duodecimal (dozenal) Numeral System
- Positional Systems with Base 16: Hexadecimal Numeral System
- Positional Systems with Base 20: Vigesimal Numeral System
- Positional Systems with Base 60: Sexagesimal Numeral System
`

const SAMPLE_OUTPUT = [
    { q: 'What is a numeral system?', a: 'A numeral system is a writing system for expressing numbers, using digits or other symbols in a consistent manner.' },
    { q: 'What is the goal of a numeral system?', a: 'The goal of a numeral system is to represent a useful set of numbers (eg: integers, rational numbers), give every number represented a unique representation, and reflect the algebraic and arithmetic structure of the numbers.' },
    { q: 'What is a positional notation also known as?', a: 'Place-value Notation' },
    { q: 'What is a radix/base used for in the context of positional notation?', a: 'To indicate the number of unique digits that are used to represent numbers in a position until the position of the digit is used to signify a power of the base number' },
    { q: 'What numeral system uses a base of 2?', a: 'Binary Numeral System' },
    { q: 'What numeral system uses a base of 8?', a: 'Octal Numeral System' },
    { q: 'What numeral system uses a base of 10?', a: 'Decimal Numeral System' },
    { q: 'What numeral system uses a base of 12?', a: 'Duodecimal Numeral System' },
    { q: 'What numeral system uses a base of 16?', a: 'Hexadecimal Numeral System' },
    { q: 'What numeral system uses a base of 20?', a: 'Vigesimal Numeral System' },
    { q: 'What numeral system uses a base of 60?', a: 'Sexagesimal Numeral System' },
    { q: 'What is binary number representation?', a: 'Binary number representation is a number expressed in the base-2 numeral system or binary numeral system.' },
    // { q: '', a: '' },
]

function generateRepeatedSampleOutput(num: number) {
    if (num < SAMPLE_OUTPUT.length) return SAMPLE_OUTPUT.slice(0, num);

    let count = 0;
    const output = [];
    while (count < num) {
        output.push(...SAMPLE_OUTPUT)
        count += SAMPLE_OUTPUT.length;
    }
    return output.slice(0, num);
}

function createMessages(notes: string, num: number) {
    // Typed up front, so each push below is checked without a cast.
    const messages: ChatCompletionMessageParam[] = [];
    messages.push({
        role: 'system',
        content: `You will be provided notes on a specific topic. The notes are formatted in markdown. Based on the given notes, make a list of ${num} questions and short answers that can be used for reviewing said notes by spaced repetition. Use the following guidelines:
        - output the questions and answers in the following JSON format { "questions_answers": [{ "q": "<generated question>", "a": "<generated answer>" }] }
        - ensure that the questions cover the entire portion of the given notes, do not come up with similar questions or repeat the same questions
    `});

    // Insert sample user prompt
    messages.push({
        role: 'user',
        content: SAMPLE_NOTE,
    });
    

    // Insert sample assistant output (JSON format)
    messages.push({
        role: 'assistant',
        content: JSON.stringify({
            "questions_answers": generateRepeatedSampleOutput(num)
        }),
    });

    // Insert notes
    messages.push({
        role: 'user',
        content: `\n${notes.trim()}\n`,
    });

    return messages;
}
  
// The model's reply is untrusted text: check it really is { questions_answers: [{ q, a }] }.
// Returns null if the shape is wrong; entries that aren't a question/answer pair are dropped.
function parseQuestionsAnswers(content: string): CardInformation[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const list = (parsed as { questions_answers?: unknown }).questions_answers;
    if (!Array.isArray(list)) return null;
    return list.filter((item): item is CardInformation =>
        item !== null && typeof item === 'object' &&
        typeof (item as { q?: unknown }).q === 'string' &&
        typeof (item as { a?: unknown }).a === 'string');
}

function describeOpenAiError(err: unknown, model: string) {
    if (err instanceof OpenAI.APIError && err.status !== undefined) {
        if (err.status === 401) {
            return 'OpenAI rejected the API key (401). Check the key in the Auto Anki settings.';
        }
        if (err.status === 404) {
            return `OpenAI doesn't know the model "${model}" (404). Check the model name in the Auto Anki settings.\n${err.message}`;
        }
        if (err.status === 400 && /reasoning_effort/.test(err.message)) {
            return `The model "${model}" doesn't accept the chosen reasoning effort. Set "Reasoning effort" to "Model default" in the Auto Anki settings, or pick another level.\n${err.message}`;
        }
        if (err.status === 429) {
            return `OpenAI rate limit or quota reached (429).\n${err.message}`;
        }
        return `OpenAI returned an error (${err.status}).\n${err.message}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Could not connect to OpenAI! ${message}`;
}

export async function convertNotesToFlashcards(
    apiKey: string,
    model: string,
    notes: string,
    num_q: number,
    num: number,
    options: GenerationOptions,
) {
    let response: ChatCompletion;
    try {
        const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });

        response = await client.chat.completions.create({
            model,
            messages: createMessages(notes, num_q),
            // max_tokens is deprecated, and reasoning models refuse it. This cap includes
            // the tokens a reasoning model spends thinking, not just the visible answer.
            max_completion_tokens: options.maxOutputTokens,
            n: num,
            stream: false,
            response_format: { type: "json_object" },
            // Only sent when chosen: models without reasoning reject the parameter.
            ...(options.reasoningEffort !== 'default' ? { reasoning_effort: options.reasoningEffort } : {}),
            // Temperature, top_p and the penalties are deliberately never sent: current
            // OpenAI models only accept their defaults.
        } as ChatCompletionCreateParams) as ChatCompletion;
    }
    catch (err) {
        logger.log({
            level: 'error',
            message: describeOpenAiError(err, model),
        });
        return [];
    }

    const card_choices: Array<CardInformation[]> = [];
    logger.log({
        level: 'info',
        message: `Generated ${response.choices.length} choices!`,
    });

    for (const [idx, set] of response.choices.entries()) {
        if (set.finish_reason === 'length') {
            logger.log({
                level: 'error',
                message: `The model ran out of tokens before finishing (choice ${idx + 1}). Raise "Maximum output tokens" or lower "Reasoning effort" in the Auto Anki settings, or ask for fewer questions.`,
            });
            return [];
        }
        const content = set.message.content ?? '';
        logger.log({
            level: 'info',
            message: content,
        });
        const questions = parseQuestionsAnswers(content);
        if (questions == null) {
            logger.log({
                level: 'error',
                message: `The model's reply wasn't in the expected format (choice ${idx + 1}), so no cards were made. Try again, or try a different model.`,
            });
            return [];
        }
        logger.log({
            level: 'info',
            message: `Choice ${idx}: generated ${questions.length} questions and answers`,
        });
        card_choices.push(questions);
    }
    return card_choices;
}

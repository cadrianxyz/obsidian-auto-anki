import { Notice } from 'obsidian';
import { Configuration, OpenAIApi } from 'openai';
import { GptAdvancedOptions } from 'src/settings';

export interface CardInformation {
    question: string;
    answer: string;
}

export function checkGpt(openAiKey: string) {
    // check gpt api key
    if (openAiKey === '') {
        new Notice("ERR: OpenAI API key not provided! Please go to your 'Simple Recall' settings to set an API key.")
        return false;
    }
    return true;
}

function createPrompt(notes: string, num: number) {
    let finalPrompt = 'The following are notes on a specific topic, written in markdown.';
    finalPrompt += `\n${notes.trim()}\n`;
    finalPrompt += `Based on the information given, make a list of ${num} questions and short answers using the following format:
    Q: question
    A: answer`;
    return finalPrompt;
}
  
export async function convertNotesToFlashcards(
    apiKey: string,
    notes: string,
    num_q: number,
    num: number,
    options: GptAdvancedOptions,
) {
    let response;
    try {
        const config = new Configuration({ apiKey });
        const openai = new OpenAIApi(config);

        const {
            max_tokens_per_question: tokensPerQuestion,
            ...completionOptions
        } = options;
    
        // for anki connect, the output
        response = await openai.createCompletion({
            model: 'text-davinci-003',
            prompt: createPrompt(notes, num_q),
            max_tokens: tokensPerQuestion * num_q,
            n: num,
            ...completionOptions,
        });
    }
    catch (err) {
        if (!err.response) {
            new Notice(`ERR: Could not connect to OpenAI! ${err.message}`);
        }
        else {
            const errStatus = err.response.status;
            const errBody = err.response.data;
            let supportingMessage = `(${errBody.error.code}) ${errBody.error.message}`;
            if (errStatus === 401) {
                supportingMessage = 'Check that your API Key is correct/valid!';
            }
            new Notice(`ERR ${errStatus}: Could not connect to OpenAI! ${supportingMessage}`);
        }
        return [];
    }

    try {
        const card_choices: Array<Array<CardInformation>> = [];
        
        response.data.choices.forEach((set) => {
            const data = set.text ?? '';
            const choices: Array<string> = data.trim().split('\n\n');
            const cards: Array<CardInformation> = [];
            choices.forEach((choice: string) => {
                const splits: Array<string> = choice.split('\n');
                if (splits.length < 2) return;
                cards.push({
                    question: splits[0].slice(3),
                    answer: splits[1].slice(3),
                });
            });
            card_choices.push(cards);
        })
        return card_choices;
    }
    catch (err) {
        new Notice(`ERR: Something happened while parsing OpenAI output! Please contact a developer for more support.`);
        return [];
    }
}
import { Notice } from 'obsidian';
import { Configuration, OpenAIApi } from 'openai';

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
  
export async function convertNotesToFlashcards(apiKey: string, notes: string, num: number) {
    let response;
    try {
        const config = new Configuration({ apiKey });
        const openai = new OpenAIApi(config);
    
        // for anki connect, the output
        response = await openai.createCompletion({
            model: 'text-davinci-003',
            prompt: createPrompt(notes, num),
            temperature: 0.3,
            max_tokens: 150 * num,
            top_p: 1.0,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
        });
    }
    catch (err) {
        const errStatus = err.response.status;
        const errBody = err.response.data;
        let supportingMessage = `(${errBody.error.code}) ${errBody.error.message}`;
        if (errStatus === 401) {
            supportingMessage = 'Check that your API Key is correct/valid!';
        }
        new Notice(`ERR ${errStatus}: Could not connect to OpenAI! ${supportingMessage}`);
        return [];
    }

    try {
        const data = response.data.choices[0].text ?? ''
        const choices = data.trim().split('\n\n');
        const cards: Array<CardInformation> = choices.map((choice) => {
        // const cards = choices.map((choice) => {
            const splits: Array<string> = choice.split('\n');
            return {
                question: splits[0].slice(3),
                answer: splits[1].slice(3),
            }
        });
        return cards;
    }
    catch (err) {
        new Notice(`ERR: Something happened while parsing OpenAI output! Please contact a developer for more support.`);
        return [];
    }
}
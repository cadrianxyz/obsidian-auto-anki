import { Configuration, OpenAIApi } from 'openai';

export interface CardInformation {
    question: string;
    answer: string;
}

const PRE_PROMPT = `The following are notes on a specific topic, written in markdown.`;
const PROMPT_REQ = `Based on the information given, make a list of questions and short answers using the following format:
Q: question
A: answer`;
  
export async function convertNotesToFlashcards(apiKey: string, notes: string, num: number) {
    const config = new Configuration({ apiKey });
    const openai = new OpenAIApi(config);

    // for anki connect, the output
    const response = await openai.createCompletion({
        model: 'text-davinci-003',
        prompt: `${PRE_PROMPT}\n${notes.trim()}\n${PROMPT_REQ}`,
        temperature: 0.3,
        max_tokens: 150 * num,
        top_p: 1.0,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
    });

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
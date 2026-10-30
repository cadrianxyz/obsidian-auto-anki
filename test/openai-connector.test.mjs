// Invented replies with the documented Responses API shapes, sent through the official SDK
// to a fake fetch. These tests make no network calls.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetAll, openai, openAiReply, openAiError, BASIC_DESTINATIONS, generatedNote } from './helpers.mjs';
import { createModelSettings } from '../src/settings/schema';
import { OutputMode } from '../src/ai/generation';
import { requestNotes } from '../src/ai/openai/request';
import { noteResponseSchema } from '../src/generate/result';

beforeEach(resetAll);
const NOTE_RESPONSE_SCHEMA = noteResponseSchema(BASIC_DESTINATIONS);
const KEY = 'sk-FAKE-contract-key';
const NOTES = { notes: [generatedNote({ type: 'basic', front: 'Which queue item leaves first?', back: 'The earliest item added.' })], note_issues: [] };
const PROMPT = { instructions: '# Writing rules\n\nKeep this exact.  \n', source: '{"markdown":"Arrival order."}', diagrams: [], schema: NOTE_RESPONSE_SCHEMA };
const model = () => createModelSettings('future-provider-model-id');
const reply = (output, extra = {}) => ({ json: { ...openAiReply(NOTES.notes).json, output, ...extra } });
const message = (content, extra = {}) => ({ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content, ...extra });
const text = value => ({ type: 'output_text', annotations: [], text: value });
const call = (name = 'submit_notes', args = JSON.stringify(NOTES)) => ({ type: 'function_call', id: 'fc_test', call_id: 'call_test', status: 'completed', name, arguments: args });
function generate(selected, handler, { signal, timeoutMs, prompt = PROMPT } = {}) {
	openai.handler = handler;
	return requestNotes({ apiKey: KEY, model: selected, prompt, signal }, timeoutMs === undefined ? {} : { timeoutMs });
}

describe('OpenAI Responses request and response formats', () => {
	test('a stateless request with instructions, typed input and a strict schema', async () => {
		const result = await generate(model(), () => openAiReply(NOTES.notes));
		assert.equal(openai.requests.length, 1);
		const { url, headers, body } = openai.requests[0];
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
		assert.equal(headers.get('x-stainless-retry-count'), '0');
		assert.equal(body.model, 'future-provider-model-id');
		assert.equal(body.store, false);
		assert.equal(body.stream, false);
		assert.equal(body.instructions, PROMPT.instructions);
		assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: PROMPT.source }] }]);
		assert.equal(body.max_output_tokens, 25000);
		assert.deepEqual(body.text, { format: { type: 'json_schema', name: 'submit_notes', strict: true, schema: NOTE_RESPONSE_SCHEMA } });
		for (const absent of ['reasoning', 'tools', 'tool_choice', 'previous_response_id', 'messages', 'response_format', 'max_completion_tokens', 'temperature']) assert.ok(!(absent in body), absent);
		assert.equal(result.outputMode, OutputMode.JsonSchema);
		assert.deepEqual(JSON.parse(result.content), { notes: NOTES.notes, note_issues: [] });
	});
	test('environment variables cannot redirect requests, add an organisation or project, or enable SDK logging', async () => {
		const saved = { ...process.env };
		Object.assign(process.env, { OPENAI_BASE_URL: 'https://attacker.invalid/v1', OPENAI_ORG_ID: 'org-env', OPENAI_PROJECT_ID: 'proj-env', OPENAI_API_KEY: 'env-key', OPENAI_ADMIN_KEY: 'env-admin-key', OPENAI_LOG: 'debug' });
		const logged = [];
		const original = { debug: console.debug, info: console.info, log: console.log };
		console.debug = console.info = console.log = (...args) => logged.push(args);
		try {
			await generate(model(), () => openAiReply(NOTES.notes));
		}
		finally {
			Object.assign(console, original);
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
		const { url, headers } = openai.requests[0];
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
		assert.equal(headers.get('openai-organization'), null);
		assert.equal(headers.get('openai-project'), null);
		assert.deepEqual(logged, [], 'SDK logging stays disabled');
	});
	test('a chosen effort, including one newer than the SDK types, is sent as reasoning.effort', async () => {
		for (const effort of ['max', 'future-effort']) {
			await generate({ ...model(), reasoningEffort: effort, maxOutputTokens: 4096 }, () => openAiReply(NOTES.notes));
			assert.deepEqual(openai.requests.at(-1).body.reasoning, { effort });
			assert.equal(openai.requests.at(-1).body.max_output_tokens, 4096);
		}
	});
	test('diagrams follow filename labels as input images', async () => {
		const prompt = { ...PROMPT, diagrams: [{ name: 'Attachments/queue.png', mime: 'image/png', base64: 'AQID' }] };
		await generate(model(), () => openAiReply(NOTES.notes), { prompt });
		assert.deepEqual(openai.requests[0].body.input[0].content, [
			{ type: 'input_text', text: PROMPT.source }, { type: 'input_text', text: 'Diagram: Attachments/queue.png' },
			{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQID' },
		]);
	});
	test('tool mode forces one strict function and returns its arguments, ignoring reasoning and commentary', async () => {
		const selected = { ...model(), outputMode: OutputMode.Tool, reasoningEffort: 'high' };
		const result = await generate(selected, () => reply([{ type: 'reasoning', id: 'rs_test', summary: [{ type: 'summary_text', text: 'Never show this.' }] },
			message([text('Submitting the notes now.')], { phase: 'commentary' }), call()]));
		const body = openai.requests[0].body;
		assert.deepEqual(body.tools, [{ type: 'function', name: 'submit_notes', description: 'Return the generated Anki notes and source concerns.', parameters: NOTE_RESPONSE_SCHEMA, strict: true }]);
		assert.deepEqual(body.tool_choice, { type: 'function', name: 'submit_notes' });
		assert.deepEqual(body.reasoning, { effort: 'high' });
		assert.ok(!('text' in body));
		assert.deepEqual(result, { content: JSON.stringify(NOTES), outputMode: OutputMode.Tool });
	});
	test('plain JSON mode asks for a JSON object', async () => {
		await generate({ ...model(), outputMode: OutputMode.Json }, () => openAiReply(NOTES.notes));
		assert.deepEqual(openai.requests[0].body.text, { format: { type: 'json_object' } });
	});
	test('reasoning and commentary are never returned as note content, and final text may span parts', async () => {
		const json = JSON.stringify(NOTES);
		const result = await generate(model(), () => reply([{ type: 'reasoning', id: 'rs_test', summary: [] },
			message([text('Reading the note first.')], { phase: 'commentary' }),
			message([text(json.slice(0, 10)), text(json.slice(10))], { phase: 'final_answer' })]));
		assert.equal(result.content, json);
	});
});

describe('OpenAI bounded output-format fallback', () => {
	test('Auto uses schema, then tool, then plain JSON only after explicit unsupported-format errors', async () => {
		const result = await generate(model(), body => {
			if (body.text?.format?.type === 'json_schema') return openAiError(400, 'text.format json_schema is not supported by this model.');
			if (body.tools) return openAiError(400, 'tool_choice is unsupported by this model.');
			return openAiReply(NOTES.notes);
		});
		assert.equal(openai.requests.length, 3);
		assert.equal(openai.requests[2].body.text.format.type, 'json_object');
		assert.equal(result.outputMode, OutputMode.Json);
	});
	test('an explicit choice, an invalid schema and other errors make exactly one request', async () => {
		for (const [selected, error, expected] of [
			[{ ...model(), outputMode: OutputMode.JsonSchema }, openAiError(400, 'text.format json_schema is unsupported'), /OpenAI returned an error \(400\)/],
			[model(), openAiError(400, 'Invalid schema for text.format: keyword is not supported'), /OpenAI returned an error \(400\)/],
			[model(), openAiError(400, "Unsupported value: 'reasoning.effort' does not support 'max' with this model."), /reasoning effort/],
			[model(), openAiError(400, 'max_output_tokens is too large for this model'), /output-token limit/],
			[model(), openAiError(401, 'Incorrect API key'), /rejected the API key/],
			[model(), openAiError(404, 'The model does not exist'), /doesn't know the model/],
			// The SDK would retry these without maxRetries: 0, sending a second paid generation.
			[model(), openAiError(429, 'Rate limit reached'), /rate limit or quota/],
			[model(), openAiError(500, 'The server had an error'), /OpenAI returned an error \(500\)/],
		]) {
			resetAll();
			await assert.rejects(generate(selected, () => error), expected);
			assert.equal(openai.requests.length, 1);
		}
	});
});

describe('incomplete and malformed OpenAI responses', () => {
	test('output_text from an incomplete or unfinished response is never used', async () => {
		for (const [extra, expected] of [
			[{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, /ran out of tokens/],
			[{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, /declined/],
			[{ status: 'incomplete', incomplete_details: null }, /did not finish/],
			[{ status: 'failed', error: { code: 'server_error', message: 'Failed' } }, /did not finish/],
			[{ status: 'in_progress' }, /did not finish/],
		]) {
			await assert.rejects(generate(model(), () => reply([message([text(JSON.stringify(NOTES))])], { output_text: JSON.stringify(NOTES), ...extra })), expected);
		}
		await assert.rejects(generate(model(), () => reply([message([text(JSON.stringify(NOTES))], { status: 'incomplete' })])), /expected format/);
	});
	test('a refusal is rejected even beside text', async () => {
		await assert.rejects(generate(model(), () => reply([message([text(JSON.stringify(NOTES)), { type: 'refusal', refusal: 'Cannot help.' }])])), /declined/);
	});
	test('unexpected output items, empty text and malformed function calls are rejected without another request', async () => {
		const cases = [
			[model(), []], [model(), [call()]], [model(), [{ type: 'web_search_call', id: 'ws', status: 'completed' }]],
			[model(), [message([text('   ')])]], [model(), [message([{ type: 'output_text', text: 5 }])]],
			[{ ...model(), outputMode: OutputMode.Tool }, [message([text(JSON.stringify(NOTES))])]],
			[{ ...model(), outputMode: OutputMode.Tool }, [call('other')]],
			[{ ...model(), outputMode: OutputMode.Tool }, [call('submit_notes', '')]],
			[{ ...model(), outputMode: OutputMode.Tool }, [call(), call()]],
		];
		for (const [selected, output] of cases) {
			resetAll();
			await assert.rejects(generate(selected, () => reply(output)), /readable|expected (?:function )?format/);
			assert.equal(openai.requests.length, 1);
		}
	});
	test('an unreadable success body is reported without retrying', async () => {
		await assert.rejects(generate(model(), () => ({ status: 200, text: '{"object":"response",', headers: { 'content-type': 'application/json' } })), /readable generation result/);
		assert.equal(openai.requests.length, 1);
	});
});

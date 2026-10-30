// Invented replies with the documented Messages API shapes, sent through the official SDK
// to a fake fetch. These tests make no network calls.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { resetAll, BASIC_DESTINATIONS, generatedNote } from './helpers.mjs';
import { createModelSettings } from '../src/settings/schema';
import { OutputMode } from '../src/ai/generation';
import { requestNotes } from '../src/ai/anthropic/request';

import { noteResponseSchema, parseGeneratedNotes } from '../src/generate/result';

beforeEach(resetAll);
const NOTE_RESPONSE_SCHEMA = noteResponseSchema(BASIC_DESTINATIONS);
const KEY = 'sk-ant-FAKE-contract-key';
const NOTES = { notes: [generatedNote({ type: 'basic', front: 'Which queue item leaves first?', back: 'The earliest item added.' })], note_issues: [] };
const PROMPT = { instructions: '# Writing rules\n\nKeep this exact.  \n', source: '{"markdown":"Arrival order."}', diagrams: [], schema: NOTE_RESPONSE_SCHEMA };
const model = () => createModelSettings('future-provider-model-id');
const response = (text = JSON.stringify(NOTES), stop = 'end_turn') => ({ status: 200, json: {
	id: 'msg_test', type: 'message', role: 'assistant', model: 'future-provider-model-id',
	content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null,
	usage: { input_tokens: 100, output_tokens: 50 },
} });
const apiError = (status, message) => ({ status, json: { type: 'error', error: { type: 'invalid_request_error', message } } });
// Requests go through the official SDK and the test fetch; the handler receives each parsed body.
function generate(selected, handler, { signal, timeoutMs, prompt = PROMPT } = {}) {
	fake.providerHandler = handler;
	return requestNotes({ apiKey: KEY, model: selected, prompt, signal }, timeoutMs === undefined ? {} : { timeoutMs });
}

describe('Claude request and response formats', () => {
	test('native schema uses Bearer authentication, a top-level system prompt and no unnecessary parameters', async () => {
		const result = await generate(model(), () => response());
		assert.equal(fake.providerRequests.length, 1);
		const sent = fake.providerRequests[0];
		assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
		assert.equal(sent.method, 'POST');
		assert.equal(sent.headers['content-type'], 'application/json');
		assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
		assert.ok(!('x-api-key' in sent.headers));
		assert.equal(sent.headers['anthropic-version'], '2026-10-21');
		assert.equal(sent.headers['anthropic-dangerous-direct-browser-access'], 'true');
		assert.equal(sent.headers['x-stainless-retry-count'], '0');
		assert.ok(!('traceparent' in sent.headers), 'no trace headers');
		const body = sent.body;
		assert.equal(body.system, PROMPT.instructions);
		assert.equal(body.model, 'future-provider-model-id');
		assert.equal(body.max_tokens, 25000);
		assert.equal(body.stream, false);
		assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: PROMPT.source }] }]);
		assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: NOTE_RESPONSE_SCHEMA } });
		for (const absent of ['thinking', 'temperature', 'top_p', 'top_k', 'n', 'cache_control', 'output_format', 'response_format', 'tools', 'max_completion_tokens']) assert.ok(!(absent in body), absent);
		assert.deepEqual(result, { content: JSON.stringify(NOTES), outputMode: OutputMode.JsonSchema });
	});
	test('environment variables cannot redirect requests, replace the key or enable SDK logging', async () => {
		const saved = { ...process.env };
		Object.assign(process.env, { ANTHROPIC_BASE_URL: 'https://attacker.invalid', ANTHROPIC_AUTH_TOKEN: 'env-token', ANTHROPIC_API_KEY: 'env-key', ANTHROPIC_LOG: 'debug' });
		const logged = [];
		const original = { debug: console.debug, info: console.info, log: console.log };
		console.debug = console.info = console.log = (...args) => logged.push(args);
		try {
			await generate(model(), () => response());
		}
		finally {
			Object.assign(console, original);
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
		const sent = fake.providerRequests[0];
		assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
		assert.equal(sent.headers.authorization, `Bearer ${KEY}`, 'ANTHROPIC_AUTH_TOKEN is never sent');
		assert.ok(!('x-api-key' in sent.headers));
		assert.deepEqual(logged, [], 'SDK logging stays disabled');
	});
	test('explicit effort and output ceiling reach Claude, including a future reported effort name', async () => {
		const selected = { ...model(), reasoningEffort: 'future-effort', maxOutputTokens: 4096 };
		let body;
		await generate(selected, sent => { body = sent; return response(); });
		assert.equal(body.output_config.effort, 'future-effort');
		assert.equal(body.output_config.format.type, 'json_schema');
		assert.equal(body.max_tokens, 4096);
		assert.ok(!('thinking' in body));
	});
	test('a large output ceiling is sent without streaming because the timeout is explicit', async () => {
		// The SDK otherwise refuses non-streaming requests it estimates exceed ten minutes.
		let body;
		await generate({ ...model(), maxOutputTokens: 128000 }, sent => { body = sent; return response(); });
		assert.equal(body.max_tokens, 128000);
		assert.equal(body.stream, false);
		assert.equal(fake.providerRequests[0].headers['x-stainless-timeout'], '600');
	});
	test('diagrams follow filename labels as native base64 image blocks', async () => {
		const prompt = { ...PROMPT, diagrams: [{ name: 'Attachments/queue.png', mime: 'image/png', base64: 'AQID' }] };
		let body;
		await generate(model(), sent => { body = sent; return response(); }, { prompt });
		assert.deepEqual(body.messages[0].content, [
			{ type: 'text', text: PROMPT.source }, { type: 'text', text: 'Diagram: Attachments/queue.png' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
		]);
	});
	test('tool mode returns data from the single named tool without executing anything', async () => {
		const selected = { ...model(), outputMode: OutputMode.Tool, reasoningEffort: 'low' };
		let body;
		const reply = response(); reply.json.stop_reason = 'tool_use';
		reply.json.content = [{ type: 'text', text: 'Here is the result.' }, { type: 'tool_use', id: 'toolu_test', name: 'submit_notes', input: NOTES }];
		const result = await generate(selected, sent => { body = sent; return reply; });
		assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_notes' });
		assert.deepEqual(body.tools[0].input_schema, NOTE_RESPONSE_SCHEMA);
		assert.deepEqual(body.output_config, { effort: 'low' });
		assert.deepEqual(JSON.parse(result.content), NOTES);
		assert.equal(result.outputMode, OutputMode.Tool);
	});
	test('plain JSON allows prose or a fenced object and handles escaped quotes and braces inside strings', async () => {
		const selected = { ...model(), outputMode: OutputMode.Json };
		const content = { notes: [{ type: 'basic', front: 'Meaning of {x} and "a"?', back: 'Literal text with \\slashes.' }], note_issues: [] };
		for (const text of [JSON.stringify(content), `Here is the result:\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\`\nDone.`]) {
			const result = await generate(selected, body => {
				assert.ok(!('output_config' in body));
				assert.ok(!('tools' in body));
				assert.equal(body.messages.length, 1, 'no assistant prefill');
				return response(text);
			});
			assert.deepEqual(JSON.parse(result.content), content);
		}
	});
	test('thinking blocks are excluded, and final text can span more than one block', async () => {
		const json = JSON.stringify(NOTES);
		const reply = response(); reply.json.content = [{ type: 'thinking', thinking: 'Never show this.' },
			{ type: 'redacted_thinking', data: 'hidden' }, { type: 'text', text: json.slice(0, 15) }, { type: 'text', text: json.slice(15) }];
		const result = await generate(model(), () => reply);
		assert.equal(result.content, json);
		assert.deepEqual(parseGeneratedNotes(result.content, undefined, BASIC_DESTINATIONS).notes[0], NOTES.notes[0]);
	});
});

describe('bounded output-format fallback', () => {
	test('Auto uses schema, then tool, then plain JSON only after explicit unsupported-format errors', async () => {
		const bodies = [];
		const result = await generate(model(), body => {
			bodies.push(body);
			if (body.output_config?.format) return apiError(400, 'This model does not support output_config.format json_schema.');
			if (body.tools) return apiError(400, 'tool_choice forced tool use is not supported by this model.');
			return response(`\`\`\`json\n${JSON.stringify(NOTES)}\n\`\`\``);
		});
		assert.equal(bodies.length, 3);
		assert.equal(bodies[0].output_config.format.type, 'json_schema');
		assert.equal(bodies[1].tool_choice.type, 'tool');
		assert.ok(!('output_config' in bodies[2]));
		assert.equal(result.outputMode, OutputMode.Json);
	});
	test('a remembered format starts at that rung, while an explicit choice prevents fallback', async () => {
		let calls = 0;
		const cached = { ...model(), capabilities: { outputMode: OutputMode.Json } };
		await generate(cached, body => { calls++; assert.ok(!('tools' in body)); return response(); });
		assert.equal(calls, 1);
		await assert.rejects(generate({ ...model(), outputMode: OutputMode.JsonSchema }, () => { calls++; return apiError(400, 'output_config.format is unsupported'); }), /Claude returned an error/);
		assert.equal(calls, 2);
	});
	test('an older model rejecting output_config permits fallback only when no effort was selected', async () => {
		let calls = 0;
		await generate(model(), () => {
			calls++; return calls === 1 ? apiError(400, 'output_config: Extra inputs are not permitted')
				: { ...response(), json: { ...response().json, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_notes', input: NOTES }] } };
		});
		assert.equal(calls, 2);
		calls = 0;
		await assert.rejects(generate({ ...model(), reasoningEffort: 'low' }, () => {
			calls++; return apiError(400, 'output_config: Extra inputs are not permitted');
		}), /Claude returned an error/);
		assert.equal(calls, 1);
	});
	for (const [status, message, expected] of [
		[401, 'Authentication failed', /rejected the API key/], [403, 'Not allowed', /denied access/],
		[404, 'Unknown model', /doesn't know the model/], [429, 'Quota reached', /rate limit or quota/],
		[529, 'Service busy', /temporarily overloaded/], [500, 'Server error', /error \(500\)\.\nServer error$/],
		[400, 'output_config.effort does not support low', /reasoning effort/],
		[400, 'max_tokens: 25000 > 8192, which is the maximum allowed', /output-token limit/],
		[400, 'image input is unsupported', /could not accept the diagrams/],
		[400, 'Invalid schema for output_config.format: keyword is not supported', /error \(400\)/],
	]) {
		test(`${status} ${message}: one request and a useful error`, async () => {
			let calls = 0;
			await assert.rejects(generate(model(), () => { calls++; return apiError(status, message); }), expected);
			assert.equal(calls, 1);
		});
	}
});

describe('stopped and malformed Claude replies', () => {
	for (const [reason, expected] of [['refusal', /declined/], ['max_tokens', /ran out of tokens/], ['model_context_window_exceeded', /context limit/], ['pause_turn', /did not finish/], [null, /did not finish/]]) {
		test(`stop_reason ${reason} is never parsed as completed notes`, async () => {
			let calls = 0;
			await assert.rejects(generate(model(), () => { calls++; return response(JSON.stringify(NOTES), reason); }), expected);
			assert.equal(calls, 1);
		});
	}
	test('malformed content and unexpected function calls fail without another API request', async () => {
		for (const json of [null, {}, { stop_reason: 'end_turn', content: [] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 5 }] },
			{ stop_reason: 'end_turn', content: [{ type: 'tool_use', name: 'other', input: NOTES }] }]) {
			let calls = 0;
			await assert.rejects(generate(model(), () => { calls++; return { status: 200, json }; }), /readable|unreadable/);
			assert.equal(calls, 1);
		}
	});
	test('tool replies must contain exactly one call with the expected name and an object input', async () => {
		for (const content of [[], [{ type: 'tool_use', name: 'other', input: NOTES }], [{ type: 'tool_use', name: 'submit_notes', input: [] }],
			[{ type: 'tool_use', name: 'submit_notes', input: NOTES }, { type: 'tool_use', name: 'submit_notes', input: NOTES }]]) {
			await assert.rejects(generate({ ...model(), outputMode: OutputMode.Tool }, () => ({ status: 200, json: { stop_reason: 'tool_use', content } })), /readable|function format/);
		}
	});
	test('plain JSON extraction rejects ambiguous objects and truncated output', async () => {
		for (const text of ['No JSON here.', `${JSON.stringify(NOTES)}\n${JSON.stringify(NOTES)}`, '{"notes": [{"front": "unfinished']) {
			await assert.rejects(generate({ ...model(), outputMode: OutputMode.Json }, () => response(text)), /expected format/);
		}
	});
	test('an unreadable JSON body and a non-JSON HTTP error are both handled', async () => {
		await assert.rejects(generate(model(), () => ({ status: 200, text: '{"type":"message",' , headers: { 'content-type': 'application/json' } })), /readable generation/);
		await assert.rejects(generate(model(), () => ({ status: 502, text: '<html>Bad gateway</html>' })), /error \(502\)/);
	});
});

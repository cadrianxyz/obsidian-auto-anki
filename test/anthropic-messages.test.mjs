// Invented replies with the documented Messages API shapes. These tests make no network calls.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { resetAll } from './helpers.mjs';
import { createModelSettings } from '../src/settings/model';
import { OutputMode } from '../src/ai/model-info';
import { requestAnthropicCards } from '../src/ai/anthropic-messages';
import { CARD_RESPONSE_SCHEMA, parseGeneratedCards } from '../src/generate/result';

beforeEach(resetAll);
const KEY = 'sk-ant-FAKE-contract-key';
const CARDS = { cards: [{ type: 'basic', front: 'Which queue item leaves first?', back: 'The earliest item added.' }], note_issues: [] };
const PROMPT = { instructions: '# Writing rules\n\nKeep this exact.  \n', source: '{"markdown":"Arrival order."}', diagrams: [] };
const model = () => createModelSettings('future-provider-model-id');
const response = (text = JSON.stringify(CARDS), stop = 'end_turn') => ({ status: 200, json: {
	id: 'msg_test', type: 'message', role: 'assistant', model: 'future-provider-model-id',
	content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null,
	usage: { input_tokens: 100, output_tokens: 50 },
} });
const apiError = (status, message) => ({ status, json: { type: 'error', error: { type: 'invalid_request_error', message } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('Claude request and response formats', () => {
	test('native schema uses preset authentication, a top-level system prompt and no unnecessary parameters', async () => {
		let sent;
		const result = await requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async request => { sent = request; return response(); } });
		assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
		assert.equal(sent.method, 'POST');
		assert.equal(sent.contentType, 'application/json');
		assert.deepEqual(sent.headers, { 'anthropic-version': '2023-06-01', 'x-api-key': KEY });
		assert.equal(sent.throw, false);
		const body = JSON.parse(sent.body);
		assert.equal(body.system, PROMPT.instructions);
		assert.equal(body.model, 'future-provider-model-id');
		assert.equal(body.max_tokens, 25000);
		assert.equal(body.stream, false);
		assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: PROMPT.source }] }]);
		assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema: CARD_RESPONSE_SCHEMA } });
		for (const absent of ['thinking', 'temperature', 'top_p', 'top_k', 'n', 'cache_control', 'output_format', 'response_format', 'tools', 'max_completion_tokens']) assert.ok(!(absent in body), absent);
		assert.deepEqual(result, { content: JSON.stringify(CARDS), outputMode: OutputMode.JsonSchema });
	});
	test('explicit effort and output ceiling reach Claude, including a future reported effort name', async () => {
		const selected = { ...model(), reasoningEffort: 'future-effort', maxOutputTokens: 4096 };
		let body;
		await requestAnthropicCards(KEY, selected, PROMPT, undefined, { send: async request => { body = JSON.parse(request.body); return response(); } });
		assert.equal(body.output_config.effort, 'future-effort');
		assert.equal(body.output_config.format.type, 'json_schema');
		assert.equal(body.max_tokens, 4096);
		assert.ok(!('thinking' in body));
	});
	test('diagrams follow filename labels as native base64 image blocks', async () => {
		const prompt = { ...PROMPT, diagrams: [{ name: 'Attachments/queue.png', mime: 'image/png', base64: 'AQID' }] };
		let body;
		await requestAnthropicCards(KEY, model(), prompt, undefined, { send: async request => { body = JSON.parse(request.body); return response(); } });
		assert.deepEqual(body.messages[0].content, [
			{ type: 'text', text: PROMPT.source }, { type: 'text', text: 'Diagram: Attachments/queue.png' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
		]);
	});
	test('tool mode returns data from the single named tool without executing anything', async () => {
		const selected = { ...model(), outputMode: OutputMode.Tool, reasoningEffort: 'low' };
		let body;
		const reply = response(); reply.json.stop_reason = 'tool_use';
		reply.json.content = [{ type: 'text', text: 'Here is the result.' }, { type: 'tool_use', id: 'toolu_test', name: 'submit_cards', input: CARDS }];
		const result = await requestAnthropicCards(KEY, selected, PROMPT, undefined, { send: async request => { body = JSON.parse(request.body); return reply; } });
		assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_cards' });
		assert.deepEqual(body.tools[0].input_schema, CARD_RESPONSE_SCHEMA);
		assert.deepEqual(body.output_config, { effort: 'low' });
		assert.deepEqual(JSON.parse(result.content), CARDS);
		assert.equal(result.outputMode, OutputMode.Tool);
	});
	test('plain JSON allows prose or a fenced object and handles escaped quotes and braces inside strings', async () => {
		const selected = { ...model(), outputMode: OutputMode.Json };
		const content = { cards: [{ type: 'basic', front: 'Meaning of {x} and "a"?', back: 'Literal text with \\slashes.' }], note_issues: [] };
		for (const text of [JSON.stringify(content), `Here is the result:\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\`\nDone.`]) {
			const result = await requestAnthropicCards(KEY, selected, PROMPT, undefined, { send: async request => {
				const body = JSON.parse(request.body);
				assert.ok(!('output_config' in body));
				assert.ok(!('tools' in body));
				assert.equal(body.messages.length, 1, 'no assistant prefill');
				return response(text);
			} });
			assert.deepEqual(JSON.parse(result.content), content);
		}
	});
	test('thinking blocks are excluded, and final text can span more than one block', async () => {
		const json = JSON.stringify(CARDS);
		const reply = response(); reply.json.content = [{ type: 'thinking', thinking: 'Never show this.' },
			{ type: 'redacted_thinking', data: 'hidden' }, { type: 'text', text: json.slice(0, 15) }, { type: 'text', text: json.slice(15) }];
		const result = await requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => reply });
		assert.equal(result.content, json);
		assert.deepEqual(parseGeneratedCards(result.content).cards[0], { q: CARDS.cards[0].front, a: CARDS.cards[0].back });
	});
});

describe('bounded output-format fallback', () => {
	test('Auto uses schema, then tool, then plain JSON only after explicit unsupported-format errors', async () => {
		const bodies = [];
		const result = await requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async request => {
			const body = JSON.parse(request.body); bodies.push(body);
			if (body.output_config?.format) return apiError(400, 'This model does not support output_config.format json_schema.');
			if (body.tools) return apiError(400, 'tool_choice forced tool use is not supported by this model.');
			return response(`\`\`\`json\n${JSON.stringify(CARDS)}\n\`\`\``);
		} });
		assert.equal(bodies.length, 3);
		assert.equal(bodies[0].output_config.format.type, 'json_schema');
		assert.equal(bodies[1].tool_choice.type, 'tool');
		assert.ok(!('output_config' in bodies[2]));
		assert.equal(result.outputMode, OutputMode.Json);
	});
	test('a remembered format starts at that rung, while an explicit choice prevents fallback', async () => {
		let calls = 0;
		const cached = { ...model(), capabilities: { outputMode: OutputMode.Json } };
		await requestAnthropicCards(KEY, cached, PROMPT, undefined, { send: async request => {
			calls++; assert.ok(!('tools' in JSON.parse(request.body))); return response();
		} });
		assert.equal(calls, 1);
		await assert.rejects(requestAnthropicCards(KEY, { ...model(), outputMode: OutputMode.JsonSchema }, PROMPT, undefined,
			{ send: async () => { calls++; return apiError(400, 'output_config.format is unsupported'); } }), /Claude returned an error/);
		assert.equal(calls, 2);
	});
	test('an older model rejecting output_config permits fallback only when no effort was selected', async () => {
		let calls = 0;
		await requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => {
			calls++; return calls === 1 ? apiError(400, 'output_config: Extra inputs are not permitted')
				: { ...response(), json: { ...response().json, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_cards', input: CARDS }] } };
		} });
		assert.equal(calls, 2);
		calls = 0;
		await assert.rejects(requestAnthropicCards(KEY, { ...model(), reasoningEffort: 'low' }, PROMPT, undefined, { send: async () => {
			calls++; return apiError(400, 'output_config: Extra inputs are not permitted');
		} }), /Claude returned an error/);
		assert.equal(calls, 1);
	});
	for (const [status, message, expected] of [
		[401, 'Authentication failed', /rejected the API key/], [403, 'Not allowed', /denied access/],
		[404, 'Unknown model', /doesn't know the model/], [429, 'Quota reached', /rate limit or quota/],
		[529, 'Service busy', /temporarily overloaded/], [500, 'Server error', /error \(500\)/],
		[400, 'output_config.effort does not support low', /reasoning effort/],
		[400, 'max_tokens: 25000 > 8192, which is the maximum allowed', /output-token limit/],
		[400, 'image input is unsupported', /could not accept the diagrams/],
		[400, 'Invalid schema for output_config.format: keyword is not supported', /error \(400\)/],
	]) {
		test(`${status} ${message}: one request and a useful error`, async () => {
			let calls = 0;
			await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => { calls++; return apiError(status, message); } }), expected);
			assert.equal(calls, 1);
		});
	}
});

describe('stopped and malformed Claude replies', () => {
	for (const [reason, expected] of [['refusal', /declined/], ['max_tokens', /ran out of tokens/], ['model_context_window_exceeded', /context limit/], ['pause_turn', /did not finish/], [null, /did not finish/]]) {
		test(`stop_reason ${reason} is never parsed as completed cards`, async () => {
			let calls = 0;
			await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => { calls++; return response(JSON.stringify(CARDS), reason); } }), expected);
			assert.equal(calls, 1);
		});
	}
	test('malformed content and unexpected function calls fail without another API request', async () => {
		for (const json of [null, {}, { stop_reason: 'end_turn', content: [] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 5 }] },
			{ stop_reason: 'end_turn', content: [{ type: 'tool_use', name: 'other', input: CARDS }] }]) {
			let calls = 0;
			await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => { calls++; return { status: 200, json }; } }), /readable|unreadable/);
			assert.equal(calls, 1);
		}
	});
	test('tool replies must contain exactly one call with the expected name and an object input', async () => {
		for (const content of [[], [{ type: 'tool_use', name: 'other', input: CARDS }], [{ type: 'tool_use', name: 'submit_cards', input: [] }],
			[{ type: 'tool_use', name: 'submit_cards', input: CARDS }, { type: 'tool_use', name: 'submit_cards', input: CARDS }]]) {
			await assert.rejects(requestAnthropicCards(KEY, { ...model(), outputMode: OutputMode.Tool }, PROMPT, undefined,
				{ send: async () => ({ status: 200, json: { stop_reason: 'tool_use', content } }) }), /readable|function format/);
		}
	});
	test('plain JSON extraction rejects ambiguous objects and truncated output', async () => {
		for (const text of ['No JSON here.', `${JSON.stringify(CARDS)}\n${JSON.stringify(CARDS)}`, '{"cards": [{"front": "unfinished']) {
			await assert.rejects(requestAnthropicCards(KEY, { ...model(), outputMode: OutputMode.Json }, PROMPT, undefined,
				{ send: async () => response(text) }), /expected format/);
		}
	});
	test('an unreadable JSON body and a non-JSON HTTP error are both handled', async () => {
		await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => ({ status: 200, get json() { throw new Error('invalid JSON'); } }) }), /readable generation/);
		await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => ({ status: 502, get json() { throw new Error('HTML'); } }) }), /error \(502\)/);
	});
});

describe('Claude request cancellation and timeout', () => {
	test('a cancelled run before sending makes no request', async () => {
		const controller = new AbortController(); controller.abort();
		let calls = 0;
		await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, controller.signal, { send: async () => { calls++; return response(); } }), /cancelled/);
		assert.equal(calls, 0);
	});
	test('cancelling an in-flight request rejects promptly and a late unsupported-format reply starts no fallback', async () => {
		const controller = new AbortController(); const wait = deferred(); const started = deferred(); let calls = 0;
		const task = requestAnthropicCards(KEY, model(), PROMPT, controller.signal, { send: async () => { calls++; started.resolve(); return wait.promise; } });
		await started.promise;
		controller.abort();
		await assert.rejects(task, /cancelled/);
		wait.resolve(apiError(400, 'output_config.format is unsupported'));
		await flush();
		assert.equal(calls, 1);
	});
	test('a timeout ignores late replies, and a network failure does not retry', async () => {
		const wait = deferred(); let calls = 0;
		await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { timeoutMs: 5, send: async () => { calls++; return wait.promise; } }), /timed out/);
		wait.resolve(apiError(400, 'output_config.format is unsupported'));
		await flush();
		assert.equal(calls, 1);
		await assert.rejects(requestAnthropicCards(KEY, model(), PROMPT, undefined, { send: async () => { calls++; throw new Error('network down'); } }), /Could not connect to Claude/);
		assert.equal(calls, 2);
	});
});

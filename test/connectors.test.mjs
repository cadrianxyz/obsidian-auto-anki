// The shared connector contract, checked against every provider through its official SDK
// and a fake fetch. Provider-specific request and response formats have their own tests.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake } from 'obsidian';
import { resetAll, openai, openAiReply, openAiError, BASIC_DESTINATIONS, generatedNote } from './helpers.mjs';
import { createModelSettings } from '../src/settings/schema';
import { OutputMode, getGenerationOutputModes } from '../src/ai/generation';
import { PROVIDER_IDS } from '../src/ai/providers';
import { createClient as createOpenAiClient } from '../src/ai/openai/client';
import { createClient as createAnthropicClient } from '../src/ai/anthropic/client';
import { getProvider } from '../src/ai/registry';
import { requestNotes as requestOpenAiNotes } from '../src/ai/openai/request';
import { requestNotes as requestAnthropicNotes } from '../src/ai/anthropic/request';
import { generateWithFallback, GENERATION_TIMEOUT_MS } from '../src/ai/generation';
import { noteResponseSchema } from '../src/generate/result';

beforeEach(resetAll);
const NOTES = { notes: [generatedNote({ type: 'basic', front: 'Which queue item leaves first?', back: 'The earliest item added.' })], note_issues: [] };
const PROMPT = { instructions: 'Rules.', source: '{"markdown":"Arrival order."}', diagrams: [], schema: noteResponseSchema(BASIC_DESTINATIONS) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const claudeError = (status, message) => ({ status, json: { type: 'error', error: { type: 'invalid_request_error', message } } });

// The same scenarios, expressed in each provider's own reply format.
const PROVIDERS = {
	openai: {
		name: 'OpenAI',
		connector: requestOpenAiNotes,
		handle(handler) { openai.handler = handler; },
		requests: () => openai.requests,
		success: () => openAiReply(NOTES.notes),
		toolSuccess: () => ({ json: { ...openAiReply([]).json, output: [{ type: 'function_call', call_id: 'c', status: 'completed', name: 'submit_notes', arguments: JSON.stringify(NOTES) }] } }),
		formatError: () => openAiError(400, 'text.format json_schema is unsupported'),
		serverError: () => openAiError(500, 'The server had an error'),
	},
	anthropic: {
		name: 'Claude',
		connector: requestAnthropicNotes,
		handle(handler) { fake.providerHandler = handler; },
		requests: () => fake.providerRequests,
		success: () => ({ status: 200, json: { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(NOTES) }] } }),
		toolSuccess: () => ({ status: 200, json: { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit_notes', input: NOTES }] } }),
		formatError: () => claudeError(400, 'output_config.format is unsupported'),
		serverError: () => claudeError(500, 'Server error'),
	},
};

test('every provider registers generation and model listing', () => {
	assert.equal(getProvider('openai').generate, requestOpenAiNotes);
	assert.equal(getProvider('anthropic').generate, requestAnthropicNotes);
	assert.deepEqual(PROVIDER_IDS.map(id => getProvider(id).generate), [requestOpenAiNotes, requestAnthropicNotes]);
	for (const id of PROVIDER_IDS) assert.equal(typeof getProvider(id).fetchModels, 'function');
	assert.equal(GENERATION_TIMEOUT_MS, 10 * 60 * 1000);
});

// --- Output-mode policy ---

test('provider-specific fallback orders preserve explicit choices and skip unsupported hints', async () => {
	const model = createModelSettings('contract-model');
	const order = [OutputMode.JsonSchema, OutputMode.Json];
	assert.deepEqual(getGenerationOutputModes(model), [OutputMode.JsonSchema, OutputMode.Tool, OutputMode.Json]);
	assert.deepEqual(getGenerationOutputModes(model, order), order);
	model.capabilities = { outputMode: OutputMode.Tool };
	assert.deepEqual(getGenerationOutputModes(model, order), order);
	model.outputMode = OutputMode.Tool;
	assert.deepEqual(getGenerationOutputModes(model, order), [OutputMode.Tool]);

	const sent = [];
	model.outputMode = OutputMode.Auto;
	const result = await generateWithFallback(model, undefined, {
		send: async mode => { sent.push(mode); if (mode === OutputMode.JsonSchema) throw new Error('unsupported'); return 'result'; },
		parse: value => value,
		unsupportedFormat: () => true,
		describeError: error => error.message,
	}, order);
	assert.deepEqual(sent, order);
	assert.deepEqual(result, { content: 'result', outputMode: OutputMode.Json });
});

// --- Shared client safety ---

for (const [name, createClient, variable, otherVariable] of [
	['OpenAI', createOpenAiClient, 'OPENAI_CUSTOM_HEADERS', 'ANTHROPIC_CUSTOM_HEADERS'],
	['Claude', createAnthropicClient, 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_CUSTOM_HEADERS'],
]) {
	test(`${name} rejects nonempty SDK custom headers without leaking values or mutating the environment`, () => {
		const saved = { ...process.env };
		try {
			for (const value of ['Authorization: Bearer sk-SECRET-env', 'x-api-key: sk-SECRET-env\nx-extra: unsafe', 'malformed']) {
				process.env[variable] = value;
				const before = { ...process.env };
				assert.throws(() => createClient('sk-SECRET-settings', { timeoutMs: 1234 }), error => {
					assert.ok(error.message.includes(variable));
					assert.match(error.message, /Unset .* and restart Obsidian/);
					assert.ok(!error.message.includes('sk-SECRET'));
					assert.ok(!error.message.includes(value));
					return true;
				});
				assert.deepEqual({ ...process.env }, before);
			}
		}
		finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
	test(`${name} permits empty custom headers and ignores the other SDK's environment`, () => {
		const saved = { ...process.env };
		const fetch = async () => { throw new Error('No network expected'); };
		try {
			process.env[otherVariable] = 'Authorization: Bearer unrelated';
			for (const value of [undefined, '', ' \n\t ']) {
				if (value === undefined) delete process.env[variable];
				else process.env[variable] = value;
				const before = { ...process.env };
				const client = createClient('sk-FAKE-settings', { timeoutMs: 1234, fetch });
				assert.equal(client.timeout, 1234);
				assert.equal(client.maxRetries, 0);
				assert.equal(client.logLevel, 'off');
				assert.equal(client.fetch, fetch);
				assert.deepEqual({ ...process.env }, before);
			}
		}
		finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
}

// --- Cancellation policy ---

test('cancellation wins over a successful late send even when the transport ignores abort', async () => {
	const controller = new AbortController();
	const wait = deferred();
	let reads = 0;
	let sends = 0;
	const task = generateWithFallback(createModelSettings('contract-model'), controller.signal, {
		send() { sends++; return wait.promise; },
		parse() { reads++; return JSON.stringify(NOTES); },
		unsupportedFormat() { assert.fail('A successful late response must not start fallback'); },
		describeError() { assert.fail('Cancellation must retain its own error'); },
	});
	controller.abort();
	wait.resolve({});
	await assert.rejects(task, /^Error: Generation cancelled\.$/);
	assert.equal(sends, 1);
	assert.equal(reads, 0);
});

// --- Provider contract ---

for (const provider of Object.values(PROVIDERS)) {
	describe(`${provider.name} connector contract`, () => {
		const generate = (handler, { signal, timeoutMs, model = createModelSettings('contract-model') } = {}) => {
			provider.handle(handler);
			return provider.connector({ apiKey: 'sk-FAKE-contract', model, prompt: PROMPT, signal }, timeoutMs === undefined ? {} : { timeoutMs });
		};
		test('returns the generated content and the format used, for downstream parsing', async () => {
			const reply = await generate(() => provider.success());
			assert.deepEqual(Object.keys(reply).sort(), ['content', 'outputMode']);
			assert.equal(reply.outputMode, OutputMode.JsonSchema);
			assert.deepEqual(JSON.parse(reply.content).notes, NOTES.notes);
		});
		test('a run cancelled before sending makes no request', async () => {
			const controller = new AbortController(); controller.abort();
			await assert.rejects(generate(() => provider.success(), { signal: controller.signal }), /^Error: Generation cancelled\.$/);
			assert.equal(provider.requests().length, 0);
		});
		test('cancelling an in-flight request aborts it, and a late unsupported-format reply starts no fallback', async () => {
			const controller = new AbortController(); const wait = deferred(); const started = deferred();
			const task = generate(() => { started.resolve(); return wait.promise; }, { signal: controller.signal });
			await started.promise;
			controller.abort();
			await assert.rejects(task, /^Error: Generation cancelled\.$/);
			wait.resolve(provider.formatError());
			await flush();
			assert.equal(provider.requests().length, 1);
		});
		test('a timeout aborts the request with a clear message and starts no fallback', async () => {
			const wait = deferred();
			await assert.rejects(generate(() => wait.promise, { timeoutMs: 5 }), new RegExp(`^Error: ${provider.name} generation timed out`));
			wait.resolve(provider.formatError());
			await flush();
			assert.equal(provider.requests().length, 1);
		});
		test('network and server failures are reported once, never retried', async () => {
			await assert.rejects(generate(() => { throw new TypeError('network down'); }), new RegExp(`Could not connect to ${provider.name}`));
			assert.equal(provider.requests().length, 1);
			await assert.rejects(generate(() => provider.serverError()), new RegExp(`${provider.name} returned an error \\(500\\)`));
			assert.equal(provider.requests().length, 2);
		});
		test('Auto steps to the next format only after an explicit unsupported-format error', async () => {
			let calls = 0;
			const reply = await generate(() => (++calls === 1 ? provider.formatError() : provider.toolSuccess()));
			assert.equal(calls, 2);
			assert.equal(reply.outputMode, OutputMode.Tool);
			assert.deepEqual(JSON.parse(reply.content), NOTES);
		});
	});
}

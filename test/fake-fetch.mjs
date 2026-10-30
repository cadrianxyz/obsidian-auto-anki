// A stand-in for the hosted AI APIs. Both official SDKs send requests with fetch, so
// fetch is replaced: each request is recorded, and a handler decides the reply.
// OpenAI generation goes to `openai.handler`. Model discovery and Claude generation
// share `fake.providerRequests`/`fake.providerHandler` with the public catalogue fake.
// A handler returns { status, json } or { status, text } for a non-JSON body, may throw
// to simulate a network failure, and may never settle: aborting the request rejects it.
import { fake } from 'obsidian';

export const openai = {
	requests: [],
	handler: null,
	reset() { this.requests.length = 0; this.handler = null; },
};

function aborted(signal) {
	return new Promise((_, reject) => {
		const fail = () => reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
		if (signal.aborted) fail();
		else signal.addEventListener('abort', fail, { once: true });
	});
}

globalThis.fetch = async (url, init = {}) => {
	const href = String(url);
	const headers = new Headers(init.headers);
	const body = init.body ? JSON.parse(init.body) : undefined;
	const metadataOrClaude = init.method === 'GET' || href.startsWith('https://api.anthropic.com/');
	const request = { url: href, method: init.method, headers: Object.fromEntries(headers), body };
	if (metadataOrClaude) fake.providerRequests.push(request);
	else openai.requests.push({ url: href, headers, body });
	const handler = metadataOrClaude ? fake.providerHandler : openai.handler;
	if (!handler) throw new TypeError('fetch failed');
	const pending = Promise.resolve().then(() => handler(body, metadataOrClaude ? request : { url: href, headers }));
	const reply = await (init.signal ? Promise.race([pending, aborted(init.signal)]) : pending);
	const text = reply?.text ?? JSON.stringify(reply?.json ?? {});
	return new Response(text, {
		status: reply?.status ?? 200,
		// retry-after-ms would make any SDK retry immediate; the plugin disables retries.
		headers: { 'content-type': reply?.text === undefined ? 'application/json' : 'text/html', 'retry-after-ms': '0', ...(reply?.headers ?? {}) },
	});
};

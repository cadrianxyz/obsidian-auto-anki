// A stand-in for OpenAI's API. The OpenAI SDK sends requests with fetch, so fetch is
// replaced: each request is recorded, and `openai.handler` decides the reply.
export const openai = {
	requests: [],
	handler: null,
	reset() { this.requests.length = 0; this.handler = null; },
};

globalThis.fetch = async (url, init = {}) => {
	const headers = new Headers(init.headers);
	const body = init.body ? JSON.parse(init.body) : undefined;
	openai.requests.push({ url: String(url), headers, body });
	if (!openai.handler) throw new TypeError('fetch failed');
	const reply = await openai.handler(body, { url: String(url), headers });
	return new Response(JSON.stringify(reply.json ?? {}), {
		status: reply.status ?? 200,
		// retry-after-ms makes the SDK's automatic retries (on 429 and 5xx) immediate.
		headers: { 'content-type': 'application/json', 'retry-after-ms': '0', ...(reply.headers ?? {}) },
	});
};

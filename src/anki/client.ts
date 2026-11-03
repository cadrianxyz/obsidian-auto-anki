import { requestUrl } from 'obsidian';
import { asRecord } from '../utils/data';

export class AnkiConnectError extends Error {
	constructor(message: string, readonly action: string) { super(message); }
	get unsupported(): boolean { return /unsupported action|unknown action|action.*not found/i.test(this.message); }
}

/** AnkiConnect calls return {result,error}; HTTP success alone does not mean Anki accepted them. */
export class AnkiClient {
	constructor(readonly url: string) {}
	async invoke(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
		let response;
		try { response = await requestUrl({ url: this.url, method: 'POST', contentType: 'application/json', body: JSON.stringify({ action, version: 6, params }), throw: false }); }
		catch { throw new AnkiConnectError(`Could not connect to Anki at ${this.url}. Open Anki with AnkiConnect enabled, then retry.`, action); }
		if (response.status < 200 || response.status >= 300) throw new AnkiConnectError(`AnkiConnect returned HTTP ${response.status}.`, action);
		let body: Record<string, unknown>;
		try { body = asRecord(response.json); }
		catch { throw new AnkiConnectError('AnkiConnect returned unreadable data.', action); }
		if (!('result' in body) || !('error' in body)) throw new AnkiConnectError('AnkiConnect returned an unexpected response.', action);
		if (body.error !== null) throw new AnkiConnectError(typeof body.error === 'string' ? body.error : 'AnkiConnect reported an unknown error.', action);
		return body.result;
	}
}

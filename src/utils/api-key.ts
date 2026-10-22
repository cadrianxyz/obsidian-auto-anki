import { App } from 'obsidian';

// The OpenAI API key lives in Obsidian's Keychain (app.secretStorage, Obsidian 1.11.4+),
// not in data.json. data.json sits inside the vault, so anything that copies the vault
// (sync, backups, git) would copy the key with it. The Keychain stays on this device.
//
// The ID is fixed rather than device- or vault-specific, so the same name works on every
// device the vault is opened on. It must be lowercase letters, digits and dashes.
export const OPENAI_API_KEY_SECRET_ID = 'auto-anki-openai-api-key';

function secretStorage(app: App) {
	// minAppVersion guarantees this exists; the check only protects a manually
	// installed build on an older Obsidian from crashing.
	return app.secretStorage ?? null;
}

export function isKeychainAvailable(app: App) {
	return secretStorage(app) !== null;
}

// Obsidian doesn't say whether the Keychain can throw (for example when the system's secret
// store is locked). These two may; the exported functions below catch it, because a Keychain
// error must never stop the plugin from loading or a command from running.
function readKey(app: App): string | null {
	const value = secretStorage(app)?.getSecret(OPENAI_API_KEY_SECRET_ID);
	return value && value.trim() ? value.trim() : null;
}

function writeKey(app: App, value: string) {
	secretStorage(app)?.setSecret(OPENAI_API_KEY_SECRET_ID, value.trim());
}

export function getOpenAiApiKey(app: App): string | null {
	try {
		return readKey(app);
	}
	catch (err) {
		console.error('Auto Anki: could not read the OpenAI API key from the Keychain', err);
		return null;
	}
}

export function setOpenAiApiKey(app: App, value: string) {
	try {
		writeKey(app, value);
	}
	catch (err) {
		console.error('Auto Anki: could not save the OpenAI API key in the Keychain', err);
	}
}

export function maskApiKey(key: string) {
	return key.length >= 7 ? `${key.slice(0, 3)}...${key.slice(-4)}` : '****';
}

// Fields 0.2.x kept in data.json. They are removed once the key is safely in the Keychain.
export interface LegacyKeyFields {
	openAiApiKey?: string | null;
	openAiApiKeyIdentifier?: string;
}

export type KeyMigrationResult =
	| 'nothing'        // no key in data.json
	| 'cleaned'        // empty legacy fields removed, no key to move
	| 'moved'          // key moved into the Keychain and removed from data.json
	| 'kept-keychain'  // the Keychain already held a different key on this device; that one is kept
	| 'unavailable'    // no Keychain (Obsidian older than 1.11.4); data.json left untouched
	| 'failed';        // the Keychain threw, or didn't hold the key after writing; data.json left untouched

// Mutates `data`: removes the legacy fields, but only once the key is confirmed in the Keychain.
export function migrateLegacyApiKey(app: App, data: LegacyKeyFields): KeyMigrationResult {
	if (!('openAiApiKey' in data) && !('openAiApiKeyIdentifier' in data)) return 'nothing';
	if (!isKeychainAvailable(app)) return 'unavailable';

	const legacyKey = typeof data.openAiApiKey === 'string' ? data.openAiApiKey.trim() : '';
	const removeLegacyFields = () => {
		delete data.openAiApiKey;
		delete data.openAiApiKeyIdentifier;
	};

	if (!legacyKey) {
		removeLegacyFields();
		return 'cleaned';
	}

	// Uses the functions that throw, so that a Keychain that can't be read is never mistaken
	// for an empty one (which would overwrite a key it may hold).
	try {
		const existing = readKey(app);
		if (existing) {
			removeLegacyFields();
			return existing === legacyKey ? 'moved' : 'kept-keychain';
		}

		writeKey(app, legacyKey);
		if (readKey(app) !== legacyKey) return 'failed';
	}
	catch (err) {
		console.error('Auto Anki: could not move the OpenAI API key into the Keychain', err);
		return 'failed';
	}
	removeLegacyFields();
	return 'moved';
}

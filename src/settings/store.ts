import type { App } from 'obsidian';
import { prepareSettings, settingsData, type PreparedSettings } from './migration';
import { createDefaultSettings, normalizeSettings, type SettingsV1 } from './model';

/**
 * Reads and saves the user's choices in data.json. For example, changing the model
 * while a token-limit edit is saving must keep both changes. This class finishes
 * one read or save before starting the next, and uses a changed setting only after
 * its save succeeds.
 */
export class SettingsStore {
	private prepared?: PreparedSettings;
	private readonly defaults = createDefaultSettings();
	private lastOperation: Promise<void> = Promise.resolve();
	private readonly app: App;
	private readonly readSettingsFile: () => Promise<unknown>;
	private readonly writeSettingsFile: (value: SettingsV1) => Promise<void>;
	/** Editing stays disabled until a successful load, to avoid overwriting unreadable settings. */
	canSave = false;

	/** main.ts supplies functions that call Obsidian's loadData() and saveData(). */
	constructor(
		app: App,
		readSettingsFile: () => Promise<unknown>,
		writeSettingsFile: (value: SettingsV1) => Promise<void>,
	) {
		this.app = app;
		this.readSettingsFile = readSettingsFile;
		this.writeSettingsFile = writeSettingsFile;
	}

	/** Return the last successfully loaded or saved choices; otherwise return fresh defaults. */
	get settings(): SettingsV1 {
		return this.prepared?.settings ?? this.defaults;
	}

	/** Load at startup, or reload when another device/program changes data.json (external=true). */
	load(external = false): Promise<PreparedSettings> {
		return this.enqueue(async () => {
			try {
				const stored = await this.readSettingsFile();
				// A synced file that is not a settings object must not erase the current choices.
				if (external && (!stored || typeof stored !== 'object' || Array.isArray(stored))) {
					throw new Error('The synced Auto Anki settings are unreadable. The previous settings are still in use.');
				}
				const prepared = prepareSettings(this.app, stored);
				if (prepared.migrated) await this.writeSettingsFile(settingsData(prepared));
				this.prepared = prepared;
				this.canSave = true;
				return prepared;
			}
			catch (error) {
				// In particular, never overwrite a schema written by a newer plugin.
				this.canSave = false;
				throw error;
			}
		});
	}

	/** Apply an edit to a validated copy. Keep using the old settings if saving the copy fails. */
	update(change: (settings: SettingsV1) => void): Promise<void> {
		return this.enqueue(async () => {
			if (!this.canSave || !this.prepared) throw new Error('Auto Anki settings could not be loaded. Reload the plugin after fixing data.json before editing settings.');
			const next = normalizeSettings(this.settings);
			change(next);
			const prepared = { ...this.prepared, settings: normalizeSettings(next) };
			// If an old key could not be moved to the Keychain, settingsData keeps it
			// in the file until a later load can confirm the move. Ordinary edits must not lose it.
			await this.writeSettingsFile(settingsData(prepared));
			this.prepared = prepared;
		});
	}

	/** Wait for the previous read/save before starting this one, including after a failed operation. */
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.lastOperation.then(operation);
		// The caller receives task's success or failure. The queue itself remains
		// usable after a failure, so the user can fix the problem and try again.
		this.lastOperation = task.then(() => undefined, () => undefined);
		return task;
	}
}

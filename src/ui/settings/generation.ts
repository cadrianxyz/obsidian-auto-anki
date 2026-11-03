import type { ButtonComponent, SettingDefinitionItem } from 'obsidian';
import type AutoAnkiPlugin from '../../main';
import { COVERAGE_LEVELS, type CoverageLevel } from '../../settings/schema';
import { NOTE_WRITING_INSTRUCTIONS_VERSION, DEFAULT_NOTE_WRITING_INSTRUCTIONS } from '../../generate/note-writing-instructions';

/** How notes are written: coverage, diagrams, and the editable writing guidance. */
export class GenerationSettings {
	private resetInstructionsButton?: ButtonComponent;
	constructor(private readonly plugin: AutoAnkiPlugin) {}
	hide(): void { this.resetInstructionsButton = undefined; }
	owns(key: string): boolean { return key.startsWith('notes.'); }

	getValue(key: string): unknown {
		const notes = this.plugin.settings.notes;
		switch (key) {
			case 'notes.sendDiagrams': return notes.sendDiagrams;
			case 'notes.coverageLevel': return notes.coverageLevel;
			case 'notes.extraInstructions': return notes.extraInstructions;
			case 'notes.noteWritingInstructions': return notes.noteWritingInstructions?.text ?? DEFAULT_NOTE_WRITING_INSTRUCTIONS;
		}
		return undefined;
	}

	async setValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case 'notes.sendDiagrams':
				if (typeof value === 'boolean') await this.plugin.updateSettings(settings => { settings.notes.sendDiagrams = value; }, false);
				return;
			case 'notes.coverageLevel':
				if (COVERAGE_LEVELS.includes(value as CoverageLevel)) {
					await this.plugin.updateSettings(settings => { settings.notes.coverageLevel = value as CoverageLevel; }, false);
				}
				return;
			case 'notes.extraInstructions':
				if (typeof value === 'string') await this.plugin.updateSettings(settings => { settings.notes.extraInstructions = value; }, false);
				return;
			case 'notes.noteWritingInstructions':
				if (typeof value !== 'string') return;
				await this.plugin.updateSettings(settings => {
					const edited = settings.notes.noteWritingInstructions;
					if (!edited && value === DEFAULT_NOTE_WRITING_INSTRUCTIONS) return;
					// Read the version inside the queued edit: rapid typing or a synced
					// override must keep the version of the guidance the edit began with.
					settings.notes.noteWritingInstructions = { text: value, defaultVersion: edited?.defaultVersion ?? NOTE_WRITING_INSTRUCTIONS_VERSION };
				}, false); // Keep the text area and cursor in place while typing.
				this.resetInstructionsButton?.setDisabled(!this.plugin.settingsStore.canSave || !this.plugin.settings.notes.noteWritingInstructions);
				return;
		}
	}

	definitions(): SettingDefinitionItem[] {
		const disabled = () => !this.plugin.settingsStore.canSave;
		return [
			{ name: 'Send diagrams', desc: 'Include supported images embedded in the note when the selected model accepts images.',
				control: { type: 'toggle', key: 'notes.sendDiagrams', disabled } },
			{ name: 'Coverage', desc: 'Choose how much detail to turn into Anki notes. More detail usually means more Anki notes.',
				control: { type: 'dropdown', key: 'notes.coverageLevel', disabled, options: {
					'key-ideas': 'Key ideas only',
					'main-ideas-and-details': 'Main ideas and important details',
					'everything': 'Everything worth remembering',
				} } },
			{ type: 'group', cls: 'auto-anki-instructions', items: [
				{ name: 'Extra instructions', desc: 'Default extra instructions for each run, such as "Use British spelling". You can edit or clear them in the export modal for one run. Markdown, spacing and line breaks are kept.',
					control: { type: 'textarea', key: 'notes.extraInstructions', rows: 5, placeholder: 'Add your preferences here…', disabled } },
			] },
			{ type: 'page', name: 'Advanced', desc: 'Edit the guidance for writing Anki notes, or reset it to the built-in version.', items: [
				{ type: 'group', cls: 'auto-anki-instructions', items: [
					{ name: 'Note-writing instructions', desc: 'Editing replaces the built-in writing guidance and keeps your version through updates. For small additions, use Extra instructions instead. Required response-format rules are separate and cannot be edited here.',
						control: { type: 'textarea', key: 'notes.noteWritingInstructions', rows: 18, disabled } },
				] },
				{ name: 'Built-in guidance', desc: 'Reset discards your edited guidance and follows the current built-in instructions, including future improvements.', render: setting => {
					setting.addButton(button => {
						this.resetInstructionsButton = button;
						button.setButtonText('Reset to default').setDisabled(disabled() || !this.plugin.settings.notes.noteWritingInstructions)
							.onClick(async () => {
								button.setDisabled(true);
								await this.plugin.updateSettings(settings => { delete settings.notes.noteWritingInstructions; });
							});
					});
				} },
			] },
		];
	}
}

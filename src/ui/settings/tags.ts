import type { SettingDefinitionItem } from 'obsidian';
import type AutoAnkiPlugin from '../../main';
import { TAG_PREFIX, noteTags, promptVersionTag, type TagRun, type TagSettings } from '../../anki/tags';
import { describeTags, showTags } from '../tags/tag-display';

type TagSwitch = Exclude<keyof TagSettings, 'extra'>;
const SWITCHES: readonly TagSwitch[] = ['enabled', 'model', 'reasoningEffort', 'promptVersion', 'prefix'];
const KEY = 'anki.tags.';

/** Anki → Tags: which tags new Anki notes get. Notes already in Anki are never changed. */
export class TagSettingsPage {
	private exampleEl?: HTMLElement;
	constructor(private readonly plugin: AutoAnkiPlugin) {}
	hide(): void { this.exampleEl = undefined; }
	owns(key: string): boolean { return key.startsWith(KEY); }

	getValue(key: string): unknown {
		const option = key.slice(KEY.length);
		const tags = this.plugin.settings.anki.tags;
		return option === 'extra' ? tags.extra : SWITCHES.includes(option as TagSwitch) ? tags[option as TagSwitch] : undefined;
	}

	async setValue(key: string, value: unknown): Promise<void> {
		const option = key.slice(KEY.length);
		if (option === 'extra' && typeof value === 'string') {
			// Keep the text box and cursor in place while typing; only the example changes.
			await this.plugin.updateSettings(settings => { settings.anki.tags.extra = value; }, false);
			if (this.exampleEl) this.showExample(this.exampleEl);
		}
		else if (SWITCHES.includes(option as TagSwitch) && typeof value === 'boolean') {
			// Redraw: the switches change which rows show, the descriptions and the example.
			await this.plugin.updateSettings(settings => { settings.anki.tags[option as TagSwitch] = value; });
		}
	}

	/** The tags one Anki note would get with tagging on, using the default model as the example run. */
	private showExample(el: HTMLElement): void {
		const { settings } = this.plugin;
		const reference = settings.defaultModel;
		const model = reference && settings.providers[reference.providerId].models.find(model => model.id === reference.modelId);
		const run: TagRun = {
			providerId: reference?.providerId ?? '<provider>', modelId: reference?.modelId ?? '<model>',
			reasoningEffort: model?.reasoningEffort ?? 'default',
			promptVersion: promptVersionTag(settings.notes.noteWritingInstructions),
		};
		// Shown while tagging is off too, so the greyed-out choices can be judged before turning it on.
		showTags(el, noteTags({ ...settings.anki.tags, enabled: true }, run), 'none. Turn on an option or add extra tags.');
	}

	/** The entry on the Anki page. */
	page(): SettingDefinitionItem {
		return { type: 'page', name: 'Tags', desc: 'Tag new Anki notes with the model, reasoning effort, prompt version or your own tags.',
			displayValue: () => this.plugin.settings.anki.tags.enabled ? 'On' : 'Off', items: this.definitions() };
	}

	private definitions(): SettingDefinitionItem[] {
		const locked = () => !this.plugin.settingsStore.canSave;
		// The options stay visible but can't be changed until tagging is on.
		const disabled = () => locked() || !this.plugin.settings.anki.tags.enabled;
		const toggle = (option: TagSwitch) => ({ type: 'toggle' as const, key: `${KEY}${option}`, disabled });
		const tags = this.plugin.settings.anki.tags;
		const prefix = tags.prefix ? `${TAG_PREFIX}::` : '';
		return [
			{ name: '', searchable: false, render: setting => {
				setting.settingEl.empty();
				setting.settingEl.classList.remove('setting-item');
				// A paragraph, as in the export dialog's note types, so its margin spaces it from the title.
				setting.settingEl.createDiv({ cls: 'setting-horizontal-padding' }).createEl('p', { cls: 'setting-item-description search-description',
					text: 'Tags record how each Anki note was made, so you can find, compare or delete those notes in Anki later. They are added only when a note is created; notes already in Anki are never changed.' });
			} },
			{ name: 'Tag Anki notes', desc: 'Add the tags below to each new Anki note. While this is off, no tags are added.',
				control: { type: 'toggle', key: `${KEY}enabled`, disabled: locked } },
			{ type: 'group', heading: 'Tags to add', items: [
				{ name: 'Model', desc: describeTags(`Adds \`${prefix}<provider>::<model>\`, such as \`${prefix}anthropic::<model>\`. The provider is its ID, which never changes.`),
					control: toggle('model') },
				{ name: 'Reasoning effort', desc: describeTags(`Adds \`${prefix}effort::<level>\`, the level chosen for that run. \`default\` means the model used its own default.`),
					control: toggle('reasoningEffort') },
				{ name: 'Prompt version', desc: describeTags(`Adds \`${prefix}prompt::<version>\`, the version of the built-in note-writing instructions. It ends in \`-edited\` when you use your own.`),
					control: toggle('promptVersion') },
				{ name: `Prefix tags with ${TAG_PREFIX}::`, desc: describeTags(`Searching \`tag:${TAG_PREFIX}::*\` in Anki then finds every note these tags were added to. Without the prefix, they can mix with your own tags of the same name.`),
					control: toggle('prefix') },
				{ name: 'Extra tags', desc: describeTags('Your own tags for every new Anki note, separated by spaces. Use `::` for nested tags, such as `uni::cs101`. No prefix is added to these. You can change them for one export in the deck step.'),
					control: { type: 'text', key: `${KEY}extra`, placeholder: 'obsidian uni::cs101', disabled } },
				{ name: 'Example', searchable: false, render: setting => {
					setting.descEl.setText(`${tags.enabled ? 'Tags' : 'Once tagging is on, the tags'} one new Anki note would get, using your default model: `);
					this.exampleEl = setting.descEl.createSpan();
					this.showExample(this.exampleEl);
				} },
			] },
		];
	}
}

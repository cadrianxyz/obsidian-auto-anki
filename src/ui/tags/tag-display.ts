// --- Showing tags ---

/** Styled in styles.css: Obsidian only styles code inside notes, not in settings or dialogs. */
const TAG_CLASS = 'auto-anki-tag';

/** Shows each tag as code, so tags stand apart from the words around them. */
export function showTags(el: HTMLElement, tags: readonly string[], empty: string): void {
	el.empty();
	if (!tags.length) { el.appendText(empty); return; }
	tags.forEach((tag, index) => {
		if (index) el.appendText(' ');
		el.createEl('code', { text: tag, cls: TAG_CLASS });
	});
}

/** A description in which each `backticked` part, such as a tag pattern, is shown as code. */
export function describeTags(text: string): DocumentFragment {
	return createFragment(fragment => {
		text.split('`').forEach((part, index) => {
			if (index % 2) fragment.createEl('code', { text: part, cls: TAG_CLASS });
			else if (part) fragment.appendText(part);
		});
	});
}

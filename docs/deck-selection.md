## Deck Selection

Open **Settings → Auto Anki → Anki → Deck Selection**. Leave **Deck template** blank to start each export with your default deck. To suggest a deck based on the note'smetadat, use `{{vault}}` for the vault name, `{{folder}}` for the full folder path, `{{lastFolder}}` for the immediate parent folder, and `{{note}}` for the note name without `.md`.

For example, if your vault is `Study` and the note is `Computer Science/Operating Systems/Scheduling.md`, `{{vault}}::{{folder}}` suggests `Study::Computer Science::Operating Systems`, while `{{vault}}::{{lastFolder}}` suggests `Study::Operating Systems`. Folder names keep their spaces and punctuation; only `/` changes to `::`. For a note at the vault root, an empty folder level is omitted. A selection uses the path of the note it came from.

The **Deck template preview** names the current note it uses, or shows a sample note when none is open. It shows what the template would suggest without checking Anki.

- If the full deck exists, it starts selected. If only a parent deck exists, it isn't a match.
- If the deck is missing, the picker keeps the default (or its fallback) selected and offers **Create new deck: [full name]**. The deck is created only when you click **Create deck and export**. You can instead choose any existing deck.
- Turn on **Sort by name match** in **Deck Selection** to rank existing decks against the template result, or your default deck if the template gives no result. An exact match comes first, followed by decks sharing more words with the target. Words from the note or highlighted text break ties. Sorting doesn't send text anywhere or download a model.

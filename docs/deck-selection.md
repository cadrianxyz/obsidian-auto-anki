# Deck selection

When you export, you choose which Anki deck the new notes go into. Auto Anki can pick a starting deck for you, either one fixed **default deck** or a deck based on where the note sits in your vault.

You can always choose a different deck when you export.

Open **Settings → Auto Anki → Anki → Deck Selection**.

## Default deck

Click **Choose deck…** and pick a deck. Exports start with this deck selected, unless the deck template (below) suggests another.

## Deck template

A **deck template** suggests a deck based on the note you're working on. Type a deck name using these placeholders, with `::` between deck levels, the same way Anki writes subdecks:

| Placeholder | Becomes |
|---|---|
| `{{vault}}` | Your vault's name |
| `{{folder}}` | The note's full folder path |
| `{{lastFolder}}` | Only the folder the note is directly in |
| `{{note}}` | The note's name |

For example, with the vault `Study` and the note `Computer Science/Operating Systems/Scheduling.md`:

| Template | Suggested deck |
|---|---|
| `{{vault}}::{{folder}}` | `Study::Computer Science::Operating Systems` |
| `{{vault}}::{{lastFolder}}` | `Study::Operating Systems` |
| `Notes::{{note}}` | `Notes::Scheduling` |

Leave the template empty to always start with your default deck.

**Deck template preview** shows what your template would suggest for the open note, or for a sample note if none is open.

### When the suggested deck doesn't exist

- **If the deck exists in Anki**, it's selected for you.
- **If it doesn't exist**, your default deck stays selected, and the deck list offers **Create new deck: …**. Choose it, and the deck is created when you click **Create deck and export**. Auto Anki never creates a deck unless you choose this.

## Sort by name match

Turn on **Sort by name match** to list the decks most like the suggested deck first (or your default deck, if there's no template). An exact match comes first, then decks with the most words in common. Words from your note help break ties.

Sorting happens on your computer. Nothing is sent anywhere.

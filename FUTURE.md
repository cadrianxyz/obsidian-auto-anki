# Auto Anki — Future features

> Future features and proposals. None of these is scheduled unless the build plan says so.

# Tracking which notes have cards ("carded" tracking)

Left out of the current plan in October 2026: the plan doesn't track whether a note already has cards.
From 1.1, a card can record the model that made it in its Anki tags, but only if the user turns
tagging on (it's off by default), so tags can't stand in for tracking.

**What it would add:**

- The status bar shows the open note's cards: `Anki: 6 cards`, `Anki: 6 cards · changed`,
  `Anki: no cards`.
- The folder dialog shows each note's status, and ticks only what's new:

  | Status | Ticked by default |
  |---|---|
  | Not carded | ✅ |
  | Changed since carded | ☐ (ticking it re-cards it) |
  | Carded, unchanged | — (disabled) |
  | Has a skip tag | ☐ |
- **Re-carding:** generating again for a changed note, with its existing cards (read live from
  Anki, so edits made there count) sent along, so only new material becomes cards.
- A renamed or moved note keeps its cards attached.

**Terms it would add:**

| Term | Means |
|---|---|
| **Card index** | The record of which notes have cards: for each note, a hash of its text when it was carded, and its Anki notes |
| **Carded** | A note whose full text has been through generation and whose cards were added |
| **Changed since carded** | A carded note whose text no longer matches the hash in the card index |
| **Re-carding** | Generating again for a changed note, with its existing cards sent along so only new material becomes cards |

## The design worked out so far

Anki tags can't replace the model stored per card below. Tagging is optional and off by
default, the user can turn off any option or the `auto-anki::` prefix, and tags can be edited
in Anki. So the index keeps its own record of which model made each card.

Stored in its own file, **`card-index.json`**, in the plugin's folder next to `data.json`. Nothing
is written into notes. It's written compactly, without indentation; laid out here for reading:

```json
{
  "version": 1,
  "models": [["anthropic", "claude-haiku-5-5"], ["openai", "gpt-6-luna"]],
  "notes": {
    "Engineering/…/Load Bypassing and Load Forwarding.md": {
      "hash": "sha256 of the note body, frontmatter excluded",
      "carded_at": "2026-10-17T10:30:00Z",
      "cards": [[1760697000001, 0], [1760697000002, 1]]
    }
  }
}
```

- **Each card is `[Anki note ID, model]`**, where the model is its position in `models`, the list
  of every provider and model that has made a card. The provider and model are recorded for every
  card, because Regenerate can mix models within one note. `models` only grows by one entry per
  model ever used.
- **Why its own file:** settings saves don't rewrite the card index, and a sync conflict in one
  file doesn't touch the other. Obsidian's own API docs show a plugin keeping a file like this in
  its folder (`${plugin.manifest.dir}/cache.json`), read and written through the vault adapter.
- **Why compact:** Obsidian Sync's Standard plan caps a single file at 5 MB. Writing each card's
  provider and model in full would cost about 100 bytes a card, and the index would pass 5 MB in a
  large vault. Compact, it's about 20 bytes a card:

  | Vault, fully carded | Size |
  |---|---|
  | V1 (328 notes, ~2,600 cards) | ~100 KB |
  | 5,000 notes, ~50,000 cards | ~1.8 MB |
- **No change event:** Obsidian only tells a plugin when `data.json` changes on disk, not other
  files. So the plugin reads `card-index.json` again before each run and before each write (see
  *Combining two computers' copies*, below).
- Frontmatter is left out of the hash, so a change to properties doesn't make a note look changed.
- **When you rename or move a note in Obsidian**, the plugin hears the vault's `rename` event and
  moves the note's entry to the new path, so its cards stay attached to it. The note itself is
  untouched. Deleting a note keeps its entry, because its cards are still in Anki.
- **Cards deleted in Anki:** their IDs are pruned whenever a folder run or a re-card asks Anki about
  them.
- **Selections** add their Anki notes to the note's entry but don't set `hash`. A note with only
  selection cards is not carded, and the status bar says so.
- Cards made by 0.2.x aren't in the index and are left alone.

## Combining two computers' copies

If two computers make cards before syncing, the sync keeps one computer's `card-index.json` and
drops the other's new entries. Those notes then look uncarded, and a folder run could make
duplicate cards. The recommendation was to read the file again before every write, and combine it
with the copy in memory note by note: keep every Anki note ID from both, and keep the hash and
`carded_at` of whichever copy carded the note later.

## A lighter alternative, with nothing tracked in the plugin

Before generating, ask Anki for the note's existing cards through the note link (which needs the
link stored in a field), and send them along so only new material becomes cards.

---

# Choosing a deck with AI

Ask the model which deck fits a note, from the decks' names and, optionally, sample cards. It
would be a separate option next to the NLP matching in *Deck Selection*. It needs no
download, but it sends note text and Anki deck information to the provider, so it should be
clearly opt-in. Not scheduled; the NLP option may cover most of the need.

---

# Anki note checks for prompt changes

The build plan's *Checking the prompt* describes automatic checks on generated Anki notes, to show
whether a prompt change made them better or worse. Not needed for 1.0; the plan's open decision 1
still covers the live script.

**What they would check** (rules code can apply without reading the card's meaning):

- **Answer length:** a long answer is hard to recall at a glance. Needs a threshold.
- **List markers:** a field starting with `-`, `1.` or `•` probably packs several facts into one note.
- **Cloze numbering:** a cloze note should use only `c1`, so each note makes one card. Confirm before building.
- **`{{image:…}}` names only diagrams that were sent**, and **empty fields** and **the note limit**. The
  export already refuses these, so the checks would only count them.

**When they would run:**

- `npm test`, on saved replies in `test/fixtures/`, with no network. Saved replies test the checks, not
  the current prompt or models, so they need re-recording when the prompt changes.
- `scripts/prompt-check.mjs`, by hand, live. Costs a few cents, and writes a report with every Anki note
  for reading, and compares it with an earlier report.
- Never inside the plugin at runtime. Generation and export behave the same with or without them.

**Outcomes:** bug-class failures (a rule the code already enforces) would fail `npm test`. Quality
signals would only appear in the report, since a threshold would otherwise block good prompt changes.

**Open:** the answer-length threshold; whether `npm test` becomes a step in the release workflow (it
isn't one today); and whether the replies are recorded from a live run or written by hand.

# Other ideas

| Idea | Notes |
|---|---|
| Mobile | AnkiConnect is desktop-only. AnkiDroid's API is a separate project |
| Choosing card types to include in a run (cloze, comparisons, "why" questions, diagram cards…), in the dialog before generating | A future consideration. It would mean "include these where the note supports them", never "must include", since forcing a type the note doesn't support is padding. Instructions for this run can steer a run meanwhile. Run options already go into the format instructions, so nothing in the plugin needs to change for it |
| Trying your own card-writing instructions on a sample note, inside the plugin | Prompts are checked only with scripts for now |
| A view of what you changed in the card-writing instructions, against the default (additions, removals and changes, like a git diff) | Mostly useful when an update changes the default and you've edited yours. The plugin records which default an edit started from, so a later release can show both changes |
| AWS Bedrock and Google Vertex directly | They need signed requests or OAuth, not a pasted key. Reachable through a gateway meanwhile |
| Anki image occlusion | It needs its own note type and mask format. Diagram cards cover the common case |
| Capturing animated GIF content for card generation | Let the model understand changes across an animation, rather than only a still frame. One possible approach is to extract representative frames and send them in order. Frame selection, timing, request limits and cost still need designing. Preserving the original GIF in Anki is separate from understanding its animation. Not planned yet |
| Expanding embedded notes (`![[Other note]]`) | It changes what "the note" means (and, with carded tracking, its hash). Revisit if folder runs feel thin |
| Sending Excalidraw drawings, canvases and embedded PDF pages as images | The plugin skips them, because they aren't image files, and names them in both dialogs. Each would need rendering to an image first |
| Splitting a long note into parts, each generated on its own | Considered for folder runs and held off. A whole note fits easily in what current models accept, and splitting costs quality: each part loses context from the rest (a definition near the top), parts overlap so cards repeat, coverage is judged per part rather than across the note, and diagrams must be assigned to parts. The prompt check's long sample note shows whether it's needed: later sections getting fewer cards, or replies cut off at the output limit. A selection already makes cards from part of a note |
| A setting for how many notes a folder run sends at once | Folder runs start with three and wait when a provider reports a rate limit. Most people don't know their limits; a setting would be for people who want faster runs |
| Batch APIs for folder runs (cheaper) | Results arrive minutes to hours later, which doesn't fit a review dialog |

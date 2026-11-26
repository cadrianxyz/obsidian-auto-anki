# Generating notes

Before you start, make sure Anki is open with [AnkiConnect](https://ankiweb.net/shared/info/2055492159) installed.

Open the command palette (**Ctrl/Cmd + P**) and run one of these commands:

- **Auto Anki: Generate notes from current file**: uses the whole open note.
- **Auto Anki: Generate notes from highlighted text**: uses only the text you've selected. The note must be open in editing view.

Frontmatter (the properties at the top of a note) and `%%comments%%` are never sent.

## Step 1: Generate

The dialog shows which model will be used and exactly what will be sent. You can change these options for this run only. Your saved settings stay the same.

- **Coverage**: how much of the note to turn into Anki notes: **Key ideas only**, **Main ideas and important details**, or **Everything worth remembering**.
- **Note types**: which kinds of Anki notes the AI may write (see [Note types](note-types.md)).
- **Advanced**:
  - **Model** and **Reasoning effort**: which AI to use, and how hard it should think.
  - **Maximum notes**: an upper limit on the number of Anki notes. One Anki note can make several flashcards. Leave it empty for no limit.
  - **Extra instructions**: anything extra you want the AI to follow, such as "Use British spelling".

Click **Generate Anki notes**. The status bar shows that it's working. Long notes can take a while, and a run stops after 10 minutes.

Closing the dialog cancels the run. The provider may still charge for a request it has already started.

## Step 2: Review

Each suggested Anki note shows its note type and all its fields. Tick the notes you want to keep (**Select all** and **Deselect all** can help), then click **Confirm selection**.

The AI also lists anything in your note that looks like a mistake, and anything it skipped.

## Step 3: Export

Choose a deck (see [Deck selection](deck-selection.md)). If tagging is on, you can also change this export's tags (see [Tags](tags.md)). Then click **Confirm and export**.

If Anki refuses a note, for example because it's a duplicate, that note stays on screen so you can try again. Notes that were already added aren't sent twice.

## Your writing preferences

Open **Settings → Auto Anki → Generation** to set defaults for every run:

- **Coverage**: the starting coverage for the generate dialog.
- **Send diagrams**: lets the AI see images in your notes (see below). On by default.
- **Extra instructions**: your standing preferences, such as "Use British spelling" or "Keep answers under 20 words". You can use Markdown and several lines.

**Generation → Advanced → Note-writing instructions** shows the built-in guidance the AI follows when writing notes. You can rewrite it completely, and **Reset to default** brings back the original. For small tweaks, use **Extra instructions** instead. That way, you still get improvements to the built-in guidance when the plugin updates.

## Images and diagrams

When **Send diagrams** is on and the model accepts images, images embedded in your note are sent along so the AI can write notes about them. If a note uses an image, the image is copied into Anki and shown on the card.

- Only images saved in your vault are sent. Images linked from the web are skipped.
- Up to 20 images are sent per run. Large images are shrunk first, and your original files aren't changed.
- Supported formats: PNG, JPEG, GIF, WebP, BMP and AVIF. For an animated GIF, the AI sees only the first frame, but Anki gets the full animation.
- When you use only highlighted text, only the images inside that selection are sent.

## How notes look in Anki

- Formatting such as bold, lists and code is kept.
- Maths written as `$…$` or `$$…$$` is displayed with Anki's built-in maths support.
- Cloze deletions such as `{{c1::…}}` are kept as written.
- HTML is shown as plain text, so it can't run code on your cards.

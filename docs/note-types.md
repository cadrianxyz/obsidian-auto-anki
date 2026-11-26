# Note types

In Anki, every note has a **note type**. The note type sets the note's fields (such as *Front* and *Back*) and which flashcards it makes. **Basic** and **Cloze** are the most common, but you may have made your own.

Auto Anki lets you choose which of your note types the AI may use.

## Choose note types

1. Open Anki, with AnkiConnect installed.
2. In Obsidian, open **Settings → Auto Anki → Anki**.
3. Under **Note types**, turn on the types the AI may use. **Basic** and **Cloze** are on to start.

For each run, the AI picks whichever of these types suits the content best. It doesn't have to use all of them. You can also change the types for a single run in the generate dialog.

## How the AI fills your fields

The AI sees each note type's field names and card layout, and writes text straight into each field. Custom note types with more than two fields work too.

**Tip:** to tell the AI what a field is for, add a description to that field in Anki (**Tools → Manage Note Types → Fields**). Auto Anki passes it on to the AI.

A few rules:

- The first field always gets text. Other fields may be left empty.
- Note types that need images to be made for them, such as Image Occlusion, can't be used. Auto Anki explains why next to the type.
- Auto Anki never changes your note types, fields or card layouts.

## After changing note types in Anki

Click the refresh button beside **Note types** to load your changes.

If a note type you turned on is missing from Anki, it stays selected but is skipped until it's back.

If you change a note type in Anki while you're reviewing notes, the export stops and your generated notes are kept. Change the note type back, or generate again.

## AnkiConnect address

**AnkiConnect address**, on the same page, tells Auto Anki where to find Anki. The default, `http://127.0.0.1:8765`, works unless you've changed AnkiConnect's own settings. If you change it, refresh the note types afterwards.

# Changelog

Notable changes to Auto Anki, newest first. Each release starts with a short summary, then lists changes in detail.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses [Semantic Versioning](https://semver.org/): a change in the first number (1.0.0) can mean you need to redo some setup, a change in the second (1.1.0) adds features, and a change in the third (1.1.1) fixes problems.

## [1.1.0] - Unreleased

**In short:** Auto Anki can now tag the notes it adds to Anki, so you can find, compare or delete them later: for example, every note one model made. Tagging is off until you turn it on.

### Added

- **Tags for new Anki notes.** Turn them on in **Settings → Auto Anki → Anki → Tags**, with **Tag Anki notes**. You choose which tags each new note gets:
  - **Model** (on by default): the provider and model that made the note, such as `auto-anki::anthropic::claude-haiku-5-5`.
  - **Reasoning effort** (off by default): the effort chosen for that run, such as `auto-anki::effort::high`.
  - **Prompt version** (off by default): the version of the built-in note-writing instructions, such as `auto-anki::prompt::1.0.0`. It ends in `-edited` if you replaced those instructions with your own.
  - **Extra tags**: your own tags for every new note, separated by spaces. Use `::` for nested tags, such as `uni::cs101`.
- **The `auto-anki::` prefix** (on by default) keeps the plugin's own tags together. Search `tag:auto-anki::*` in Anki's browser to find every note they were added to. The prefix is never added to your extra tags.
- **An example line** on the Tags page shows the tags one new note would get with your current default model.
- **Tags for one export.** While tagging is on, the deck step has a **Tags** section where you can change the extra tags for that export only. Your saved settings stay the same.

### Changed

- New Anki notes are no longer tagged `auto-gpt-imported`. Notes that already have that tag keep it.

### Upgrading from 1.0.0

Nothing to do. Your settings carry over, and tagging stays off until you turn it on. Tags are only added to notes when they're created: Auto Anki never changes the tags of notes already in Anki.

## [1.0.0] - 2026-11-02

**In short:** Auto Anki 1.0 is a rebuild. It now works with **OpenAI or Claude**, fills **any Anki note type** you choose (including Cloze and your own custom types), can read the **diagrams** in your notes, and shows them on your cards. Your existing OpenAI key, model, deck and AnkiConnect port carry over automatically.

> **Before you upgrade:** 1.0.0 needs **Obsidian 1.13.1 or newer** on desktop. Older Obsidian versions keep the last Auto Anki version they support: 0.3.1 from Obsidian 1.11.4, or 0.2.2 before that.

### Added

- **Claude support.** Use Claude as well as OpenAI. Each needs an API key from that provider; a ChatGPT or Claude chat subscription doesn't include API access.
- **Choose your own models.** Each provider's settings page lists the models your account can use. Turn on the ones you want in **Manage models**, and pick a **Default model**. New models show up without a plugin update, and you can enter an exact model ID if one is missing from the list.
- **Settings for each model.** Every model keeps its own reasoning effort and maximum output tokens. Changing one model leaves the others as they were.
- **Any Anki note type.** Choose which of your existing note types the AI may use, under **Settings → Auto Anki → Anki → Note types**. Basic and Cloze are selected to begin with. The AI sees each type's fields and their descriptions, and fills every field directly, so custom types with more than two fields work too.
- **Diagrams and images.** With **Send diagrams** on, images embedded in your note are sent to models that accept images, so the AI can write notes about them. When a note uses an image, it is copied into Anki and shown on the card. PNG, JPEG, GIF, WebP, BMP and AVIF are supported, with up to 20 images per run.
- **Formatted cards.** Fields keep their formatting (bold, lists, code and so on) in Anki, and maths written as `$…$` or `$$…$$` displays with Anki's built-in MathJax.
- **Coverage** replaces the number of questions. Choose **Key ideas only**, **Main ideas and important details** (the default), or **Everything worth remembering**. An optional **Maximum notes** limit is in the dialog's **Advanced** section.
- **Extra instructions** for standing preferences, such as "Use British spelling". You can also replace the built-in note-writing instructions under **Generation → Advanced**, and reset them at any time.
- **Choices for one run.** The generation dialog lets you change the coverage, note types, model, reasoning effort, maximum notes and extra instructions for that run only, without changing your saved settings.
- **A default deck picker** that lists your Anki decks. You can still choose a different deck for each export.
- **Clearer review.** Each generated note shows its note type and all its fields. Possible mistakes the AI spotted in your note, and content it skipped, are shown alongside.

### Changed

- **The commands are renamed** to **Generate notes from current file** and **Generate notes from highlighted text**. If you assigned hotkeys to the old commands, check that they still work.
- **The AnkiConnect setting is now a full address**, such as `http://127.0.0.1:8765`, instead of just a port. Your old port carries over.
- **Safer exports.** Auto Anki checks with Anki before adding notes. Notes that Anki refuses, for example duplicates, stay in the review so you can try again, and notes already added aren't sent twice. If a deck you chose no longer exists, notes go to Anki's **Default** deck; the plugin never creates decks.
- **Cancelling is safe.** Closing the dialog cancels the request in progress. A failed request is reported rather than retried, so one click never sends the same paid request twice. A generation that runs longer than ten minutes stops with a message.

### Removed

- **Number of questions and alternatives.** Coverage and the optional Maximum notes limit replace them.
- **The fixed Front/Back format.** Notes now use the fields of the note types you choose.

### Privacy and security

- Nothing from your note is sent until you click **Generate Anki notes**. The dialog shows exactly what will be sent: the note's text (without frontmatter or `%%comments%%`) and its diagrams.
- API keys stay in Obsidian's Keychain on your device, never in your vault. The Keychain doesn't sync, so enter your key once on each device.
- OpenAI requests are sent with response storage turned off.
- Auto Anki only adds notes and images to Anki. It never edits or deletes your existing notes, and never creates or changes note types, fields, card templates or decks.

### Upgrading from 0.x

Your settings upgrade automatically the first time 1.0.0 loads:

- Your OpenAI key stays in the Keychain. If you're coming from 0.2, it's moved there first, as described in [Upgrading to 0.3.0](https://github.com/cadrianxyz/obsidian-auto-anki/blob/master/CHANGELOG.md#upgrading-to-030).
- Your OpenAI model becomes your default model, with its reasoning effort and output limit.
- Your AnkiConnect port becomes the AnkiConnect address, and your deck becomes the default deck.

After upgrading, open **Settings → Auto Anki → Anki** with Anki running and check that the note types you want are turned on. To try Claude, add a Claude API key and turn on a model under **Manage models**.

## Earlier versions

Versions before 1.0.0 only have upgrade notes here. For everything else they changed, see the [GitHub releases](https://github.com/cadrianxyz/obsidian-auto-anki/releases).

### Upgrading to 0.3.0

- **Your API key moved out of your vault.** Earlier versions stored your OpenAI API key in plain text in the plugin's `data.json`, inside your vault, so anything that copies your vault (sync, backups, git) copied the key too. 0.3.0 moves it into Obsidian's Keychain automatically the first time it loads, removes it from `data.json`, and shows a notice when it has. Older copies of your vault may still contain the key, so consider replacing it at OpenAI.
- **Enter the key once on each device.** On any other device where you use the same vault, enter the key once in the Auto Anki settings. If one of those devices has an Obsidian older than 1.11.4, it stays on 0.2.2, which only reads the key from `data.json`: update Obsidian there too, or that device will keep asking for the key.
- **Sampling settings are gone.** The temperature, top-p, frequency penalty and presence penalty settings are removed. Current OpenAI models only accept their default values, so changing them made requests fail. **Reasoning effort** replaces them as the way to trade speed and cost against quality.
- **Maximum output tokens** replaces **Maximum tokens per question**. It's a single cap per request that includes the model's reasoning.
- 0.3.0 needs Obsidian 1.11.4 or newer.

### Upgrading from 0.2.1

0.2.1 always used `gpt-3.5-turbo-1106`, which OpenAI shut down on 28 September 2026, so it can no longer generate Anki notes. From 0.2.2 the model is a setting; your other settings carry over unchanged.

[1.1.0]: https://github.com/cadrianxyz/obsidian-auto-anki/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/cadrianxyz/obsidian-auto-anki/compare/0.3.1...1.0.0

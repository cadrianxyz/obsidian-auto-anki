# Tags

Auto Anki can add tags to the notes it creates in Anki. You can use these tags to find, compare or delete those notes later. For example, you could find every note one model made.

## Turn on tags

Tagging is **off** until you turn it on. Open **Settings → Auto Anki → Anki → Tags** and turn on **Tag Anki notes**. Then choose which tags to add:

| Option | Default | Adds | Example |
|---|---|---|---|
| **Model** | on | The provider and model that wrote the note | `auto-anki::anthropic::claude-haiku-5-5` |
| **Reasoning effort** | off | The reasoning effort used (`default` if you left it to the model) | `auto-anki::effort::high` |
| **Prompt version** | off | The version of the built-in note-writing instructions. It ends in `-edited` if you rewrote them | `auto-anki::prompt::1.0.0` |
| **Prefix tags with `auto-anki::`** | on | Puts `auto-anki::` in front of the three tags above | Off: `anthropic::claude-haiku-5-5` |
| **Extra tags** | empty | Your own tags, separated by spaces. Use `::` for nested tags | `obsidian uni::cs101` |

The **Example** line on the page shows the tags a new note would get.

## Find tagged notes in Anki

In Anki's **Browse** window, search for:

- `tag:auto-anki::*` to find every note Auto Anki tagged.
- `tag:auto-anki::anthropic::*` to find every note a Claude model wrote. For OpenAI models, use `openai` instead of `anthropic`.

This is why the `auto-anki::` prefix is on by default. It keeps the plugin's tags in one place instead of mixing them with your own tags. The prefix is never added to your extra tags.

## Change tags for one export

When tagging is on, the export step has a **Tags** section. Open it to edit **Extra tags for this export**. The change applies to that export only, and your settings stay the same.

## Good to know

- Tags are added only when a note is created. Auto Anki never changes tags on notes already in Anki.
- Tags are decided when you click **Generate Anki notes**. Changing tag settings during review doesn't affect those notes.
- Repeated tags are added only once. Anki treats tags that differ only in capital letters as the same tag.
- Older versions tagged every note `auto-gpt-imported`. New notes don't get that tag, but notes that already have it keep it.

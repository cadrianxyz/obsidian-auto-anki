# Providers and models

A **provider** is the AI company that writes your notes: **OpenAI** or **Claude**. A **model** is one specific AI from that provider. Providers offer several models, which differ in speed, price and quality.

You need an API key for at least one provider, and at least one model turned on.

## Add your API key

An **API key** is like a password that lets Auto Anki use your AI account. You can get one from [OpenAI](https://platform.openai.com/api-keys) or [Claude](https://platform.claude.com/). The provider bills you for what you use.

1. Open **Settings → Auto Anki**.
2. Under **AI providers**, choose **OpenAI** or **Claude**.
3. Paste your key and click **Save key**.

Your key is kept in Obsidian's Keychain on this computer only, not in your vault, so it doesn't sync. On another computer, add it again. Leaving the key box empty doesn't delete a saved key. To remove one, go to **Settings → Keychain**.

## Turn on models

Adding a key doesn't turn on any models. You choose them yourself:

1. On the provider's settings page, click **Manage models** (the gear icon beside **Your models**).
2. Turn on the models you want. Use the search box to find one, or **Refresh models** to get the latest list.
3. Click **Save changes**. (**Cancel** throws away your changes.)

The models you turn on show up under **Your models** and in the model picker when you generate.

- **Greyed-out models** can't write text, so they can't be used.
- **Missing a model?** Open **Advanced: enter a model ID**, type the model's exact ID from the provider, and click **Include in selection**. Your account still needs access to it.
- **Turning a model off** hides it but keeps its settings. Turn it back on to get them back.

The list comes straight from your provider, so new models appear without a plugin update. The order (newest first) is not a quality ranking.

## Choose a default model

The **default model** is used whenever you don't pick a different one in the generate dialog.

- If you have no default yet, the first model you turn on becomes the default.
- To change it, click **Use as default model** on a model's page, or pick one in **Default model** on the main Auto Anki settings page.
- If you turn off your default model, Auto Anki doesn't pick a new one for you. Choose a new default before you generate.

## Model settings

Click a model under **Your models** to change its settings. Each model keeps its own settings.

| Setting | What it does |
|---|---|
| **Reasoning effort** | How much the model "thinks" before answering. More effort usually means better notes, but they're slower and cost more. **Model default** lets the provider decide. |
| **Maximum output tokens** | A limit on how long the AI's reply can be. Tokens are the small chunks of text that providers count and bill by. The default is 25,000. You only pay for what's actually used. |
| **Output mode** (Advanced) | How the AI sends its answer back to the plugin. Leave this on **Auto**. |
| **Accepts images** (Advanced) | Whether the model can look at images. **Auto** works it out for you. Change it only if a model gets this wrong. |

If generation stops with "ran out of tokens", raise **Maximum output tokens**, lower **Reasoning effort**, or use a shorter selection.

## Troubleshooting

- **"API Key rejected"** next to a provider: the key is wrong or has been revoked. Paste a fresh key and click **Save key**.
- **Other warnings next to a provider**: Auto Anki couldn't reach the provider just now. Models you already turned on keep working.
- **Connection problems despite a correct key**: if you've set the `OPENAI_CUSTOM_HEADERS` or `ANTHROPIC_CUSTOM_HEADERS` environment variable on your computer, remove it and restart Obsidian. (Most people never set these.)

## What gets sent and saved

- **Your notes** go only to the provider you chose, and only when you click **Generate Anki notes**.
- **Model names and details**, such as which models accept images, come from [models.dev](https://models.dev/), a public list of AI models. It never receives your key or your notes. Auto Anki keeps a copy in `model-catalog-cache.json` in the plugin's folder. You can safely delete that file, and Auto Anki will download it again.
- **Your settings** (models, note types, decks, tags) are saved in the plugin's `data.json` file in your vault.

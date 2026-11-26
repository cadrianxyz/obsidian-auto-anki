# Contributing

## Development

Requires Node.js 24, the version the release workflow uses.

```bash
npm install
npm run dev     # rebuilds main.js on every change
npm run build   # type-checks, then makes a production build
npm run lint    # checks the code with ESLint, including Obsidian's own plugin-review rules
npm test        # runs the tests
```

The tests (in `test/`) load the plugin in Node against a stand-in for Obsidian, with a fake Keychain, fake OpenAI and Claude APIs and a fake AnkiConnect, so they need no vault, no API key and no Anki. They cover moving the API key out of `data.json` (including synced vaults and a Keychain that fails), reading settings saved by every earlier version, the export flow with its error messages, image handling and field rendering.

To test in a vault, point `OBSIDIAN_PLUGIN_DIR` at the plugin's folder inside that vault. Every build is then copied there (`main.js`, `manifest.json`, `styles.css`):

```bash
OBSIDIAN_PLUGIN_DIR=~/path/to/vault/.obsidian/plugins/auto-anki npm run dev
```

Then reload the plugin in Obsidian (Settings > Community Plugins), or install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin to have it reloaded after every build.

## Releasing

Add a `## [<new-version>]` section to `CHANGELOG.md` first: the release workflow copies it into the GitHub release, and stops without releasing if it's missing. `npm version <new-version>` updates `manifest.json` and `versions.json`. Push the tag (`git push origin <new-version>`): the release workflow builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release with that tag. The workflow does not run `npm test`, so run it before tagging. Push the branch afterwards, since Obsidian reads `manifest.json` from the default branch to decide which release to install.

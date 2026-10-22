// ESLint "flat config" (the format ESLint 9 made the default and ESLint 10 requires).
// It replaces the old .eslintrc and .eslintignore files.
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	// Files ESLint never looks at: build output, dependencies, and the build scripts.
	globalIgnores([
		"node_modules",
		"main.js",
		"sample",
		// The tests run in Node against a stand-in for Obsidian, so Obsidian's plugin rules don't apply.
		"test",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
	]),
	{
		languageOptions: {
			// The plugin runs in Obsidian's window, so browser globals (document, window…) exist.
			globals: {
				...globals.browser,
			},
			parserOptions: {
				// Lets the type-aware rules use tsconfig.json to understand the code's types.
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	// Obsidian's own rules for community plugins, the same ones its review uses.
	...obsidianmd.configs.recommended,
	{
		rules: {
			// UI text must be in sentence case. These names keep their capitals. Setting
			// "brands" replaces the rule's built-in list, so every brand used is listed here.
			"obsidianmd/ui/sentence-case": ["warn", {
				brands: ["Auto Anki", "AnkiConnect", "Anki", "Obsidian", "Keychain", "OpenAI", "GPT", "Git"],
			}],
		},
	},
);

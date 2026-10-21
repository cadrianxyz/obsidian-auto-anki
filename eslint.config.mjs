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
);

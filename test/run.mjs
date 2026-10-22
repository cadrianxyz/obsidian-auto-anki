// Runs the tests: `npm test`.
//
// Each test/*.test.mjs is bundled with esbuild the same way the plugin is (same target,
// browser-style bundle, Node's modules left out), except that "obsidian" is replaced by
// test/fake-obsidian.mjs. Node's built-in test runner then runs the bundles.
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const testDir = import.meta.dirname;
const outDir = join(testDir, ".build");
const only = process.argv.slice(2);
const entries = readdirSync(testDir)
	.filter((f) => f.endsWith(".test.mjs"))
	.filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
	.map((f) => join(testDir, f));

rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
	entryPoints: entries,
	outdir: outDir,
	outExtension: { ".js": ".cjs" },
	bundle: true,
	format: "cjs",
	target: "es2021",
	logLevel: "warning",
	alias: { obsidian: join(testDir, "fake-obsidian.mjs") },
	external: [...builtinModules, "node:*"],
	// Keeps the plugin's development-only console logging quiet.
	define: { "process.env.NODE_ENV": '"production"' },
});

const bundles = readdirSync(outDir).filter((f) => f.endsWith(".test.cjs")).map((f) => join(outDir, f));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...bundles], { stdio: "inherit" });
process.exit(result.status ?? 1);

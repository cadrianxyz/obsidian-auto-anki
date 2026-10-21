// Run by `npm version <new-version>` (see "version" in package.json), which sets
// npm_package_version and then commits manifest.json and versions.json with the bump.
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	throw new Error("Run this through `npm version <new-version>`, which sets npm_package_version.");
}

// Set the new version in manifest.json, keeping its minAppVersion.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// Record which Obsidian version the new release needs, so older apps are offered an older
// release. Skipped if this version is already listed, e.g. when re-running after a failed attempt.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}

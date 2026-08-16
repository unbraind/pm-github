import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

interface PackageManifest {
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface ExtensionManifest {
  readonly pm_min_version?: unknown;
}

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as PackageManifest;
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as ExtensionManifest;

const CLI = "@unbrained/pm-cli";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Two independent systems enforce the pm CLI compatibility floor, and each reads
 * a different declaration.
 *
 * `npm` enforces `peerDependencies["@unbrained/pm-cli"]` at install time, and it
 * never sees a globally installed host CLI. The pm CLI itself enforces the
 * top-level `pm_min_version` in `manifest.json` — it refuses to install or
 * activate an extension whose floor exceeds the running CLI, and reports
 * `extension_pm_min_version_unmet` from `pm health`. Neither reads the other's
 * field, and a floor written into a field nothing reads is silently inert.
 *
 * These tests bind the two declarations to the same version so that whichever
 * enforcement path a consumer takes, it applies the same floor.
 */
test("the peer dependency declares the CLI floor as a minimum, not an exact pin", () => {
  const peer = packageJson.peerDependencies?.[CLI];
  assert.ok(peer, `package.json peerDependencies must declare ${CLI}`);
  assert.match(
    peer,
    /^>=\d+\.\d+\.\d+$/,
    `peerDependencies["${CLI}"] must be a >= floor so any newer host CLI satisfies it, got ${peer}`,
  );
});

test("the extension manifest declares the same floor the CLI actually enforces", () => {
  const peer = packageJson.peerDependencies?.[CLI];
  assert.ok(peer);
  const declared = extensionManifest.pm_min_version;
  assert.strictEqual(
    typeof declared,
    "string",
    "manifest.json must declare a top-level pm_min_version — it is the only floor the pm CLI reads, so without it the CLI enforces no floor. npm still enforces the peerDependencies floor, but only for a locally resolved dependency, never for a globally installed host CLI",
  );
  assert.strictEqual(
    declared,
    peer.slice(">=".length),
    "manifest.json pm_min_version must equal the peerDependencies floor, or npm and the pm CLI enforce different minimums",
  );
});

test("the development dependency is an exact pin at or above the declared floor", () => {
  const dev = packageJson.devDependencies?.[CLI];
  assert.ok(dev, `package.json devDependencies must declare ${CLI}`);
  assert.match(
    dev,
    EXACT_VERSION,
    `devDependencies["${CLI}"] must be an exact pin so CI and a working copy resolve the same CLI, got ${dev}`,
  );
  const declared = String(extensionManifest.pm_min_version);
  assert.match(
    declared,
    EXACT_VERSION,
    `manifest.json pm_min_version must be an exact three-part version to be comparable, got ${declared}`,
  );
  // Fleet versions are YYYY.M.D, so "2026.8.15" sorts BELOW "2026.8.7" lexicographically.
  // Both operands are known to match EXACT_VERSION here, so every part parses.
  const floor = declared.split(".").map(Number);
  const pinned = dev.split(".").map(Number);
  const compared = floor.findIndex((part, index) => pinned[index] !== part);
  assert.ok(
    compared === -1 || pinned[compared] > floor[compared],
    `the pinned development CLI ${dev} is below the declared floor ${declared}`,
  );
});

/** Regression coverage for the npm package links shipped in package.json. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** The canonical stable version grammar both reusable workflow preflights enforce. */
const canonicalStable = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$/;
const canonicalPeerFloor = /^>=(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$/;

test("npm homepage points to the package catalog", () => {
  assert.equal(packageJson.homepage, "https://pm-cli.unbrained.dev/packages/pm-github");
});

test("npm author links to the maintainer about page", () => {
  assert.deepEqual(packageJson.author, {
    name: "unbrained",
    url: "https://unbrained.dev/about",
  });
});

test("npm repository points to the package repository", () => {
  assert.deepEqual(packageJson.repository, {
    "type": "git",
    "url": "git+https://github.com/unbraind/pm-github.git"
  });
});

test("npm bugs points to the package issue tracker", () => {
  assert.deepEqual(packageJson.bugs, {
    "url": "https://github.com/unbraind/pm-github/issues"
  });
});

test("released compatibility ceiling is the pm CLI version locked for package tests", () => {
  const cli = "@unbrained/pm-cli";
  const manifest = packageJson as { devDependencies: Record<string, string>; peerDependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
  };
  const maximum = manifest.devDependencies[cli]!;
  assert.match(manifest.peerDependencies[cli]!, canonicalPeerFloor);
  const minimum = manifest.peerDependencies[cli]!.slice(2);
  assert.match(maximum, canonicalStable);
  assert.equal(lock.packages[""]?.devDependencies?.[cli], maximum);
  assert.equal(lock.packages[`node_modules/${cli}`]?.version, maximum);
  assert.ok(minimum.localeCompare(maximum, undefined, { numeric: true }) <= 0);
});

test("a known-incompatible host declaration is absent or a stable version above the tested ceiling", () => {
  const cli = "@unbrained/pm-cli";
  const manifest = packageJson as { pmCliIncompatibleFrom?: unknown; devDependencies: Record<string, string> };
  const declared = manifest.pmCliIncompatibleFrom;
  // Absent by default: only a deliberate, reviewed declaration stops newer hosts.
  if (declared === undefined) return;
  const value = String(declared);
  assert.equal(typeof declared, "string", "the declaration must be a string version");
  assert.match(value, canonicalStable, "the declaration must be an exact canonical stable version");
  const maximum = manifest.devDependencies[cli]!;
  const delta = value.split(".").map(Number)
    .map((part, index) => part - Number(maximum.split(".")[index])).find(part => part !== 0) ?? 0;
  assert.ok(delta > 0, "the declaration must sit above the release's tested host ceiling");
});

test("the metadata grammar is the preflights' canonical stable version grammar", () => {
  // The workflows reject zero-padded components, so metadata tests must too.
  assert.equal(canonicalStable.test("2026.11.23"), true);
  for (const invalid of ["2026.11.023", "02026.11.23", "2026.011.23", "2026.11.23-1", "2026.11.23.1", " 2026.11.23", "2026.11.23 "]) {
    assert.equal(canonicalStable.test(invalid), false, invalid);
  }
  assert.equal(canonicalPeerFloor.test(">=2026.10.23"), true);
  assert.equal(canonicalPeerFloor.test(">=2026.10.023"), false);
});

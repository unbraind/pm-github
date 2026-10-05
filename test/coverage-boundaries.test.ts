import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { formatRateLimit, readPmItems } from "../index.ts";
import { gitBlobOid, readObject, runGate } from "../scripts/privacy-gate.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";
import { nodeScenario } from "./helpers/node-scenario.ts";

const INDEX_URL = new URL("../index.ts", import.meta.url).href;
const PRIVACY_URL = new URL("../scripts/privacy-gate.ts", import.meta.url).href;

/** Create a temporary directory whose lifetime follows the test. */
function directory(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-coverage-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Run actual git, with every setup failure asserted before exercising the gate. */
function git(root: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Start an independent git repository with an approving identity allowlist. */
function repository(t: TestContext, commit = true): string {
  const root = directory(t);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Fixture Bot"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  fs.mkdirSync(path.join(root, ".github"));
  fs.writeFileSync(path.join(root, ".github", "approved-git-identities.txt"), "fixture@example.invalid\n");
  if (commit) {
    git(root, ["add", ".github/approved-git-identities.txt"]);
    git(root, ["commit", "-qm", "Fixture baseline"]);
  }
  return root;
}

/** Write reviewed fixture provenance with exact blob, commit, and source names. */
function manifest(root: string, value: unknown): void {
  const folder = path.join(root, "test", "fixtures", "privacy-gate");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(value));
}

test("secure Windows relaunch rejects missing, malformed, and escaping executable metadata", async t => {
  const root = directory(t);
  await withEnv({ PM_CLI_PACKAGE_ROOT: undefined }, async () => {
    assert.throws(() => readPmItems(root, "win32", undefined), /did not publish/);
  });
  assert.throws(() => readPmItems(root, "win32", "  "), /did not publish/);
  assert.throws(() => readPmItems(root, "win32", root), /Could not read/);
  fs.writeFileSync(path.join(root, "package.json"), "{");
  assert.throws(() => readPmItems(root, "win32", root), /Could not read/);
  for (const metadata of [null, {}, { bin: "cli.js" }, { bin: {} }, { bin: { pm: 7 } }, { bin: { pm: "  " } }]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(metadata));
    assert.throws(() => readPmItems(root, "win32", root), /does not declare/);
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ bin: { pm: "../outside.js" } }));
  assert.throws(() => readPmItems(root, "win32", root), /outside its package root/);
});

test("whole-corpus reads distinguish missing executables, empty diagnostics, invalid JSON, and buffer exhaustion", t => {
  const root = directory(t);
  const executable = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  assert.ok(executable);
  const binary = path.join(root, "pm");
  nodeScenario(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { readPmItems } from ${JSON.stringify(INDEX_URL)};
    const root = ${JSON.stringify(root)};
    assert.throws(() => readPmItems(root), /pm list --all failed:/);
    for (const [body, expected] of [
      ['process.exit(4);', /pm list --all failed$/],
      ['process.stdout.write("invalid-json");', /Could not parse/],
      ['process.stdout.write("x".repeat(2 * 1024 * 1024));', /exceeded the 1048576 byte read buffer/],
    ]) {
      fs.writeFileSync(${JSON.stringify(binary)}, ${JSON.stringify(`#!${executable}\n`)} + body, { mode: 0o755 });
      assert.throws(() => readPmItems(root), expected);
    }
  `, { PATH: root, PM_JSON_MAX_BUFFER: "1048576" });
});

test("token fallback ignores an empty successful credential helper response", t => {
  const root = directory(t);
  const executable = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(root, "gh"), `#!${executable}\nprocess.stdout.write("  ");\n`, { mode: 0o755 });
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { resolveGitHubToken } from ${JSON.stringify(INDEX_URL)};
    assert.equal(resolveGitHubToken(), undefined);
  `, { PATH: root, GITHUB_TOKEN: undefined, GH_TOKEN: undefined });
  assert.equal(formatRateLimit({ remaining: 1, reset: Number.MAX_VALUE, low: true }), "GitHub API quota: 1 remaining");
});

test("registered preflight warns only for mutations lacking a token", async t => {
  const root = directory(t);
  const ext = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const context = { command: "github sync", args: [], options: {}, cwd: root, pm_root: root, global: { json: true }, decision: {
    enforce_item_format_gate: true, run_preflight_item_format_sync: true, run_extension_migrations: true, enforce_mandatory_migration_gate: true,
  } };
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { createExtensionTestHarness } from ${JSON.stringify(new URL("../node_modules/@unbrained/pm-cli/dist/sdk/testing.js", import.meta.url).href)};
    import extension from ${JSON.stringify(INDEX_URL)};
    import { captureStderr } from ${JSON.stringify(new URL("./helpers/mock-github-server.ts", import.meta.url).href)};
    const ext = await createExtensionTestHarness(extension, { capabilities: ['commands', 'importers', 'schema', 'hooks', 'preflight', 'search'] });
    const context = ${JSON.stringify(context)};
    const { stderr } = await captureStderr(() => ext.runPreflightOverride(context));
    assert.match(stderr.join(" "), /no GitHub token is resolvable/);
    const preview = await captureStderr(() => ext.runPreflightOverride({ ...context, options: { "dry-run": true } }));
    assert.deepEqual(preview.stderr, []);
  `, { PATH: "", GITHUB_TOKEN: undefined, GH_TOKEN: undefined });
  await withEnv({ GITHUB_TOKEN: "fixture" + "-token" }, async () => {
    const { stderr } = await captureStderr(() => ext.runPreflightOverride(context));
    assert.deepEqual(stderr, []);
  });
});

test("privacy history gate refuses an unborn HEAD and malformed fixture manifest", t => {
  const unborn = repository(t, false);
  assert.match(runGate(unborn).stderr, /fixture exemption resolution failed/);
  const root = repository(t);
  const folder = path.join(root, "test", "fixtures", "privacy-gate");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "manifest.json"), "{");
  assert.match(runGate(root).stderr, /fixture exemption resolution failed/);
});

test("historical fixture exemptions require an exact test blob and valid provenance", t => {
  const root = repository(t);
  fs.mkdirSync(path.join(root, "test"));
  const secret = "ghp_" + "A".repeat(36);
  const content = `// synthetic ${secret}\n`;
  fs.writeFileSync(path.join(root, "test", "synthetic.test.ts"), content);
  git(root, ["add", "test/synthetic.test.ts"]);
  git(root, ["commit", "-qm", "Reviewed fixture"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const oid = gitBlobOid(content);
  for (const source of [
    { commit: "invalid", path: "test/synthetic.test.ts" },
    { commit, path: "source.ts" },
    { commit, path: "test/missing.test.ts" },
    { commit: "0".repeat(40), path: "test/synthetic.test.ts" },
  ]) {
    manifest(root, { [oid]: { justification: "Reviewed synthetic credential", historical_test: source } });
    assert.match(runGate(root).stderr, /fixture exemption resolution failed/);
  }
  manifest(root, { [oid]: { justification: "Reviewed synthetic credential", historical_test: { commit, path: "test/synthetic.test.ts" } } });
  assert.equal(runGate(root).exitCode, 0);
  manifest(root, {});
  const rejected = runGate(root);
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /github-token-classic/);
  assert.ok(!rejected.stderr.includes(secret));
});

test("git object readers propagate missing tools and nonexistent object errors", t => {
  const root = repository(t);
  assert.throws(() => readObject(root, "blob", "0".repeat(40)), /git cat-file/);
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { listAllObjects, readObject } from ${JSON.stringify(PRIVACY_URL)};
    const root = ${JSON.stringify(root)};
    assert.throws(() => listAllObjects(root), /ENOENT/);
    assert.throws(() => readObject(root, "blob", "0".repeat(40)), /ENOENT/);
  `, { PATH: "" });
});

test("docstring CLI performs its real source scan", () => {
  const result = spawnSync("node", ["scripts/docstring-gate.ts"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /declaration\(s\) documented/);
});

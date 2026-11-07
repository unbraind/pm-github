/** Diagnostic contracts hold across encoded input, receipt carriers and actual installed hosts. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { init } from "@unbrained/pm-cli/sdk";
import { scanLineForRuleHits } from "../gate.ts";
import { decodeWorkflowDiagnostic, readWorkflowFailure, redactWorkflowFailure } from "../workflow-diagnostic.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { withPackedFixture } from "./helpers/packed-fixture.ts";

const packageRoot = join(import.meta.dirname, "..");
const cli = join(packageRoot, "node_modules/.bin/pm");

/** Decode one source pass independently of the scanner's offset tables. */
function decodeSource(source: string): string {
  return source.replace(/\\u([a-f0-9]{4})|\\([\\/nrt"])/gi, (_match, unicode: string | undefined, escape: string) =>
    unicode ? String.fromCharCode(Number.parseInt(unicode, 16)) : ({ n: "\n", r: "\r", t: "\t" }[escape] ?? escape));
}

/** Deterministic encoding keeps the source-to-decoded mapping adversarial and reproducible. */
function encodeSource(source: string, seed: number): string {
  return [...source].map((character, index) => (index + seed) % 3 === 0
    ? "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
    : character === "\\" ? "\\\\" : character).join("");
}

/** Fingerprint authoritative tracker bytes, excluding derived cache/runtime output. */
function durable(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true }).map(String)
    .filter(file => file.endsWith(".toon") || /^history\/.*\.jsonl$/.test(file)).sort()
    .map(file => [file, readFileSync(join(root, file), "utf8")]));
}

test("live adoption entry points link the complete current watch matrix", () => {
  const path = "docs/scheduled-workflow-watch-1106.md";
  const issue = decode(readFileSync(join(packageRoot, ".agents/pm/issues/pm-github-samq.toon"), "utf8")) as { description: string };
  for (const entry of [issue.description, readFileSync(join(packageRoot, "README.md"), "utf8")]) {
    assert.ok(entry.includes(path));
    assert.ok(entry.indexOf(path) < entry.indexOf("docs/scheduled-workflow-refusals.md"), "current evidence must lead historical scope");
  }
  const watch = readFileSync(join(packageRoot, path), "utf8");
  const expected = ["ado", "beads", "brief", "changelog", "context", "csv", "evidence", "gantt-chart", "glossary", "http", "jev", "jira", "linear", "memory", "ops", "presets", "rl", "rust", "slack", "slack-standup", "swarm", "vcs"];
  assert.equal(expected.length, 22);
  for (const caller of expected) assert.ok(watch.includes(`| pm-${caller} |`), caller);
});

test("rollout follow-ups preserve the canonical issue owner's unique provenance", () => {
  const root = join(packageRoot, ".agents/pm/issues");
  const rollout = decode(readFileSync(join(root, "pm-github-samq.toon"), "utf8")) as { tags: string[] };
  const canonical = decode(readFileSync(join(root, "pm-github-repeat-noop.toon"), "utf8")) as { tags: string[] };
  assert.ok(canonical.tags.includes("gh:unbraind/pm-github#175"));
  for (const tag of canonical.tags.filter(tag => tag.startsWith("gh:"))) assert.ok(!rollout.tags.includes(tag), "the adoption follow-up is not a second canonical owner");
});

test("every scanner hit maps to its full original source span before redaction", () => {
  const token = "ghp_" + "A".repeat(36);
  const values = [token, "C:" + String.raw`\u005cu005c`, "C:" + "\\fixture\\secret", ["", "home", "fixture", "secret"].join("/"), "fixture" + "@example.dev", "Bearer " + "A".repeat(32), "api_key = " + "aB3cD4eF5gH6iJ7kL8mN9pQ0rS1tU2vW"];
  for (const value of values) for (const source of [value, JSON.stringify(value), ...[0, 1, 2].map(seed => encodeSource(value, seed))]) {
    for (const trackerLine of [false, true]) {
      const line = trackerLine ? `body: ${source}` : source;
      const hits = scanLineForRuleHits(line, trackerLine);
      assert.ok(hits.length > 0, `Every private fixture must be recognized: ${JSON.stringify(source)}/${trackerLine}`);
      for (const hit of hits) {
        assert.ok(hit.index >= 0 && hit.end > hit.index && hit.end <= line.length);
        assert.equal(decodeSource(line.slice(hit.index, hit.end)), hit.matched, `complete source span for ${hit.rule}`);
      }
    }
  }
  const raw = "C:" + String.raw`\u005cu005c`;
  assert.equal(redactWorkflowFailure(`HTTP 403; ${raw}; reviewer required`), "HTTP 403; [redacted]; reviewer required");
  for (const value of [token, "C:" + "\\fixture\\secret"]) for (const seed of [0, 1, 2]) {
    assert.equal(redactWorkflowFailure(`HTTP 403; ${encodeSource(value, seed)}; reviewer required`), "HTTP 403; [redacted]; reviewer required");
  }
  for (const safe of ["Supply required fields: reviewer.", "GET /api/items HTTP 403", "repo/relative/file.ts"]) {
    assert.equal(redactWorkflowFailure(safe), safe, "released safe diagnostic content stays readable");
  }
});

test("generic stderr wrappers cannot displace a specific text cause or structured report", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-carriers-"));
  try {
    const report = join(root, "report.json"), error = join(root, "command.err");
    const cause = "GET /repos/fixture/project/pulls failed HTTP 403; reviewer required";
    const generic = ["Command failed", "command failed.", "COMMAND FAILED!", "Command failed No branch was published.", "Command failed No branch was published. No branch was published."];
    for (const prefix of ["Error", "error", "ERROR"]) for (const title of generic) for (const tail of [cause, `Cause: ${cause}`, `Caused by: ${cause}`, `Error: ${cause}`, `What happened:\n  ${cause}`, `What happened:\n\n  ${cause}`]) {
      const text = `progress\n${prefix}: ${title}\n\n${tail}\nWhy:\n  private help`;
      assert.equal(decodeWorkflowDiagnostic(text).reason, cause);
      writeFileSync(report, JSON.stringify({ reason: "less useful report" })); writeFileSync(error, text);
      assert.equal(readWorkflowFailure(report, error, undefined).reason, cause + " No branch was published.");
    }
    for (const title of generic) for (const stderr of [`Error: ${title}`, `Error: ${title}\nWhat is required:\n  private help`, `Error: ${title}\n  at private stack`, `Error: ${title}\nWhat happened:\n\nWhy:\n  private help`, `Error: ${title}\nWhat happened:\n Command failed\nWhy:\n private help`, JSON.stringify({ detail: title })]) {
      for (const payload of [{ reason: cause }, { detail: cause }, { plan: [{ item: "fixture-1", pr: 42, action: "skip", code: "required_checks_unverified", reason: cause }] }]) {
        writeFileSync(report, JSON.stringify(payload)); writeFileSync(error, stderr);
        assert.ok(readWorkflowFailure(report, error, undefined).reason.includes(cause));
      }
      writeFileSync(report, "{}");
      assert.ok(readWorkflowFailure(report, error, undefined).reason.toLowerCase().includes("command failed"));
    }
    writeFileSync(report, "{}"); writeFileSync(error, "What happened:\n  Command failed");
    assert.match(readWorkflowFailure(report, error, undefined).reason, /Command failed/);
    writeFileSync(error, "Error: Command failed\n\nCommand failed\n\n" + cause);
    assert.equal(readWorkflowFailure(report, error, undefined).reason, cause + " No branch was published.");
    for (const plan of [[], [{ action: "skip", code: "already_terminal" }]]) {
      writeFileSync(report, JSON.stringify({ command: "github closeout", failed: 1, plan }));
      writeFileSync(error, "Error: " + cause);
      assert.equal(readWorkflowFailure(report, error, undefined).reason, cause + " No branch was published.");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packed npm and Bun diagnostics preserve specific redacted causes in JSON and TOON without git", { timeout: 600_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "diagnostic-packed-"));
  await withPackedFixture(base, async ({ root, env }) => {
    const pmRoot = join(root, ".agents/pm");
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: root, pmRoot, noExtensions: true });
    writeFileSync(join(root, "package.json"), "{}\n");
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(root, "node_modules/@unbrained"), { recursive: true });
    symlinkSync(cli, join(root, "node_modules/.bin/pm"));
    symlinkSync(join(packageRoot, "node_modules/@unbrained/pm-cli"), join(root, "node_modules/@unbrained/pm-cli"));
    /** Execute a bounded real host with the fixture's credential-free environment. */
    const run = async (bin: string, args: string[], cwd = root, environment = env): Promise<string> => {
      const result = await boundedCli(bin, args, cwd, environment);
      assert.equal(result.timedOut, false, result.stderr);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    const packed = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", base], packageRoot,
      { ...env, PM_PATH: join(packageRoot, ".agents/pm") })) as [{ filename: string }];
    await run(cli, ["--path", pmRoot, "package", "install", join(base, packed[0].filename), "--project"]);
    const report = join(base, "report.json"), error = join(base, "error.txt");
    const privatePath = "C:" + String.raw`\u005cu005c`;
    const cause = `GET failed HTTP 403; ${privatePath}; reviewer required`;
    const expected = "GET failed HTTP 403; [redacted]; reviewer required No branch was published.";
    const before = durable(pmRoot);
    for (const bin of ["npm", "bun"]) for (const json of [true, false]) for (const explicit of [true, false]) {
      writeFileSync(report, JSON.stringify({ reason: cause }));
      writeFileSync(error, explicit ? `Error: Command failed\nCaused by: ${cause}` : "Error: Command failed");
      const args = ["--path", pmRoot, "github", "workflow-diagnostic", "--report", report, "--error-file", error, ...(json ? ["--json"] : [])];
      const output = await run(bin, bin === "npm" ? ["exec", "--offline", "--", "pm", ...args] : ["--bun", cli, ...args]);
      const decoded = (json ? JSON.parse(output) : decode(output)) as { reason: string };
      assert.equal(decoded.reason, expected, `${bin}/${json}/${explicit}`);
      assert.ok(!decoded.reason.includes(privatePath));
      assert.equal(durable(pmRoot), before, "diagnostics must preserve durable non-git tracker state");
    }
  });
});

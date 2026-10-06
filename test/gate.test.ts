// Fail-closed privacy gate over a proposed tracker change — rule battery,
// diff parsing with item/field attribution, git change collection on a REAL
// repository, content-hash allowlisting, the registered `pm github gate`
// command through the extension test harness, and the workflow contract.
//
// Malicious fixtures are syntactically valid but FAKE and built by
// concatenation so no tracked blob ever contains a complete credential or
// host-path shape: the values exist only inside the test process at run time.
// Findings never echo the matched content, so neither this file nor the gate
// output can carry the fixtures verbatim.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { captureStderr } from "./helpers/mock-github-server.ts";

import { createHash } from "node:crypto";
import {
  GATE_ALLOWLIST_FILENAME,
  GateInputError,
  attributeToonFields,
  collectTrackerChange,
  formatGateReport,
  isHighEntropySecretAssignment,
  parseUnifiedDiff,
  readGateAllowlist,
  runGitDefault,
  runTrackerGate,
  scanLineForRuleHits,
  shannonEntropyPerChar,
  type GateReport,
} from "../gate.ts";
import { nodeScenario } from "./helpers/node-scenario.ts";
import extension, { runCommandTrackerGate } from "../index.ts";

const MANIFEST_CAPABILITIES = ["commands", "importers", "schema", "hooks", "preflight", "search"] as const;
const harnessPromise: Promise<ExtensionTestHarness> =
  createExtensionTestHarness(extension, { capabilities: [...MANIFEST_CAPABILITIES] });

test("staged content is scanned even when the working copy restores clean text", () => {
  const { root, git } = initGateRepo();
  try {
    const file = path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `id: pm-test-aabb\nbody: "${GH_TOKEN}"\n`);
    assert.equal(git(["add", ".agents/pm/issues/pm-test-aabb.toon"]).status, 0);
    fs.writeFileSync(file, original);
    assert.equal(runTrackerGate({ pmRoot: root }).verdict, "fail");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operational exclusions cannot hide staged files or nested item content", () => {
  const { root, git } = initGateRepo();
  try {
    for (const relative of ["locks/receipt.json", "issues/extensions/item.toon"]) {
      const file = path.join(root, ".agents/pm", relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `body: "${GH_TOKEN}"\n`);
    }
    assert.equal(git(["add", ".agents/pm/locks/receipt.json"]).status, 0);
    const report = runTrackerGate({ pmRoot: root });
    assert.equal(report.verdict, "fail");
    assert.equal(report.scanned_files, 2);
    assert.equal(report.findings.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history pointer syntax never suppresses credentials in a pointer", () => {
  const diff = `--- /dev/null\n+++ b/history/item.jsonl\n@@ -0,0 +1 @@\n+${JSON.stringify({ patch: [{ op: "add", path: `/metadata/${GH_TOKEN}`, value: "clean" }] })}\n`;
  const { root } = initGateRepo();
  try {
    const file = path.join(root, "proposal.diff");
    fs.writeFileSync(file, diff);
    const report = runTrackerGate({ pmRoot: root, diffFile: file });
    assert.equal(report.verdict, "fail");
    assert.ok(report.findings.some(finding => finding.rule === "github-token-classic"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an allowlisted value cannot hide another value in the same item field", () => {
  const { root } = initGateRepo();
  try {
    const other = "ghp_" + "B".repeat(36);
    fs.writeFileSync(path.join(root, GATE_ALLOWLIST_FILENAME), JSON.stringify({
      [sha256Hex(GH_TOKEN)]: { reason: "Reviewed synthetic value." },
    }));
    fs.writeFileSync(path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon"),
      `id: pm-test-aabb\nbody: "${GH_TOKEN} and ${other}"\n`);
    const report = runTrackerGate({ pmRoot: root });
    assert.equal(report.verdict, "fail");
    assert.equal(report.allowlisted, 1);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.hash, sha256Hex(other));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, truncated, and binary diffs fail closed", () => {
  for (const diff of ["garbage", "--- a/item\n+++ b/item\n@@ -0,0 +1,2 @@\n+body: clean",
    "diff --git a/item b/item\nBinary files a/item and b/item differ",
    "--- a/item\n+++ b/item\n@@ invalid @@\n+body: clean"]) {
    assert.throws(() => parseUnifiedDiff(diff), GateInputError);
  }
  assert.deepEqual(parseUnifiedDiff(""), []);
});

test("escaped tokens and Windows paths retain redacted findings", () => {
  const escapedToken = "\\u0067" + GH_TOKEN.slice(1);
  assert.ok(scanLineForRuleHits(escapedToken).some(hit => hit.rule === "github-token-classic"));
  assert.ok(scanLineForRuleHits(JSON.stringify(WIN_PATH)).some(hit => hit.rule === "windows-host-path"));
  assert.ok(scanLineForRuleHits("Authorization: Bearer " + "A".repeat(32)).some(hit => hit.rule === "bearer-token"));
  assert.deepEqual(scanLineForRuleHits("noreply@example.org"), []);
  // SSH clone URLs name the git service account, not a person.
  assert.deepEqual(scanLineForRuleHits("clone with `git@github.com:acme/widgets.git`"), []);
  assert.deepEqual(scanLineForRuleHits("git@gitlab.com:group/project.git"), []);
  assert.ok(scanLineForRuleHits("gitlover@example.org").some(hit => hit.rule === "email-address"));
  // Only the SSH URL shape is exempt: a git@ contact address is still personal data.
  for (const contact of ["Contact git@example.org", "write to git@example.org: thanks", "agit@github.com:x"]) {
    assert.ok(scanLineForRuleHits(contact).some(hit => hit.rule === "email-address"), contact);
  }
  assert.ok(scanLineForRuleHits("person-noreply@example.org").some(hit => hit.rule === "email-address"));
});

test("a present but unreadable optional allowlist fails without echoing its error", () => {
  assert.throws(() => readGateAllowlist("reviewed.json", false, () => {
    const failure = new Error(GH_TOKEN) as NodeJS.ErrnoException;
    failure.code = "EACCES";
    throw failure;
  }), err => err instanceof GateInputError && !err.message.includes(GH_TOKEN));
});

test("the SDK resolves custom tracker roots and scans symlink destinations", () => {
  const { root } = initGateRepo();
  try {
    const custom = path.join(root, "tracker");
    fs.renameSync(path.join(root, ".agents", "pm"), custom);
    fs.symlinkSync("/" + "srv/private/report", path.join(custom, "issues", "link"));
    const report = runTrackerGate({ pmRoot: custom });
    assert.equal(report.verdict, "fail");
    assert.ok(report.findings.some(f => f.rule === "absolute-host-path"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history pointers are structural but encoded history values are scanned", () => {
  const { root } = initGateRepo();
  try {
    const history = path.join(root, ".agents", "pm", "history");
    fs.mkdirSync(history);
    fs.writeFileSync(path.join(history, "pm-test-aabb.jsonl"), JSON.stringify({ patch: [
      { op: "replace", path: "/metadata/body", value: "clean" },
      { op: "add", path: "/metadata/comments", value: [{ text: GH_TOKEN }] },
    ] }) + "\n");
    const report = runTrackerGate({ pmRoot: root });
    assert.equal(report.verdict, "fail");
    assert.ok(report.findings.some(f => f.rule === "github-token-classic"));
    assert.ok(!report.findings.some(f => f.rule === "absolute-host-path"));
    fs.writeFileSync(path.join(history, "pm-test-aabb.jsonl"), "not json\n");
    assert.throws(() => runTrackerGate({ pmRoot: root }), GateInputError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Fake-but-well-formed malicious fixtures, assembled from parts so that no
// --- tracked blob holds a complete signature.
const GH_TOKEN = "ghp_" + "A".repeat(36);
const GH_PAT = "github_pat_" + "B".repeat(30);
const NPM_TOKEN = "npm_" + "C".repeat(36);
const AWS_KEY = "AKIA" + "D".repeat(16);
const SLACK_TOKEN = "xoxb-" + "E".repeat(24);
const OPENAI_KEY = "sk-" + "F".repeat(28) + "T3BlbkFJ" + "G".repeat(28);
const ANTHROPIC_KEY = "sk-ant-" + "H".repeat(30);
const HIGH_ENTROPY_SECRET = "Zj9kP2mQ7xW4" + "nB8vC5tR1sD";
const HOME_PATH = "/" + "home" + "/alice/report.txt";
const TMP_PATH = "/" + "tmp" + "/scratch.log";
const WIN_PATH = "C:" + "\\Users" + "\\bob" + "\\debug.log";
const PERSONAL_EMAIL = "alice.person@example.org";
const PHONE_US = "(555) 123-4567";
const PHONE_INTL = "+49 30 5557 9922";

/**
 * Create a real Git repository with a committed pm tracker, for collection tests.
 *
 * The gate's production path shells out to Git over the real working tree, so
 * the collection tests stage, modify, untrack, and delete real files in a real
 * repository rather than mocking subprocess output.
 *
 * @returns The workspace root and a helper to run Git inside it.
 */
function initGateRepo(): { root: string; git: (args: readonly string[]) => { stdout: string; status: number | null } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-gate-"));
  const git = (args: readonly string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  fs.mkdirSync(path.join(root, ".agents", "pm", "issues"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "pm", "settings.json"), '{"version":1}\n');
  fs.writeFileSync(
    path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon"),
    'id: pm-test-aabb\ntitle: "Baseline item"\nbody: "clean body"\n',
  );
  assert.strictEqual(git(["init", "-b", "main"]).status, 0, "git init failed");
  assert.strictEqual(git(["config", "user.name", "Gate Fixture"]).status, 0);
  assert.strictEqual(git(["config", "user.email", "fixture@example.invalid"]).status, 0);
  assert.strictEqual(git(["add", ".agents/pm"]).status, 0);
  assert.strictEqual(git(["commit", "-m", "baseline"]).status, 0, "baseline commit failed");
  return { root, git };
}

/** Run the registered `github gate` command through the real dispatch engine. */
async function runGateCommand(
  pmRoot: string,
  options: Record<string, unknown> = {},
): Promise<GateReport> {
  const ext = await harnessPromise;
  const result = await ext.runCommand({ command: "github gate", options, global: { json: true }, pmRoot });
  assert.strictEqual(result.handled, true, "the gate command must be registered");
  return result.result as GateReport;
}

// ---------------------------------------------------------------------------
// Rule battery — the scanner fires on every listed credential, personal-data,
// and host-path shape, and stays silent on prose, timestamps, and no-reply
// addresses.
// ---------------------------------------------------------------------------

test("scanner fires on every high-confidence credential signature", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["github-token-classic", `use ${GH_TOKEN} now`],
    ["github-token-fine-grained", `token ${GH_PAT}`],
    ["npm-token", `publish with ${NPM_TOKEN}`],
    ["aws-access-key-id", `export AWS_ACCESS_KEY_ID=${AWS_KEY}`],
    ["slack-token", `slack ${SLACK_TOKEN}`],
    ["slack-webhook", "https://hooks.slack.com/" + "services/T12345678/B12345678/" + "A".repeat(24)],
    ["openai-api-key", `key ${OPENAI_KEY}`],
    ["anthropic-api-key", `key ${ANTHROPIC_KEY}`],
    ["openai-project-key", "key " + "sk-proj-" + "I".repeat(30)],
    ["openai-service-account-key", "key " + "sk-svcacct-" + "I".repeat(30)],
    ["private-key-block", "-----BEGIN " + "RSA PRIVATE KEY-----"],
  ];
  for (const [rule, line] of cases) {
    const hits = scanLineForRuleHits(line);
    assert.ok(
      hits.some((hit) => hit.rule === rule),
      `${rule} should fire on its signature`,
    );
  }
});

test("bearer rule detects credentials including letter-only values", () => {
  assert.deepStrictEqual(
    scanLineForRuleHits("Authorization: Bearer " + "aB3cD9eFg1hA7bC2dE4fG").map((hit) => hit.rule),
    ["bearer-token"],
  );
  assert.deepStrictEqual(scanLineForRuleHits("Use Bearer authentication everywhere"), []);
});

test("personal-data rules: emails and phone numbers, with no-reply exemption", () => {
  assert.deepStrictEqual(
    scanLineForRuleHits(`contact ${PERSONAL_EMAIL} today`).map((hit) => hit.rule),
    ["email-address"],
  );
  assert.deepStrictEqual(
    scanLineForRuleHits("1153461+unbraind@users.noreply.github.com"),
    [],
    "a GitHub no-reply identity is exempt",
  );
  assert.deepStrictEqual(
    scanLineForRuleHits(`call ${PHONE_US} please`).map((hit) => hit.rule),
    ["phone-number"],
  );
  assert.deepStrictEqual(
    scanLineForRuleHits(`call ${PHONE_INTL} please`).map((hit) => hit.rule),
    ["phone-number"],
    "the two phone shapes collapse to one deduped finding",
  );
  // An ISO timestamp is 3-2-2-digit groups, never a phone shape.
  assert.deepStrictEqual(scanLineForRuleHits("2026-10-05T06:04:48.192Z"), []);
});

test("host-path rule flags host-identifying roots, not slash commands, links or API routes", () => {
  const rulesOf = (line: string): string[] => scanLineForRuleHits(line).map((hit) => hit.rule);
  for (const clean of ["/assign @someone", "/label bug", "please `/approve`", "see [docs](/docs/setup.md)", "GET /api/v1 returns 404", "my /homework folder"]) {
    assert.deepStrictEqual(rulesOf(clean), [], clean);
  }
  for (const leak of ["at /" + "home/someone/project", "cd /" + "Users/someone", "read /" + "etc/passwd", "under /" + "root", "mounted (/" + "mnt/data)"]) {
    assert.deepStrictEqual(rulesOf(leak), ["absolute-host-path"], leak);
  }
});

test("host-path rules: absolute paths, windows paths, and home usernames", () => {
  assert.deepStrictEqual(
    scanLineForRuleHits(`crash at ${HOME_PATH}`).map((hit) => hit.rule),
    ["absolute-host-path"],
  );
  assert.deepStrictEqual(
    scanLineForRuleHits(`log at ${TMP_PATH}`).map((hit) => hit.rule),
    ["absolute-host-path"],
  );
  assert.deepStrictEqual(
    scanLineForRuleHits(`log at ${WIN_PATH}`).map((hit) => hit.rule),
    ["windows-host-path"],
  );
  assert.deepStrictEqual(
    scanLineForRuleHits("see ~" + "alice/report.txt").map((hit) => hit.rule),
    ["home-username"],
  );
  // Anonymous home, prose approximations, and URLs stay clean.
  assert.deepStrictEqual(scanLineForRuleHits("see ~/report.txt"), []);
  assert.deepStrictEqual(scanLineForRuleHits("roughly ~most users hit this"), []);
  assert.deepStrictEqual(scanLineForRuleHits("https://example.com/root/path"), []);
});

test("high-entropy assignment rule fires only on secret-shaped values", () => {
  assert.strictEqual(isHighEntropySecretAssignment("API_TOKEN", HIGH_ENTROPY_SECRET), true);
  assert.strictEqual(isHighEntropySecretAssignment("api_key", HIGH_ENTROPY_SECRET), true);
  assert.strictEqual(isHighEntropySecretAssignment("private_key", HIGH_ENTROPY_SECRET), true);
  // Prose values never carry secret identifiers or entropy.
  assert.strictEqual(isHighEntropySecretAssignment("description", "Refuse incomplete pm item corpora"), false);
  assert.strictEqual(isHighEntropySecretAssignment("API_TOKEN", "the production deploy token"), false);
  // Structured values (timestamps, UUIDs) are excluded even under secret names.
  assert.strictEqual(isHighEntropySecretAssignment("created_at", "2026-10-05T06:04:48.192Z"), false);
  assert.strictEqual(
    isHighEntropySecretAssignment("request_id", "a1b2c3d4-e5f6-7890-abcd-ef0123456789"),
    false,
  );
  // A non-secret identifier never fires, however random the value.
  assert.strictEqual(isHighEntropySecretAssignment("sort_key", HIGH_ENTROPY_SECRET), false);
  assert.strictEqual(isHighEntropySecretAssignment("API_TOKEN", "short"), false);
  assert.deepStrictEqual(
    scanLineForRuleHits(`token: "${HIGH_ENTROPY_SECRET}"`).map((hit) => hit.rule),
    ["high-entropy-assignment"],
  );
});

test("shannon entropy separates random from structured text", () => {
  assert.ok(shannonEntropyPerChar(HIGH_ENTROPY_SECRET) >= 3.9);
  assert.ok(shannonEntropyPerChar("2026-10-05T06:04:48.192Z") < 3.9);
  assert.strictEqual(shannonEntropyPerChar(""), 0);
});

// ---------------------------------------------------------------------------
// Diff parsing + attribution
// ---------------------------------------------------------------------------

test("parseUnifiedDiff attributes item id and toon fields, and skips removed lines", () => {
  const diff = [
    "diff --git a/.agents/pm/issues/pm-x1.toon b/.agents/pm/issues/pm-x1.toon",
    "index 111..222 100644",
    "--- a/.agents/pm/issues/pm-x1.toon",
    "+++ b/.agents/pm/issues/pm-x1.toon",
    "@@ -1,2 +1,5 @@",
    " id: pm-x1",
    '-title: "old"',
    '+title: "New title"',
    `+body: "token ${GH_TOKEN}"`,
    "+notes[1]{created_at,author,text}:",
    `+  "2026-01-01T00:00:00Z",alice,"see ${GH_TOKEN}"`,
    "\\ No newline at end of file",
    "diff --git a/.agents/pm/history/pm-x1.jsonl b/.agents/pm/history/pm-x1.jsonl",
    "--- /dev/null",
    "+++ b/.agents/pm/history/pm-x1.jsonl",
    "@@ -0,0 +1,2 @@",
    `+{"op":"add","path":"/metadata/body","value":"mail ${PERSONAL_EMAIL}"}`,
    `+{"op":"add","path":"/metadata/id","value":"pm-x1"}`,
  ].join("\n");

  const files = parseUnifiedDiff(diff);
  assert.strictEqual(files.length, 2, "one entry per changed file");

  const toon = files[0]!;
  assert.strictEqual(toon.filePath, ".agents/pm/issues/pm-x1.toon");
  assert.strictEqual(toon.itemId, "pm-x1");
  const fields = toon.addedLines.map((line) => line.field);
  assert.deepStrictEqual(fields, ["title", "body", "notes", "notes"]);
  assert.ok(
    toon.addedLines.every((line) => !line.text.startsWith("-")),
    "removed lines never enter the change",
  );

  const history = files[1]!;
  assert.strictEqual(history.itemId, "pm-x1", "the id is read from the first added jsonl line");
});

test("parseUnifiedDiff attributes jsonl hits to the enclosing patch field", () => {
  const historyDiff = [
    "--- /dev/null",
    "+++ b/.agents/pm/history/pm-x2.jsonl",
    "@@ -0,0 +1 @@",
    `+{"op":"add","path":"/metadata/body","value":"crash ${HOME_PATH}"}`,
  ].join("\n");
  const files = parseUnifiedDiff(historyDiff);
  assert.strictEqual(files.length, 1);
  const report = runTrackerGate({
    pmRoot: "/unused-workspace",
    diffFile: "synthetic.patch",
    dependencies: {
      runGit: () => ({ ok: false, stdout: "", stderr: "no default allowlist outside a repo" }),
      readFileSync: () => historyDiff,
    },
  });
  assert.strictEqual(report.verdict, "fail");
  const finding = report.findings[0]!;
  assert.strictEqual(finding.item_id, "pm-x2");
  assert.strictEqual(finding.field, "body");
  assert.strictEqual(finding.rule, "absolute-host-path");
});

test("attributeToonFields tracks the enclosing top-level section", () => {
  const fields = attributeToonFields([
    { text: "id: pm-x1", added: false },
    { text: "notes[1]{created_at,author,text}:", added: false },
    { text: '  "2026-01-01T00:00:00Z",alice,"text"', added: true },
    { text: "", added: true },
    { text: "body:", added: true },
  ]);
  assert.deepStrictEqual(fields, ["id", "notes", "notes", "notes", "body"]);
});

test("scanLineForRuleHits reports every rule firing on one line without dedupe at line level", () => {
  const digitBearingToken = "ghp_" + "A9".repeat(18);
  const hits = scanLineForRuleHits(`Authorization: Bearer ${digitBearingToken}`);
  assert.ok(hits.some((hit) => hit.rule === "bearer-token"), "the bearer shape fires when the value mixes digits");
  assert.ok(hits.some((hit) => hit.rule === "github-token-classic"), "the token shape fires independently");
});

// ---------------------------------------------------------------------------
// Git change collection on a real repository
// ---------------------------------------------------------------------------

test("tracker file names that look like pathspec magic are still scanned", { skip: process.platform === "win32" && "colons and parentheses are not valid Windows file names" }, () => {
  // git reads a leading ":(attr:x)" and glob characters as pathspec magic
  // unless told to take paths literally. Tracker paths always start with a
  // directory today, which keeps the magic inert; the gate passes
  // --literal-pathspecs so that holds for every layout, and this guards it.
  const { root, git } = initGateRepo();
  try {
    for (const name of [":(attr:x)pm-test-magic.toon", "pm-test-[ab].toon"]) {
      fs.writeFileSync(path.join(root, ".agents", "pm", "issues", name), `id: pm-test-magic\nbody: "${GH_TOKEN}"\n`);
      assert.equal(git(["--literal-pathspecs", "add", `.agents/pm/issues/${name}`]).status, 0);
    }
    const report = runTrackerGate({ pmRoot: root });
    assert.strictEqual(report.verdict, "fail");
    assert.strictEqual(report.findings.filter((finding) => finding.rule === "github-token-classic").length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectTrackerChange scans staged, working, and untracked tracker files", () => {
  const { root, git } = initGateRepo();
  try {
    const tracker = path.join(root, ".agents", "pm");
    // Staged: a new committed-adjacent file added to the index.
    fs.writeFileSync(path.join(tracker, "issues", "pm-test-ccdd.toon"), 'id: pm-test-ccdd\ntitle: "Staged"\n');
    assert.strictEqual(git(["add", ".agents/pm/issues/pm-test-ccdd.toon"]).status, 0);
    // Working: modify a tracked file without staging — a secret assignment.
    fs.writeFileSync(
      path.join(tracker, "issues", "pm-test-aabb.toon"),
      `id: pm-test-aabb\ntitle: "Baseline item"\nsecret: "${HIGH_ENTROPY_SECRET}"\n`,
    );
    // Untracked: brand new file, never staged.
    fs.writeFileSync(
      path.join(tracker, "issues", "pm-test-eeff.toon"),
      `id: pm-test-eeff\ntitle: "Untracked"\nbody: "contact ${PERSONAL_EMAIL}"\n`,
    );

    const report = runTrackerGate({ pmRoot: root });
    assert.strictEqual(report.source, "git");
    assert.strictEqual(report.scanned_files, 3, "staged + working + untracked");
    assert.strictEqual(report.verdict, "fail");
    const rules = report.findings.map((finding) => finding.rule).sort();
    assert.deepStrictEqual(rules, ["email-address", "high-entropy-assignment"]);
    const emailFinding = report.findings.find((finding) => finding.rule === "email-address")!;
    assert.strictEqual(emailFinding.item_id, "pm-test-eeff");
    assert.strictEqual(emailFinding.field, "body");
    const entropyFinding = report.findings.find((finding) => finding.rule === "high-entropy-assignment")!;
    assert.strictEqual(entropyFinding.item_id, "pm-test-aabb");
    assert.strictEqual(entropyFinding.field, "secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectTrackerChange ignores deletions, non-tracker files, and operational subpaths", () => {
  const { root, git } = initGateRepo();
  try {
    fs.rmSync(path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon"));
    // Outside the tracker path entirely.
    fs.writeFileSync(path.join(root, "notes.txt"), `token ${GH_TOKEN}\n`);
    // Operational subpath: a transient lock and an installed extension file.
    fs.mkdirSync(path.join(root, ".agents", "pm", "locks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents", "pm", "locks", "sync.lock"), `{"pid":1,"token":"${GH_TOKEN}"}\n`);
    fs.mkdirSync(path.join(root, ".agents", "pm", "extensions", "pm-github"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agents", "pm", "extensions", "pm-github", "README.md"),
      `token ${GH_TOKEN}\n`,
    );
    const report = runTrackerGate({ pmRoot: root });
    assert.strictEqual(report.verdict, "pass", "deletions and excluded paths contribute nothing");
    assert.strictEqual(report.scanned_files, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectTrackerChange fails closed outside a Git work tree and on Git failure", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-plain-"));
  try {
    assert.throws(() => runTrackerGate({ pmRoot: plain }), GateInputError);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
  const failingGit = () => ({ ok: false, stdout: "", stderr: "boom" });
  assert.throws(
    () => runTrackerGate({ pmRoot: "/unused", dependencies: { runGit: failingGit } }),
    GateInputError,
  );
  const { root } = initGateRepo();
  try {
    const statusFailingGit = (cwd: string, args: readonly string[]) =>
      args.includes("status")
        ? { ok: false, stdout: "", stderr: "status boom" }
        : { ok: true, stdout: fs.realpathSync(root), stderr: "" };
    assert.throws(
      () => runTrackerGate({ pmRoot: root, dependencies: { runGit: statusFailingGit } }),
      /git status failed/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an oversized untracked tracker file fails closed instead of being skipped", () => {
  const { root } = initGateRepo();
  try {
    const huge = path.join(root, ".agents", "pm", "issues", "pm-test-huge.toon");
    fs.writeFileSync(huge, "x".repeat(8 * 1024 * 1024 + 1));
    assert.throws(() => runTrackerGate({ pmRoot: root }), GateInputError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the default runner is the real git subprocess contract", () => {
  const { root } = initGateRepo();
  try {
    const ok = runGitDefault(root, ["rev-parse", "--show-toplevel"]);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(path.resolve(ok.stdout.trim()), path.resolve(root));
    const failed = runGitDefault(root, ["nope"]);
    assert.strictEqual(failed.ok, false);
    assert.ok(failed.stderr.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("collectTrackerChange fails closed when the tracker escapes the Git work tree", () => {
  const { root } = initGateRepo();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pm-gate-elsewhere-"));
  try {
    assert.throws(() => runTrackerGate({ pmRoot: root, dependencies: {
      runGit: () => ({ ok: true, stdout: elsewhere, stderr: "" }),
    } }), (err: unknown) => err instanceof GateInputError && /escapes the Git work tree/.test(err.message));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a vanished untracked tracker file fails closed", () => {
  const { root } = initGateRepo();
  try {
    assert.throws(() => runTrackerGate({
      pmRoot: root,
      dependencies: {
        runGit: (cwd, args) => {
          if (args.includes("rev-parse")) return { ok: true, stdout: `${cwd}\n`, stderr: "" };
          if (args.includes("status")) {
            return {
              ok: true,
              stdout: "?? .agents/pm/issues/ghost.toon\0",
              stderr: "",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    }), GateInputError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Git diff failure for one changed tracker file fails the whole gate", () => {
  const { root } = initGateRepo();
  try {
    assert.throws(
      () =>
        runTrackerGate({
          pmRoot: root,
          dependencies: {
            runGit: (cwd, args) => {
              if (args.includes("rev-parse")) return { ok: true, stdout: `${cwd}\n`, stderr: "" };
              if (args.includes("status")) {
                return { ok: true, stdout: " M .agents/pm/settings.json\0", stderr: "" };
              }
              return { ok: false, stdout: "", stderr: "diff boom" };
            },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof GateInputError);
        assert.match(err.message, /git diff failed/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a jsonl line without an id statement falls back to the history file name", () => {
  const files = parseUnifiedDiff(
    [
      "--- /dev/null",
      "+++ b/.agents/pm/history/pm-x3.jsonl",
      "@@ -0,0 +1 @@",
      '+{"op":"add","path":"/metadata/body","value":"clean"}',
    ].join("\n"),
  );
  assert.strictEqual(files[0]!.itemId, "pm-x3");
});

// ---------------------------------------------------------------------------
// Allowlist — content-hash keyed, with a written justification required
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("an allowlisted content hash is suppressed and counted, never widened to a pattern", () => {
  const allowlistDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-allowlist-"));
  const allowlist = path.join(allowlistDirectory, "allowlist.json");
  fs.writeFileSync(
    allowlist,
    JSON.stringify({
      [sha256Hex(GH_TOKEN)]: { reason: "Reviewed: synthetic fixture token in test corpus." },
    }),
  );
  try {
    const diff = [
      "--- /dev/null",
      "+++ b/.agents/pm/issues/pm-allow.toon",
      "@@ -0,0 +2,2 @@",
      `+body: "token ${GH_TOKEN}"`,
      `+body: "token ${NPM_TOKEN}"`,
    ].join("\n");
    const report = runTrackerGate({
      pmRoot: "/unused",
      diffFile: "synthetic.diff",
      allowlistFile: allowlist,
      dependencies: { readFileSync: (filePath: string) => (filePath.endsWith(".json") ? fs.readFileSync(filePath, "utf-8") : diff) },
    });
    assert.strictEqual(report.verdict, "fail", "only the reviewed hash is suppressed");
    assert.strictEqual(report.allowlisted, 1);
    assert.deepStrictEqual(
      report.findings.map((finding) => finding.rule),
      ["npm-token"],
    );
  } finally {
    fs.rmSync(allowlistDirectory, { recursive: true, force: true });
  }
});

test("readGateAllowlist fails closed on every malformed shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-allowlist-"));
  try {
    const write = (name: string, content: string): string => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      return file;
    };
    // Valid file with a reason parses.
    const valid = write("valid.json", JSON.stringify({ [sha256Hex("x")]: { reason: "ok" } }));
    assert.strictEqual(readGateAllowlist(valid, true).size, 1);
    // Missing optional is an empty allowlist; missing required fails.
    const missing = path.join(dir, "missing.json");
    assert.strictEqual(readGateAllowlist(missing, false).size, 0);
    assert.throws(() => readGateAllowlist(missing, true), GateInputError);
    // Non-JSON, non-object, bad key, and missing reason each fail closed.
    assert.throws(() => readGateAllowlist(write("bad.json", "{nope"), true), GateInputError);
    assert.throws(() => readGateAllowlist(write("array.json", "[]"), true), GateInputError);
    assert.throws(() => readGateAllowlist(write("key.json", JSON.stringify({ nothash: { reason: "x" } })), true), GateInputError);
    assert.throws(() => readGateAllowlist(write("noreason.json", JSON.stringify({ [sha256Hex("x")]: {} })), true), GateInputError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the default repository-root allowlist is consulted when present", () => {
  const { root, git } = initGateRepo();
  try {
    fs.writeFileSync(
      path.join(root, GATE_ALLOWLIST_FILENAME),
      JSON.stringify({ [sha256Hex(PERSONAL_EMAIL)]: { reason: "Reviewed: public support address in docs item." } }),
    );
    fs.writeFileSync(
      path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon"),
      `id: pm-test-aabb\ntitle: "Baseline item"\nbody: "mail ${PERSONAL_EMAIL}"\n`,
    );
    const report = runTrackerGate({ pmRoot: root });
    assert.strictEqual(report.verdict, "pass");
    assert.strictEqual(report.allowlisted, 1);
    assert.strictEqual(report.allowlist_path, GATE_ALLOWLIST_FILENAME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed inputs and report shape
// ---------------------------------------------------------------------------

test("an unreadable explicit diff file fails closed with a wrapped error", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-plain-"));
  try {
    assert.throws(
      () =>
        runTrackerGate({
          pmRoot: plain,
          diffFile: "missing.patch",
          dependencies: {
            runGit: () => ({ ok: false, stdout: "", stderr: "not a repo" }),
            readFileSync: () => {
              throw new Error("ENOENT");
            },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof GateInputError);
        assert.match(err.message, /could not read the proposed tracker change/);
        return true;
      },
    );
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("a clean change passes and the report is machine-readable without matched content", () => {
  const { root } = initGateRepo();
  try {
    const report = runTrackerGate({ pmRoot: root });
    assert.strictEqual(report.verdict, "pass");
    assert.deepStrictEqual(report.findings, []);
    assert.strictEqual(report.scanned_files, 0);
    assert.strictEqual(report.added_lines, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("formatGateReport findings never contain the matched content", () => {
  const { root } = initGateRepo();
  try {
    fs.writeFileSync(
      path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon"),
      `id: pm-test-aabb\ntitle: "Baseline item"\nbody: "token ${GH_TOKEN}"\n`,
    );
    const report = runTrackerGate({ pmRoot: root });
    const lines = formatGateReport(report).join("\n");
    assert.ok(!lines.includes(GH_TOKEN), "the report must never echo the secret");
    assert.match(lines, /github-token-classic/);
    assert.match(lines, /pm-test-aabb/);
    assert.match(lines, /body/);
    assert.match(lines, /sha256:[0-9a-f]{12}…/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registered command — real dispatch through the extension test harness
// ---------------------------------------------------------------------------

test("pm github gate passes a clean repo through the registered command", async () => {
  const { root } = initGateRepo();
  try {
    const report = await runGateCommand(root);
    assert.strictEqual(report.verdict, "pass");
    assert.strictEqual(report.source, "git");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pm github gate fails non-zero on a finding, without echoing the secret", async () => {
  const ext = await harnessPromise;
  const { root } = initGateRepo();
  try {
    fs.writeFileSync(
      path.join(root, ".agents", "pm", "issues", "pm-test-aabb.toon"),
      `id: pm-test-aabb\ntitle: "Baseline item"\nbody: "token ${GH_TOKEN}"\n`,
    );
    await assert.rejects(
      ext.runCommand({ command: "github gate", global: { json: true }, pmRoot: root }),
      (err: unknown) => {
        assert.strictEqual((err as { exitCode?: number }).exitCode, 1);
        const message = (err as Error).message;
        assert.match(message, /FAIL/);
        assert.match(message, /github-token-classic/);
        assert.match(message, /pm-test-aabb/);
        assert.ok(!message.includes(GH_TOKEN), "the error message must never echo the secret");
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pm github gate fails closed outside a Git work tree", async () => {
  const ext = await harnessPromise;
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-plain-"));
  try {
    await assert.rejects(
      ext.runCommand({ command: "github gate", global: { json: true }, pmRoot: plain }),
      (err: unknown) => {
        assert.strictEqual((err as { exitCode?: number }).exitCode, 1);
        assert.match((err as Error).message, /not inside a Git work tree/);
        return true;
      },
    );
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("pm github gate scans an explicit --diff file and honors --allowlist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-diff-"));
  try {
    const diffFile = path.join(dir, "change.patch");
    fs.writeFileSync(
      diffFile,
      ["--- /dev/null", "+++ b/.agents/pm/issues/pm-diff.toon", "@@ -0,0 +1 @@", `+body: "mail ${PERSONAL_EMAIL}"`].join("\n"),
    );
    await assert.rejects(
      runGateCommand("/unused", { diff: diffFile }),
      (err: unknown) => {
        assert.strictEqual((err as { exitCode?: number }).exitCode, 1);
        assert.match((err as Error).message, /email-address/);
        return true;
      },
    );
    const allowlistFile = path.join(dir, "allow.json");
    fs.writeFileSync(
      allowlistFile,
      JSON.stringify({ [sha256Hex(PERSONAL_EMAIL)]: { reason: "Reviewed: support address in import docs." } }),
    );
    const report = await runGateCommand("/unused", { diff: diffFile, allowlist: allowlistFile });
    assert.strictEqual(report.verdict, "pass");
    assert.strictEqual(report.source, "diff");
    assert.strictEqual(report.allowlisted, 1);
    assert.strictEqual(report.scanned_files, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Coverage additions: default-dependency collection, rename provenance tokens,
// within-file dedupe, context-only hunks, raw git failure surfaces, and the
// command's non-JSON report surface.
// ---------------------------------------------------------------------------

test("collectTrackerChange runs against a real work tree with the default dependencies", () => {
  const { root } = initGateRepo();
  try {
    fs.writeFileSync(path.join(root, ".agents", "pm", "issues", "pm-test-ccdd.toon"),
      `id: pm-test-ccdd\ntitle: "Fresh item"\nbody: "clean body"\n`);
    const files = collectTrackerChange(path.join(root, ".agents", "pm"));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.filePath, path.join(".agents", "pm", "issues", "pm-test-ccdd.toon"));
    assert.equal(files[0]!.itemId, "pm-test-ccdd");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rename entry's original path is skipped and the new path is scanned", () => {
  const { root, git } = initGateRepo();
  try {
    const renamed = path.join(root, ".agents", "pm", "issues", "pm-test-ccdd.toon");
    assert.equal(git(["mv", ".agents/pm/issues/pm-test-aabb.toon", ".agents/pm/issues/pm-test-ccdd.toon"]).status, 0);
    fs.writeFileSync(renamed, `id: pm-test-ccdd\ntitle: "Renamed item"\nbody: "token ${GH_TOKEN}"\n`);
    const report = runTrackerGate({ pmRoot: root });
    assert.equal(report.verdict, "fail");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.item_id, "pm-test-ccdd");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("identical repeated findings inside one file are reported once", () => {
  const diff = [
    "--- a/.agents/pm/issues/pm-dedupe.jsonl",
    "+++ b/.agents/pm/issues/pm-dedupe.jsonl",
    "@@ -0,0 +1,2 @@",
    `+{"patch":[{"op":"add","path":"/body","value":"token ${GH_TOKEN}"}]}`,
    `+{"patch":[{"op":"add","path":"/body","value":"token ${GH_TOKEN}"}]}`,
  ].join("\n");
  const { root } = initGateRepo();
  try {
    const file = path.join(root, "repeat.diff");
    fs.writeFileSync(file, diff);
    const report = runTrackerGate({ pmRoot: root, diffFile: file });
    assert.equal(report.verdict, "fail");
    assert.equal(report.findings.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a context-only hunk contributes a scanned file with no added lines", () => {
  const diff = [
    "--- a/.agents/pm/issues/pm-context.toon",
    "+++ b/.agents/pm/issues/pm-context.toon",
    "@@ -1,1 +1,1 @@",
    " title: \"Unchanged\"",
  ].join("\n");
  const { root } = initGateRepo();
  try {
    const file = path.join(root, "context.diff");
    fs.writeFileSync(file, diff);
    const report = runTrackerGate({ pmRoot: root, diffFile: file });
    assert.equal(report.verdict, "pass");
    assert.equal(report.scanned_files, 1);
    assert.equal(report.added_lines, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a finding outside any item is rendered as no item and unknown field", () => {
  const diff = [
    "--- /dev/null",
    "+++ b/notes/general.md",
    "@@ -0,0 +1 @@",
    `+shared token ${GH_TOKEN}`,
  ].join("\n");
  const { root } = initGateRepo();
  try {
    const file = path.join(root, "noitem.diff");
    fs.writeFileSync(file, diff);
    const report = runTrackerGate({ pmRoot: root, diffFile: file });
    assert.equal(report.verdict, "fail");
    const lines = formatGateReport(report).join("\n");
    assert.match(lines, /\(no item\)/);
    assert.match(lines, /github-token-classic/);
    assert.ok(!lines.includes(GH_TOKEN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gate-scoped collaborator error passes through unwrapped", () => {
  const { root } = initGateRepo();
  try {
    // An injected reader that raises its own gate-prefixed diagnostic must
    // surface verbatim rather than being re-labelled as unreadable input.
    assert.throws(() => runTrackerGate({
      pmRoot: root,
      diffFile: path.join(root, "change.patch"),
      dependencies: { readFileSync: () => { throw new Error("pm github gate: injected reader failure"); } },
    }), (err: unknown) => err instanceof Error && /injected reader failure/.test(err.message));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runGitDefault reports a missing git executable without throwing", () => {
  // A child process with a PATH that cannot resolve git proves the raw runner
  // is fail-closed: ENOENT becomes ok:false with the spawn error in stderr.
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { runGitDefault } from ${JSON.stringify(new URL("../gate.ts", import.meta.url).href)};
    const result = runGitDefault(${JSON.stringify(path.resolve(os.tmpdir()))}, ["status"]);
    assert.equal(result.ok, false);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ENOENT/);
  `, { PATH: "" });
});

test("the registered gate command prints its report outside JSON mode", async () => {
  const ext = await harnessPromise;
  const { root } = initGateRepo();
  try {
    const { stderr, result } = await captureStderr(async () =>
      ext.runCommand({ command: "github gate", global: { json: false }, pmRoot: root }));
    assert.strictEqual((result as { result: GateReport }).result.verdict, "pass");
    assert.match(stderr.join("\n"), /pm github gate: PASS/);
    assert.match(stderr.join("\n"), /0 finding\(s\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the shared command gate redacts unexpected Git collaborator errors", () => {
  const { root } = initGateRepo();
  try {
    const original = runGitDefault;
    let topLevelCalls = 0;
    assert.throws(() => runCommandTrackerGate({ pmRoot: root, dependencies: {
      runGit: (cwd, args) => {
        if (args.join(" ") === "rev-parse --show-toplevel" && ++topLevelCalls === 2) throw new Error("private diagnostic fixture");
        return original(cwd, args);
      },
    } }), (error: unknown) => error instanceof Error && error.message === "pm github gate: scanner error; scan did not complete.");
    assert.throws(() => runCommandTrackerGate({ pmRoot: path.join(root, "missing") }), /pm github gate:/);
    assert.equal(runCommandTrackerGate({ pmRoot: root }).verdict, "pass");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GateInputError, formatGateReport, parseUnifiedDiff, runTrackerGate, scanLineForRuleHits } from "../gate.ts";

/** A real git and PM project for explicit proposals and planned-value scans. */
function repository(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-gate-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [command, args] of [
    ["git", ["init", "-q", "-b", "main"]],
    ["git", ["config", "user.name", "Fixture Bot"]],
    ["git", ["config", "user.email", "fixture@example.invalid"]],
    ["pm", ["--path", path.join(root, ".agents", "pm"), "init", "fixture"]],
    ["git", ["add", ".agents/pm"]],
    ["git", ["commit", "-qm", "Fixture baseline"]],
  ] as const) {
    const result = spawnSync(command, [...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

test("diff parsing accepts quoted filenames and deletion-only proposals", () => {
  const changed = parseUnifiedDiff('--- a/item.toon\n+++ "b/item.toon"\n@@ -1 +1 @@\n-title: Before\n+title: After\n');
  assert.deepEqual(changed, [{ filePath: "item.toon", itemId: "item", addedLines: [{ text: "title: After", field: "title" }] }]);
  assert.deepEqual(parseUnifiedDiff("--- a/item.toon\n+++ /dev/null\n@@ -1 +0,0 @@\n-title: Before\n"), []);
  assert.deepEqual(parseUnifiedDiff("--- a/item.toon\n+++ b/item.toon\n@@ -1,0 +1,0 @@\n\n"), []);
});

test("diff parsing rejects unreadable filenames and content outside or after a complete hunk", () => {
  for (const [diff, diagnostic] of [
    ['+++ "unterminated\n', /unreadable diff filename/],
    ["+++ b/item.toon\nbody: outside\n", /content outside a diff hunk/],
    ["+++ b/item.toon\n@@ -0,0 +1 @@\n+body: inside\n?invalid\n", /invalid unified diff content/],
  ] as const) assert.throws(() => parseUnifiedDiff(diff), diagnostic);
});

test("serialized escapes retain ordinary text and reject short phone lookalikes", () => {
  assert.deepEqual(scanLineForRuleHits("ordinary text\\"), []);
  assert.deepEqual(scanLineForRuleHits("+1 12 34 56"), []);
  assert.deepEqual(scanLineForRuleHits("escaped\\nline\\rreturn\\ttab"), []);
});

test("planned scans redact hostile item and field names in every report surface", t => {
  const root = repository(t);
  const token = "ghp_" + "A".repeat(36);
  const report = runTrackerGate({ pmRoot: root, plannedItems: [{ itemId: token, fields: { [token]: token } }] });
  assert.equal(report.verdict, "fail");
  assert.ok(report.findings.some(f => f.item_id === "" && f.field === "unknown"));
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!formatGateReport(report).join("\n").includes(token));
});

test("history patch attribution handles root pointers, metadata roots, and copy sources", t => {
  const root = repository(t);
  const token = "ghp_" + "B".repeat(36);
  const rows = [
    { patch: [{ op: "replace", path: "/", value: token }] },
    { patch: [{ op: "add", path: "/metadata", value: token }] },
    { patch: [{ op: "copy", path: "/metadata/body", from: "/metadata/title", value: [null, token] }] },
  ];
  const proposal = path.join(root, "proposal.diff");
  fs.writeFileSync(proposal, `--- /dev/null\n+++ b/history/item.jsonl\n@@ -0,0 +1,3 @@\n${rows.map(row => `+${JSON.stringify(row)}`).join("\n")}\n`);
  const report = runTrackerGate({ pmRoot: root, diffFile: proposal });
  assert.equal(report.verdict, "fail");
  assert.deepEqual(new Set(report.findings.map(f => f.field)), new Set(["unknown", "metadata", "body"]));
});

test("explicit diff failures preserve gate diagnostics and wrap other filesystem failures", t => {
  const root = repository(t);
  const proposal = path.join(root, "proposal.diff");
  fs.writeFileSync(proposal, '+++ "unterminated\n');
  assert.throws(() => runTrackerGate({ pmRoot: root, diffFile: proposal }), /unreadable diff filename/);
  fs.mkdirSync(path.join(root, "directory.diff"));
  assert.throws(() => runTrackerGate({ pmRoot: root, diffFile: path.join(root, "directory.diff") }), GateInputError);
});

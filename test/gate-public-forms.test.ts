// Public technical-forms corpora for the privacy gate (gh:unbraind/pm-github#193):
// the must-allow table proves every permitted form (procfs/sysfs interfaces,
// RFC 2606/6761 reserved-domain fixture addresses, the SSH git transport
// identity, GitHub-hosted runner workspaces and placeholder home segments)
// passes in plain-line, serialized and tracker-line modes plus the full gate,
// while the must-refuse table keeps every concrete home, root, temp,
// traversal-escape, encoded-escape, embedded-identity and contact-address
// shape fail-closed with its listed rule.
//
// Corpus rows are assembled from parts so no tracked blob ever holds a
// complete host-path shape; synthetic identities only.

import assert from "node:assert/strict";
import test from "node:test";

import { runTrackerGate, scanLineForRuleHits } from "../gate.ts";
import { PUBLIC_FORMS_MUST_ALLOW, PUBLIC_FORMS_MUST_REFUSE } from "./gate-public-forms-corpus.ts";

/** Render one corpus line as a serialized TOON tracker body line. */
const toonLine = (line: string): string => `body: ${JSON.stringify(line)}`;

/** Render one corpus line as a decoded history patch row. */
const jsonlLine = (line: string): string =>
  JSON.stringify({ patch: [{ op: "add", path: "/metadata/body", value: line }] });

/** Run the gate over an explicit synthetic diff with no default allowlist. */
function gateOverDiff(diffText: string) {
  return runTrackerGate({
    pmRoot: "/unused-workspace",
    diffFile: "synthetic.diff",
    dependencies: {
      runGit: () => ({ ok: false, stdout: "", stderr: "no default allowlist outside a repo" }),
      readFileSync: () => diffText,
    },
  });
}

test("must-allow corpus passes every public technical form in plain, serialized and tracker-line modes", () => {
  for (const row of PUBLIC_FORMS_MUST_ALLOW) {
    assert.deepStrictEqual(scanLineForRuleHits(row.line), [], row.id);
    assert.deepStrictEqual(scanLineForRuleHits(JSON.stringify(row.line)), [], row.id);
    assert.deepStrictEqual(scanLineForRuleHits(toonLine(row.line), true), [], row.id);
  }
});

test("must-refuse corpus keeps every host, temp, escape and contact shape fail-closed", () => {
  for (const row of PUBLIC_FORMS_MUST_REFUSE) {
    for (const [text, trackerLine] of [[row.line, false], [toonLine(row.line), true]] as const) {
      const hits = scanLineForRuleHits(text, trackerLine);
      assert.ok(hits.some((hit) => hit.rule === row.rule), `${row.id} must keep firing ${row.rule}`);
    }
  }
});

test("a synthetic toon tracker change with only public forms passes the full gate", () => {
  const added = PUBLIC_FORMS_MUST_ALLOW.map((row) => `+${toonLine(row.line)}`);
  const diff = ["--- /dev/null", "+++ b/.agents/pm/issues/pm-public-forms.toon",
    `@@ -0,0 +1,${added.length} @@`, ...added].join("\n");
  const report = gateOverDiff(diff);
  assert.equal(report.verdict, "pass");
  assert.equal(report.scanned_files, 1);
  assert.equal(report.added_lines, PUBLIC_FORMS_MUST_ALLOW.length);
  assert.deepEqual(report.findings, []);
});

test("a synthetic history change with only public forms passes the full gate", () => {
  const added = PUBLIC_FORMS_MUST_ALLOW.map((row) => `+${jsonlLine(row.line)}`);
  const diff = ["--- /dev/null", "+++ b/.agents/pm/history/pm-public-forms.jsonl",
    `@@ -0,0 +1,${added.length} @@`, ...added].join("\n");
  const report = gateOverDiff(diff);
  assert.equal(report.verdict, "pass");
  assert.equal(report.scanned_files, 1);
  assert.equal(report.added_lines, PUBLIC_FORMS_MUST_ALLOW.length);
  assert.deepEqual(report.findings, []);
});

test("a synthetic tracker change refuses every must-refuse row with its listed rule and item", () => {
  const files = PUBLIC_FORMS_MUST_REFUSE.map((row) => [
    "--- /dev/null",
    `+++ b/.agents/pm/issues/${row.id}.toon`,
    "@@ -0,0 +1 @@",
    `+${toonLine(row.line)}`,
  ].join("\n"));
  const report = gateOverDiff(files.join("\n"));
  assert.equal(report.verdict, "fail");
  for (const row of PUBLIC_FORMS_MUST_REFUSE) {
    assert.ok(
      report.findings.some((finding) => finding.item_id === row.id && finding.rule === row.rule),
      `${row.id} must produce ${row.rule} attributed to its own item`,
    );
  }
  // Findings never carry the matched content, so the report cannot echo any
  // corpus fixture — including the concrete home path it just refused.
  const serialized = JSON.stringify(report);
  for (const row of PUBLIC_FORMS_MUST_REFUSE) {
    if (row.refuseGroup === "concrete-home" || row.refuseGroup === "embedded-identity") {
      assert.ok(!serialized.includes(row.line), `${row.id} must not be echoed`);
    }
  }
});
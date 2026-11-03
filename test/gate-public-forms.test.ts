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

/** Extract the path-like tokens of a corpus line (a POSIX root slash, a tilde username, or a Windows drive path). */
const pathLikeTokens = (line: string): readonly string[] =>
  [...line.matchAll(/(?:[A-Za-z]:[\\/][^\s"'`),;\]]*|~[A-Za-z0-9._-]*\/[^\s"'`),;\]]*|\/[^\s"'`),;\]]*)/g)]
    .map((match) => match[0]);

/** POSIX path assembled from parts, so no tracked blob holds a complete shape. */
const posix = (...segments: readonly string[]): string => ["", ...segments].join("/");

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
  // corpus fixture — including the concrete home path it just refused. Check
  // the path-like token of EVERY must-refuse row (every refusal group), not
  // the whole corpus line (which contains prose the report never holds).
  const serialized = JSON.stringify(report);
  for (const row of PUBLIC_FORMS_MUST_REFUSE) {
    for (const token of pathLikeTokens(row.line)) {
      assert.ok(!serialized.includes(token), `${row.id} path token must not be echoed`);
    }
  }
  // The assertion must be able to fail: every host-path row yields at least
  // one token, and a report that DID carry one would contain it verbatim.
  for (const row of PUBLIC_FORMS_MUST_REFUSE) {
    if (["absolute-host-path", "windows-host-path", "home-username"].includes(row.rule)) {
      assert.ok(pathLikeTokens(row.line).length > 0, `${row.id} must yield a path-like token`);
    }
  }
  const homeRow = PUBLIC_FORMS_MUST_REFUSE.find((row) => row.id === "home-alice")!;
  const echoedToken = pathLikeTokens(homeRow.line)[0]!;
  assert.ok(JSON.stringify({ excerpt: echoedToken }).includes(echoedToken), "the no-echo assertion must be able to fail");
});

test("the delimiter check answers adversarial bracket chains in bounded time", () => {
  // Two pathological inputs for the path-behind-a-delimiter check: a chain of
  // repeated procfs-style segments each ending in a delimiter (exponential
  // under the recursive predecessor — measured at ~2.3x per segment, so the
  // 40-segment line does not finish), and one long bracket run (quadratic
  // under the predecessor — 934 ms at 20000 brackets). Both must stay far
  // below 200 ms and resolve to zero findings: every segment is public.
  const procSegment = posix("proc", "self", "x");
  const chain = "read " + (procSegment + ">").repeat(40);
  const bracketRun = "read " + procSegment + ">".repeat(20000);
  // A long run of delimiters that never start a path stays linear: no suffix is
  // copied or judged, and no segment end is searched twice (quadratic before).
  const colonRun = "read " + procSegment + ":".repeat(20000);
  for (const line of [chain, bracketRun, colonRun]) {
    const started = performance.now();
    const hits = scanLineForRuleHits(line);
    const elapsed = performance.now() - started;
    assert.deepStrictEqual(hits, []);
    assert.ok(elapsed < 200, `${line.length}-character adversarial line took ${elapsed.toFixed(1)} ms`);
  }
});

test("a long chain of delimiter-started public paths fails closed in linear time", () => {
  // Each delimiter-started path copies and judges the remaining suffix, so an
  // uncapped chain is quadratic (measured: 1.4 s at 1,000 paths and 13.4 s at
  // 4,000 before the cap). Past the cap the match fails closed, so a hostile
  // line costs at most the capped number of suffix judgments.
  const chain = "read " + Array.from({ length: 1000 }, () => posix("proc", "self", "status")).join(":");
  const started = performance.now();
  const hits = scanLineForRuleHits(chain);
  const elapsed = performance.now() - started;
  assert.deepStrictEqual(hits.map((hit) => hit.rule), ["absolute-host-path"]);
  assert.ok(elapsed < 1000, `${chain.length}-character delimiter chain took ${elapsed.toFixed(1)} ms`);
});
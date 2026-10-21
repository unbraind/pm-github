import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("bare-root JavaScript regexes stay clean while paths alongside or inside regexes are refused", () => {
  for (const method of ["test", "exec"]) {
    const source = `const paused = /private paused = true;/g.${method}(source);`;
    assert.deepEqual(scanLineForRuleHits(source), []);
    assert.deepEqual(scanLineForRuleHits(JSON.stringify(source)), []);
    assert.deepEqual(scanLineForRuleHits(source.replace("private ", "private   ")), []);
    assert.deepEqual(scanLineForRuleHits(`/private paused = true;/.${method}(source)`), []);
    assert.deepEqual(scanLineForRuleHits(`const re=/private paused = true;/.${method}(source)`), []);
    const leak = "/" + "private/fixture/report";
    assert.ok(scanLineForRuleHits(`${source} ${leak}`).some(hit => hit.matched === leak));
    assert.ok(scanLineForRuleHits(`const path = ${leak}/.${method}(source);`).some(hit => hit.rule === "absolute-host-path"));
  }
  for (const text of ["read /" + "private now", "read /" + "private", "const paused = /private paused = true;",
    'const path = "/' + 'home "; const re = /.test(source)',
    "cd /" + "home ; /.test(source)", "`/" + "home `; /.test(source)"]) {
    assert.ok(scanLineForRuleHits(text).some(hit => hit.rule === "absolute-host-path"));
  }
  // A malformed regex with long whitespace must still be refused. Keeping
  // the first space fixed-width avoids overlapping whitespace quantifiers.
  assert.ok(scanLineForRuleHits("const re = /private" + " ".repeat(100_000)).some(hit => hit.rule === "absolute-host-path"));
});

test("quoted host roots cannot use the regex exception in raw or serialized fields", () => {
  const root = "/" + "home";
  for (const quote of ['"', "'", "`"]) {
    for (const method of ["test", "exec"]) {
      const sources = [
        `const note = ${quote}path = ${root} sample/.${method}(source)${quote}`,
        `const first = /${quote}/.test(source); const note = ${quote}path = ${root} sample/.${method}(source)${quote}`,
        `const first = /[/${quote}]/.test(source); const note = ${quote}path = ${root} sample/.${method}(source)${quote}`,
        `const first = /[\\]${quote}]/.test(source); const note = ${quote}path = ${root} sample/.${method}(source)${quote}`,
        `const first = /${quote}/.test(source);\nconst note = ${quote}path = ${root} sample/.${method}(source)${quote}`,
        `const note = ${quote}escaped \\${quote} path = ${root} sample/.${method}(source)${quote}`,
        `const note = ${quote}escaped \\\\ path = ${root} sample/.${method}(source)${quote}`,
        `const note = ${quote}escaped ${"\\".repeat(3)}${quote} path = ${root} sample/.${method}(source)${quote}`,
      ];
      if (quote === "`") sources.push(`const note = \`first line\npath = ${root} sample/.${method}(source)\``);
      for (const source of sources) {
        for (const [text, trackerLine] of [[source, false], [JSON.stringify(source), false], [`body: ${JSON.stringify(source)}`, true]] as const) {
          const hit = scanLineForRuleHits(text, trackerLine).find(hit => hit.rule === "absolute-host-path");
          assert.ok(hit, text);
          assert.equal(hit.matched, root);
          assert.equal(hit.index, text.indexOf(root));
        }
      }
    }
  }
  // An invalid wrapper cannot grant a serialization exception.
  assert.ok(scanLineForRuleHits(`"path = ${root} sample/.test(source)`).some(hit => hit.matched === root));
});

test("serialized and fenced regex source keeps its original offsets and clean verdict", () => {
  const source = 'const label = "public"; const re = /private paused = true;/.test(source)';
  for (const [text, trackerLine] of [[source, false], [JSON.stringify(source), false], [`body: ${JSON.stringify(source)}`, true], [`\`\`\`js\n${source}\n\`\`\``, false]] as const) {
    assert.deepEqual(scanLineForRuleHits(text, trackerLine), []);
  }
  assert.deepEqual(scanLineForRuleHits('"ordinary string"  '), []);
  assert.deepEqual(scanLineForRuleHits("const first = /[\nconst re = /private paused = true;/.test(source)"), []);
  assert.deepEqual(scanLineForRuleHits('"bad\\q"'), []);
  assert.deepEqual(scanLineForRuleHits("'unfinished\nconst re = /private paused = true;/.test(source)"), []);
});

test("secret offsets identify the captured value through escapes", () => {
  const secret = "Zj9kP2mQ7xW4" + "nB8vC5tR1sD";
  for (const source of [`token = "${secret}"`, `  token: ${secret}`, `token = ${secret}; secret = ${secret}`]) {
    for (const text of [source, JSON.stringify(source), source.replace(secret[0]!, "\\u005a")]) {
      const hits = scanLineForRuleHits(text).filter(hit => hit.rule === "high-entropy-assignment");
      const starts = [...text.matchAll(/Zj9k|\\u005aj9k/g)].map(match => match.index);
      assert.deepEqual(hits.map(hit => hit.index), starts);
      assert.ok(hits.every(hit => hit.matched === secret));
    }
  }
});

test("home-username offsets exclude consumed delimiters through escapes", () => {
  const home = "~" + "fixture/report.txt";
  for (const text of [home, `see ${home}`, `path="${home}"`, `see \\u007e${home.slice(1)}`]) {
    const hit = scanLineForRuleHits(text).find(hit => hit.rule === "home-username")!;
    assert.equal(hit.matched, home);
    assert.equal(hit.index, text.includes(home) ? text.indexOf(home) : text.indexOf("\\u007e"));
  }
});

test("non-git tracker diff reports secret value offsets and refuses quoted regex-shaped paths", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-gate-plain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracker = path.join(root, ".agents", "pm");
  const init = spawnSync("pm", ["--path", tracker, "init", "fixture"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
  const secret = "Zj9kP2mQ7xW4" + "nB8vC5tR1sD";
  const hostRoot = "/" + "home";
  const home = "~" + "fixture/report.txt";
  const values = { body: `const note = "path = ${hostRoot} sample/.test(source)"`, title: `token = "${secret}"`, description: `see ${home}` };
  const rows = Object.entries(values).map(([field, value]) => JSON.stringify({ patch: [{ op: "add", path: `/metadata/${field}`, value }] }));
  const proposal = path.join(root, "proposal.diff");
  fs.writeFileSync(proposal, `--- /dev/null\n+++ b/history/item.jsonl\n@@ -0,0 +1,${rows.length} @@\n${rows.map(row => `+${row}`).join("\n")}\n`);
  const report = runTrackerGate({ pmRoot: root, diffFile: proposal });
  assert.equal(report.verdict, "fail");
  for (const [rule, field, matched] of [
    ["absolute-host-path", "body", hostRoot], ["high-entropy-assignment", "title", secret], ["home-username", "description", home],
  ] as const) {
    const hit = report.findings.find(hit => hit.rule === rule)!;
    assert.equal(hit.field, field);
    assert.equal(hit.match_offset, values[field].indexOf(matched));
    assert.equal(hit.hash, createHash("sha256").update(matched).digest("hex"));
  }
  for (const output of [JSON.stringify(report), formatGateReport(report).join("\n")]) {
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(home));
  }
});

test("TOON serialization context cannot be inferred from raw labelled field content", t => {
  const root = repository(t);
  const hostRoot = "/" + "home";
  const source = `body: "path = ${hostRoot} sample/.test(source)"`;
  for (const text of [source, JSON.stringify(source)]) {
    assert.ok(scanLineForRuleHits(text).some(hit => hit.matched === hostRoot));
  }
  const planned = runTrackerGate({ pmRoot: root, plannedItems: [{ itemId: "labelled", fields: { body: source } }] });
  assert.equal(planned.verdict, "fail");
  assert.equal(planned.findings[0]!.match_offset, source.indexOf(hostRoot));
  const serialized = `body: ${JSON.stringify(source)}`;
  const proposal = path.join(root, "proposal.diff");
  fs.writeFileSync(proposal, `--- /dev/null\n+++ b/labelled.toon\n@@ -0,0 +1 @@\n+${serialized}\n`);
  const persisted = runTrackerGate({ pmRoot: root, diffFile: proposal });
  assert.equal(persisted.verdict, "fail");
  assert.equal(persisted.findings[0]!.match_offset, serialized.indexOf(hostRoot));
});

test("match evidence gives decoded-field offsets and safe excerpts in JSON and workflow text", t => {
  const root = repository(t);
  const leak = "/" + "home/fixture-private/report";
  const token = "ghp_" + "D".repeat(36);
  const report = runTrackerGate({ pmRoot: root, plannedItems: [{ itemId: "github-issue-219", fields: {
    body: `See ${leak}`, title: token,
  } }] });
  const hit = report.findings.find(finding => finding.rule === "absolute-host-path")!;
  assert.equal(hit.field, "body");
  assert.equal(hit.item_id, "github-issue-219");
  assert.equal(hit.match_offset, 4);
  assert.equal(hit.excerpt, "/h***/…");
  assert.equal(report.findings.find(finding => finding.rule === "github-token-classic")!.excerpt, "[redacted]");
  const text = formatGateReport(report).join("\n");
  assert.ok(text.includes("github-issue-219 · body · absolute-host-path · offset:4 · /h***/…"));
  for (const surface of [JSON.stringify(report), text]) {
    assert.ok(!surface.includes(leak));
    assert.ok(!surface.includes("fixture-private"));
    assert.ok(!surface.includes(token));
  }
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

test("history object keys are scanned like values", t => {
  // A .toon line is scanned as raw text, so a credential used as a JSON object
  // key in history must fail the gate the same way.
  const root = repository(t);
  const token = "ghp_" + "C".repeat(36);
  const proposal = path.join(root, "proposal.diff");
  const row = { patch: [{ op: "add", path: "/metadata/x", value: { [token]: "clean" } }] };
  fs.writeFileSync(proposal, `--- /dev/null\n+++ b/history/item.jsonl\n@@ -0,0 +1 @@\n+${JSON.stringify(row)}\n`);
  const report = runTrackerGate({ pmRoot: root, diffFile: proposal });
  assert.equal(report.verdict, "fail");
  assert.ok(report.findings.some(f => f.rule === "github-token-classic"));
});

test("explicit diff failures preserve gate diagnostics and wrap other filesystem failures", t => {
  const root = repository(t);
  const proposal = path.join(root, "proposal.diff");
  fs.writeFileSync(proposal, '+++ "unterminated\n');
  assert.throws(() => runTrackerGate({ pmRoot: root, diffFile: proposal }), /unreadable diff filename/);
  fs.mkdirSync(path.join(root, "directory.diff"));
  assert.throws(() => runTrackerGate({ pmRoot: root, diffFile: path.join(root, "directory.diff") }), GateInputError);
});

test("diff hunk content keeps added plus-plus and removed minus-minus prefixes", () => {
  const files = parseUnifiedDiff("--- a/item.toon\n+++ b/item.toon\n@@ -1,2 +1,2 @@\n--- old content\n+++ public content\n body: clean\n");
  assert.deepEqual(files[0]!.addedLines, [{ text: "++ public content", field: "unknown" }]);
  const token = "ghp_" + "A".repeat(36);
  assert.ok(scanLineForRuleHits(parseUnifiedDiff(`+++ b/item.toon\n@@ -0,0 +1 @@\n+++ ${token}\n`)[0]!.addedLines[0]!.text).length > 0);
});

test("Git refuses invalid UTF-8 in both tracked and staged changes", t => {
  const root = repository(t);
  const file = path.join(root, ".agents/pm/notes.txt");
  fs.writeFileSync(file, "public baseline\n");
  assert.equal(spawnSync("git", ["add", ".agents/pm/notes.txt"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-qm", "Text baseline"], { cwd: root }).status, 0);
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28, 0x0a]));
  assert.throws(() => runTrackerGate({ pmRoot: root }), GateInputError);
  assert.equal(spawnSync("git", ["add", ".agents/pm/notes.txt"], { cwd: root }).status, 0);
  assert.throws(() => runTrackerGate({ pmRoot: root }), GateInputError);
});

test("Git tracker scanning canonicalizes a symlinked checkout including operational exclusions", t => {
  const root = repository(t);
  const alias = root + "-alias";
  fs.symlinkSync(root, alias, "dir");
  t.after(() => fs.unlinkSync(alias));
  fs.mkdirSync(path.join(root, ".agents/pm/locks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/pm/locks/transient"), "ghp_" + "A".repeat(36));
  fs.writeFileSync(path.join(root, ".agents/pm/notes.txt"), "public change\n");
  const report = runTrackerGate({ pmRoot: alias });
  assert.equal(report.verdict, "pass");
  assert.equal(report.scanned_files, 1);
});

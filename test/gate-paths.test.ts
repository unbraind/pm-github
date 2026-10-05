import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runTrackerGate, scanLineForRuleHits } from "../gate.ts";

test("a credential in a proposed tracker filename fails without exposing the filename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-gate-path-"));
  const token = "ghp_" + "A".repeat(36);
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    const tracker = path.join(root, ".agents", "pm");
    fs.mkdirSync(path.join(tracker, "issues"), { recursive: true });
    fs.writeFileSync(path.join(tracker, "settings.json"), "{}\n");
    fs.writeFileSync(path.join(tracker, "issues", `${token}.toon`), "body: public text\n");
    const report = runTrackerGate({ pmRoot: tracker });
    assert.equal(report.verdict, "fail");
    assert.deepEqual(report.findings.map(finding => [finding.item_id, finding.field, finding.rule]), [
      ["", "file_path", "github-token-classic"],
    ]);
    assert.equal(JSON.stringify(report).includes(token), false);
    assert.equal(spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" }).status, 128);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows drive paths accept both separators while public URLs stay clean", () => {
  for (const separator of ["/", "\\"]) {
    const value = "C:" + separator + ["Users", "fixture", "report.txt"].join(separator);
    assert.ok(scanLineForRuleHits(`path="${value}"`).some(hit => hit.rule === "windows-host-path"));
    assert.ok(scanLineForRuleHits(JSON.stringify(value)).some(hit => hit.rule === "windows-host-path"));
  }
  for (const value of ["https://github.com/acme/widgets/issues/1", "https://example.org/a", "C:relative.txt"]) {
    assert.equal(scanLineForRuleHits(value).some(hit => hit.rule === "windows-host-path"), false);
  }
});

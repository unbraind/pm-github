import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GateInputError, isHighEntropySecretAssignment, runTrackerGate, scanLineForRuleHits } from "../gate.ts";

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

test("camel-case secrets, Slack app credentials and labelled plain phones are gated", () => {
  const secret = "Zj9kP2mQ7xW4" + "nB8vC5tR1sD";
  for (const name of ["accessToken", "clientSecret", "privateKey", "APIToken", "AWSSecretAccessKey"]) {
    assert.equal(isHighEntropySecretAssignment(name, secret), true);
    assert.ok(scanLineForRuleHits(`${name} = "${secret}"`).some(hit => hit.rule === "high-entropy-assignment"));
  }
  for (const value of [secret + "2026-10-05", "a1b2c3d4-e5f6" + "-7890-abcd-ef0123456789"]) {
    assert.equal(isHighEntropySecretAssignment("api_key", value), true);
  }
  assert.equal(isHighEntropySecretAssignment("request_id", "a1b2c3d4-e5f6-7890-abcd-ef0123456789"), false);
  for (const prefix of ["xapp", "xoxc", "xoxd"]) {
    assert.ok(scanLineForRuleHits(prefix + "-" + "A".repeat(36)).some(hit => hit.rule === "slack-token"));
  }
  for (const value of ["phone: " + "415" + "555" + "0123", '"mobile": "' + "0044" + "7700" + "900123" + '"']) {
    assert.ok(scanLineForRuleHits(value).some(hit => hit.rule === "phone-number"));
  }
  for (const value of ["github-comment:" + "12345678901", "phone: 123456", "phone: 1-----2", "phone: 1234567890123456"]) {
    assert.equal(scanLineForRuleHits(value).some(hit => hit.rule === "phone-number"), false);
  }
});

test("untracked binary content and undecodable files fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-gate-encoding-"));
  const token = "ghp_" + "A".repeat(36);
  try {
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    const tracker = path.join(root, ".agents", "pm");
    fs.mkdirSync(path.join(tracker, "issues"), { recursive: true });
    fs.writeFileSync(path.join(tracker, "settings.json"), "{}\n");
    const file = path.join(tracker, "issues", "encoded.toon");
    for (const bytes of [Buffer.from("body: " + token, "utf16le"), Buffer.from([0xc3, 0x28]), Buffer.from("body: clean\0data")]) {
      fs.writeFileSync(file, bytes);
      assert.throws(() => runTrackerGate({ pmRoot: tracker }), error =>
        error instanceof GateInputError && !error.message.includes(token));
    }
    const diff = path.join(root, "proposal.patch");
    fs.writeFileSync(diff, Buffer.from([0xc3, 0x28]));
    assert.throws(() => runTrackerGate({ pmRoot: tracker, diffFile: diff }), GateInputError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

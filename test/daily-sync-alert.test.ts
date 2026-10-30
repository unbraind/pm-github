/** Execute the reusable alert's actual shell against a local GitHub CLI double. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface Step { name: string; run?: string; if?: string }
const workflow = parse(readFileSync(new URL("../.github/workflows/pm-github-sync.yml", import.meta.url), "utf8")) as {
  permissions?: unknown; jobs: Record<string, { needs?: string; if?: string; permissions?: unknown; steps: Step[] }>;
};
const alert = workflow.jobs["sync-status-issue"]!;

test("failure alert deduplicates, updates safely and closes on recovery; API failures never create duplicates", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-alert-"));
  try {
    const receipt = join(root, "body");
    const number = join(root, "number");
    writeFileSync(join(root, "gh"), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "api --paginate")
    if [[ "$3" == *'/issues?'* ]]; then
      [[ "\${LOOKUP_FAIL:-0}" == 0 ]] || exit 1
      if [[ -f "$ALERT_NUMBER" ]] && [[ "$3" == *state=all* || "$(cat "$ALERT_NUMBER")" == open ]]; then
        printf '{"number":7,"title":"Daily gated issue sync is failing","state":"%s"}\\n' "$(cat "$ALERT_NUMBER")"
      fi
      printf '{"number":9,"title":"Unrelated issue"}\\n'
    else
      [[ "\${JOBS_FAIL:-0}" == 0 ]] || exit 1
      printf '%s\\n' "\${JOBS_JSON}"
    fi ;;
  "issue create"|"issue edit")
    [[ "\${WRITE_FAIL:-0}" == 0 ]] || exit 1
    echo "$2" >> "$ALERT_CALLS"
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --body-file ]]; then cp "$2" "$ALERT_RECEIPT"; break; fi
      shift
    done
    echo open > "$ALERT_NUMBER" ;;
  "issue close")
    [[ "\${WRITE_FAIL:-0}" == 0 ]] || exit 1
    echo close >> "$ALERT_CALLS"
    echo closed > "$ALERT_NUMBER" ;;
  "issue reopen")
    [[ "\${WRITE_FAIL:-0}" == 0 ]] || exit 1
    echo reopen >> "$ALERT_CALLS"
    echo open > "$ALERT_NUMBER" ;;
  *) exit 23 ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, PATH: root + delimiter + process.env.PATH, ALERT_NUMBER: number, ALERT_RECEIPT: receipt,
      ALERT_CALLS: join(root, "calls"), GITHUB_REPOSITORY: "fixture/project", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com", SYNC_RESULT: "failure", FAILURE_RULES: "absolute-host-path,email-address",
      JOBS_JSON: JSON.stringify({ name: "caller / gated-sync", steps: [{ name: "Gated GitHub to pm import", conclusion: "failure" }] }) };
    const shell = alert.steps[0]!.run!;
    const run = (changes: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync("bash", ["-c", shell], { cwd: root, env: { ...env, ...changes }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result;
    };
    run({ LOOKUP_FAIL: "1" });
    assert.equal(existsSync(number), false);
    run({ JOBS_FAIL: "1" });
    assert.equal(existsSync(number), false);
    run();
    assert.equal(readFileSync(receipt, "utf8"), "Failing step: Gated GitHub to pm import\nRun URL: https://github.com/fixture/project/actions/runs/42/attempts/2\nRules: absolute-host-path,email-address\n");
    run();
    assert.equal(readFileSync(join(root, "calls"), "utf8"), "create\nedit\n");
    run({ JOBS_JSON: JSON.stringify({ name: "gated-sync", steps: [{ name: "untrusted step text", conclusion: "failure" }] }) });
    assert.match(readFileSync(receipt, "utf8"), /^Failing step: gated-sync\n/);
    run({ SYNC_RESULT: "success", WRITE_FAIL: "1" });
    assert.equal(existsSync(number), true);
    run({ SYNC_RESULT: "success" });
    assert.equal(readFileSync(number, "utf8").trim(), "closed");
    run({ SYNC_RESULT: "success" });
    run({ WRITE_FAIL: "1" });
    assert.equal(readFileSync(number, "utf8").trim(), "closed");
    run();
    run({ WRITE_FAIL: "1" });
    assert.equal(readFileSync(join(root, "calls"), "utf8"), "create\nedit\nedit\nclose\nreopen\nedit\n");
    run({ FAILURE_RULES: "untrusted diagnostic text\nabsolute-host-path,unknown-rule" });
    assert.match(readFileSync(receipt, "utf8"), /Rules: absolute-host-path\n$/);
    assert.doesNotMatch(readFileSync(receipt, "utf8"), /untrusted|unknown-rule/);
    run({ JOBS_JSON: JSON.stringify({ name: "gated-sync", steps: [{ name: "Record safe failure rules", conclusion: "failure" }] }) });
    assert.match(readFileSync(receipt, "utf8"), /^Failing step: Record safe failure rules\n/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("alert runs after success and failure with caller-scoped permission inheritance", () => {
  assert.equal(alert.needs, "gated-sync");
  assert.match(alert.if!, /always\(\).*failure.*success/);
  assert.equal(workflow.permissions, undefined);
  assert.equal(alert.permissions, undefined);
  assert.ok(!alert.steps.some(step => step.name.includes("Checkout")));
});


test("failure-rule transport emits only enumerated identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-rule-output-"));
  try {
    const output = join(root, "outputs");
    writeFileSync(join(root, "pm-github-failure-rules"), "untrusted diagnostic\nemail-address\nunknown-rule\nabsolute-host-path\nemail-address\n");
    const shell = workflow.jobs["gated-sync"]!.steps.find(step => step.name === "Record safe failure rules")!.run!;
    const result = spawnSync("bash", ["-c", shell], { env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "rules=absolute-host-path,email-address\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

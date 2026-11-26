/** Execute the reusable alert's actual shell against a local GitHub CLI double. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "yaml";

interface Step { name: string; run?: string; if?: string }
const workflow = parse(readFileSync(new URL("../.github/workflows/pm-github-sync.yml", import.meta.url), "utf8")) as {
  permissions?: unknown; jobs: Record<string, { needs?: string; if?: string; permissions?: unknown; steps: Step[] }>;
};
const alert = workflow.jobs["sync-status-issue"]!;

const title = "Daily gated issue sync is failing";
const bot = "github-actions[bot]";
const marker = "<!-- pm-github-sync-status -->";

interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  user: { login: string };
  body?: string | null;
  pull_request?: object;
}

/** Serve synthetic issue pages and record every attempted mutation by number. */
function alertFixture(t: TestContext, issues: Issue[] = []) {
  const root = mkdtempSync(join(tmpdir(), "sync-alert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = join(root, "body");
  const number = join(root, "number");
  writeFileSync(join(root, "gh"), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "api --paginate")
    if [[ "$3" == *'/issues?'* ]]; then
      [[ "\${LOOKUP_FAIL:-0}" == 0 ]] || exit 1
      jq -c "$5" <<< "$ISSUES_JSON"
      if [[ -f "$ALERT_NUMBER" ]] && [[ "$3" == *state=all* || "$(cat "$ALERT_NUMBER")" == open ]]; then
        jq -n --arg title "$ALERT_TITLE" --arg login "$ALERT_BOT" --arg state "$(cat "$ALERT_NUMBER")" \\
          --rawfile body "$ALERT_RECEIPT" '[{number:7,$title,$state,user:{$login},$body}]' | jq -c "$5"
      fi
    else
      [[ "\${JOBS_FAIL:-0}" == 0 ]] || exit 1
      printf '%s\\n' "\${JOBS_JSON}"
    fi ;;
  "issue create"|"issue edit")
    [[ "\${WRITE_FAIL:-0}" == 0 ]] || exit 1
    if [[ "$2" == edit ]]; then
      echo "edit $3" >> "$ALERT_CALLS"
    else
      echo create >> "$ALERT_CALLS"
    fi
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --body-file ]]; then cp "$2" "$ALERT_RECEIPT"; break; fi
      shift
    done
    echo open > "$ALERT_NUMBER" ;;
  "issue close")
    [[ "\${WRITE_FAIL:-0}" == 0 ]] || exit 1
    echo "close $3" >> "$ALERT_CALLS"
    echo closed > "$ALERT_NUMBER" ;;
  "issue reopen")
    [[ "\${WRITE_FAIL:-0}" == 0 ]] || exit 1
    echo "reopen $3" >> "$ALERT_CALLS"
    echo open > "$ALERT_NUMBER" ;;
  *) exit 23 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: root + delimiter + process.env.PATH, ALERT_NUMBER: number, ALERT_RECEIPT: receipt,
    ALERT_CALLS: join(root, "calls"), GITHUB_STEP_SUMMARY: join(root, "summary"), ISSUES_JSON: JSON.stringify(issues),
    ALERT_TITLE: title, ALERT_BOT: bot, GITHUB_REPOSITORY: "fixture/project", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SERVER_URL: "https://github.com", SYNC_RESULT: "failure", FAILURE_RULES: "absolute-host-path,email-address",
    COMPATIBILITY_HINT: "",
    JOBS_JSON: JSON.stringify({ name: "caller / gated-sync", steps: [{ name: "Gated GitHub to pm import", conclusion: "failure" }] }) };
  const shell = alert.steps[0]!.run!;
  const run = (changes: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("bash", ["-c", shell], { cwd: root, env: { ...env, ...changes }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  return { run, receipt, number,
    calls: () => existsSync(env.ALERT_CALLS) ? readFileSync(env.ALERT_CALLS, "utf8").trim().split("\n") : [],
    summary: () => existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, "utf8") : "",
  };
}

test("failure alert deduplicates, updates safely and closes on recovery; API failures never create duplicates", t => {
  const { run, receipt, number, calls } = alertFixture(t);
  run({ LOOKUP_FAIL: "1" });
  assert.equal(existsSync(number), false);
  run({ JOBS_FAIL: "1" });
  assert.equal(existsSync(number), false);
  run();
  assert.equal(readFileSync(receipt, "utf8"), marker + "\n\nFailing step: Gated GitHub to pm import\nRun URL: https://github.com/fixture/project/actions/runs/42/attempts/2\nRules: absolute-host-path,email-address\n");
  run();
  assert.deepEqual(calls(), ["create", "edit 7"]);
  run({ JOBS_JSON: JSON.stringify({ name: "gated-sync", steps: [{ name: "untrusted step text", conclusion: "failure" }] }) });
  assert.match(readFileSync(receipt, "utf8"), /^<!-- pm-github-sync-status -->\n\nFailing step: gated-sync\n/);
  run({ SYNC_RESULT: "success", WRITE_FAIL: "1" });
  assert.equal(existsSync(number), true);
  run({ SYNC_RESULT: "success" });
  assert.equal(readFileSync(number, "utf8").trim(), "closed");
  run({ SYNC_RESULT: "success" });
  run({ WRITE_FAIL: "1" });
  assert.equal(readFileSync(number, "utf8").trim(), "closed");
  run();
  run({ WRITE_FAIL: "1" });
  assert.deepEqual(calls(), ["create", "edit 7", "edit 7", "close 7", "reopen 7", "edit 7"]);
  run({ FAILURE_RULES: "untrusted diagnostic text\nabsolute-host-path,unknown-rule" });
  assert.match(readFileSync(receipt, "utf8"), /Rules: absolute-host-path\n$/);
  assert.doesNotMatch(readFileSync(receipt, "utf8"), /untrusted|unknown-rule/);
  run({ JOBS_JSON: JSON.stringify({ name: "gated-sync", steps: [{ name: "Record safe failure rules", conclusion: "failure" }] }) });
  assert.match(readFileSync(receipt, "utf8"), /^<!-- pm-github-sync-status -->\n\nFailing step: Record safe failure rules\n/);
  run({ JOBS_JSON: JSON.stringify({ name: "gated-sync", steps: [{ name: "Confirm caller CI registration and summarize handoff", conclusion: "failure" }] }) });
  assert.match(readFileSync(receipt, "utf8"), /^<!-- pm-github-sync-status -->\n\nFailing step: Confirm caller CI registration and summarize handoff\n/);
});

test("failure alert names the host compatibility step without quoting its diagnostics", t => {
  const { run, receipt } = alertFixture(t);
  run({ JOBS_JSON: JSON.stringify({ name: "gated-sync", steps: [
    { name: "Check pm CLI host compatibility", conclusion: "failure", detail: "Untrusted diagnostic" },
  ] }) });
  assert.match(readFileSync(receipt, "utf8"), /^<!-- pm-github-sync-status -->\n\nFailing step: Check pm CLI host compatibility\n/);
  assert.doesNotMatch(readFileSync(receipt, "utf8"), /Untrusted diagnostic/);
});

test("failure alert leads with the validated preflight hint and refuses any other hint text", t => {
  const { run, receipt } = alertFixture(t);
  const plain = marker + "\n\nFailing step: Gated GitHub to pm import\nRun URL: https://github.com/fixture/project/actions/runs/42/attempts/2\nRules: absolute-host-path,email-address\n";
  const hint = "pm CLI 2026.11.24 is newer than the newest host this pm-github release was tested with (2026.11.22); continuing. If the apply step fails, move the workflow pin to a newer pm-github release.";
  const holdHint = "pm CLI 2026.11.24 is newer than the newest host this pm-github release was tested with (2026.11.22); continuing. If the apply step fails, remove or update the pm-github-version hold that selected pm-github 2026.11.15, or move the workflow pin to a newer pm-github release.";
  run({ COMPATIBILITY_HINT: hint });
  assert.equal(readFileSync(receipt, "utf8"), marker + "\n\n" + hint + "\n\n" + plain.slice(marker.length + 2));
  run({ COMPATIBILITY_HINT: holdHint });
  assert.equal(readFileSync(receipt, "utf8"), marker + "\n\n" + holdHint + "\n\n" + plain.slice(marker.length + 2));
  const prereleaseHoldHint = holdHint.replace("2026.11.15", "2026.11.25-1");
  run({ COMPATIBILITY_HINT: prereleaseHoldHint });
  assert.equal(readFileSync(receipt, "utf8"), marker + "\n\n" + prereleaseHoldHint + "\n\n" + plain.slice(marker.length + 2));
  const padded = hint.replace("(2026.11.22)", "(2026.11.022)");
  const unstable = hint.replace("pm CLI 2026.11.24", "pm CLI 2026.11.24-1");
  const holdPadded = holdHint.replace("selected pm-github 2026.11.15", "selected pm-github 2026.11.015");
  for (const untrusted of [
    "Untrusted diagnostic. " + hint, hint + "\nUntrusted second line", hint + " Untrusted suffix.", padded, unstable, holdPadded,
    "pm CLI 2026.11.24 is newer than the newest host this pm-github release was tested with (2026.11.22-unvalidated); continuing.",
    prereleaseHoldHint.replace("2026.11.25-1", "2026.11.25-beta"),
    prereleaseHoldHint.replace("pm CLI 2026.11.24", "pm CLI 2026.11.24-1"),
    prereleaseHoldHint.replace("(2026.11.22)", "(2026.11.22-1)"),
  ]) {
    run({ COMPATIBILITY_HINT: untrusted });
    assert.equal(readFileSync(receipt, "utf8"), plain, "only the preflight's exact hint grammar may enter the alert body");
  }
});

test("recovery closes only open owned alerts, including the legacy exact-title alert", t => {
  const fixture = alertFixture(t, [
    { number: 1, title, state: "open", user: { login: "person" }, body: marker },
    { number: 2, title, state: "open", user: { login: bot }, body: null },
    { number: 3, title: "Renamed alert", state: "open", user: { login: bot }, body: marker },
    { number: 4, title: "Unrelated bot issue", state: "open", user: { login: bot }, body: "Unrelated" },
    { number: 5, title, state: "closed", user: { login: bot }, body: marker },
    { number: 6, title, state: "open", user: { login: bot }, body: marker, pull_request: {} },
  ]);

  fixture.run({ SYNC_RESULT: "success" });
  assert.deepEqual(fixture.calls().sort(), ["close 2", "close 3"]);
  assert.match(fixture.summary(), /left 1 same-title issue\(s\) from other authors untouched/i);
});

for (const state of ["open", "closed"] as const) {
  test("failure leaves the " + state + " same-title issue from another author alone and creates a marked alert", t => {
    const fixture = alertFixture(t, [
      { number: 1, title, state, user: { login: "person" }, body: marker },
      { number: 2, title: "Unrelated bot issue", state: "open", user: { login: bot }, body: "" },
    ]);

    fixture.run();
    assert.deepEqual(fixture.calls(), ["create"]);
    assert.ok(readFileSync(fixture.receipt, "utf8").startsWith(marker + "\n\n"));
    assert.match(fixture.summary(), /left 1 same-title issue\(s\) from other authors untouched/i);
  });

  test("failure prefers the " + state + " marked bot alert over same-title issues", t => {
    const fixture = alertFixture(t, [
      { number: 1, title, state, user: { login: "person" }, body: marker },
      { number: 2, title, state: "open", user: { login: bot }, body: "Legacy alert" },
      { number: 3, title: "Renamed alert", state, user: { login: bot }, body: marker },
    ]);

    fixture.run();
    assert.deepEqual(fixture.calls(), state === "closed" ? ["reopen 3", "edit 3"] : ["edit 3"]);
    assert.ok(readFileSync(fixture.receipt, "utf8").startsWith(marker + "\n\n"));
    assert.match(fixture.summary(), /left 1 same-title issue\(s\) from other authors untouched/i);
  });
}

test("failure reopens and marks a legacy exact-title bot alert", t => {
  const fixture = alertFixture(t, [
    { number: 1, title, state: "closed", user: { login: "person" } },
    { number: 2, title, state: "closed", user: { login: bot }, body: "Legacy alert" },
  ]);

  fixture.run();
  assert.deepEqual(fixture.calls(), ["reopen 2", "edit 2"]);
  assert.ok(readFileSync(fixture.receipt, "utf8").startsWith(marker + "\n\n"));
});

test("caller documentation states the bot and marker ownership rule and the legacy fallback", () => {
  for (const file of ["README.md", "docs/sync-workflow-caller.yml", "docs/daily-sync-recovery.md"]) {
    const text = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.match(text, /github-actions\[bot\]/, file);
    assert.ok(text.includes(marker), file);
    assert.match(text, /legacy.*(exact|original) title/i, file);
  }
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

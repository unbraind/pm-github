/** Execute reusable closeout publication against real SDK trackers and isolated Git remotes. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { get, update } from "@unbrained/pm-cli/sdk";
import { bash, branch, cli, command, finish, fixture, repoRoot, setup, shell, sync, title, unpublished, workflow } from "./helpers/closeout-workflow.ts";

test("closeout contract keeps sync safety helpers, exact pins, env bindings and least privilege", () => {
  assert.match(workflow, /^on:\n  workflow_call:/m);
  assert.match(workflow, /group: pm-github-closeout-\$\{\{ github.repository \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: write\n      pull-requests: write\n      checks: read\n      actions: write/);
  assert.match(workflow, /SYNC_BRANCH: pm-github\/closeout/);
  assert.doesNotMatch(workflow, /inputs.sync-branch|persist-credentials: true/);
  for (const step of workflow.split("      - name: ").slice(1)) {
    const name = step.split("\n")[0]!;
    if (!step.includes("run:")) continue;
    assert.doesNotMatch(shell(name), /\$\{\{/);
  }
  for (const name of ["Validate npm project directory", "Install dependencies", "Require clean setup artifacts", "Isolate workflow setup artifacts", "Gate tracker and regenerated changelog", "Verify strict pm health"]) {
    assert.equal(shell(name), shell(name, sync), name);
  }
  // Sync adds rule receipts and installation-failure cleanup. Compare the
  // unchanged publication boundaries directly, rather than diagnostic wrappers.
  const scopes = [shell("Resolve sync commit scope"), shell("Resolve sync commit scope", sync)];
  assert.equal(scopes[0]!.split("report_workflow_failure()")[0], scopes[1]!.split("report_workflow_failure()")[0]);
  assert.equal(scopes[0]!.split("mapfile -t sync_scope")[1]!.split("restore_sync_setup()")[0],
    scopes[1]!.split("mapfile -t sync_scope")[1]!.split("restore_sync_setup()")[0]);
  for (const name of ["restore_sync_setup", "restore_workflow_setup_artifacts", "check_sync_setup_clean", "check_sync_scope", "check_sync_path"]) {
    const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m");
    const shared = scopes.map(source => pattern.exec(source)?.[0]);
    assert.ok(shared[0], name);
    assert.ok(shared[1], name);
    assert.equal(shared[0], shared[1], name);
  }
  const gates = scopes.map(source => /^gate_sync_change\(\) \{[\s\S]*?^\}/m.exec(source)![0]);
  assert.equal(gates[0]!.split(/  (?:if ! )?pm github gate/)[0], gates[1]!.split(/  (?:if ! )?pm github gate/)[0]);
  for (const source of gates) assert.ok(source.includes('pm github gate --diff "${RUNNER_TEMP}/pm-github-sync.patch" --json'));
  const install = shell("Install pinned pm-github extension", sync).split("\n");
  let previous = -1;
  for (const line of shell("Install pinned pm-github extension").split("\n").filter(Boolean)) {
    const index = install.indexOf(line, previous + 1);
    assert.ok(index > previous, line);
    previous = index;
  }
  assert.match(workflow, /--force-with-lease="refs\/heads\/\$\{SYNC_BRANCH\}:\$\{SYNC_LEASE\}"/);
  assert.match(workflow, /--since 1970-01-01 --apply --json/);
  for (const action of workflow.matchAll(/uses: (actions\/[^@]+)@([^\s]+)/g)) assert.match(action[2]!, /^[a-f0-9]{40}$/);
  const caller = readFileSync(join(repoRoot, "docs/closeout-workflow-caller.yml"), "utf8");
  assert.match(caller, /schedule:/);
  assert.match(caller, /workflow_dispatch:/);
  assert.match(caller, /npm-project-dir: "\."/);
  assert.match(caller, /@RELEASE_COMMIT_SHA/);
  assert.match(caller, /^permissions: \{\}$/m);
  assert.match(caller, /gated-closeout:\n    permissions:\n      contents: write\n      pull-requests: write\n      checks: read\n      actions: write/);
  assert.match(caller, /required-checks: \|\n        test \(22\)\n        test \(26\)/);
  assert.match(workflow, /REQUIRED_CHECKS: \$\{\{ inputs.required-checks \}\}/);
  assert.doesNotMatch(caller, /issues: read/);
});

test("schedule without repository payload resolves trunk; clean closeout opens one PR and repeat edits it", async () => fixture(async f => {
  f.env.SUMMARY_ROWS = "true";
  const baseHead = f.git("rev-parse", "HEAD");
  const first = await f.run([...setup, ...finish]);
  assert.equal(first.code, 0, first.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "closed");
  const published = f.git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
  assert.ok(published);
  assert.equal(f.git("ls-remote", "origin", "refs/heads/trunk").split(/\s/)[0], baseHead);
  const body = readFileSync(f.env.PR_BODY!, "utf8");
  assert.match(body, /blob\/trunk\/\.agents\/pm/);
  assert.match(body, /"action": "close"/);
  assert.match(body, /"other_repository": 1/);
  assert.doesNotMatch(body, /"code": "other_repository"/);
  assert.doesNotMatch(body, /"checks"|"reason"/);
  assert.match(f.git("show", `${published}:CHANGELOG.md`), /Verified delivery/);
  const second = await f.run([...setup, ...finish]);
  assert.equal(second.code, 0, second.out);
  const receipts = readFileSync(f.env.RECEIPTS!, "utf8");
  assert.equal(receipts.split("\n").filter(line => line.startsWith("pr create ")).length, 1);
  assert.equal(receipts.split("\n").filter(line => line.startsWith("pr edit 7 ")).length, 1);
  assert.equal(receipts.split("\n").filter(line => line.startsWith("workflow run ci.yml ")).length, 2);
  assert.ok(receipts.includes(`--title ${title}`));
}));

test("scheduled closeout follows verified numeric pagination with declared checks and publishes delivery", async () => fixture(async f => {
  Object.assign(f.env, { NUMERIC_PAGINATION: "true", PROTECTION_DENIED: "true", REQUIRED_CHECKS: "CI" });
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "closed");
  assert.equal(existsSync(f.env.PR_STATE!), true);
}));

test("malicious tracker acceptance criteria fails the final privacy gate before any remote write", async () => fixture(async f => {
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { acceptanceCriteria: "ghp_" + "A".repeat(36) }, { pmRoot: f.pmRoot, noExtensions: true });
  const result = await f.run(finish);
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /github-token-classic|fail/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

test("zero closes discards caller drift and creates no remote branch or PR", async () => fixture(async f => {
  f.env.NO_DELIVERY = "true";
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /no branch or PR/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
  assert.equal(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), "Caller changelog before closeout\n");
}));

test("permission-limited read token fails closed with a clear diagnostic", async () => fixture(async f => {
  f.env.READ_DENIED = "true";
  const result = await f.run([...setup, ...finish]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /::error::GitHub GET \/repos\/acme\/widgets\/pulls failed.*HTTP 403/);
  assert.equal(result.out.match(/::error::/g)?.length, 1);
  unpublished(f.git);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
  Object.assign(f.env, { READ_DENIED: "false", CHECKS_DENIED: "true" });
  const checks = await f.run(finish);
  assert.equal(checks.code, 0, checks.out);
  assert.match(readFileSync(f.env.PR_BODY!, "utf8"), /missing_evidence/);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
}));

test("SDK close validation keeps its full JSON receipt and reports the exact item and field", async () => fixture(async f => {
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { tags: "requires-review" }, { pmRoot: f.pmRoot, noExtensions: true });
  const policy = { id: "review-required", description: "Private policy prose", effect: "refuse",
    subject: { tags: ["requires-review"], operations: ["close"] }, rule: { kind: "require_fields", fields: ["reviewer"] } };
  command(f.root, cli, ["--path", f.pmRoot, "schema", "policy-put", policy.id, "--definition", JSON.stringify(policy)], f.env);
  command(f.root, cli, ["--path", f.pmRoot, "schema", "policy-mode", "refuse"], f.env);
  const result = await f.run(finish);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /::error::Closeout refused item .*PR #42:.*Supply required fields: reviewer/);
  assert.equal(result.out.match(/::error::/g)?.length, 1);
  assert.ok(!result.out.includes("Private policy prose"));
  assert.equal((JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as { failed: number }).failed, 1);
  unpublished(f.git);
}));

test("workflow refusal reporter emits one precise annotation and withholds private receipt values", async () => fixture(async f => {
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  const report = join(f.base, "failure.json");
  const error = join(f.base, "failure.err");
  const diff = join(f.base, "repeat.patch");
  const secret = "ghp_" + "A".repeat(36);
  for (const [payload, patch, expected] of [
    [{ plan: [{ item: f.id, pr: 42, missing_evidence: [{ code: "close_failed", reason: "SDK close refused: workflow_policy_refused. Supply required fields: reviewer." }] }] }, "", /item .*PR #42:.*reviewer/],
    [{ findings: [{ item_id: "github-issue-1", field: "body", rule: "absolute-host-path" }] }, "", /item github-issue-1, field body, rule absolute-host-path/],
    [{ reason: secret }, "", /\[redacted\]/],
    [{}, `diff --git a/.agents/pm/tasks/${f.id}.toon b/.agents/pm/tasks/${f.id}.toon\n-updated_at: before\n+updated_at: after`, /field updated_at/],
  ] as const) {
    writeFileSync(report, JSON.stringify(payload)); writeFileSync(error, ""); writeFileSync(diff, patch);
    const result = await bash('source "${RUNNER_TEMP}/pm-github-sync-scope.sh"\nreport_workflow_failure "$FAILURE_REPORT" "$FAILURE_ERROR" "$FAILURE_DIFF"', f.root,
      { ...f.env, FAILURE_REPORT: report, FAILURE_ERROR: error, FAILURE_DIFF: diff });
    assert.equal(result.code, 0, result.out);
    assert.equal(result.out.match(/::error::/g)?.length, 1, result.out);
    assert.match(result.out, expected);
    assert.ok(!result.out.includes(secret));
    unpublished(f.git);
  }
}));

test("PR-write and dispatch restrictions fail clearly and never alter the default branch", async () => {
  for (const denied of ["PR_DENIED", "DISPATCH_DENIED"]) await fixture(async f => {
    const head = f.git("rev-parse", "HEAD");
    f.env[denied] = "true";
    const result = await f.run([...setup, ...finish]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, denied === "PR_DENIED" ? /token requires contents:write and pull-requests:write/ : /token requires actions:write/);
    assert.equal(f.git("ls-remote", "origin", "refs/heads/trunk").split(/\s/)[0], head);
  });
});

test("default-branch guard refuses non-default refs and unresolved metadata before tracker edits", async () => {
  for (const mode of ["wrong-ref", "unresolved", "payload-fallback"]) await fixture(async f => {
    if (mode === "wrong-ref") f.env.RUN_REF = "refs/heads/feature";
    else f.env.API_DENIED = "true";
    if (mode === "payload-fallback") f.env.EVENT_DEFAULT_BRANCH = "trunk";
    const result = await f.run(["Require caller default branch"]);
    assert.equal(result.code, mode === "payload-fallback" ? 0 : 1, result.out);
    unpublished(f.git);
  });
});

test("contents-write denial rejects the leased push before PR creation", async () => fixture(async f => {
  writeFileSync(join(f.base, "remote.git/hooks/pre-receive"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const result = await f.run([...setup, ...finish]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /token requires contents:write/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

test("zero closes refuses caller-only tracker drift as an empty closeout PR", async () => fixture(async f => {
  f.env.NO_DELIVERY = "true";
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { title: "Caller observation without delivery" }, { pmRoot: f.pmRoot, noExtensions: true });
  const result = await f.run(finish);
  assert.equal(result.code, 0, result.out);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

test("behavioural revert: removing only the staged privacy scan publishes malicious tracker content", async () => fixture(async f => {
  const mutant = workflow.replace('pm github gate --diff "${RUNNER_TEMP}/pm-github-sync.patch" --json', ": # privacy scan removed");
  assert.notEqual(mutant, workflow);
  const prepared = await f.run(setup, mutant);
  assert.equal(prepared.code, 0, prepared.out);
  const secret = "ghp_" + "A".repeat(36);
  await update(f.id, { acceptanceCriteria: secret }, { pmRoot: f.pmRoot, noExtensions: true });
  const result = await f.run(finish, mutant);
  assert.equal(result.code, 0, result.out);
  const remoteItem = f.git("show", `refs/remotes/origin/${branch}:.agents/pm/tasks/${f.id}.toon`);
  assert.ok(remoteItem.includes(secret));
  assert.equal(existsSync(f.env.PR_STATE!), true);
}));

test("behavioural revert: removing only the no-op guard opens a PR with zero closes", async () => fixture(async f => {
  f.env.NO_DELIVERY = "true";
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { title: "Caller observation without delivery" }, { pmRoot: f.pmRoot, noExtensions: true });
  const mutant = workflow.replace('if [[ "${CLOSEOUT_CLOSED}" == 0 && "${CLOSEOUT_REVIEW:-0}" == 0 ]] || git diff --cached --quiet -- "${sync_scope[0]}" "${sync_scope[@]:2}"; then', "if false; then");
  assert.notEqual(mutant, workflow);
  const result = await f.run(finish, mutant);
  assert.equal(result.code, 0, result.out);
  assert.equal(existsSync(f.env.PR_STATE!), true);
  assert.equal((JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as { closed: number }).closed, 0);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
}));

test("closeout inputs reject cross-repo writes, floating pins, command injection and a default bot branch", async () => fixture(async f => {
  for (const [key, value] of [["REPOSITORY", "other/widgets"], ["PM_GITHUB_VERSION", "latest"],
    ["POST_CLOSEOUT_SCRIPT", "changelog:full; exit 0"], ["SYNC_BRANCH", "trunk"]]) {
    const saved = f.env[key];
    f.env[key] = value;
    const result = await f.run(["Require caller default branch", "Validate closeout inputs"]);
    assert.equal(result.code, 1, result.out);
    Object.assign(f.env, { [key]: saved });
    unpublished(f.git);
  }
  f.env.API_BRANCH = branch;
  f.env.RUN_REF = `refs/heads/${branch}`;
  const result = await f.run(["Require caller default branch", "Validate closeout inputs"]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /bot branch cannot be the caller default branch/);
}));

test("an explicit lease refuses a competing bot-branch writer", async () => fixture(async f => {
  const prepared = await f.run([...setup, ...finish.slice(0, 4)]);
  assert.equal(prepared.code, 0, prepared.out);
  f.git("push", "origin", `trunk:refs/heads/${branch}`);
  const competingHead = f.git("rev-parse", "trunk");
  const result = await f.run(finish.slice(4));
  assert.notEqual(result.code, 0);
  assert.match(result.out, /stale info|rejected/);
  assert.equal(f.git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0], competingHead);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

for (const mode of ["unlinked", "foreign", "terminal", "local", "incomplete", "unlinked-incomplete"]) {
  test(`unavailable evidence is scoped to local tracker refusals: ${mode}`, async () => fixture(async f => {
    f.env.CHECKS_DENIED = "true";
    if (mode.startsWith("unlinked")) f.env.NO_LINKS = "true";
    if (mode === "foreign") f.env.FOREIGN_LINK = "true";
    if (mode.includes("incomplete")) f.env.INCOMPLETE_MERGE = "true";
    if (mode === "terminal") await update(f.id, { status: "canceled" }, { pmRoot: f.pmRoot, noExtensions: true });
    const result = await f.run([...setup, ...finish]);
    assert.equal(result.code, 0, result.out);
    if (mode === "local") assert.match(readFileSync(f.env.PR_BODY!, "utf8"), /missing_evidence/);
    if (mode === "incomplete") {
      assert.match(readFileSync(f.env.PR_BODY!, "utf8"), /incomplete_merge/);
      assert.equal(f.env.HEAD_LOOKUPS, undefined);
    }
    if (mode !== "local" && mode !== "incomplete") unpublished(f.git);
    assert.equal(existsSync(f.env.PR_STATE!), mode === "local" || mode === "incomplete");
  }));
}

test("compact PR summary is privacy gated before the bot branch is published", async () => fixture(async f => {
  f.env.SUMMARY_ITEM = "ghp_" + "A".repeat(36);
  const result = await f.run([...setup, ...finish]);
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /github-token-classic/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

for (const mode of ["undeclared", "blank", "missing", "neutral", "skipped", "pending", "success", "metadata"]) {
  test(`required-check metadata boundary ${mode} uses the real workflow and command`, async () => fixture(async f => {
    f.env.PROTECTION_DENIED = mode === "metadata" ? "false" : "true";
    // A declared policy never replaces a complete readable policy.
    f.env.REQUIRED_CHECKS = mode === "undeclared" ? "" : mode === "blank" ? " \n\t\r\n " : mode === "missing" || mode === "metadata" ? "CI\nmissing" : "CI";
    if (["neutral", "skipped"].includes(mode)) f.env.HEAD_CONCLUSION = mode;
    if (mode === "pending") f.env.HEAD_STATUS = "queued";
    const before = readFileSync(join(f.pmRoot, "tasks", `${f.id}.toon`), "utf8");
    const result = await f.run([...setup, ...finish]);
    const report = JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as { closed: number; plan: { code: string }[] };
    const passes = mode === "success" || mode === "metadata";
    assert.equal(report.closed, passes ? 1 : 0);
    assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, passes ? "closed" : "in_progress");
    if (passes) {
      assert.equal(result.code, 0, result.out);
      assert.equal(existsSync(f.env.PR_STATE!), true);
      assert.notEqual(f.git("ls-remote", "origin", `refs/heads/${branch}`), "");
      const item = (await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item;
      assert.match(String(item.actual_result), mode === "metadata" ? /required checks satisfied/ : /caller-declared checks concluded success; repository required-check metadata was unavailable; successful head checks: CI/);
    } else {
      assert.equal(report.plan[0]!.code, "needs_review");
      assert.equal(result.code, 0, result.out);
      assert.equal(readFileSync(join(f.pmRoot, "tasks", `${f.id}.toon`), "utf8"), before);
      assert.equal(existsSync(f.env.PR_STATE!), true);
      assert.match(readFileSync(f.env.PR_BODY!, "utf8"), /"action": "needs_review"/);
      assert.doesNotMatch(readFileSync(f.env.PR_BODY!, "utf8"), /"action": "close"/);
    }
  }));
}

for (const [scenario, names, input] of [
  ["single name", ["CI / build"], "CI / build"],
  ["spaces parentheses and slashes", ["CI / build (linux)", "CI / lint"], "CI / build (linux)\nCI / lint"],
  ["fleet example", ["test (22)", "test (26)"], "test (22)\ntest (26)\n"],
  ["empty lines and trimming", ["test (22)", "test (26)"], "\n  test (22) \r\n \t\n\t test (26)\t\n\n"],
  ["literal shell names", ["$(id)", "CI / 'single' and \"double\" quotes", "$(touch injected)", "CI \\ * ? [ab]"], "$(id)\nCI / 'single' and \"double\" quotes\n$(touch injected)\nCI \\ * ? [ab]"],
] as const) {
  test(`newline required contexts ${scenario} survive the real workflow and command`, async () => fixture(async f => {
    f.env.PROTECTION_DENIED = "true";
    f.env.HEAD_NAMES = JSON.stringify(names);
    f.env.REQUIRED_CHECKS = input;
    const result = await f.run([...setup, "Close delivered tracker items"]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as { closed: number; checks: { rule: string; passed: string[] }[] };
    assert.equal(report.closed, 1);
    assert.equal(report.checks[0]!.rule, "declared");
    assert.deepEqual([...report.checks[0]!.passed].sort(), [...names].sort());
    assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "closed");
    assert.equal(existsSync(join(f.root, "injected")), false);
  }));
}


test("ambiguous deliveries open a review-only PR listing every candidate and leave the item open", async () => fixture(async f => {
  f.env.AMBIGUOUS = "true";
  f.env.APP_DEADLINE = String(Math.floor(Date.now() / 1000) + 600);
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
  const body = readFileSync(f.env.PR_BODY!, "utf8");
  assert.match(body, /"action": "needs_review"/);
  assert.match(body, /"candidates": \[\s*42,\s*43\s*\]/);
  assert.match(body, /closeout-review\.json/);
  assert.doesNotMatch(readFileSync(f.env.RECEIPTS!, "utf8"), /pr merge .*--auto/);
  assert.match(result.out, /automatic landing is disabled/);
  const published = f.git("show", `refs/remotes/origin/${branch}:.agents/pm/closeout-review.json`);
  assert.deepEqual(JSON.parse(published), { needs_review: [{ item: f.id, action: "needs_review", candidates: [42, 43] }] });
}));


test("earlier armed auto-merge is disabled before a later hold updates the reused PR", async () => fixture(async f => {
  f.env.APP_DEADLINE = String(Math.floor(Date.now() / 1000) + 600);
  const first = await f.run([...setup, ...finish]);
  assert.equal(first.code, 0, first.out);
  assert.equal(existsSync(f.env.AUTO_STATE!), true);
  f.env.AMBIGUOUS = "true";
  const second = await f.run([...setup, ...finish]);
  assert.equal(second.code, 0, second.out);
  assert.equal(existsSync(f.env.AUTO_STATE!), false);
  assert.equal(existsSync(f.env.ARMED_EDIT!), false, "held branch must be disarmed before updating its PR");
  assert.match(readFileSync(f.env.PR_BODY!, "utf8"), /Automatic merge is disabled because delivery attribution needs_review/);
  assert.match(readFileSync(f.env.RECEIPTS!, "utf8"), /pr merge 7 -R acme\/widgets --disable-auto/);
}));

test("informational parked-run failure preserves armed auto-merge through always cleanup", async () => fixture(async f => {
  f.env.APP_DEADLINE = String(Math.floor(Date.now() / 1000) + 600);
  f.env.RUN_LIST_DENIED = "true";
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Could not list approval-required runs/);
  assert.equal(existsSync(f.env.AUTO_STATE!), true, "informational failure must not revoke armed auto-merge");
  assert.equal(existsSync(f.env.ARMED_EDIT!), false);
  const calls = readFileSync(f.env.RECEIPTS!, "utf8");
  assert.match(calls, /pr merge 7 .*--auto --squash/);
  assert.equal(calls.split("\n").filter(line => line.startsWith("run list")).length, 1);
  assert.doesNotMatch(calls, /--disable-auto/);
}));

for (const mode of ["guard", "setup", "evidence", "privacy", "no-op", "empty-ci", "dispatch", "maintenance", "disable-denied"]) {
  test(`previous auto-merge is revoked on workflow exit: ${mode}`, async () => fixture(async f => {
    f.env.APP_DEADLINE = String(Math.floor(Date.now() / 1000) + 600);
    const first = await f.run([...setup, ...finish]);
    assert.equal(first.code, 0, first.out);
    assert.equal(existsSync(f.env.AUTO_STATE!), true);
    if (mode === "guard") f.env.RUN_REF = "refs/heads/feature";
    if (mode === "setup") f.env.NPM_PROJECT_DIR = "../outside";
    if (mode === "evidence") f.env.READ_DENIED = "true";
    if (mode === "privacy") f.env.SUMMARY_ITEM = "ghp_" + "A".repeat(36);
    if (mode === "no-op") f.env.NO_DELIVERY = "true";
    if (mode === "empty-ci") f.env.CI_WORKFLOWS = "";
    if (mode === "dispatch") f.env.DISPATCH_DENIED = "true";
    if (mode === "disable-denied") f.env.DISABLE_DENIED = "true";
    const priorBranch = f.git("ls-remote", "origin", `refs/heads/${branch}`);
    // A required head lookup failure remains fatal; parked-run reporting is informational.
    const source = mode === "maintenance" ? workflow.replace('head_sha="$(git rev-parse HEAD)"',
      'head_sha="$(git rev-parse --verify refs/heads/missing-fixture-head || exit 1)"') : workflow;
    if (mode === "maintenance") assert.notEqual(source, workflow, "inject the failure at the production head lookup");
    const second = await f.run([...setup, ...finish], source);
    assert.equal(second.code, ["no-op", "empty-ci"].includes(mode) ? 0 : 1, second.out);
    assert.equal(existsSync(f.env.AUTO_STATE!), mode === "disable-denied");
    assert.equal(existsSync(f.env.ARMED_EDIT!), false);
    if (mode === "disable-denied") assert.equal(f.git("ls-remote", "origin", `refs/heads/${branch}`), priorBranch);
  }));
}


test("confirmed unmerged references cannot block publication of a unique merged delivery", async () => fixture(async f => {
  f.env.AMBIGUOUS = "true";
  f.env.UNMERGED_COMPETITOR = "true";
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "closed");
  const body = readFileSync(f.env.PR_BODY!, "utf8");
  assert.match(body, /"action": "close"/);
  assert.doesNotMatch(body, /"action": "needs_review"|"code": "incomplete_merge"/);
  assert.match(body, /"not_merged": 1/);
}));

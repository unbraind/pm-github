/** Exercise the exact reusable dispatch shell with real Git and receipt-only GitHub commands. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");

/** Extract the final executable step, including every function used by production. */
function maintenance(kind: string): string {
  return stepShell(kind, "Dispatch caller CI and report parked runs");
}

/** Read one executable block without interpreting GitHub expression bindings. */
function stepShell(kind: string, name: string): string {
  const workflow = readFileSync(join(root, `.github/workflows/pm-github-${kind}.yml`), "utf8");
  return workflow.split(`      - name: ${name}\n`)[1]!.split("      - name: ")[0]!.split("        run: |\n")[1]!
    .split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
}

/** Reject runner-waiting operations regardless of the surrounding loop spelling. */
function assertNoRunnerWaits(shell: string): void {
  assert.doesNotMatch(shell, /\bsleep\b/, "no in-job wait may remain");
  assert.doesNotMatch(shell, /for \(\(attempt/, "no poll loop may remain");
  assert.doesNotMatch(shell, /\bgh\s+(?:[^;\n]*?\s)?run\s+(?:watch|view)\b|check-runs|check-suites|\bgh\s+pr\s+checks\b[^\n]*--watch/, "no caller-run polling command may remain");
  assert.doesNotMatch(shell, /gh pr view|compare\/|update-branch/, "no PR-state polling may remain");
}

/** Model only the remote GitHub API; branch update performs a real merge against a real remote. */
function fixture(run: (f: { dir: string; env: NodeJS.ProcessEnv; receipts: () => string; execute: (kind: string) => ReturnType<typeof spawnSync> }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bot-pr-"));
  const bin = join(dir, "bin");
  const env: NodeJS.ProcessEnv & { RECEIPTS: string } = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com",
    APP_DEADLINE: "1700002400", REPOSITORY: "acme/widgets", DEFAULT_BRANCH: "trunk", SYNC_BRANCH: "automation/proposal", SYNC_PUBLISHED: "true", SYNC_PR_NUMBER: "7", CI_WORKFLOWS: "ci.yml codeql.yml",
    GITHUB_ENV: join(dir, "job-env"), RECEIPTS: join(dir, "receipts"), STATE: join(dir, "state"), PATH: bin + ":" + process.env.PATH };
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  try {
    mkdirSync(bin); mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    for (const name of ["ci", "codeql"]) writeFileSync(join(dir, `.github/workflows/${name}.yml`), "on:\n  pull_request:\n  workflow_dispatch:\n");
    git("init", "-q", "-b", "trunk"); git("add", ".github"); git("commit", "-qm", "Caller base");
    git("init", "--bare", "-q", join(dir, "remote.git")); git("remote", "add", "origin", join(dir, "remote.git")); git("push", "-q", "origin", "trunk");
    git("switch", "-qc", "automation/proposal"); git("commit", "--allow-empty", "-qm", "Proposal");
    let releaseCreated = false;
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s HEAD=%s\\n' "$*" "$(git rev-parse HEAD)" >> "$RECEIPTS"
case "$1 $2" in
  'workflow run') exit "\${DISPATCH_DENIED:-0}" ;;
  'pr merge')
    if [[ "\${AUTO_DENIED:-0}" != 0 ]]; then
      printf 'pull request auto-merge is disabled\\n' >&2
      exit "\${AUTO_DENIED}"
    fi ;;
  'run list') printf '%s\\n' "\${PARKED_URL:-}"; exit "\${PARKED_READ_DENIED:-0}" ;;
  'api repos/acme/widgets')
    [[ "\${SETTING_READ_DENIED:-0}" == 0 ]] || exit 1
    printf '%s\\n' "\${AUTO_ALLOWED:-true}" ;;
  'api repos/acme/widgets/branches/'*)
    [[ "\${PROTECTION_READ_DENIED:-0}" == 0 ]] || exit 1
    printf '%s\\n' "\${PROTECTED:-true}" ;;
  'pr view')
    if [[ "\${PR_READ_FAILURE:-none}" != none ]]; then
      if [[ "\${PR_READ_FAILURE}" == always || ! -f "$STATE.pr-read" ]]; then
        touch "$STATE.pr-read"; exit 1
      fi
    fi
    if [[ "\${BEHIND:-false}" == true && ! -f "$STATE" ]]; then
      printf '{"number":7,"state":"OPEN","headRefOid":"%s","mergeStateStatus":"%s"}' "$(git rev-parse HEAD)" "\${MERGE_STATE:-BEHIND}"
    elif [[ "\${BEHIND:-false}" == true && ! -f "$STATE.done" ]]; then
      touch "$STATE.done"
      printf '{"number":7,"state":"OPEN","headRefOid":"%s","mergeStateStatus":"BLOCKED"}' "$(git rev-parse HEAD)"
    elif [[ "\${BLOCKED:-false}" == true ]]; then
      printf '{"number":7,"state":"OPEN","headRefOid":"%s","mergeStateStatus":"BLOCKED"}' "$(git rev-parse HEAD)"
    else printf '{"state":"MERGED"}'; fi ;;
  'api repos/acme/widgets/compare/'*)
    if [[ "\${COMPARE_READ_FAILURE:-none}" != none ]]; then
      if [[ "\${COMPARE_READ_FAILURE}" == always || ! -f "$STATE.compare-read" ]]; then
        touch "$STATE.compare-read"; exit 1
      fi
    fi
    if [[ "\${INVALID_ANCESTRY:-false}" == true ]]; then printf 'invalid';
    else git rev-list --count HEAD..origin/trunk; fi ;;
  'api --method')
    [[ "$*" == *"expected_head_sha=$(git rev-parse HEAD)"* ]] || exit 9
    git fetch -q origin trunk
    git merge -q --no-edit origin/trunk
    touch "$STATE" ;;
  *) exit 8 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, "date"), '#!/usr/bin/env bash\nprintf "%s\\n" "${FAKE_NOW:-1700000000}"\n', { mode: 0o755 });
    writeFileSync(join(bin, "sleep"), '#!/usr/bin/env bash\nprintf "sleep %s\\n" "$*" >> "$RECEIPTS"\nexit 0\n', { mode: 0o755 });
    run({ dir, env, receipts: () => { try { return readFileSync(env.RECEIPTS, "utf8"); } catch { return ""; } },
      execute: kind => {
        if (env.BEHIND === "true" && !releaseCreated) {
          git("switch", "-q", "trunk"); writeFileSync(join(dir, "release.txt"), "Release advances base\n");
          git("add", "release.txt"); git("commit", "-qm", "Release"); git("push", "-q", "origin", "trunk"); git("switch", "-q", "automation/proposal");
          releaseCreated = true;
        }
        return spawnSync("bash", ["-c", maintenance(kind)], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
      } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("README distinguishes App auto-merge from no-App maintainer landing", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /In App mode, after dispatch the workflow requests `gh pr merge --auto --squash` with the expected head SHA and exits; required checks decide the merge, and no runner is held while they run/);
  assert.match(readme, /Without an App, maintainers approve native PR runs, wait for required checks and conversations, and merge with an authorized credential; the workflow does not arm auto-merge/);
  assert.doesNotMatch(readme, /dispatches all selected workflows and, in App mode, requests auto-merge again when the new head appears/);
  assert.match(readme, /Never wait in-job for caller CI: it takes runners from the same account pool/);
});

for (const kind of ["sync", "closeout"]) {
  test(`${kind}: default selects CI and CodeQL, respecting explicit overrides`, () => fixture(f => {
    const source = readFileSync(join(root, `.github/workflows/pm-github-${kind}.yml`), "utf8");
    assert.match(source, /default: "ci.yml codeql.yml"/);
    f.env.CI_WORKFLOWS = "ci.yml";
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.match(f.receipts(), /workflow run ci.yml/); assert.doesNotMatch(f.receipts(), /workflow run codeql.yml/);
    assert.match(f.receipts(), /pr merge 7 .*--auto --squash --match-head-commit [a-f0-9]{40}/);
    assert.doesNotMatch(f.receipts(), /--admin|--force|resolve/);
  }));
  for (const trigger of [
    '"on":\n  workflow_dispatch:\n', "'on':\n    workflow_dispatch:\n",
    "on:\n workflow_dispatch:\n", "on:\n    workflow_dispatch:\n",
    "on:\n  - pull_request\n  - workflow_dispatch\n", "on:\n- pull_request\n- workflow_dispatch\n",
    '"on": workflow_dispatch\n', "'on': [pull_request, workflow_dispatch]\n",
  ]) {
    test(`${kind}: dispatch accepts common YAML trigger ${JSON.stringify(trigger)}`, () => fixture(f => {
      writeFileSync(join(f.dir, ".github/workflows/ci.yml"), trigger);
      f.env.CI_WORKFLOWS = "ci.yml";
      const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
      assert.match(f.receipts(), /workflow run ci.yml/);
    }));
  }
  test(`${kind}: nested dispatch input cannot masquerade as a trigger`, () => fixture(f => {
    writeFileSync(join(f.dir, ".github/workflows/ci.yml"), '"on":\n    push:\n      inputs:\n        workflow_dispatch: ignored\n');
    f.env.CI_WORKFLOWS = "ci.yml";
    const r = f.execute(kind); assert.equal(r.status, 1);
    assert.doesNotMatch(f.receipts(), /workflow run|pr merge/);
  }));
  test(`${kind}: GITHUB_TOKEN fallback dispatches validation without arming auto-merge`, () => fixture(f => {
    delete f.env.APP_DEADLINE;
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.match(f.receipts(), /workflow run ci.yml/);
    assert.doesNotMatch(f.receipts(), /pr merge/);
    assert.match(String(r.stdout), /Auto-merge not armed with GITHUB_TOKEN/);
  }));
  test(`${kind}: no dispatchable workflow refuses automatic landing`, () => fixture(f => {
    for (const name of ["ci", "codeql"]) writeFileSync(join(f.dir, `.github/workflows/${name}.yml`), "on:\n  pull_request:\nenv:\n  workflow_dispatch: ignored\njobs:\n  test:\n    workflow_dispatch: ignored\n");
    const r = f.execute(kind); assert.equal(r.status, 1); assert.match(String(r.stdout), /No dispatchable caller workflow/);
    assert.doesNotMatch(f.receipts(), /workflow run|pr merge/);
  }));
  test(`${kind}: CodeQL without dispatch reports the trigger repair and leaves required checks intact`, () => fixture(f => {
    writeFileSync(join(f.dir, ".github/workflows/codeql.yml"), "on:\n  pull_request:\n");
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.match(String(r.stdout), /codeql.yml. Add workflow_dispatch: under on:/);
    assert.match(f.receipts(), /workflow run ci.yml/); assert.doesNotMatch(f.receipts(), /workflow run codeql.yml/);
  }));
  test(`${kind}: a base advance after publication never polls; landing stays with auto-merge and the next scheduled run`, () => fixture(f => {
    f.env.BEHIND = "true";
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
    const dispatches = f.receipts().split("\n").filter(line => line.startsWith("workflow run"));
    assert.equal(dispatches.length, 2, "exactly one dispatch round, no redispatch on a moved base");
    assert.match(f.receipts(), /pr merge 7 .*--auto --squash --match-head-commit [a-f0-9]{40}/);
    assert.doesNotMatch(f.receipts(), /pr view|compare\/trunk|update-branch|sleep/);
    assert.match(String(r.stdout), /Landing stays outside this runner/);
    assert.equal(existsSync(join(f.dir, "release.txt")), false, "a base advance is repaired by the next scheduled run, not in-job");
  }));
  test(`${kind}: dispatch denial reports the token diagnostic before auto-merge`, () => fixture(f => {
    f.env.DISPATCH_DENIED = "1";
    const r = f.execute(kind); assert.equal(r.status, 1, String(r.stderr));
    assert.match(String(r.stdout), /token requires actions:write/);
    assert.doesNotMatch(f.receipts(), /pr merge|pr view/);
  }));
  test(`${kind}: unavailable auto-merge reports the reason and exits without polling; the next scheduled run retries`, () => fixture(f => {
    f.env.AUTO_DENIED = "1";
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
    assert.match(String(r.stdout), /Squash auto-merge unavailable for the bot PR \(pull request auto-merge is disabled\)/);
    assert.match(String(r.stdout), /the next scheduled run retries/);
    assert.match(f.receipts(), /workflow run ci\.yml/);
    assert.doesNotMatch(f.receipts(), /pr view|update-branch|sleep|--admin|resolve/);
  }));
  for (const [variable, value, reason] of [
    ["AUTO_ALLOWED", "false", "repository auto-merge is disabled"],
    ["AUTO_ALLOWED", "null", "repository auto-merge is disabled"],
    ["SETTING_READ_DENIED", "1", "repository auto-merge is disabled"],
    ["PROTECTED", "false", "base branch protection is absent"],
    ["PROTECTED", "invalid", "base branch protection is absent"],
    ["PROTECTION_READ_DENIED", "1", "base branch protection is absent"],
  ]) {
    test(`${kind}: ${variable}=${value} uses the scheduled fallback without merging or polling`, () => fixture(f => {
      f.env[variable!] = value;
      f.env.PARKED_URL = "https://github.com/acme/widgets/actions/runs/123";
      const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
      assert.ok(String(r.stdout).includes(reason!));
      assert.match(String(r.stdout), /the next scheduled run retries/);
      assert.match(String(r.stdout), /maintainer approval: https:\/\/github.com\/acme\/widgets\/actions\/runs\/123/);
      assert.equal(f.receipts().split("\n").filter(line => line.startsWith("workflow run")).length, 2);
      assert.doesNotMatch(f.receipts(), /pr merge|pr view|update-branch|sleep/);
      assert.ok(f.receipts().split("\n").filter(line => line.startsWith("api ")).length <= 2);
    }));
  }
  for (const appMode of [true, false]) {
    test(`${kind}: parked-run listing failure is informational in ${appMode ? "App" : "GITHUB_TOKEN"} mode`, () => fixture(f => {
      if (!appMode) delete f.env.APP_DEADLINE;
      f.env.PARKED_READ_DENIED = "47";
      // A failed lookup may return partial output; do not present it as a complete report.
      f.env.PARKED_URL = "https://github.com/acme/widgets/actions/runs/123";
      const r = f.execute(kind);
      assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
      assert.match(String(r.stdout), /::notice::Could not list approval-required runs/);
      assert.match(String(r.stdout), /Landing stays outside this runner/);
      assert.doesNotMatch(String(r.stdout), /::error::|maintainer approval: https:/);
      const calls = f.receipts().trim().split("\n");
      assert.equal(calls.filter(line => line.startsWith("workflow run")).length, 2);
      assert.equal(calls.filter(line => line.startsWith("pr merge")).length, Number(appMode));
      assert.equal(calls.filter(line => line.startsWith("run list")).length, 1, "reporting is never retried");
      assert.ok(calls.at(-1)!.startsWith("run list"), "no later remote action or polling");
      if (kind === "closeout" && appMode) assert.match(readFileSync(f.env.GITHUB_ENV!, "utf8"), /CLOSEOUT_AUTOMERGE_ALLOWED=true/);
    }));
  }
  test(`${kind}: armed auto-merge is requested exactly once and the step exits after the parked-run report`, () => fixture(f => {
    f.env.PARKED_URL = "https://github.com/acme/widgets/actions/runs/123";
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
    const arms = f.receipts().split("\n").filter(line => line.startsWith("pr merge 7"));
    assert.equal(arms.length, 1);
    const calls = f.receipts();
    assert.ok(calls.lastIndexOf("workflow run") < calls.indexOf("pr merge 7"));
    assert.ok(calls.indexOf("pr merge 7") < calls.indexOf("run list"));
    assert.match(String(r.stdout), /maintainer approval: https:\/\/github.com\/acme\/widgets\/actions\/runs\/123/);
    assert.match(arms[0]!, /--auto --squash --match-head-commit [a-f0-9]{40}/);
    assert.doesNotMatch(arms[0]!, /--admin|--force/);
    assert.equal(f.receipts().split("\n").filter(line => line.startsWith("workflow run")).length, 2);
    assert.match(f.receipts(), /run list .*--status action_required/);
    assert.doesNotMatch(f.receipts(), /pr view|compare\/trunk|update-branch|sleep/);
    assert.match(String(r.stdout), /Landing stays outside this runner/);
  }));
}

test("sync and closeout share PR maintenance apart from the closeout attribution hold", () => {
  const hold = 'if [[ "${CLOSEOUT_REVIEW:-0}" != 0 ]]; then\n'
    + '  echo "::notice::Delivery attribution needs review; caller checks were dispatched and automatic landing is disabled."\n'
    + '  exit 0\nfi\n';
  const closeout = maintenance("closeout");
  assert.equal(closeout.split(hold).length, 2);
  const landingReceipt = 'if [[ -n "${APP_DEADLINE:-}" ]]; then\n'
    + '  printf \'CLOSEOUT_AUTOMERGE_ALLOWED=true\\n\' >> "${GITHUB_ENV}"\nfi\n';
  assert.equal(closeout.split(landingReceipt).length, 2);
  assert.equal(maintenance("sync"), closeout.replace(hold, "").replace(landingReceipt, ""));
});

for (const kind of ["sync", "closeout"]) {
  test(`${kind}: App publication uses a pinned repo-scoped token after gates and bounds its lifetime`, () => {
    const source = readFileSync(join(root, `.github/workflows/pm-github-${kind}.yml`), "utf8");
    const mint = source.split("      - name: Create automation app token\n")[1]!.split("      - name: ")[0]!;
    assert.match(mint, /uses: actions\/create-github-app-token@[a-f0-9]{40} # v[0-9]+\.[0-9]+\.[0-9]+/);
    assert.match(mint, /if: inputs.automation-app-client-id != ''/);
    assert.match(mint, /client-id: \$\{\{ inputs.automation-app-client-id \}\}/);
    assert.match(mint, /private-key: \$\{\{ secrets.automation_app_private_key \}\}/);
    assert.match(mint, /^          repositories: \$\{\{ github.repository \}\}$/m);
    const grants = [...mint.matchAll(/^          permission-([a-z-]+): (read|write)$/gm)];
    const permissions = Object.fromEntries(grants.map(match => [match[1]!, match[2]!]));
    assert.equal(grants.length, Object.keys(permissions).length);
    assert.deepEqual(permissions, { contents: "write", "pull-requests": "write", actions: "write", checks: "read", statuses: "read" });
    assert.doesNotMatch(mint, /^          (owner|enterprise):/m);
    assert.match(mint, /skip-token-revoke: false/);
    assert.ok(source.indexOf("name: Verify strict pm health") < source.indexOf("name: Create automation app token"));
    assert.ok(source.indexOf("name: Validate publication credentials") < source.indexOf("name: Commit gated"));
    assert.equal(source.split("GH_TOKEN: ${{ steps.automation_token.outputs.token || github.token }}").length - 1, kind === "closeout" ? 3 : 2);
    assert.equal((source.match(/secrets\.automation_app_private_key/g) ?? []).length, 2);
    assert.match(source, /APP_DEADLINE: \$\{\{ steps.publication_auth.outputs.deadline \}\}/);
    assert.doesNotMatch(source, /MAINTENANCE_|--admin|gh pr review|resolveReviewThread|\/check-runs.*--method POST/);
  });
  test(`${kind}: partial App credentials fail closed and legacy mode reports check ineligibility`, () => fixture(f => {
    for (const [clientId, key, token, status] of [["", "false", "false", 0], ["", "true", "false", 1],
      ["Iv1.fixture", "false", "false", 1], ["Iv1.fixture", "true", "false", 1], ["Iv1.fixture", "true", "true", 0]] as const) {
      const r = spawnSync("bash", ["-c", stepShell(kind, "Validate publication credentials")], {
        env: { ...f.env, GITHUB_OUTPUT: join(f.dir, "auth-output"), APP_CLIENT_ID: clientId, HAS_APP_PRIVATE_KEY: key, HAS_AUTOMATION_TOKEN: token }, encoding: "utf8",
      });
      assert.equal(r.status, status, r.stderr + r.stdout);
      if (!clientId && status === 0) assert.match(r.stdout, /dispatched checks cannot satisfy PR branch rules/);
      if (clientId && status === 0) {
        assert.doesNotMatch(r.stdout, /Using GITHUB_TOKEN/);
        assert.equal(readFileSync(join(f.dir, "auth-output"), "utf8"), "deadline=1700002400\n");
      }
    }
  }));
  test(`${kind}: the dispatch step shell never sleeps or polls other runs`, () => {
    const source = parse(readFileSync(join(root, `.github/workflows/pm-github-${kind}.yml`), "utf8")) as { jobs: Record<string, { steps: Record<string, unknown>[] }> };
    const step = source.jobs[`gated-${kind}`]!.steps.find(step => step.name === "Dispatch caller CI and report parked runs")!;
    assert.equal(step["timeout-minutes"], 5, "dispatch is capped even if a CLI call hangs");
    const shell = maintenance(kind);
    assertNoRunnerWaits(shell);
    assert.match(shell, /Landing stays outside this runner/);
  });
}

test("every job in the reusable workflows declares an explicit timeout", () => {
  for (const file of readdirSync(join(root, ".github/workflows")).filter(file => /\.ya?ml$/.test(file))) {
    const parsed = parse(readFileSync(join(root, `.github/workflows/${file}`), "utf8")) as { on?: { workflow_call?: unknown }; jobs: Record<string, Record<string, unknown>> };
    if (!parsed.on || !Object.hasOwn(parsed.on, "workflow_call")) continue;
    for (const [id, job] of Object.entries(parsed.jobs)) {
      const timeout = job["timeout-minutes"];
      assert.ok(typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0 && timeout <= 60,
        `${file} job ${id} needs an explicit, bounded timeout-minutes`);
    }
  }
});

for (const kind of ["sync", "closeout"]) {
  for (const command of [
    "while :; do gh run watch 7; done",
    "until gh run view 7; do :; done",
    "for run in 7 8; do gh -R acme/widgets run view \"$run\"; done",
    "gh\t run\twatch 7",
    "while :; do gh api repos/acme/widgets/commits/HEAD/check-runs; done",
    "until gh api repos/acme/widgets/commits/HEAD/check-suites; do :; done",
    "gh pr checks 7 --watch",
  ]) {
    test(`${kind}: no-wait contract rejects adversarial polling ${command}`, () => {
      const shell = maintenance(kind);
      assertNoRunnerWaits(shell); // Legitimate gh run list and while read remain allowed.
      assert.throws(() => assertNoRunnerWaits(`${shell}\n${command}`), /no caller-run polling command/);
    });
  }
}

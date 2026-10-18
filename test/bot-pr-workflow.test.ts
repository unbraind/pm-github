/** Exercise the exact reusable maintenance shell with real Git and receipt-only GitHub commands. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

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

/** Model only the remote GitHub API; branch update performs a real merge against a real remote. */
function fixture(run: (f: { dir: string; env: NodeJS.ProcessEnv; receipts: () => string; execute: (kind: string) => ReturnType<typeof spawnSync> }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bot-pr-"));
  const bin = join(dir, "bin");
  const env: NodeJS.ProcessEnv & { RECEIPTS: string } = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com",
    APP_DEADLINE: "1700002400", REPOSITORY: "acme/widgets", DEFAULT_BRANCH: "trunk", SYNC_BRANCH: "automation/proposal", SYNC_PUBLISHED: "true", SYNC_PR_NUMBER: "7", CI_WORKFLOWS: "ci.yml codeql.yml",
    RECEIPTS: join(dir, "receipts"), STATE: join(dir, "state"), PATH: bin + ":" + process.env.PATH };
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
  'pr merge') exit "\${AUTO_DENIED:-0}" ;;
  'run list') ;;
  'pr view')
    if [[ "\${BEHIND:-false}" == true && ! -f "$STATE" ]]; then
      printf '{"number":7,"state":"OPEN","headRefOid":"%s","mergeStateStatus":"%s"}' "$(git rev-parse HEAD)" "\${MERGE_STATE:-BEHIND}"
    elif [[ "\${BEHIND:-false}" == true && ! -f "$STATE.done" ]]; then
      touch "$STATE.done"
      printf '{"number":7,"state":"OPEN","headRefOid":"%s","mergeStateStatus":"BLOCKED"}' "$(git rev-parse HEAD)"
    elif [[ "\${BLOCKED:-false}" == true ]]; then
      printf '{"number":7,"state":"OPEN","headRefOid":"%s","mergeStateStatus":"BLOCKED"}' "$(git rev-parse HEAD)"
    else printf '{"state":"MERGED"}'; fi ;;
  'api repos/acme/widgets/compare/'*) git rev-list --count HEAD..origin/trunk ;;
  'api --method')
    [[ "$*" == *"expected_head_sha=$(git rev-parse HEAD)"* ]] || exit 9
    git fetch -q origin trunk
    git merge -q --no-edit origin/trunk
    touch "$STATE" ;;
  *) exit 8 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, "date"), '#!/usr/bin/env bash\nprintf "%s\\n" "${FAKE_NOW:-1700000000}"\n', { mode: 0o755 });
    writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    run({ dir, env, receipts: () => { try { return readFileSync(env.RECEIPTS, "utf8"); } catch { return ""; } },
      execute: kind => {
        if (env.BEHIND === "true" && !releaseCreated) {
          git("switch", "-q", "trunk"); writeFileSync(join(dir, "release.txt"), "Release advances base\n");
          git("add", "release.txt"); git("commit", "-qm", "Release"); git("push", "-q", "origin", "trunk"); git("switch", "-q", "automation/proposal");
          releaseCreated = true;
        }
        return spawnSync("bash", ["-c", maintenance(kind)], { cwd: dir, env, encoding: "utf8" });
      } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

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
  test(`${kind}: a daily release makes the proposal BEHIND, updates with a SHA lease and redispatches both workflows`, () => fixture(f => {
    f.env.BEHIND = "true";
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    const dispatches = f.receipts().split("\n").filter(line => line.startsWith("workflow run"));
    assert.equal(dispatches.length, 4); assert.match(dispatches[0]!, /ci.yml/); assert.match(dispatches[1]!, /codeql.yml/);
    const heads = dispatches.map(line => line.split("HEAD=")[1]);
    assert.equal(heads[0], heads[1]); assert.equal(heads[2], heads[3]); assert.notEqual(heads[0], heads[2]);
    assert.match(f.receipts(), /api --method PUT repos\/acme\/widgets\/pulls\/7\/update-branch -f expected_head_sha=/);
    assert.equal(readFileSync(join(f.dir, "release.txt"), "utf8"), "Release advances base\n");
  }));
  test(`${kind}: a blocked merge label cannot hide a base advance`, () => fixture(f => {
    Object.assign(f.env, { BEHIND: "true", MERGE_STATE: "BLOCKED", MAINTENANCE_ATTEMPTS: "2" });
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.match(f.receipts(), /api repos\/acme\/widgets\/compare\/trunk\.\.\./);
    assert.match(f.receipts(), /update-branch/);
    assert.equal(f.receipts().split("\n").filter(line => line.startsWith("workflow run")).length, 4);
    assert.equal(readFileSync(join(f.dir, "release.txt"), "utf8"), "Release advances base\n");
  }));
  test(`${kind}: dispatch denial reports the token diagnostic before auto-merge`, () => fixture(f => {
    f.env.DISPATCH_DENIED = "1";
    const r = f.execute(kind); assert.equal(r.status, 1, String(r.stderr));
    assert.match(String(r.stdout), /token requires actions:write/);
    assert.doesNotMatch(f.receipts(), /pr merge|pr view/);
  }));
  test(`${kind}: disabled auto-merge is a notice, unresolved conversations stay blocked at the time bound`, () => fixture(f => {
    f.env.AUTO_DENIED = "1"; f.env.BLOCKED = "true";
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.match(String(r.stdout), /Squash auto-merge unavailable/); assert.match(String(r.stdout), /configured bound/);
    assert.equal(f.receipts().split("\n").filter(line => line.startsWith("pr view")).length, 120);
    assert.doesNotMatch(f.receipts(), /update-branch|--admin|resolve/);
  }));
}

test("sync and closeout execute identical PR maintenance", () => assert.equal(maintenance("sync"), maintenance("closeout")));

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
    assert.equal(source.split("GH_TOKEN: ${{ steps.automation_token.outputs.token || github.token }}").length - 1, 2);
    assert.match(source, /MAINTENANCE_ATTEMPTS: \$\{\{ steps.automation_token.outputs.token != '' && '40' \|\| '120' \}\}/);
    assert.equal((source.match(/secrets\.automation_app_private_key/g) ?? []).length, 2);
    assert.match(source, /APP_DEADLINE: \$\{\{ steps.publication_auth.outputs.deadline \}\}/);
    assert.match(source, /MAINTENANCE_SECONDS: \$\{\{ steps.automation_token.outputs.token != '' && '2400' \|\| '7200' \}\}/);
    assert.doesNotMatch(source, /--admin|gh pr review|resolveReviewThread|\/check-runs.*--method POST/);
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
  test(`${kind}: App maintenance ends at its configured poll bound`, () => fixture(f => {
    Object.assign(f.env, { MAINTENANCE_ATTEMPTS: "1", MAINTENANCE_SECONDS: "2400", BLOCKED: "true" });
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.equal(f.receipts().split("\n").filter(line => line.startsWith("pr view")).length, 1);
    assert.match(String(r.stdout), /configured bound/);
  }));
  test(`${kind}: the elapsed-time deadline also ends maintenance before token expiry`, () => fixture(f => {
    Object.assign(f.env, { MAINTENANCE_ATTEMPTS: "40", MAINTENANCE_SECONDS: "2400", APP_DEADLINE: "1700002400", FAKE_NOW: "1700002500", BLOCKED: "true" });
    const r = f.execute(kind); assert.equal(r.status, 0, String(r.stderr));
    assert.doesNotMatch(f.receipts(), /pr view/);
    assert.match(String(r.stdout), /configured bound/);
  }));
}

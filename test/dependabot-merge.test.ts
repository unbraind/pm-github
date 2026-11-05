/** Execute the production merge policy against API receipts and its real workflow launcher. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { auditDependabotMerges, githubCallTimeout, githubCli, runDependabotMerge, type GithubCommandRunner, type MergeInput } from "../scripts/dependabot-merge.ts";

const root = resolve(import.meta.dirname, "..");
const bot = "dependabot[bot]";
const head = "a".repeat(40);
const trusted = "b".repeat(40);

/** Model only remote API responses and mutation receipts; execute the actual policy. */
function fixture() {
  const input: MergeInput = { repository: "acme/widgets", number: "7", event: "pull_request_target", actor: bot,
    triggeringActor: bot, author: bot, head, phase: "evaluate", metadataOutcome: "success",
    group: "", updateType: "version-update:semver-patch", extraGroups: "" };
  const commit = { sha: head, author: { login: bot }, committer: { login: "web-flow" }, commit: { verification: { verified: true, reason: "valid" } } };
  const state = { state: "open", user: { login: bot }, head: { sha: head }, commits: 1, auto_merge: {} as object | null };
  const pages: unknown[][] = [[commit]];
  const calls: string[][] = [];
  let reads = 0;
  const f = { input, commit, state, pages, calls, failCommits: false, failReads: false, failArm: false, failRevoke: false,
    rawPages: undefined as string | undefined, onRead: (_read: number) => {},
    execute: () => runDependabotMerge(input, f.gh), gh: (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "api" && args[1]!.includes("/commits?")) {
        assert.ok(args.includes("--paginate")); assert.ok(args.includes("--jq"));
        if (f.failCommits) throw new Error("private remote response");
        return f.rawPages ?? pages.flat().map(commit => JSON.stringify(commit)).join("\n");
      }
      if (args[0] === "api") {
        f.onRead(++reads);
        if (f.failReads) throw new Error("unreadable");
        return JSON.stringify(state);
      }
      if (args.includes("--disable-auto")) {
        if (f.failRevoke) throw new Error("revocation denied");
        state.auto_merge = null;
      } else {
        assert.ok(args.includes("--squash"));
        assert.ok(args.includes("--auto"), "the arm request must enable auto-merge");
        assert.equal(args.at(-1), head);
        if (f.failArm) throw new Error("expected head changed");
        state.auto_merge = {};
      }
      return "";
    } };
  return f;
}

test("Dependabot opens a verified PR with no existing request: arm squash", () => {
  const f = fixture(); f.state.auto_merge = null;
  assert.equal(f.execute().armed, true);
  assert.ok(!f.calls.some(args => args.includes("--disable-auto")));
  assert.ok(f.calls.find(args => args.includes("--match-head-commit")));
});

test("existing request is revoked before arming the verified Dependabot head", () => {
  const f = fixture();
  assert.equal(f.execute().armed, true);
  assert.ok(f.calls[1]!.includes("--disable-auto"));
  assert.ok(f.calls.find(args => args.includes("--match-head-commit")));
});

test("Dependabot rebase with bot committer remains eligible", () => {
  const f = fixture(); f.commit.committer.login = bot;
  assert.equal(f.execute().armed, true);
});

for (const [name, mutate] of [
  ["foreign author pushes", (f: ReturnType<typeof fixture>) => { f.commit.author.login = "outside"; f.input.actor = "outside"; }],
  ["foreign committer with bot author", (f: ReturnType<typeof fixture>) => { f.commit.committer.login = "outside"; }],
  ["unsigned web-flow", (f: ReturnType<typeof fixture>) => { f.commit.commit.verification.verified = false; }],
  ["unsigned bot account attribution", (f: ReturnType<typeof fixture>) => { f.commit.committer.login = bot; f.commit.commit.verification.verified = false; }],
  ["web-flow verification reason invalid", (f: ReturnType<typeof fixture>) => { f.commit.commit.verification.reason = "unsigned"; }],
  ["null author", (f: ReturnType<typeof fixture>) => { f.pages[0] = [{ ...f.commit, author: null }]; }],
  ["null committer", (f: ReturnType<typeof fixture>) => { f.pages[0] = [{ ...f.commit, committer: null }]; }],
  ["missing verification", (f: ReturnType<typeof fixture>) => { f.pages[0] = [{ ...f.commit, commit: {} }]; }],
  ["missing commit", (f: ReturnType<typeof fixture>) => { f.pages[0] = [{ ...f.commit, commit: null }]; }],
  ["unsafe account text", (f: ReturnType<typeof fixture>) => { f.commit.author.login = "bad\n::error::private"; }],
] as const) {
  test(`${name}: disarm and name only the short SHA and author login`, () => {
    const f = fixture(); mutate(f); const r = f.execute();
    assert.equal(r.armed, false); assert.equal(f.state.auto_merge, null);
    assert.ok(!f.calls.some(args => args.includes("--auto")));
    assert.match(r.message, /Foreign or unverified commits: aaaaaaaaaaaa (outside|dependabot\[bot\]|unknown)\./);
    assert.doesNotMatch(r.message, /private|web-flow/);
  });
}

for (const changes of [
  { event: "pull_request" }, { event: "workflow_dispatch" }, { actor: "outside" },
  { triggeringActor: "outside" }, { author: "outside" }, { head: "c".repeat(40) }, { head: "invalid" },
  { metadataOutcome: "failure" }, { metadataOutcome: "skipped" },
  { updateType: "version-update:semver-major" }, { updateType: "" },
  { group: "pm-toolchain-extra", updateType: "version-update:semver-major" },
]) {
  test(`refusal succeeds without arming: ${JSON.stringify(changes)}`, () => {
    const f = fixture(); Object.assign(f.input, changes);
    assert.equal(f.execute().armed, false); assert.equal(f.state.auto_merge, null);
    assert.ok(!f.calls.some(args => args.includes("--auto")));
  });
}

for (const changes of [
  { group: "pm-toolchain", updateType: "version-update:semver-major" },
  { group: "reviewed", extraGroups: "first, reviewed\nlast", updateType: "version-update:semver-major" },
  { updateType: "version-update:semver-minor" },
]) {
  test(`allowed metadata: ${JSON.stringify(changes)}`, () => {
    const f = fixture(); Object.assign(f.input, changes); assert.equal(f.execute().armed, true);
  });
}

for (const mutate of [
  (f: ReturnType<typeof fixture>) => { f.state.state = "closed"; },
  (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 3) f.state.state = "closed"; }; },
  (f: ReturnType<typeof fixture>) => { f.state.user.login = "outside"; },
  (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 3) f.state.user.login = "outside"; }; },
]) {
  test("live PR state and author must remain eligible", () => { const f = fixture(); mutate(f); assert.equal(f.execute().armed, false); });
}

test("all 101 commits are read across pages; foreign commit on page two disarms", () => {
  const f = fixture();
  f.pages[0] = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(f.commit), sha: i.toString(16).padStart(40, "0") }));
  f.pages.push([f.commit]); f.state.commits = 101;
  assert.equal(f.execute().armed, true);
  f.commit.committer.login = "outside";
  assert.equal(f.execute().armed, false); assert.equal(f.state.auto_merge, null);
});

for (const [name, mutate] of [
  ["API failure", (f: ReturnType<typeof fixture>) => { f.failCommits = true; }],
  ["PR API failure", (f: ReturnType<typeof fixture>) => { f.failReads = true; }],
  ["malformed JSON", (f: ReturnType<typeof fixture>) => { f.rawPages = "{"; }],
  ["non-array pages", (f: ReturnType<typeof fixture>) => { f.rawPages = "{}"; }],
  ["malformed page", (f: ReturnType<typeof fixture>) => { f.rawPages = "[{}]"; }],
  ["empty list", (f: ReturnType<typeof fixture>) => { f.pages[0] = []; f.state.commits = 0; }],
  ["missing page", (f: ReturnType<typeof fixture>) => { f.state.commits = 101; }],
  ["bad count", (f: ReturnType<typeof fixture>) => { f.state.commits = 1.5; }],
  ["bad SHA", (f: ReturnType<typeof fixture>) => { f.commit.sha = "invalid"; }],
  ["null commit", (f: ReturnType<typeof fixture>) => { f.pages[0] = [null]; }],
  ["duplicate commits", (f: ReturnType<typeof fixture>) => { f.pages[0]!.push(f.commit); f.state.commits = 2; }],
  ["head differs from last commit", (f: ReturnType<typeof fixture>) => { f.state.head.sha = trusted; }],
  ["head changes during read", (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 3) f.state.head.sha = trusted; }; }],
  ["count changes during read", (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 3) f.state.commits = 2; }; }],
  ["arm denied", (f: ReturnType<typeof fixture>) => { f.failArm = true; }],
  ["head changes after arm", (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 4) f.state.head.sha = trusted; }; }],
  ["count changes after arm", (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 4) f.state.commits = 2; }; }],
  ["author changes after arm", (f: ReturnType<typeof fixture>) => { f.onRead = n => { if (n === 4) f.state.user.login = "outside"; }; }],
] as const) {
  test(`${name}: fail closed, revoke and explain without remote response text`, () => {
    const f = fixture(); mutate(f); const r = f.execute();
    assert.equal(r.armed, false); assert.equal(f.state.auto_merge, null);
    assert.match(r.message, /API\/provenance.*auto-merge not armed/); assert.doesNotMatch(r.message, /private remote response/);
  });
}

test("early revoke skips metadata and commit reads", () => {
  const f = fixture(); f.input.phase = "revoke";
  assert.equal(f.execute().armed, false); assert.equal(f.calls.length, 2);
});

test("no existing auto-merge requires no disable mutation", () => {
  const f = fixture(); f.state.auto_merge = null; f.input.phase = "revoke";
  f.execute(); assert.equal(f.calls.length, 1);
});

test("closed PR historical auto_merge metadata is not an active request", () => {
  const f = fixture(); f.state.state = "closed";
  assert.equal(f.execute().armed, false);
  assert.ok(!f.calls.some(args => args[0] === "pr"));
});

test("revocation denial surfaces an operational error instead of false success", () => {
  const f = fixture(); f.failRevoke = true; assert.throws(f.execute, /revocation denied or unavailable/);
});

test("revocation denial after a concurrent arm is also an operational error", () => {
  const f = fixture();
  f.onRead = n => { if (n === 4) { f.state.head.sha = trusted; f.failRevoke = true; } };
  assert.throws(f.execute, /revocation denied or unavailable/);
});

for (const change of [{ repository: "--bad" }, { number: "0" }]) {
  test(`invalid target is refused before any side effect: ${JSON.stringify(change)}`, () => {
    const f = fixture(); Object.assign(f.input, change); assert.throws(f.execute, /Invalid caller/); assert.equal(f.calls.length, 0);
  });
}

/** Extract the exact loader shell, including its generated TypeScript launcher. */
function loader(): string {
  const workflow = readFileSync(join(root, ".github/workflows/pm-github-dependabot-merge.yml"), "utf8");
  return workflow.split("      - name: Load trusted merge policy\n")[1]!.split("        run: |\n")[1]!.split("      - name:")[0]!.split("\n")
    .filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
}

test("workflow policy: pinned actions, minimal grants, no PR checkout or interpolated shell", () => {
  const source = readFileSync(join(root, ".github/workflows/pm-github-dependabot-merge.yml"), "utf8");
  const workflow = parse(source) as { on: Record<string, unknown>; permissions: object; jobs: Record<string, { permissions: object; "timeout-minutes": number; steps: { uses?: string; run?: string; "timeout-minutes"?: number }[] }> };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]); assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs["dependabot-merge"]!.permissions, { contents: "write", "pull-requests": "write" });
  assert.equal(workflow.jobs["dependabot-merge"]!["timeout-minutes"], 60);
  for (const step of workflow.jobs["dependabot-merge"]!.steps) {
    if (step.uses) {
      assert.match(step.uses, /@[a-f0-9]{40}$/);
      assert.equal(step["timeout-minutes"], 5);
    }
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
  }
  assert.doesNotMatch(source, /actions\/checkout|skip-commit-verification|--admin/);
  assert.match(source, /continue-on-error: true/); assert.match(source, /job\.workflow_sha/);
  const caller = readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8");
  assert.match(caller, /uses: \.\/\.github\/workflows\/pm-github-dependabot-merge.yml/);
  assert.match(caller, /synchronize/);
  assert.match(caller, /if: github\.event_name == 'pull_request_target' && github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
  assert.doesNotMatch(caller, /github\.(?:actor|triggering_actor)/);
  assert.doesNotMatch(caller, /auto_merge_enabled/, "custom-token arm events must not revoke their own request");
});

test("custom-token arm event preserves the request; a foreign synchronize event revokes it", () => {
  const caller = parse(readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8")) as { on: { pull_request_target: { types: string[] } } };
  const subscribed = caller.on.pull_request_target.types;
  const f = fixture(); f.state.auto_merge = null;
  assert.equal(f.execute().armed, true);
  // PAT/App-generated events belong to the credential owner, not Dependabot.
  f.input.actor = "automation"; f.input.triggeringActor = "automation";
  if (subscribed.includes("auto_merge_enabled")) f.execute();
  assert.notEqual(f.state.auto_merge, null, "the token's own arm event must not disarm the request");
  f.input.actor = "outside"; f.input.triggeringActor = "outside"; f.commit.author.login = "outside";
  if (subscribed.includes("synchronize")) f.execute();
  assert.equal(f.state.auto_merge, null, "foreign synchronize must still revoke the request");
});

/** Kill only after the blocking child signals readiness; host startup time is irrelevant. */
function installFixtureTimeout(dir: string): void {
  writeFileSync(join(dir, "timeout"), `#!/bin/bash
[[ "$1" == --signal=KILL && "$2" == 60s ]] || exit 97
case "$MODE" in
  *hang*) shift 2; exec "${process.execPath}" "$TIMEOUT_SUPERVISOR" "$@" ;;
  *) exec /usr/bin/timeout "$@" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "timeout-supervisor.cjs"), `
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] });
let ready = false;
child.stdio[3].once('data', () => {
  ready = true;
  assert.equal(child.kill('SIGKILL'), true);
});
child.on('close', (code, signal) => {
  if (ready) {
    assert.equal(signal, 'SIGKILL');
    appendFileSync(process.env.KILL_RECEIPTS, 'SIGKILL\\n');
    process.exit(137);
  }
  assert.equal(signal, null);
  process.exit(code);
});
`);
}

/** Runtime bindings for the readiness-controlled deadline fixture. */
function timeoutEnvironment(dir: string): Record<string, string> {
  return { TIMEOUT_SUPERVISOR: join(dir, "timeout-supervisor.cjs"), KILL_RECEIPTS: join(dir, "kills") };
}

/** Require actual child termination, not merely an invocation or elapsed time. */
function assertHangKills(dir: string, mode: string): void {
  if (mode.includes("hang")) assert.deepEqual(readFileSync(join(dir, "kills"), "utf8").trim().split("\n"), ["SIGKILL", "SIGKILL", "SIGKILL"]);
}

for (const mode of ["external", "local", "remote-self", "audit", "audit-load-failed", "load-failed", "invalid-sha", "load-hang", "fallback-read-hang", "fallback-disable-hang", "load-retry"]) {
  test(`real workflow loader/launcher: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "dependabot-policy-"));
    const env = { ...process.env, ...timeoutEnvironment(dir), PATH: dir + ":" + process.env.PATH, RUNNER_TEMP: dir,
      RETRY_MARKER: join(dir, "retried"), POLICY_SOURCE: join(root, "scripts/dependabot-merge.ts"), WORKFLOW_SHA: mode === "invalid-sha" ? "bad" : mode === "local" ? trusted : head,
      WORKFLOW_REF: `unbraind/pm-github/.github/workflows/pm-github-dependabot-merge.yml@${mode.startsWith("local") ? "refs/pull/7/merge" : head}`,
      CALLER_REF: "refs/pull/7/merge",
      REPOSITORY: mode.startsWith("local") || mode === "remote-self" ? "unbraind/pm-github" : "acme/widgets", PR_NUMBER: mode.startsWith("audit") ? "" : "7", MODE: mode,
      GITHUB_STEP_SUMMARY: join(dir, "summary"), EVENT_NAME: "pull_request_target", AUDIT_ONLY: String(mode.startsWith("audit")), EVENT_ACTOR: "outside", TRIGGERING_ACTOR: "outside",
      GITHUB_OUTPUT: join(dir, "output"),
      PR_AUTHOR: bot, EVENT_HEAD: head, EXTRA_GROUPS: "", PHASE: "evaluate", RECEIPTS: join(dir, "receipts") };
    try {
      installFixtureTimeout(dir);
      writeFileSync(join(dir, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$RECEIPTS"
case "$*" in
  *git/ref/heads/main*) [[ "$MODE" != local-ref-failed ]] || exit 1; printf '%s' '${trusted}' ;;
  *contents/scripts*)
    [[ "$MODE" != load-hang ]] || { printf ready >&3; read -r -u 4; exit 98; }
    [[ "$MODE" != load-retry || -f "$RETRY_MARKER" ]] || { touch "$RETRY_MARKER"; printf partial; exit 1; }
    [[ "$MODE" != load-failed && "$MODE" != audit-load-failed && "$MODE" != fallback-* ]] || exit 1; cat "$POLICY_SOURCE" ;;
  *'/pulls?'*) printf '%s' '{"number":7,"user":{"login":"${bot}"},"auto_merge":{}}' ;;
  *'/commits?'*) printf '%s' '{"sha":"${head}","author":{"login":"outside"},"committer":{"login":"outside"}}' ;;
  'api '*) [[ "$MODE" != fallback-read-hang ]] || { printf ready >&3; read -r -u 4; exit 98; }; printf '%s' '{"state":"open","user":{"login":"${bot}"},"head":{"sha":"${head}"},"commits":1,"auto_merge":null}' ;;
  'pr merge '*) [[ "$MODE" != fallback-disable-hang ]] || { printf ready >&3; read -r -u 4; exit 98; } ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
      const loaded = spawnSync("bash", ["-c", loader()], { cwd: dir, env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
      const failed = ["load-failed", "invalid-sha", "load-hang", "fallback-read-hang"].includes(mode);
      assert.equal(loaded.status, mode === "fallback-disable-hang" || mode === "audit-load-failed" ? 1 : 0, loaded.stderr);
      assertHangKills(dir, mode);
      const receipts = readFileSync(env.RECEIPTS, "utf8");
      if (mode === "audit-load-failed") {
        assert.match(loaded.stdout, /Cannot load trusted audit policy/);
        assert.doesNotMatch(receipts, /pr merge|pulls\//);
      } else if (mode === "fallback-disable-hang") {
        assert.match(loaded.stdout, /Cannot revoke auto-merge after policy load failure and 3 bounded attempts/);
        assert.equal(receipts.split("\n").filter(line => line.startsWith("pr merge ")).length, 3);
      } else if (failed) {
        if (mode === "load-hang") assert.equal(receipts.split("\n").filter(line => line.includes("contents/scripts")).length, 3);
        if (mode === "fallback-read-hang") assert.equal(receipts.split("\n").filter(line => line.includes("pulls/7")).length, 3);
        assert.match(receipts, /--disable-auto/);
        assert.match(loaded.stdout, /::notice::Cannot load trusted merge policy/);
        assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /loaded=false/);
      }
      else {
        assert.match(receipts, new RegExp(`ref=${mode === "local" ? trusted : head}`));
        if (mode === "remote-self") assert.doesNotMatch(receipts, /git\/ref\/heads\/main/);
        const run = spawnSync(process.execPath, [join(dir, "run-dependabot-merge.mts")], { cwd: dir, env, encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /::notice::(?:#7: )?Foreign or unverified commits: aaaaaaaaaaaa outside/);
        assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /aaaaaaaaaaaa outside/);
        // Load the original module for coverage, with the fake gh available at
        // child startup even if a runtime caches its initial command lookup.
        const probe = join(dir, "adapter-probe.mts");
        writeFileSync(probe, readFileSync(join(dir, "run-dependabot-merge.mts"), "utf8")
          .replace("from './dependabot-merge.ts'", "from " + JSON.stringify(new URL("../scripts/dependabot-merge.ts", import.meta.url).href)));
        const defaultRun = spawnSync(process.execPath, [probe], { cwd: dir, env: { ...env, PHASE: "revoke" }, encoding: "utf8" });
        assert.equal(defaultRun.status, 0, defaultRun.stderr);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("real CLI adapter passes argv without shell expansion and propagates failure", () => {
  assert.equal(githubCli(["-p", "'literal $safe'"], process.execPath).trim(), "literal $safe");
  assert.throws(() => githubCli(["-e", "process.exit(3)"], process.execPath));
});

test("CLI adapter resolves a unique fixture command against the current PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "dependabot-command-"));
  const old = process.env.PATH;
  try {
    writeFileSync(join(dir, "policy-command-probe"), "#!/bin/bash\nprintf fixture-resolved\n", { mode: 0o755 });
    process.env.PATH = dir + ":" + old;
    assert.equal(githubCli([], "policy-command-probe"), "fixture-resolved");
  } finally { process.env.PATH = old; rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["armed", "clear", "closed", "malformed-api", "api-error", "denied", "hang-read", "hang-disable", "retry-disable"]) {
  test(`pre-tooling revocation shell: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "dependabot-revoke-"));
    try {
      const workflow = readFileSync(join(root, ".github/workflows/pm-github-dependabot-merge.yml"), "utf8");
      const shell = workflow.split("        run: |\n")[1]!.split("      - name:")[0]!.split("\n")
        .filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
      writeFileSync(join(dir, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$RECEIPTS"
if [[ "$1" == api ]]; then
  [[ "$MODE" != hang-read ]] || { printf ready >&3; read -r -u 4; exit 98; }
  [[ "$MODE" != api-error ]] || exit 1
  case "$MODE" in
    clear) payload='{"state":"open","auto_merge":null}' ;;
    closed) payload='{"state":"closed","auto_merge":{}}' ;;
    malformed-api) payload='{}' ;;
    *) payload='{"state":"open","auto_merge":{}}' ;;
  esac
  printf '%s' "$payload" | jq -r "$4"
else
  [[ "$MODE" != hang-disable ]] || { printf ready >&3; read -r -u 4; exit 98; }
  [[ "$MODE" != retry-disable || -f "$RETRY_MARKER" ]] || { touch "$RETRY_MARKER"; exit 1; }
  [[ "$MODE" != denied ]]
fi
`, { mode: 0o755 });
      installFixtureTimeout(dir);
      const env = { ...process.env, ...timeoutEnvironment(dir), PATH: dir + ":" + process.env.PATH, RETRY_MARKER: join(dir, "retried"), REPOSITORY: "acme/widgets", PR_NUMBER: "7",
        MODE: mode, RECEIPTS: join(dir, "receipts"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
      const result = spawnSync("bash", ["-c", shell], { cwd: dir, env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
      assert.equal(result.status, mode === "denied" || mode === "hang-disable" ? 1 : 0, result.stderr);
      if (mode === "denied" || mode === "hang-disable") assert.match(result.stdout, /Cannot revoke auto-merge/);
      else assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /cleared before tooling/);
      assertHangKills(dir, mode);
      const receipts = readFileSync(env.RECEIPTS, "utf8");
      if (mode === "hang-read") assert.equal(receipts.split("\n").filter(line => line.startsWith("api ")).length, 3);
      if (mode === "hang-disable" || mode === "denied") assert.equal(receipts.split("\n").filter(line => line.startsWith("pr merge ")).length, 3);
      if (mode === "retry-disable") assert.equal(receipts.split("\n").filter(line => line.startsWith("pr merge ")).length, 2);
      if (mode === "clear" || mode === "closed") assert.doesNotMatch(receipts, /--disable-auto/);
      else assert.match(receipts, /--disable-auto/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}



test("README describes the actual author guard without an owner restriction", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /workflow checks the Dependabot author, then the\s+metadata group/);
  assert.doesNotMatch(readme, /Dependabot author and repository\s+owner/);
});

for (const mode of ["retry", "exhausted"]) {
  test(`real CLI bounded attempts discard partial output: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "dependabot-bounded-"));
    try {
      const counter = join(dir, "count");
      const script = `const fs = require('node:fs'); const p = process.argv[1];
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) + 1 : 1;
        fs.writeFileSync(p, String(n));
        if (process.argv[2] === 'retry' && n === 3) process.stdout.write('complete');
        else { process.stdout.write('partial'); process.exit(1); }`;
      const run = () => githubCli(["-e", script, counter, mode], process.execPath);
      if (mode === "retry") assert.equal(run(), "complete");
      else assert.throws(run, /failed or timed out after 3 bounded attempts/);
      assert.equal(readFileSync(counter, "utf8"), "3");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}


test("CLI deadline defaults to 60 seconds, reads runtime overrides and rejects unbounded values", () => {
  const previous = process.env.DEPENDABOT_GH_TIMEOUT_SECONDS;
  const timeouts: number[] = [];
  const execute: GithubCommandRunner = (_executable, _args, options) => {
    timeouts.push(options.timeout!);
    assert.equal(options.killSignal, "SIGKILL");
    return "complete";
  };
  try {
    delete process.env.DEPENDABOT_GH_TIMEOUT_SECONDS;
    assert.equal(githubCli([], "fixture-command", undefined, execute), "complete");
    process.env.DEPENDABOT_GH_TIMEOUT_SECONDS = "7";
    assert.equal(githubCli([], "fixture-command", undefined, execute), "complete");
    assert.deepEqual(timeouts, [60_000, 7000]);
    for (const invalid of ["", "0", "-1", "1.5", "61", "Infinity", "1e2", " 7", "07", "7\n"]) {
      assert.throws(() => githubCallTimeout(invalid), /integer from 1 to 60/);
    }
    for (const invalid of [0, -1, NaN, Infinity, 0.5, 60_001]) {
      assert.throws(() => githubCli([], "fixture-command", invalid, execute), /Invalid GitHub CLI timeout/);
    }
    assert.equal(timeouts.length, 2, "invalid deadlines must not start a child");
  } finally {
    if (previous === undefined) delete process.env.DEPENDABOT_GH_TIMEOUT_SECONDS;
    else process.env.DEPENDABOT_GH_TIMEOUT_SECONDS = previous;
  }
});

test("real CLI timeout kills every blocking child and fails closed without startup counters", () => {
  let attempts = 0;
  let killed = 0;
  const execute: GithubCommandRunner = (executable, args, options) => {
    attempts++; // Parent-side receipt exists before the child can start or time out.
    try { return execFileSync(executable, args, options); }
    catch (error) {
      const receipt = error as Error & { code?: string; signal?: string };
      assert.equal(receipt.code, "ETIMEDOUT");
      assert.equal(receipt.signal, "SIGKILL");
      killed++;
      throw error;
    }
  };
  const block = "process.stdout.write('partial'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";
  assert.throws(() => githubCli(["-e", block], process.execPath, 1, execute), /^Error: GitHub CLI failed or timed out after 3 bounded attempts\.$/);
  assert.equal(attempts, 3);
  assert.equal(killed, 3);
});


/** Supply paginated PR-list receipts while exercising the shared production provenance checks. */
function auditFixture() {
  const f = fixture();
  const pulls: unknown[] = [{ number: 7, user: { login: bot }, auto_merge: {} }];
  const gh = (args: readonly string[]): string => {
    if (args[1]?.includes("/pulls?")) {
      assert.ok(args.includes("--paginate"));
      return pulls.map(pr => JSON.stringify(pr)).join("\n");
    }
    return f.gh(args);
  };
  return { f, pulls, gh, execute: () => auditDependabotMerges(f.input.repository, gh) };
}

test("independent audit preserves verified requests and never arms them", () => {
  const a = auditFixture();
  assert.match(a.execute().message, /Verified Dependabot head.*retained/);
  assert.notEqual(a.f.state.auto_merge, null);
  assert.ok(!a.f.calls.some(args => args[0] === "pr"));
});

/** Expand a numeric cron field so frequency checks cover lists, ranges and steps. */
function cronField(field: string, maximum: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    assert.ok(match, `Unsupported cron field: ${field}`);
    const step = Number(match[2] ?? 1);
    const range = match[1]!.split("-").map(Number);
    const start = match[1] === "*" ? 0 : range[0]!;
    const end = match[1] === "*" || (range.length === 1 && match[2]) ? maximum : range.at(-1)!;
    assert.ok(step >= 1 && step <= maximum + 1 && start >= 0 && start <= end && end <= maximum, `Invalid cron field: ${field}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values];
}

/** Refuse caller schedules whose minute/hour fields permit runs less than an hour apart. */
function assertHourlyAuditCeiling(schedules: readonly { cron: string }[]): void {
  const times: number[] = [];
  for (const { cron } of schedules) {
    const fields = cron.trim().split(/\s+/);
    assert.equal(fields.length, 5, "Expected five cron fields");
    const minutes = cronField(fields[0]!, 59);
    const hours = cronField(fields[1]!, 23);
    for (const hour of hours) for (const minute of minutes) times.push(hour * 60 + minute);
  }
  times.sort((a, b) => a - b);
  assert.ok(times.length > 0, "Expected an audit schedule");
  for (let i = 0; i < times.length; i++) {
    const next = times[i + 1] ?? times[0]! + 24 * 60;
    assert.ok(next - times[i]! >= 60, "Fleet audit schedules must not run more often than hourly");
  }
}

for (const [name, cron, allowed] of [
  ["five-minute", "3-58/5 * * * *", false],
  ["fifteen-minute", "*/15 * * * *", false],
  ["hourly", "23 * * * *", true],
  ["daily", "23 4 * * *", true],
  ["minute-list", "0,30 * * * *", false],
  ["cross-midnight", "0,59 0,23 * * *", false],
  ["two-hour-range", "23 0-22/2 * * *", true],
  ["stepped-start", "5/15 * * * *", false],
] as const) {
  test(`caller schedule policy: ${name}`, () => {
    const check = () => assertHourlyAuditCeiling([{ cron }]);
    if (allowed) check();
    else assert.throws(check, /must not run more often than hourly/);
  });
}

test("caller schedule policy combines all entries and rejects malformed fields", () => {
  assert.throws(() => assertHourlyAuditCeiling([{ cron: "0 * * * *" }, { cron: "30 * * * *" }]), /more often than hourly/);
  for (const cron of ["@daily", "60 * * * *", "0 24 * * *", "*/0 * * * *", "4-2 * * * *", "bad * * * *"]) {
    assert.throws(() => assertHourlyAuditCeiling([{ cron }]));
  }
  assert.throws(() => assertHourlyAuditCeiling([]), /Expected an audit schedule/);
});

test("caller and README template keep audits daily and never more often than hourly", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.split("## Verified Dependabot auto-merge\n")[1]!.split("## ")[0]!;
  const template = section.split("```yaml\n")[1]!.split("```")[0]!;
  for (const source of [readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8"), template]) {
    const caller = parse(source) as { on: { schedule: { cron: string }[]; workflow_dispatch: unknown } };
    assertHourlyAuditCeiling(caller.on.schedule);
    assert.deepEqual(caller.on.schedule, [{ cron: "23 4 * * *" }]);
    assert.ok(Object.hasOwn(caller.on, "workflow_dispatch"));
  }
  assert.match(section, /Fleet callers must not schedule the audit more often than hourly/);
  assert.match(section, /prefer daily\s+plus `workflow_dispatch`/);
  assert.doesNotMatch(section, /five-minute schedule/);
});

test("scheduled audit revokes a foreign push when its synchronize run never executes", () => {
  const caller = parse(readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8")) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: unknown; pull_request_target: { types: string[] } };
    jobs: Record<string, { if: string; with?: { "audit-only": boolean } }>;
  };
  assertHourlyAuditCeiling(caller.on.schedule);
  assert.ok(Object.hasOwn(caller.on, "workflow_dispatch"));
  assert.equal(caller.jobs["audit-armed-requests"]!.if, "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
  assert.equal(caller.jobs["audit-armed-requests"]!.with!["audit-only"], true);
  assert.ok(caller.on.pull_request_target.types.includes("synchronize"));
  const a = auditFixture(); a.f.commit.author.login = "github-actions[bot]";
  // No synchronize policy run: a workflow-generated push leaves the old request armed.
  assert.notEqual(a.f.state.auto_merge, null);
  assert.match(a.execute().message, /Foreign or unverified commits/);
  assert.equal(a.f.state.auto_merge, null);
  assert.ok(!a.f.calls.some(args => args.includes("--auto")));
});

test("audit and arm use identical provenance verdicts over varied API snapshots", () => {
  for (let i = 0; i < 40; i++) {
    const a = auditFixture(); const f = fixture();
    for (const next of [a.f, f]) {
      next.commit.author.login = i % 2 ? bot : "outside";
      next.commit.committer.login = i % 3 ? "web-flow" : "outside";
      next.commit.commit.verification.verified = i % 5 !== 0;
      next.commit.commit.verification.reason = i % 7 ? "valid" : "unsigned";
    }
    const eligible = f.execute().armed;
    a.execute();
    assert.equal(a.f.state.auto_merge !== null, eligible);
    assert.ok(!a.f.calls.some(args => args.includes("--auto")));
  }
});

for (const change of ["closed-before", "closed-after", "foreign-before", "foreign-after", "changed-head", "api-error"] as const) {
  test(`independent audit refuses stale or unverifiable snapshots: ${change}`, () => {
    const a = auditFixture();
    if (change === "closed-before") a.f.state.state = "closed";
    if (change === "foreign-before") a.f.state.user.login = "outside";
    if (change === "closed-after") a.f.onRead = n => { if (n === 2) a.f.state.state = "closed"; };
    if (change === "foreign-after") a.f.onRead = n => { if (n === 2) a.f.state.user.login = "outside"; };
    if (change === "changed-head") a.f.onRead = n => { if (n === 2) a.f.state.head.sha = trusted; };
    if (change === "api-error") a.f.failCommits = true;
    a.execute();
    assert.ok(!a.f.calls.some(args => args.includes("--auto")));
    if (!change.startsWith("closed")) assert.equal(a.f.state.auto_merge, null);
  });
}

test("audit ignores unarmed and other authors' requests, and handles an empty listing", () => {
  const a = auditFixture();
  a.pulls[0] = { number: 7, user: { login: bot }, auto_merge: null };
  a.pulls.push({ number: 8, user: { login: "outside" }, auto_merge: {} });
  assert.match(a.execute().message, /No armed Dependabot requests/);
  a.pulls.length = 0;
  assert.equal(a.execute().armed, false);
  assert.equal(a.f.calls.length, 0);
});

for (const pr of [null, {}, { number: 0 }, { number: 1, user: null }, { number: 1, user: { login: bot } }]) {
  test(`audit refuses an incomplete listing before any mutation: ${JSON.stringify(pr)}`, () => {
    const a = auditFixture(); a.pulls[0] = pr;
    assert.throws(a.execute, /Incomplete PR audit listing/);
    assert.equal(a.f.calls.length, 0);
  });
}

test("audit listing errors and malformed pagination fail with sanitized messages", () => {
  assert.throws(() => auditDependabotMerges("--bad"), /Invalid audit repository/);
  for (const receipt of ["private malformed", "{}\npartial"]) {
    assert.throws(() => auditDependabotMerges("acme/widgets", () => receipt), /^Error: Cannot read complete PR audit listing; retry immediately\.$/);
  }
  assert.throws(() => auditDependabotMerges("acme/widgets", () => { throw new Error("private remote error"); }), /Cannot read complete PR audit listing/);
});

test("audit continues other PRs after denied revocation and reports operational failure", () => {
  const a = auditFixture(); a.pulls.push({ number: 8, user: { login: bot }, auto_merge: {} });
  a.f.commit.author.login = "outside"; a.f.failRevoke = true;
  assert.throws(a.execute, /Cannot complete 2 auto-merge revocations/);
  assert.equal(a.f.calls.filter(args => args.includes("--disable-auto")).length, 2);
});

test("activation tracker reflects active workflow and keeps fleet acceptance separate", () => {
  const chore = readFileSync(join(root, ".agents/pm/chores/pm-github-dependabot-activation.toon"), "utf8");
  const description = chore.split("description: ")[1]!.split("\ntype:")[0]!;
  const criteria = chore.split("acceptance_criteria: ")[1]!.split("\nblocked_by:")[0]!;
  assert.match(description, /now reports.*active/);
  assert.match(description, /fleet caller adoption separate/);
  assert.doesNotMatch(criteria, /enable the previously disabled/);
  for (const requirement of ["token", "protected-branch", "live", "fleet", "event policy", "scheduled audit"]) assert.ok(criteria.includes(requirement));
});


test("trusted caller and audit launcher cannot run PR workflow code or accidentally arm during a sweep", () => {
  const caller = parse(readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8")) as {
    on: Record<string, unknown>; jobs: Record<string, { uses: string }>;
  };
  assert.ok(Object.hasOwn(caller.on, "pull_request_target"));
  assert.ok(!Object.hasOwn(caller.on, "pull_request"));
  for (const job of Object.values(caller.jobs)) assert.equal(job.uses, "./.github/workflows/pm-github-dependabot-merge.yml");
  const reusable = parse(readFileSync(join(root, ".github/workflows/pm-github-dependabot-merge.yml"), "utf8")) as {
    jobs: Record<string, { env: Record<string, string>; steps: { name: string; if?: string; run?: string; env?: Record<string, string> }[] }>;
  };
  const job = reusable.jobs["dependabot-merge"]!;
  assert.equal(job.env.AUDIT_ONLY, "${{ inputs.audit-only }}");
  for (const step of job.steps.filter(step => step.name.includes("Revoke previous") || step.name === "Fetch Dependabot metadata")) {
    assert.match(step.if!, /!inputs.audit-only/);
  }
  assert.match(job.steps.find(step => step.name === "Fetch Dependabot metadata")!.if!, /github.event_name == 'pull_request_target'/);
  const load = job.steps.find(step => step.name === "Load trusted merge policy")!;
  assert.equal(load.env!.WORKFLOW_SHA, "${{ job.workflow_sha }}");
  assert.doesNotMatch(load.run!, /git\/ref\/heads|EVENT_HEAD.*contents|CALLER_REF/);
  assert.match(load.run!, /e\.AUDIT_ONLY === 'true' \? auditDependabotMerges/);
});

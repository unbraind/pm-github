/** Execute the production merge policy against API receipts and its real workflow launcher. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { githubCli, runDependabotMerge, type MergeInput } from "../scripts/dependabot-merge.ts";

const root = resolve(import.meta.dirname, "..");
const bot = "dependabot[bot]";
const head = "a".repeat(40);
const trusted = "b".repeat(40);

/** Model only remote API responses and mutation receipts; execute the actual policy. */
function fixture() {
  const input: MergeInput = { repository: "acme/widgets", number: "7", event: "pull_request", actor: bot,
    triggeringActor: bot, author: bot, head, phase: "evaluate", metadataOutcome: "success",
    group: "", updateType: "version-update:semver-patch", extraGroups: "" };
  const commit = { sha: head, author: { login: bot }, committer: { login: "web-flow" }, commit: { verification: { verified: true, reason: "valid" } } };
  const state = { state: "open", user: { login: bot }, head: { sha: head }, commits: 1, auto_merge: {} as object | null };
  const pages: unknown[][] = [[commit]];
  const calls: string[][] = [];
  let reads = 0;
  const f = { input, commit, state, pages, calls, failCommits: false, failReads: false, failArm: false, failRevoke: false,
    rawPages: undefined as string | undefined, onRead: (_read: number) => {},
    execute: () => runDependabotMerge(input, args => {
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
    }) };
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
  { event: "pull_request_target" }, { event: "workflow_dispatch" }, { actor: "outside" },
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
  assert.match(caller, /if: github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
  assert.doesNotMatch(caller, /github\.(?:actor|triggering_actor)|pull_request_target/);
  assert.doesNotMatch(caller, /auto_merge_enabled/, "custom-token arm events must not revoke their own request");
});

test("custom-token arm event preserves the request; a foreign synchronize event revokes it", () => {
  const caller = parse(readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8")) as { on: { pull_request: { types: string[] } } };
  const subscribed = caller.on.pull_request.types;
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

/** Exercise the production timeout arguments with a shorter real clock in shell fixtures. */
function installFixtureTimeout(dir: string): void {
  writeFileSync(join(dir, "timeout"), `#!/bin/bash
[[ "$1" == --signal=KILL && "$2" == 60s ]] || exit 97
shift 2
duration=60s
case "$MODE" in *hang*) duration=0.3s ;; esac
exec /usr/bin/timeout --signal=KILL "$duration" "$@"
`, { mode: 0o755 });
}

for (const mode of ["external", "local", "remote-self", "load-failed", "invalid-sha", "local-ref-failed", "load-hang", "fallback-read-hang", "fallback-disable-hang", "load-retry"]) {
  test(`real workflow loader/launcher: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "dependabot-policy-"));
    const env = { ...process.env, PATH: dir + ":" + process.env.PATH, RUNNER_TEMP: dir,
      RETRY_MARKER: join(dir, "retried"), POLICY_SOURCE: join(root, "scripts/dependabot-merge.ts"), WORKFLOW_SHA: mode === "invalid-sha" ? "bad" : head,
      WORKFLOW_REF: `unbraind/pm-github/.github/workflows/pm-github-dependabot-merge.yml@${mode.startsWith("local") ? "refs/pull/7/merge" : head}`,
      CALLER_REF: "refs/pull/7/merge",
      REPOSITORY: mode.startsWith("local") || mode === "remote-self" ? "unbraind/pm-github" : "acme/widgets", PR_NUMBER: "7", MODE: mode,
      GITHUB_STEP_SUMMARY: join(dir, "summary"), EVENT_NAME: "pull_request", EVENT_ACTOR: "outside", TRIGGERING_ACTOR: "outside",
      GITHUB_OUTPUT: join(dir, "output"),
      PR_AUTHOR: bot, EVENT_HEAD: head, EXTRA_GROUPS: "", PHASE: "evaluate", RECEIPTS: join(dir, "receipts") };
    try {
      installFixtureTimeout(dir);
      writeFileSync(join(dir, "gh"), `#!/bin/bash
printf '%s\\n' "$*" >> "$RECEIPTS"
case "$*" in
  *git/ref/heads/main*) [[ "$MODE" != local-ref-failed ]] || exit 1; printf '%s' '${trusted}' ;;
  *contents/scripts*)
    [[ "$MODE" != load-hang ]] || { trap '' TERM; sleep 2; exit 0; }
    [[ "$MODE" != load-retry || -f "$RETRY_MARKER" ]] || { touch "$RETRY_MARKER"; printf partial; exit 1; }
    [[ "$MODE" != load-failed && "$MODE" != fallback-* ]] || exit 1; cat "$POLICY_SOURCE" ;;
  *'/commits?'*) printf '%s' '{"sha":"${head}","author":{"login":"outside"},"committer":{"login":"outside"}}' ;;
  'api '*) [[ "$MODE" != fallback-read-hang ]] || { trap '' TERM; sleep 2; exit 0; }; printf '%s' '{"state":"open","user":{"login":"${bot}"},"head":{"sha":"${head}"},"commits":1,"auto_merge":null}' ;;
  'pr merge '*) [[ "$MODE" != fallback-disable-hang ]] || { trap '' TERM; sleep 2; exit 0; } ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
      const loaded = spawnSync("bash", ["-c", loader()], { cwd: dir, env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      const failed = ["load-failed", "invalid-sha", "local-ref-failed", "load-hang", "fallback-read-hang"].includes(mode);
      assert.equal(loaded.status, mode === "fallback-disable-hang" ? 1 : 0, loaded.stderr);
      const receipts = readFileSync(env.RECEIPTS, "utf8");
      if (mode === "fallback-disable-hang") {
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
        assert.match(run.stdout, /::notice::Foreign or unverified commits: aaaaaaaaaaaa outside/);
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
  [[ "$MODE" != hang-read ]] || { trap '' TERM; sleep 2; exit 0; }
  [[ "$MODE" != api-error ]] || exit 1
  case "$MODE" in
    clear) payload='{"state":"open","auto_merge":null}' ;;
    closed) payload='{"state":"closed","auto_merge":{}}' ;;
    malformed-api) payload='{}' ;;
    *) payload='{"state":"open","auto_merge":{}}' ;;
  esac
  printf '%s' "$payload" | jq -r "$4"
else
  [[ "$MODE" != hang-disable ]] || { trap '' TERM; sleep 2; exit 0; }
  [[ "$MODE" != retry-disable || -f "$RETRY_MARKER" ]] || { touch "$RETRY_MARKER"; exit 1; }
  [[ "$MODE" != denied ]]
fi
`, { mode: 0o755 });
      installFixtureTimeout(dir);
      const env = { ...process.env, PATH: dir + ":" + process.env.PATH, RETRY_MARKER: join(dir, "retried"), REPOSITORY: "acme/widgets", PR_NUMBER: "7",
        MODE: mode, RECEIPTS: join(dir, "receipts"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
      const result = spawnSync("bash", ["-c", shell], { cwd: dir, env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      assert.equal(result.status, mode === "denied" || mode === "hang-disable" ? 1 : 0, result.stderr);
      if (mode === "denied" || mode === "hang-disable") assert.match(result.stdout, /Cannot revoke auto-merge/);
      else assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /cleared before tooling/);
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

for (const mode of ["retry", "exhausted", "timeout"]) {
  test(`real CLI bounded attempts discard partial output: ${mode}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "dependabot-bounded-"));
    try {
      const counter = join(dir, "count");
      const script = `const fs = require('node:fs'); const p = process.argv[1];
        const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) + 1 : 1;
        fs.writeFileSync(p, String(n));
        if (process.argv[2] === 'timeout') { process.stdout.write('partial'); process.on('SIGTERM', () => {}); setTimeout(() => { process.stdout.write('late'); process.exit(0); }, 2000); }
        else if (process.argv[2] === 'retry' && n === 3) process.stdout.write('complete');
        else { process.stdout.write('partial'); process.exit(1); }`;
      const run = () => githubCli(["-e", script, counter, mode], process.execPath, mode === "timeout" ? 500 : 5000);
      if (mode === "retry") assert.equal(run(), "complete");
      else assert.throws(run, /failed or timed out after 3 bounded attempts/);
      assert.equal(readFileSync(counter, "utf8"), "3");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

/** Execute reusable closeout publication against real SDK trackers and isolated Git remotes. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workflowCorpus } from "./support/corpus.ts";

const publicationCorpus = workflowCorpus(test, "closeout-publication");
const publicationTest = publicationCorpus.test;
import { get, update } from "@unbrained/pm-cli/sdk";
import { bash, branch, cli, command, finish, fixture, repoRoot, setup, shell, sync, title, unpublished, workflow, type WorkflowFixture } from "./helpers/closeout-workflow.ts";

publicationTest("closeout contract keeps sync safety helpers, exact pins, env bindings and least privilege", () => {
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
  const policy = "Check caller changelog policy";
  const noDeliveries = '[[ "${CLOSEOUT_CLOSED}" == 0 && "${CLOSEOUT_REVIEW:-0}" == 0 ]] || ';
  assert.ok(shell(policy).includes(noDeliveries));
  assert.equal(shell(policy).replace(noDeliveries, ""), shell(policy, sync));
  // Sync adds rule receipts and installation-failure cleanup. Compare the
  // unchanged publication boundaries directly, rather than diagnostic wrappers.
  const scopes = [shell("Resolve sync commit scope"), shell("Resolve sync commit scope", sync)];
  assert.equal(scopes[0]!.split("report_workflow_failure()")[0], scopes[1]!.split("report_workflow_failure()")[0]);
  assert.equal(scopes[0]!.split("mapfile -t sync_scope")[1]!.split("restore_sync_setup()")[0],
    scopes[1]!.split("mapfile -t sync_scope")[1]!.split("restore_sync_setup()")[0]);
  for (const name of ["check_generated_paths_clean", "restore_sync_setup", "restore_workflow_setup_artifacts", "check_sync_setup_clean", "check_sync_scope", "check_sync_path", "changelog_policy_hash", "verify_changelog_policy", "stage_sync_paths", "run_generated_post_script"]) {
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

for (const [kind, source, script] of [["sync", sync, "POST_IMPORT_SCRIPT"], ["closeout", workflow, "POST_CLOSEOUT_SCRIPT"]] as const) {
  test(`${kind} generated artifact declarations are literal root files and require an npm script`, async () => {
    assert.match(source, /generated-paths:\n\s+description:[^\n]+\n\s+type: string\n\s+required: false\n\s+default: ""/);
    assert.match(source, /GENERATED_PATHS: \$\{\{ inputs\.generated-paths \}\}/);
    const validate = shell(`Validate ${kind} inputs`, source);
    const env = { ...process.env, REPOSITORY: "acme/widgets", CALLING_REPOSITORY: "acme/widgets",
      PM_GITHUB_VERSION: "2026.11.24", DEFAULT_BRANCH: "main",
      SYNC_BRANCH: kind === "sync" ? "automation/fixture" : branch, [script]: "self-host:write" };
    const forbidden = [".github/workflows/x.yml", "nested/artifact", "../artifact", "/artifact", ".gitattributes",
      ":(glob)*", "out.*", "-flag", "package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lockb",
      "pnpm-lock.yaml", "Pipfile.lock", "packages.lock.json", "gradle.lockfile", "go.sum", "CHANGELOG.md"];
    for (const paths of forbidden) {
      const result = await bash(validate, repoRoot, { ...env, GENERATED_PATHS: paths });
      assert.equal(result.code, 1, paths);
      assert.match(result.out, /generated-paths must/);
    }
    const missing = await bash(validate, repoRoot, { ...env, [script]: "", GENERATED_PATHS: "selfhost.bundle" });
    assert.equal(missing.code, 1, missing.out);
    assert.match(missing.out, /generated-paths requires a caller npm post-script/);
    for (const paths of ["", " \t\n", "selfhost.bundle\nsource.snapshot"]) {
      const result = await bash(validate, repoRoot, { ...env, GENERATED_PATHS: paths });
      assert.equal(result.code, 0, result.out);
    }
  });
}

publicationTest("sync and closeout commit only the policy-verified tree with caller hooks disabled", async t => {
  for (const [kind, source] of [["sync", sync], ["closeout", workflow]] as const) {
    const root = mkdtempSync(join(tmpdir(), "publication-commit-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]) => command(root, "git", args);
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", ".git/caller-hooks");
    mkdirSync(join(root, ".git/caller-hooks"));
    mkdirSync(join(root, "tracker"));
    for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      writeFileSync(join(root, ".git/caller-hooks", name),
        '#!/bin/sh\nprintf "caller hook ran\\n" > hook-ran\nprintf "unchecked\\n" > CHANGELOG.md\ngit add -- CHANGELOG.md\n',
        { mode: 0o755 });
    }
    writeFileSync(join(root, "CHANGELOG.md"), "verified changelog\n");
    writeFileSync(join(root, "tracker/item.toon"), "verified tracker\n");
    git("add", "--", "CHANGELOG.md", "tracker/item.toon");
    writeFileSync(join(root, "pm-github-sync-commit-paths"), "CHANGELOG.md\0tracker/item.toon\0");
    const publication = shell(`Commit gated ${kind} changes and open review PR`, source);
    const boundary = publication.slice(publication.lastIndexOf("\nverify_changelog_policy\n") + 1, publication.indexOf("\ngh auth setup-git"));
    // The closeout slice starts after the plan-derived title, so supply it as the
    // workflow environment would; the sync boundary keeps its literal message.
    const result = await bash('closeout_title="fixture publication title"\nsync_scope=(tracker CHANGELOG.md)\nverify_changelog_policy() { :; }\n' + boundary, root,
      { ...process.env, RUNNER_TEMP: root });
    assert.equal(result.code, 0, result.out);
    assert.equal(existsSync(join(root, "hook-ran")), false, kind);
    assert.equal(git("show", "HEAD:CHANGELOG.md"), "verified changelog");
    assert.equal(git("show", "HEAD:tracker/item.toon"), "verified tracker");

    writeFileSync(join(root, "CHANGELOG.md"), "unstaged changelog\n");
    const drift = await bash('closeout_title="fixture publication title"\nsync_scope=(tracker CHANGELOG.md)\nverify_changelog_policy() { :; }\n' + boundary, root,
      { ...process.env, RUNNER_TEMP: root });
    assert.notEqual(drift.code, 0, drift.out);
    assert.match(drift.out, /committed changelog or tracker differs from the verified index/);
  }
});

publicationTest("schedule without repository payload resolves trunk; clean closeout opens one PR and repeat edits it", async () => fixture(async f => {
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
  const paths = f.git("diff-tree", "--no-commit-id", "--name-only", "-r", published).split("\n");
  assert.ok(paths.includes("CHANGELOG.md"));
  assert.ok(paths.includes(`.agents/pm/tasks/${f.id}.toon`));
  const second = await f.run([...setup, ...finish]);
  assert.equal(second.code, 0, second.out);
  const receipts = readFileSync(f.env.RECEIPTS!, "utf8");
  assert.equal(receipts.split("\n").filter(line => line.startsWith("pr create ")).length, 1);
  assert.equal(receipts.split("\n").filter(line => line.startsWith("pr edit 7 ")).length, 1);
  assert.equal(receipts.split("\n").filter(line => line.startsWith("workflow run ci.yml ")).length, 2);
  assert.ok(receipts.includes(`--title ${title}`));
}));

/** Configure the caller's real npm policy and any lifecycle hooks. */
function installChangelogCheck({ root, git }: WorkflowFixture, scripts: Record<string, string>): void {
  const manifest = join(root, "tools/oracle/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { scripts: Record<string, string> };
  Object.assign(pkg.scripts, scripts);
  writeFileSync(manifest, JSON.stringify(pkg));
  git("add", "--", "tools/oracle/package.json");
  git("commit", "-qm", "Configure caller changelog check");
  git("push", "origin", "trunk");
}

test("generated artifact targets must be clean at checkout and publishable after the hook", async () => fixture(async f => {
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  appendFileSync(join(f.root, ".gitignore"), "ignored.bundle\n");
  const dirty = join(f.root, "ignored.bundle");
  const scope = ["Resolve sync commit scope"];
  writeFileSync(dirty, "existing output\n");
  f.env.GENERATED_PATHS = "ignored.bundle";
  const preexisting = await f.run(scope);
  assert.equal(preexisting.code, 1, preexisting.out);
  assert.match(preexisting.out, /must match HEAD before running/);
  assert.equal(readFileSync(dirty, "utf8"), "existing output\n");
  rmSync(dirty);

  const link = join(f.root, "link.bundle");
  symlinkSync("CHANGELOG.md", link);
  f.git("add", "--", "link.bundle");
  f.git("commit", "-qm", "Fixture committed symlink");
  for (const target of ["link.bundle", "tools"]) {
    f.env.GENERATED_PATHS = target;
    const nonFile = await f.run(scope);
    assert.equal(nonFile.code, 1, nonFile.out);
    assert.match(nonFile.out, /must be regular root files/);
  }

  const pkg = join(f.root, "tools/oracle/package.json");
  writeFileSync(pkg, JSON.stringify({ scripts: {
    "fixture:ignore": "printf output > ../../ignored.bundle",
    "fixture:link": "ln -s CHANGELOG.md ../../new.bundle",
    "fixture:skip": "node -e ''",
  } }));
  const closed = await f.run(["Close delivered tracker items"]);
  assert.equal(closed.code, 0, closed.out);
  for (const [target, script] of [["ignored.bundle", "fixture:ignore"], ["new.bundle", "fixture:link"], ["missing.bundle", "fixture:skip"]] as const) {
    Object.assign(f.env, { GENERATED_PATHS: target, POST_CLOSEOUT_SCRIPT: script });
    const refused = await f.run([...scope, "Run caller post-closeout script"]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /as a regular, publishable file/);
  }
  unpublished(f.git);
}));

for (const lateWrite of [false, true]) {
  test(lateWrite ? "closeout policy rejects caller changes to a generated artifact" : "closeout publishes a declared generated artifact with the delivered item", async () => fixture(async f => {
    const generator = "generated-artifact.mts";
    writeFileSync(join(f.root, generator), readFileSync(join(repoRoot, "test/fixtures/generated-artifact-consumer.ts")));
    f.git("add", "--", generator);
    f.git("commit", "-qm", "Add fixture bundle generator");
    installChangelogCheck(f, {
      "closeout:generate": `npm run changelog:full && cd ../.. && node ${generator}`,
      "accept:self-host": `cd ../.. && node ${generator} --check`,
      ...(lateWrite ? { "changelog:check": "printf 'unverified\\n' >> ../../selfhost.bundle" } : {}),
    });
    f.env.GENERATED_PATHS = "selfhost.bundle";
    f.env.POST_CLOSEOUT_SCRIPT = "closeout:generate";
    const parent = f.git("rev-parse", "HEAD");
    const result = await f.run([...setup, ...finish]);
    if (lateWrite) {
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /Caller changelog policy modified.*declared generated file/);
      assert.equal(f.git("rev-parse", "HEAD"), parent);
      unpublished(f.git);
      return;
    }
    assert.equal(result.code, 0, result.out);
    assert.equal(f.git("rev-parse", "HEAD^"), parent);
    const paths = f.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    assert.ok(paths.includes(`.agents/pm/tasks/${f.id}.toon`));
    assert.ok(paths.includes("CHANGELOG.md"));
    assert.ok(paths.includes("selfhost.bundle"));
    assert.equal(f.git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0], f.git("rev-parse", "HEAD"));
    const acceptance = await bash("npm run accept:self-host", join(f.root, "tools/oracle"), f.env);
    assert.equal(acceptance.code, 0, acceptance.out);
  }));
}

publicationTest("a failing caller changelog check blocks closeout publication", async () => fixture(async f => {
  installChangelogCheck(f, { "changelog:check": "node -e 'process.exit(23)'" });
  const baseHead = f.git("rev-parse", "HEAD");
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /::error::Caller changelog policy failed \(npm run changelog:check\)/);
  assert.match(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), /Verified delivery/);
  assert.equal(f.git("rev-parse", "HEAD"), baseHead);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

publicationTest("a successful closeout changelog check cannot publish a post-hook tracker change", async () => fixture(async f => {
  const trackerFile = `../../.agents/pm/tasks/${f.id}.toon`;
  installChangelogCheck(f, {
    "changelog:check": "node -e ''",
    "postchangelog:check": `node -e 'require("node:fs").appendFileSync(process.argv[1], "\\n")' ${trackerFile}`,
  });
  const baseHead = f.git("rev-parse", "HEAD");
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /^> (?:\S+ )?postchangelog:check$/m);
  assert.match(result.out, /Caller changelog policy modified CHANGELOG.md or tracker files/);
  assert.equal(f.git("rev-parse", "HEAD"), baseHead);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

publicationTest("scheduled closeout follows verified numeric pagination with declared checks and publishes delivery", async () => fixture(async f => {
  Object.assign(f.env, { NUMERIC_PAGINATION: "true", PROTECTION_DENIED: "true", REQUIRED_CHECKS: "CI" });
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "closed");
  assert.equal(existsSync(f.env.PR_STATE!), true);
}));

publicationTest("malicious tracker acceptance criteria fails the final privacy gate before any remote write", async () => fixture(async f => {
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { acceptanceCriteria: "ghp_" + "A".repeat(36) }, { pmRoot: f.pmRoot, noExtensions: true });
  const result = await f.run(finish);
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /github-token-classic|fail/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

publicationTest("a no-op closeout skips a failing caller check, discards changelog drift and closes a stale review", async () => fixture(async f => {
  installChangelogCheck(f, { "changelog:check": "node -e 'process.exit(23)'" });
  const changelog = join(f.root, "CHANGELOG.md");
  const original = readFileSync(changelog);
  f.env.NO_DELIVERY = "true";
  writeFileSync(f.env.PR_STATE!, "");
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /^> (?:\S+ )?changelog:check$/m);
  assert.match(result.out, /no branch or PR/);
  assert.match(result.out, /changelog differs from a fresh regeneration/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
  const calls = readFileSync(f.env.RECEIPTS!, "utf8");
  assert.match(calls, /^pr close 7 /m);
  assert.doesNotMatch(calls, /^pr (create|edit) |^workflow run /m);
  assert.deepEqual(readFileSync(changelog), original);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
}));

publicationTest("permission-limited read token fails closed with a clear diagnostic", async () => fixture(async f => {
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

publicationTest("SDK close validation reports the exact item and field in the published refusal", async () => fixture(async f => {
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { tags: "requires-review" }, { pmRoot: f.pmRoot, noExtensions: true });
  const policy = { id: "review-required", description: "Private policy prose", effect: "refuse",
    subject: { tags: ["requires-review"], operations: ["close"] }, rule: { kind: "require_fields", fields: ["reviewer"] } };
  command(f.root, cli, ["--path", f.pmRoot, "schema", "policy-put", policy.id, "--definition", JSON.stringify(policy)], f.env);
  command(f.root, cli, ["--path", f.pmRoot, "schema", "policy-mode", "refuse"], f.env);
  const result = await f.run(finish);
  assert.equal(result.code, 0, result.out);
  const report = JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as { failed: number; plan: { item: string; action: string; code: string; reason: string }[] };
  assert.equal(report.failed, 0);
  assert.equal(report.plan[0]!.item, f.id);
  assert.equal(report.plan[0]!.action, "refuse");
  assert.equal(report.plan[0]!.code, "close_refused");
  assert.match(report.plan[0]!.reason, /workflow_policy_refused/);
  assert.match(report.plan[0]!.reason, /reviewer/);
  assert.ok(!JSON.stringify(report).includes("Private policy prose"));
  const review = JSON.parse(f.git("show", `refs/remotes/origin/${branch}:.agents/pm/closeout-review.json`)) as { refused: { item: string; action: string; reason: string; missing_evidence: { code: string }[] }[] };
  assert.equal(review.refused[0]!.item, f.id);
  assert.equal(review.refused[0]!.action, "refuse");
  assert.match(review.refused[0]!.reason, /reviewer/);
  assert.equal(review.refused[0]!.missing_evidence[0]!.code, "close_refused");
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
}));

publicationTest("workflow refusal reporter emits one precise annotation and withholds private receipt values", async () => fixture(async f => {
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
    assert.doesNotMatch(result.out, /unbound variable/);
    assert.match(result.out, expected);
    assert.ok(!result.out.includes(secret));
    unpublished(f.git);
  }
}));

publicationTest("PR-write and dispatch restrictions fail clearly and never alter the default branch", async () => {
  for (const denied of ["PR_DENIED", "DISPATCH_DENIED"]) await fixture(async f => {
    const head = f.git("rev-parse", "HEAD");
    f.env[denied] = "true";
    const result = await f.run([...setup, ...finish]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, denied === "PR_DENIED" ? /token requires contents:write and pull-requests:write/ : /token requires actions:write/);
    assert.equal(f.git("ls-remote", "origin", "refs/heads/trunk").split(/\s/)[0], head);
  });
});

publicationTest("default-branch guard refuses non-default refs and unresolved metadata before tracker edits", async () => {
  for (const mode of ["wrong-ref", "unresolved", "payload-fallback"]) await fixture(async f => {
    if (mode === "wrong-ref") f.env.RUN_REF = "refs/heads/feature";
    else f.env.API_DENIED = "true";
    if (mode === "payload-fallback") f.env.EVENT_DEFAULT_BRANCH = "trunk";
    const result = await f.run(["Require caller default branch"]);
    assert.equal(result.code, mode === "payload-fallback" ? 0 : 1, result.out);
    unpublished(f.git);
  });
});

publicationTest("contents-write denial rejects the leased push before PR creation", async () => fixture(async f => {
  writeFileSync(join(f.base, "remote.git/hooks/pre-receive"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  const result = await f.run([...setup, ...finish]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /token requires contents:write/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

publicationTest("zero closes refuses caller-only tracker drift as an empty closeout PR", async () => fixture(async f => {
  f.env.NO_DELIVERY = "true";
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { title: "Caller observation without delivery" }, { pmRoot: f.pmRoot, noExtensions: true });
  const result = await f.run(finish);
  assert.equal(result.code, 0, result.out);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

publicationTest("behavioural revert: removing only the staged privacy scan publishes malicious tracker content", async () => fixture(async f => {
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

publicationTest("behavioural revert: removing only the no-op guard opens a PR with zero closes", async () => fixture(async f => {
  f.env.NO_DELIVERY = "true";
  const prepared = await f.run(setup);
  assert.equal(prepared.code, 0, prepared.out);
  await update(f.id, { title: "Caller observation without delivery" }, { pmRoot: f.pmRoot, noExtensions: true });
  const publication = workflow.indexOf("      - name: Commit gated closeout changes and open review PR");
  assert.ok(publication >= 0);
  const mutant = workflow.slice(0, publication) + workflow.slice(publication).replace(
    'if [[ "${CLOSEOUT_CLOSED}" == 0 && "${CLOSEOUT_REVIEW:-0}" == 0 ]] || git diff --cached --quiet -- "${tracker_scope[@]}"; then',
    "if false; then",
  );
  assert.notEqual(mutant, workflow);
  const result = await f.run(finish, mutant);
  assert.equal(result.code, 0, result.out);
  assert.equal(existsSync(f.env.PR_STATE!), true);
  assert.equal((JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as { closed: number }).closed, 0);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
}));

publicationTest("closeout inputs reject cross-repo writes, floating pins, command injection and a default bot branch", async () => fixture(async f => {
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

publicationTest("an explicit lease refuses a competing bot-branch writer", async () => fixture(async f => {
  const split = finish.indexOf("Validate publication credentials");
  const prepared = await f.run([...setup, ...finish.slice(0, split)]);
  assert.equal(prepared.code, 0, prepared.out);
  f.git("push", "origin", `trunk:refs/heads/${branch}`);
  const competingHead = f.git("rev-parse", "trunk");
  const result = await f.run(finish.slice(split));
  assert.notEqual(result.code, 0);
  assert.match(result.out, /stale info|rejected/);
  assert.equal(f.git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0], competingHead);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

for (const mode of ["unlinked", "foreign", "terminal", "local", "incomplete", "unlinked-incomplete"]) {
  publicationTest(`unavailable evidence is scoped to local tracker refusals: ${mode}`, async () => fixture(async f => {
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

publicationTest("compact PR summary is privacy gated before the bot branch is published", async () => fixture(async f => {
  f.env.SUMMARY_ITEM = "ghp_" + "A".repeat(36);
  const result = await f.run([...setup, ...finish]);
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /github-token-classic/);
  unpublished(f.git);
  assert.equal(existsSync(f.env.PR_STATE!), false);
}));

for (const mode of ["undeclared", "blank", "missing", "neutral", "skipped", "pending", "success", "metadata"]) {
  publicationTest(`required-check metadata boundary ${mode} uses the real workflow and command`, async () => fixture(async f => {
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
  publicationTest(`newline required contexts ${scenario} survive the real workflow and command`, async () => fixture(async f => {
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


publicationTest("ambiguous deliveries open a review-only PR listing every candidate and leave the item open", async () => fixture(async f => {
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


/** Publish a policy refusal and verify the attribution saved for the attempted close. */
async function verifyPublishedPolicyRefusal(f: WorkflowFixture, selectedPr: number, candidates: readonly number[]): Promise<void> {
  if (candidates.length > 1) {
    f.env.AMBIGUOUS = "true";
    await update(f.id, { tags: `delivery-pr:https://github.com/acme/widgets/pull/${selectedPr}` }, { pmRoot: f.pmRoot, noExtensions: true });
    f.git("add", "--", `.agents/pm/tasks/${f.id}.toon`, `.agents/pm/history/${f.id}.jsonl`);
  }
  const policy = { id: "completeness-task", description: "Closing without recorded steps leaves no evidence", effect: "refuse",
    subject: { types: ["Task"], operations: ["close"] }, rule: { kind: "require_fields", fields: ["repro_steps"] } };
  for (const args of [["policy-put", policy.id, "--definition", JSON.stringify(policy)], ["policy-mode", "refuse"]] as const) {
    command(f.root, cli, ["--pm-path", f.pmRoot, "schema", ...args], f.env);
  }
  f.git("add", "--", ".agents/pm/schema/policies.json", ".agents/pm/settings.json");
  f.git("commit", "-qm", "Add close completeness policy");
  f.git("push", "-q", "origin", "trunk");
  const before = readFileSync(join(f.pmRoot, "tasks", `${f.id}.toon`), "utf8");
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
  assert.equal(readFileSync(join(f.pmRoot, "tasks", `${f.id}.toon`), "utf8"), before);
  assert.equal(existsSync(f.env.PR_STATE!), true);
  const body = readFileSync(f.env.PR_BODY!, "utf8");
  assert.match(body, /"action": "refuse"/);
  assert.match(body, /"code": "close_refused"/);
  assert.match(body, new RegExp(`refuse ${candidates.length}\\b`));
  assert.match(body, /Automatic merge is disabled because the plan holds items for review \(delivery attribution or policy-refused closes\)/);
  assert.match(result.out, /automatic landing is disabled/);
  assert.doesNotMatch(readFileSync(f.env.RECEIPTS!, "utf8"), /--auto --squash/);
  const published = f.git("show", `refs/remotes/origin/${branch}:.agents/pm/closeout-review.json`);
  const review = JSON.parse(published) as { needs_review: unknown[]; refused: {
    item: string; action: string; pr: number; candidates?: number[]; reason: string;
    missing_evidence: { pr: number; code: string; reason: string }[];
  }[] };
  assert.deepEqual(review.needs_review, []);
  assert.equal(review.refused.length, 1);
  const [refusal] = review.refused;
  assert.ok(refusal);
  assert.equal(refusal.item, f.id);
  assert.equal(refusal.action, "refuse");
  assert.equal(refusal.pr, selectedPr);
  assert.deepEqual(refusal.candidates ?? [refusal.pr], candidates);
  assert.match(refusal.reason, /workflow_policy_refused/);
  assert.match(refusal.reason, /repro_steps/);
  assert.deepEqual(refusal.missing_evidence, [{ pr: selectedPr, code: "close_refused", reason: refusal.reason }]);
}

publicationTest("a policy-refused close publishes PR #42 with its candidate evidence", async () =>
  fixture(f => verifyPublishedPolicyRefusal(f, 42, [42])));
// Always exercise the attempted-PR regression, including in the quick workflow corpus.
test("a policy-refused close publishes PR #43 with its candidate evidence", async () =>
  fixture(f => verifyPublishedPolicyRefusal(f, 43, [42, 43])));

publicationTest("earlier armed auto-merge is disabled before a later hold updates the reused PR", async () => fixture(async f => {
  f.env.APP_DEADLINE = String(Math.floor(Date.now() / 1000) + 600);
  const first = await f.run([...setup, ...finish]);
  assert.equal(first.code, 0, first.out);
  assert.equal(existsSync(f.env.AUTO_STATE!), true);
  f.env.AMBIGUOUS = "true";
  const second = await f.run([...setup, ...finish]);
  assert.equal(second.code, 0, second.out);
  assert.equal(existsSync(f.env.AUTO_STATE!), false);
  assert.equal(existsSync(f.env.ARMED_EDIT!), false, "held branch must be disarmed before updating its PR");
  assert.match(readFileSync(f.env.PR_BODY!, "utf8"), /Automatic merge is disabled because the plan holds items for review \(delivery attribution or policy-refused closes\)/);
  assert.match(readFileSync(f.env.RECEIPTS!, "utf8"), /pr merge 7 -R acme\/widgets --disable-auto/);
}));

publicationTest("informational parked-run failure preserves armed auto-merge through always cleanup", async () => fixture(async f => {
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
  publicationTest(`previous auto-merge is revoked on workflow exit: ${mode}`, async () => fixture(async f => {
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


publicationTest("confirmed unmerged references cannot block publication of a unique merged delivery", async () => fixture(async f => {
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

publicationCorpus.register();

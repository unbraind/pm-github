/** Execute the reusable workflow's real bash against SDK trackers and isolated Git remotes. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, get, update } from "@unbrained/pm-cli/sdk";
import { jsonResponse, startMockGithub } from "./helpers/mock-github-server.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const workflow = readFileSync(join(repoRoot, ".github/workflows/pm-github-closeout.yml"), "utf8");
const sync = readFileSync(join(repoRoot, ".github/workflows/pm-github-sync.yml"), "utf8");
const cli = join(repoRoot, "node_modules/.bin/pm");
const branch = "pm-github/closeout";
const title = "chore(pm): close items delivered by merged pull requests";
const version = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const packedRoot = mkdtempSync(join(tmpdir(), "closeout-package-"));
let archive: string;

/** Extract executable bash from a named real workflow step. */
function shell(name: string, source = workflow): string {
  const step = source.split("      - name: ").find(part => part.startsWith(name + "\n"));
  assert.ok(step, name);
  const block = /        run: \|\n([\s\S]*)/.exec(step);
  if (block) return block[1]!.split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
  const single = /        run: (.+)/.exec(step);
  assert.ok(single, name);
  return single[1]!;
}

/** Await a real shell while the HTTP evidence fixture continues serving requests. */
function bash(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", ["-c", "set -euo pipefail\n" + script], { cwd, env });
    let out = "";
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.on("error", reject);
    child.on("close", code => resolveResult({ code, out, stdout }));
  });
}

/** Check a synchronous setup command without replacing its behavior. */
function command(cwd: string, executable: string, args: string[], env = process.env): string {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}

test.before(async () => {
  const result = await bash('npm pack --ignore-scripts --foreground-scripts=false --json --pack-destination "$PACK_DEST"', repoRoot,
    { ...process.env, PACK_DEST: packedRoot, PM_PATH: join(repoRoot, ".agents/pm") });
  assert.equal(result.code, 0, result.out);
  // First-use npm notices can follow JSON on stderr; parse only the stdout receipt.
  const receipt = result.stdout;
  archive = join(packedRoot, (JSON.parse(receipt) as [{ filename: string }])[0].filename);
});
test.after(() => rmSync(packedRoot, { recursive: true, force: true }));

/** A real caller with one eligible item, nested npm dependencies, and a local publication boundary. */
async function fixture(fn: (f: { root: string; base: string; pmRoot: string; id: string; env: NodeJS.ProcessEnv;
  run: (names: string[], source?: string) => ReturnType<typeof bash>; git: (...args: string[]) => string }) => Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "closeout-caller-"));
  const root = join(base, "caller");
  const remote = join(base, "remote.git");
  mkdirSync(root);
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(base, "global"),
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com" };
  const git = (...args: string[]) => command(root, "git", args, env);
  const pmRoot = join(root, ".agents/pm");
  command(root, "git", ["init", "--bare", remote], env);
  git("init", "-b", "trunk");
  command(root, cli, ["--pm-path", pmRoot, "init", "fixture"], env);
  const item = await create({ title: "Verified delivery", type: "Task", author: "fixture", acceptanceCriteria: "Delivery verified" }, { pmRoot, noExtensions: true });
  const id = item.item.id;
  await update(id, { status: "in_progress" }, { pmRoot, noExtensions: true });
  const project = join(root, "tools/oracle");
  mkdirSync(join(project, "node_modules/@unbrained"), { recursive: true });
  mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules/@unbrained/pm-cli"), join(project, "node_modules/@unbrained/pm-cli"));
  symlinkSync(cli, join(project, "node_modules/.bin/pm"));
  const generator = join(repoRoot, "node_modules/pm-changelog/dist/cli.js");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "2026.10.15", scripts: {
    "changelog:full": `node ${JSON.stringify(generator)} --pm-root ../../.agents/pm --mode replace --output ../../CHANGELOG.md --status closed --date-from-version --release-version-from-package`,
  } }));
  appendFileSync(join(root, ".gitignore"), "node_modules/\n.agents/pm/extensions/\n.agents/pm/locks/\n.agents/pm/checkpoints/\n");
  writeFileSync(join(root, "CHANGELOG.md"), "Caller changelog before closeout\n");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/ci.yml"), "on: workflow_dispatch\n");
  command(root, cli, ["--pm-path", pmRoot, "merge", "install"], env);
  git("add", "--", ".gitattributes", ".agents/pm", ".gitignore", "CHANGELOG.md", "tools/oracle/package.json", ".github/workflows/ci.yml");
  git("commit", "-qm", "Initialize caller");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "trunk");
  const tools = join(base, "commands");
  mkdirSync(tools);
  writeFileSync(join(tools, "npm"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == ci ]]; then [[ "$2" == --ignore-scripts ]] || exit 94; exit 0; fi
exec "$REAL_NPM" "$@"
`, { mode: 0o755 });
  writeFileSync(join(tools, "pm"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == 'package install' ]]; then
  [[ "$3" == "npm:pm-github@$PM_GITHUB_VERSION" && "$4" == --project ]] || exit 95
  exec "$REAL_PM" package install "$ARCHIVE" --project
fi
exec "$REAL_PM" "$@"
`, { mode: 0o755 });
  writeFileSync(join(tools, "gh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RECEIPTS"
case "$1 $2" in
  "api repos/acme/widgets") [[ "\${API_DENIED:-false}" != true ]] || exit 1; printf '%s' "\${API_BRANCH:-trunk}" ;;
  "auth setup-git") ;;
  "pr list")
    if [[ -f "$PR_STATE" ]]; then
      printf '[{"number":7,"headRepository":{"name":"widgets"},"headRepositoryOwner":{"login":"acme"},"isCrossRepository":false}]'
    else printf '[{"number":99,"isCrossRepository":true}]'; fi ;;
  "pr create"|"pr edit")
    [[ "\${PR_DENIED:-false}" != true ]] || exit 1
    touch "$PR_STATE"
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --body-file ]]; then cp "$2" "$PR_BODY"; break; fi
      shift
    done ;;
  "pr close") rm -f "$PR_STATE" ;;
  "workflow run") [[ "\${DISPATCH_DENIED:-false}" != true ]] || exit 1 ;;
  "run list") ;;
  *) exit 96 ;;
esac
`, { mode: 0o755 });
  Object.assign(env, { PATH: tools + ":" + project + "/node_modules/.bin:" + process.env.PATH,
    REAL_PM: cli, REAL_NPM: command(root, "bash", ["-c", "command -v npm"]), ARCHIVE: archive,
    PM_PATH: pmRoot, GH_TOKEN: "synthetic-token", GITHUB_TOKEN: "synthetic-token", REPOSITORY: "acme/widgets",
    CALLING_REPOSITORY: "acme/widgets", GITHUB_REPOSITORY: "acme/widgets", RUN_REF: "refs/heads/trunk",
    EVENT_DEFAULT_BRANCH: "", GITHUB_WORKSPACE: root, NPM_PROJECT_DIR: "tools/oracle", PM_GITHUB_VERSION: version,
    SYNC_BRANCH: branch, POST_CLOSEOUT_SCRIPT: "changelog:full", CI_WORKFLOWS: "ci.yml", RUNNER_TEMP: base,
    GITHUB_ENV: join(base, "job-env"), GITHUB_OUTPUT: join(base, "job-output"), GITHUB_PATH: join(base, "job-path"),
    PR_STATE: join(base, "pr-state"), PR_BODY: join(base, "pr-body"), RECEIPTS: join(base, "receipts") });
  const server = await startMockGithub((req, res) => {
    const url = req.url!;
    if (url.includes("/check-runs")) env.HEAD_LOOKUPS = String(Number(env.HEAD_LOOKUPS ?? 0) + 1);
    if (env.READ_DENIED === "true" || (env.CHECKS_DENIED === "true" && url.includes("/check-runs"))) { jsonResponse(res, 403, { message: "Resource not accessible by integration" }); return; }
    const sha = "a".repeat(40);
    if (url.includes("/pulls?")) jsonResponse(res, 200, env.NO_DELIVERY === "true" ? [] : [{ number: 42, merged_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" }]);
    else if (url.endsWith("/pulls/42")) jsonResponse(res, 200, { number: 42, body: env.NO_LINKS === "true" ? "Routine maintenance" : `https://github.com/${env.FOREIGN_LINK === "true" ? "other/project" : "acme/widgets"}/blob/main/.agents/pm/tasks/${id}.toon${env.SUMMARY_ROWS === "true" ? `\nhttps://github.com/other/project/blob/main/.agents/pm/tasks/${id}.toon` : ""}${env.SUMMARY_ITEM ? `\nhttps://github.com/acme/widgets/blob/main/.agents/pm/tasks/${env.SUMMARY_ITEM}.toon` : ""}`,
      merged: true, merged_at: "2026-10-15T00:00:00Z", merge_commit_sha: env.INCOMPLETE_MERGE === "true" ? null : "b".repeat(40), html_url: "https://github.com/acme/widgets/pull/42",
      head: { sha }, base: { ref: "trunk", repo: { full_name: "acme/widgets" } } });
    else if (url.includes("/protection/")) jsonResponse(res, 200, { contexts: ["CI"], checks: [] });
    else if (url.includes("/rules/branches/")) jsonResponse(res, 200, []);
    else if (url.includes("/check-runs")) jsonResponse(res, 200, { total_count: 1, check_runs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "success", app: { id: 7 } }] });
    else if (url.includes("/statuses")) jsonResponse(res, 200, []);
    else jsonResponse(res, 404, {});
  });
  Object.assign(env, { PM_GITHUB_API_BASE: server.baseUrl });
  const run = (names: string[], source = workflow) => bash(names.map(name => `(
set -a
if [[ -f "$GITHUB_ENV" ]]; then source "$GITHUB_ENV"; fi
set +a
${shell(name, source)}
)`).join("\n"), root, env);
  try { await fn({ root, base, pmRoot, id, env, run, git }); }
  finally {
    await server.close();
    // The pm CLI's detached telemetry flush can still be writing under PM_GLOBAL_PATH/runtime/telemetry
    // when the caller exits; retry the removal as import-gate.test.ts does (upstream pm-cli#1423, #1484).
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const setup = ["Require caller default branch", "Validate closeout inputs", "Validate npm project directory", "Prepare sync branch from default branch",
  "Install dependencies", "Resolve sync commit scope", "Install pinned pm-github extension", "Configure PM merge drivers", "Verify gate is available"];
const finish = ["Close delivered tracker items", "Run caller post-closeout script", "Gate tracker and regenerated changelog", "Verify strict pm health",
  "Commit gated closeout changes and open review PR", "Dispatch caller CI and report parked runs"];

/** No remote bot ref is the publication invariant for every refused or no-op run. */
function unpublished(git: (...args: string[]) => string): void {
  assert.equal(git("ls-remote", "origin", `refs/heads/${branch}`), "");
}

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
  for (const name of ["Validate npm project directory", "Resolve sync commit scope", "Install dependencies", "Install pinned pm-github extension", "Gate tracker and regenerated changelog", "Verify strict pm health"]) {
    assert.equal(shell(name), shell(name, sync), name);
  }
  assert.match(workflow, /--force-with-lease="refs\/heads\/\$\{SYNC_BRANCH\}:\$\{SYNC_LEASE\}"/);
  assert.match(workflow, /--since 1970-01-01 --apply --json/);
  for (const action of workflow.matchAll(/uses: (actions\/[^@]+)@([^\s]+)/g)) assert.match(action[2]!, /^[a-f0-9]{40}$/);
  const caller = readFileSync(join(repoRoot, "docs/closeout-workflow-caller.yml"), "utf8");
  assert.match(caller, /schedule:/);
  assert.match(caller, /workflow_dispatch:/);
  assert.match(caller, /npm-project-dir: "\."/);
  assert.match(caller, /@RELEASE_COMMIT_SHA/);
  assert.match(caller, /checks: read/);
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
  assert.match(result.out, /Closeout refused; check token read access/);
  unpublished(f.git);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
  Object.assign(f.env, { READ_DENIED: "false", CHECKS_DENIED: "true" });
  const checks = await f.run(finish);
  assert.notEqual(checks.code, 0);
  assert.match(checks.out, /Closeout refused; check token read access/);
  unpublished(f.git);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
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
  const mutant = workflow.replace('if [[ "${CLOSEOUT_CLOSED}" == 0 ]] || git diff --cached --quiet -- "${sync_scope[0]}" "${sync_scope[@]:2}"; then', "if false; then");
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
    assert.equal(result.code, mode === "local" || mode === "incomplete" ? 1 : 0, result.out);
    if (mode === "local") assert.match(result.out, /token read access to head checks for linked local tracker items/);
    if (mode === "incomplete") {
      assert.match(result.out, /incomplete merged-PR metadata blocks a linked local tracker item/);
      assert.equal(f.env.HEAD_LOOKUPS, undefined);
    }
    unpublished(f.git);
    assert.equal(existsSync(f.env.PR_STATE!), false);
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

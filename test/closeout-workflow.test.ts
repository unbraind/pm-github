/** Execute the reusable workflow's real bash against SDK trackers and isolated Git remotes. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { runWithReproducibleProcessEnvironment, create, get, update } from "@unbrained/pm-cli/sdk";
import type { runCloseout } from "../closeout.ts";
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

const claimKinds = ["closing keyword", "delivery tag", "commit claim", "mention-only", "link-only"] as const;
type ClaimKind = typeof claimKinds[number];

/** One cell in the end-to-end item-decision table; only external evidence is synthetic. */
interface DecisionCase {
  selection: "explicit delivery tag" | "single post-criteria claim" | "ambiguous" | "claim kinds";
  primaryClaim: ClaimKind;
  competitorClaim: ClaimKind;
  competitor: "none" | "valid" | "missing merge SHA" | "failed evidence fetch" | "failed checks" | "pagination cut";
  peer: "none" | "retag mid-run";
}

/** Serve distinct PR provenance and schedule a real peer SDK retag after the item snapshot. */
async function decisionEvidence(url: string, res: ServerResponse, cell: DecisionCase, id: string, pmRoot: string, env: NodeJS.ProcessEnv) {
  const number = Number(/\/pulls\/(\d+)/.exec(url)?.[1]);
  const headNumber = Number(/\/commits\/([12])/.exec(url)?.[1]);
  const head = String(headNumber).repeat(40);
  const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
  if (url.includes("/pulls?")) {
    jsonResponse(res, 200, (cell.competitor === "none" ? [2] : [2, 1]).map(n => ({ number: n, merged_at: at(n === 2 ? 8 : 4), updated_at: at(8) })));
  } else if (url.includes("/commits?")) {
    const kind = number === 2 ? cell.primaryClaim : cell.competitorClaim;
    jsonResponse(res, 200, kind === "commit claim" ? [{ commit: { message: `PM item: ${id}` } }] : []);
  }
  else if (number) {
    if (number === 1 && cell.competitor === "failed evidence fetch") { jsonResponse(res, 403, {}); return; }
    if (number === 2 && cell.peer === "retag mid-run" && env.PEER_RETAG_APPLIED !== "true") {
      env.PEER_RETAG_APPLIED = "true";
      await update(id, { tags: "delivery-pr:https://github.com/acme/widgets/pull/1", author: "peer" }, { pmRoot, noExtensions: true });
    }
    const kind = number === 2 ? cell.primaryClaim : cell.competitorClaim;
    const link = `https://github.com/acme/widgets/blob/main/.agents/pm/tasks/${id}.toon`;
    const body = kind === "closing keyword" ? `Closes ${link}` : kind === "mention-only" ? `See ${link}` : kind === "link-only" ? link : "Routine work";
    jsonResponse(res, 200, { number, body,
      commits: kind === "commit claim" ? 1 : 0, merged: true, merged_at: at(number === 2 ? 8 : 4),
      merge_commit_sha: number === 1 && cell.competitor === "missing merge SHA" ? null : (number === 1 ? "a" : "b").repeat(40),
      html_url: `https://github.com/acme/widgets/pull/${number}`, head: { sha: String(number).repeat(40) }, base: { ref: "trunk", repo: { full_name: "acme/widgets" } } });
  } else if (url.includes("/protection/")) jsonResponse(res, 200, { contexts: ["CI"], checks: [] });
  else if (url.includes("/check-runs")) jsonResponse(res, 200, {
    total_count: headNumber === 1 && cell.competitor === "pagination cut" ? 2 : 1,
    check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: headNumber === 1 && cell.competitor === "failed checks" ? "failure" : "success", app: { id: 7 } }],
  });
  else jsonResponse(res, 200, []);
}

/** The real caller and publication boundary exposed to workflow assertions. */
interface WorkflowFixture {
  root: string; base: string; pmRoot: string; id: string; env: NodeJS.ProcessEnv;
  run: (names: string[], source?: string) => ReturnType<typeof bash>;
  git: (...args: string[]) => string;
}

/** A real caller with one eligible item, nested npm dependencies, and a local publication boundary. */
async function fixture(fn: (f: WorkflowFixture) => Promise<void>, cell?: DecisionCase) {
  const base = mkdtempSync(join(tmpdir(), "closeout-caller-"));
  const root = join(base, "caller");
  const remote = join(base, "remote.git");
  mkdirSync(root);
  // PM_TELEMETRY_INLINE_FLUSH keeps the pm CLI's telemetry flush inside each command, so no detached
  // worker can still be writing under the disposable global root when teardown removes it.
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(base, "global"), PM_TELEMETRY_INLINE_FLUSH: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com" };
  const git = (...args: string[]) => command(root, "git", args, env);
  const pmRoot = join(root, ".agents/pm");
  command(root, "git", ["init", "--bare", remote], env);
  git("init", "-b", "trunk");
  command(root, cli, ["--pm-path", pmRoot, "init", "fixture"], env);
  const item = await runWithReproducibleProcessEnvironment({ PM_CLOCK: "2026-10-01T00:00:00Z", PM_SEED: "workflow" }, () => create({ title: "Verified delivery", type: "Task", author: "fixture", acceptanceCriteria: "Delivery verified" }, { pmRoot, noExtensions: true }));
  const id = item.item.id;
  await update(id, { status: "in_progress" }, { pmRoot, noExtensions: true });
  if (cell?.selection === "single post-criteria claim") await runWithReproducibleProcessEnvironment({ PM_CLOCK: "2026-10-07T00:00:00Z", PM_SEED: "table-criteria" }, () =>
    update(id, { acceptanceCriteria: "Criteria revised between the two merges" }, { pmRoot, noExtensions: true }));
  if (cell?.selection === "explicit delivery tag") await update(id, { tags: "delivery-pr:https://github.com/acme/widgets/pull/2" }, { pmRoot, noExtensions: true });
  if (cell?.selection === "claim kinds") {
    const tags = [cell.primaryClaim === "delivery tag" ? 2 : 0, cell.competitor !== "none" && cell.competitorClaim === "delivery tag" ? 1 : 0]
      .filter(Boolean).map(n => `delivery-pr:https://github.com/acme/widgets/pull/${n}`);
    if (tags.length) await update(id, { tags: tags.join(",") }, { pmRoot, noExtensions: true });
  }
  // With no competitor, ambiguity means an explicit selector outside the selected set.
  if (cell?.selection === "ambiguous" && cell.competitor === "none") await update(id, { tags: "delivery-pr:https://github.com/acme/widgets/pull/99" }, { pmRoot, noExtensions: true });
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
      printf '[{"number":7,"headRepository":{"name":"widgets"},"headRepositoryOwner":{"login":"acme"},"isCrossRepository":false,"autoMergeRequest":%s}]' "$(if [[ -f "$AUTO_STATE" ]]; then printf '{}'; else printf null; fi)"
    else printf '[{"number":99,"isCrossRepository":true}]'; fi ;;
  "pr create"|"pr edit")
    [[ "\${PR_DENIED:-false}" != true ]] || exit 1
    touch "$PR_STATE"
    if [[ -f "$AUTO_STATE" ]]; then touch "$ARMED_EDIT"; fi
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --body-file ]]; then cp "$2" "$PR_BODY"; break; fi
      shift
    done ;;
  "pr merge")
    if [[ "$*" == *--disable-auto* ]]; then
      [[ "\${DISABLE_DENIED:-false}" != true ]] || exit 1
      [[ -f "$AUTO_STATE" ]] || exit 1
      rm -f "$AUTO_STATE"
    else
      [[ "\${AUTO_MERGE_DENIED:-false}" != true ]] || exit 1
      touch "$AUTO_STATE"
    fi ;;
  "pr view") printf '{"state":"MERGED"}\\n' ;;
  "pr close") rm -f "$PR_STATE" ;;
  "workflow run") [[ "\${DISPATCH_DENIED:-false}" != true ]] || exit 1 ;;
  "run list") [[ "\${RUN_LIST_DENIED:-false}" != true ]] || exit 1 ;;
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
    AUTO_STATE: join(base, "auto-state"), ARMED_EDIT: join(base, "armed-edit"), PR_STATE: join(base, "pr-state"), PR_BODY: join(base, "pr-body"), RECEIPTS: join(base, "receipts") });
  const server = await startMockGithub((req, res) => {
    const url = req.url!;
    if (cell) {
      void decisionEvidence(url, res, cell, id, pmRoot, env).catch((error: Error) => res.destroy(error));
      return;
    }
    if (url.includes("/check-runs")) env.HEAD_LOOKUPS = String(Number(env.HEAD_LOOKUPS ?? 0) + 1);
    if (env.PROTECTION_DENIED === "true" && (url.includes("/protection/") || url.includes("/rules/branches/"))) { jsonResponse(res, 403, {}); return; }
    if (env.READ_DENIED === "true" || (env.CHECKS_DENIED === "true" && url.includes("/check-runs"))) { jsonResponse(res, 403, { message: "Resource not accessible by integration" }); return; }
    const sha = "a".repeat(40);
    if (env.NUMERIC_PAGINATION === "true" && url === "/repos/acme/widgets") jsonResponse(res, 200, { id: 17, full_name: "acme/widgets" });
    else if (env.NUMERIC_PAGINATION === "true" && url.startsWith("/repos/acme/widgets/pulls?")) jsonResponse(res, 200, [], { Link: `<${server.baseUrl}/repositories/17/pulls?page=2>; rel="next"` });
    else if (url.includes("/pulls?")) jsonResponse(res, 200, env.NO_DELIVERY === "true" ? [] : [...(env.AMBIGUOUS === "true" ? [{ number: 43, merged_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" }] : []), { number: 42, merged_at: env.UNMERGED_COMPETITOR === "true" ? null : "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" }]);
    else if (url.includes("/commits?")) jsonResponse(res, 200, []);
    else if (/\/pulls\/(42|43)$/.test(url)) jsonResponse(res, 200, { number: Number(url.split("/").at(-1)), body: env.NO_LINKS === "true" ? "Routine maintenance" : `Closes https://github.com/${env.FOREIGN_LINK === "true" ? "other/project" : "acme/widgets"}/blob/main/.agents/pm/tasks/${id}.toon${env.SUMMARY_ROWS === "true" ? `\nhttps://github.com/other/project/blob/main/.agents/pm/tasks/${id}.toon` : ""}${env.SUMMARY_ITEM ? `\nhttps://github.com/acme/widgets/blob/main/.agents/pm/tasks/${env.SUMMARY_ITEM}.toon` : ""}`,
      merged: !(env.UNMERGED_COMPETITOR === "true" && url.endsWith("/42")), commits: 0, merged_at: env.UNMERGED_COMPETITOR === "true" && url.endsWith("/42") ? null : "2026-10-15T00:00:00Z", merge_commit_sha: env.INCOMPLETE_MERGE === "true" ? null : "b".repeat(40), html_url: `https://github.com/acme/widgets/pull/${url.split("/").at(-1)}`,
      head: { sha }, base: { ref: "trunk", repo: { full_name: "acme/widgets" } } });
    else if (url.includes("/protection/")) jsonResponse(res, 200, { contexts: ["CI"], checks: [] });
    else if (url.includes("/rules/branches/")) jsonResponse(res, 200, []);
    else if (url.includes("/check-runs")) {
      const names = env.HEAD_NAMES ? JSON.parse(env.HEAD_NAMES) as string[] : ["CI"];
      jsonResponse(res, 200, { total_count: names.length, check_runs: names.map(name => ({ name, head_sha: sha, status: env.HEAD_STATUS ?? "completed", conclusion: env.HEAD_CONCLUSION ?? "success", app: { id: 7 } })) });
    }
    else if (url.includes("/statuses")) jsonResponse(res, 200, []);
    else jsonResponse(res, 404, {});
  });
  Object.assign(env, { PM_GITHUB_API_BASE: server.baseUrl });
  // Model the workflow's always() cleanup even when an ordinary step exits early.
  const run = (names: string[], source = workflow) => bash((names.includes("Disarm previous closeout auto-merge")
    ? ': > "$GITHUB_ENV"\n' : "") + `
cleanup_landing() {
  status=$?
  set -a
  if [[ -f "$GITHUB_ENV" ]]; then source "$GITHUB_ENV"; fi
  set +a
  if [[ "$status" != 0 || "\${CLOSEOUT_AUTOMERGE_ALLOWED:-}" != true ]]; then
    ( ${shell("Disarm closeout auto-merge on unsuccessful landing", source)} ) || status=1
  fi
  exit "$status"
}
trap cleanup_landing EXIT
` + names.map(name => `(
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

const setup = ["Disarm previous closeout auto-merge", "Require caller default branch", "Validate closeout inputs", "Validate npm project directory", "Prepare sync branch from default branch",
  "Install dependencies", "Resolve sync commit scope", "Require clean setup artifacts", "Install pinned pm-github extension", "Configure PM merge drivers", "Isolate workflow setup artifacts", "Verify gate is available"];
const finish = ["Close delivered tracker items", "Run caller post-closeout script", "Gate tracker and regenerated changelog", "Verify strict pm health",
  "Validate publication credentials", "Commit gated closeout changes and open review PR", "Dispatch caller CI and report parked runs"];

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
    [{ reason: secret }, "", /diagnostic blocked by the privacy gate/],
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
    if (mode === "maintenance") f.env.RUN_LIST_DENIED = "true";
    if (mode === "disable-denied") f.env.DISABLE_DENIED = "true";
    const priorBranch = f.git("ls-remote", "origin", `refs/heads/${branch}`);
    const second = await f.run([...setup, ...finish]);
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


/** Reuse immutable input baselines; the workflow resets Git and tracker state before every cell. */
interface SharedDecisionFixture {
  fixture: WorkflowFixture;
  cell: DecisionCase;
  environment: string;
  setupFiles: { path: string; contents: Buffer }[];
  release: () => void;
  done: Promise<void>;
}
const decisionFixtures = new Map<string, Promise<SharedDecisionFixture>>();

/** Retain real SDK/CLI/publication behavior while avoiding redundant fixture creation. */
async function decisionFixture(cell: DecisionCase): Promise<WorkflowFixture> {
  // A missing competitor needs its own unresolved-selector baseline for the ambiguous source.
  const key = `${cell.selection}/${cell.selection === "ambiguous" && cell.competitor === "none"}/${cell.selection === "claim kinds" && cell.primaryClaim === "delivery tag"}/${cell.selection === "claim kinds" && cell.competitor !== "none" && cell.competitorClaim === "delivery tag"}`;
  let pending = decisionFixtures.get(key);
  if (!pending) {
    let release = () => {};
    const lifetime = new Promise<void>(resolveLifetime => { release = resolveLifetime; });
    const sharedCell = { ...cell };
    pending = new Promise<SharedDecisionFixture>((resolveReady, reject) => {
      const done = fixture(async f => {
        const prepared = await f.run(setup);
        assert.equal(prepared.code, 0, prepared.out);
        const setupFiles = [join(f.pmRoot, "settings.json"), join(f.pmRoot, "history/_workspace.jsonl")]
          .filter(existsSync).map(path => ({ path, contents: readFileSync(path) }));
        resolveReady({ fixture: f, cell: sharedCell, release, done,
          environment: readFileSync(f.env.GITHUB_ENV!, "utf8"), setupFiles });
        await lifetime;
      }, sharedCell);
      void done.catch(reject);
    });
    decisionFixtures.set(key, pending);
  }
  const shared = await pending;
  Object.assign(shared.cell, cell);
  const f = shared.fixture;
  // Restore the disposable input even when a previous mutation-control cell failed before publication.
  f.git("reset", "--hard", "trunk");
  // Restore only workflow-owned setup inputs; publication restores these before committing.
  for (const file of shared.setupFiles) writeFileSync(file.path, file.contents);
  writeFileSync(f.env.GITHUB_ENV!, shared.environment);
  delete f.env.PEER_RETAG_APPLIED;
  // A prior cell's PR receipt must never count as publication by the current cell.
  for (const path of [f.env.PR_STATE!, f.env.PR_BODY!]) rmSync(path, { force: true });
  writeFileSync(f.env.RECEIPTS!, "");
  return f;
}

test.after(async () => {
  for (const pending of decisionFixtures.values()) {
    const shared = await pending;
    shared.release();
    await shared.done;
  }
});


/** Retain all 36 selection/peer rows and cross both claim dimensions with all six evidence states. */
const decisionCases: DecisionCase[] = [];
for (const selection of ["explicit delivery tag", "single post-criteria claim", "ambiguous"] as const) {
  for (const competitor of ["none", "valid", "missing merge SHA", "failed evidence fetch", "failed checks", "pagination cut"] as const) {
    for (const peer of ["none", "retag mid-run"] as const) decisionCases.push({ selection, competitor, peer, primaryClaim: selection === "ambiguous" && competitor === "none" ? "mention-only" : "closing keyword", competitorClaim: "closing keyword" });
  }
}
for (const primaryClaim of claimKinds) for (const competitorClaim of claimKinds) {
  for (const competitor of ["none", "valid", "missing merge SHA", "failed evidence fetch", "failed checks", "pagination cut"] as const) {
    decisionCases.push({ selection: "claim kinds", competitor, peer: "none", primaryClaim, competitorClaim });
  }
}

/** Expected winners are defined from the table inputs, independently of the closeout implementation. */
function expectedDecision(cell: DecisionCase): { chosen?: number; candidates: number[]; context: number[]; held: boolean } {
  const { selection, competitor, peer, primaryClaim, competitorClaim } = cell;
  if (selection !== "claim kinds") {
    // Preserve the earlier mention-only input with an unmatched selector: it is context, not ambiguity.
    if (selection === "ambiguous" && competitor === "none") return { candidates: [], context: [2], held: false };
    const closes = selection !== "ambiguous" && (peer === "retag mid-run" ? selection === "explicit delivery tag" && competitor === "valid"
      : selection === "explicit delivery tag" || competitor !== "failed evidence fetch");
    return { chosen: closes ? peer === "retag mid-run" ? 1 : 2 : undefined, candidates: competitor === "none" ? [2] : [1, 2], context: [], held: !closes };
  }
  const primary = !["mention-only", "link-only"].includes(primaryClaim);
  const other = competitor !== "none" && (!["mention-only", "link-only"].includes(competitorClaim) || competitor === "failed evidence fetch");
  const tags = [primaryClaim === "delivery tag" ? 2 : 0, competitor !== "none" && competitorClaim === "delivery tag" ? 1 : 0].filter(Boolean);
  const candidates = [...(other ? [1] : []), ...(primary ? [2] : [])];
  const context = [...(competitor !== "none" && !other ? [1] : []), ...(!primary ? [2] : [])];
  const selected = tags.length === 1 ? tags[0] : tags.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
  const chosen = selected === 2 || (selected === 1 && competitor === "valid") ? selected : undefined;
  return { chosen, candidates, context, held: candidates.length > 0 && chosen === undefined };
}

for (const cell of decisionCases) {
  const { selection, competitor, peer, primaryClaim, competitorClaim } = cell;
  const expected = expectedDecision(cell);
  test(`item decision end to end: ${selection} / ${competitor} / ${peer} / primary=${primaryClaim} / competitor=${competitorClaim}`, async () => {
    const f = await decisionFixture(cell);
    const result = await f.run(["Prepare sync branch from default branch", "Close delivered tracker items", "Commit gated closeout changes and open review PR"]);
    const report = JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as Awaited<ReturnType<typeof runCloseout>>;
    const item = (await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item;
    assert.equal(f.env.PEER_RETAG_APPLIED === "true", peer === "retag mid-run");
    assert.equal(result.code, 0, result.out);
    const closes = expected.chosen !== undefined;
    const publishes = closes || expected.held;
    assert.equal(existsSync(f.env.PR_STATE!), publishes, "only a close or hold publishes tracker changes");
    assert.equal(item.status, closes ? "closed" : "in_progress", JSON.stringify(report));
    assert.equal(report.closed, closes ? 1 : 0);
    assert.equal(report.failed, 0);
    const published = publishes ? `refs/remotes/origin/${branch}` : "trunk";
    const itemPath = `.agents/pm/tasks/${f.id}.toon`;
    const publishedItem = f.git("show", `${published}:${itemPath}`);
    const localItem = readFileSync(join(f.root, itemPath), "utf8").trim();
    if (!publishes && peer === "retag mid-run") {
      assert.notEqual(publishedItem, localItem, "a peer edit alone stays local without a closeout publication");
      assert.deepEqual(item.tags, ["delivery-pr:https://github.com/acme/widgets/pull/1"]);
    } else assert.equal(publishedItem, localItem);
    const history = f.git("show", `${published}:.agents/pm/history/${f.id}.jsonl`);
    assert.equal(history.split('"op":"close"').length - 1, closes ? 1 : 0);
    const body = publishes ? readFileSync(f.env.PR_BODY!, "utf8") : "";
    assert.deepEqual(report.plan.filter(row => row.code === "not_delivery").map(row => row.pr).sort(), expected.context);
    for (const row of report.plan.filter(row => row.code === "not_delivery")) {
      assert.equal(row.action, "skip");
      assert.equal(row.candidates, undefined);
      assert.equal(row.missing_evidence, undefined);
      if (publishes) assert.match(body, new RegExp(`"pr": ${row.pr},\\s*"action": "skip",\\s*"code": "not_delivery"`));
    }
    if (closes) {
      const chosen = expected.chosen!;
      const provenance = JSON.parse(item.close_reason!) as { pr: number; url: string; head_sha: string; merge_commit_sha: string; merged_at: string; checks: string[] };
      assert.deepEqual(provenance, { pr: chosen, url: `https://github.com/acme/widgets/pull/${chosen}`, head_sha: String(chosen).repeat(40),
        merge_commit_sha: (chosen === 1 ? "a" : "b").repeat(40), merged_at: `2026-10-0${chosen === 1 ? 4 : 8}T00:00:00Z`, checks: ["CI"] });
      assert.equal(item.completed_at, provenance.merged_at.replace("Z", ".000Z"));
      assert.match(item.resolution!, new RegExp(`pull/${chosen} `));
      assert.equal(item.expected_result, item.acceptance_criteria);
      assert.ok(item.actual_result!.includes(provenance.merged_at));
      assert.deepEqual(report.plan.filter(row => row.code !== "not_delivery").sort((a, b) => a.pr - b.pr).map(row => [row.pr, row.action, row.code]),
        expected.candidates.map(pr => [pr, pr === chosen ? "close" : "skip", pr === chosen ? "head_checks_passed" : "duplicate_selection"]));
      assert.match(body, new RegExp(`"pr": ${chosen},\\s*"action": "close"`));
      assert.doesNotMatch(body, /"action": "needs_review"|"action": "refuse"/);
      assert.equal(f.git("ls-tree", "--name-only", published, ".agents/pm/closeout-review.json"), "");
    } else if (expected.held) {
      const held = report.plan.filter(row => row.code !== "not_delivery").sort((a, b) => a.pr - b.pr);
      assert.deepEqual(held.map(row => [row.pr, row.action, row.code, row.candidates]),
        expected.candidates.map(pr => [pr, "needs_review", "needs_review", expected.candidates]));
      for (const row of held) assert.ok(row.missing_evidence?.every(gap => expected.candidates.includes(gap.pr)) ?? true);
      const review = JSON.parse(f.git("show", `${published}:.agents/pm/closeout-review.json`)) as { needs_review: { candidates: number[] }[] };
      assert.deepEqual(review.needs_review.map(row => row.candidates), [expected.candidates]);
      assert.match(body, /"action": "needs_review"/);
      assert.doesNotMatch(body, /"action": "close"|"action": "refuse"/);
    } else {
      assert.ok(report.plan.every(row => row.action === "skip" && row.code === "not_delivery"));
      assert.equal(f.git("ls-tree", "--name-only", published, ".agents/pm/closeout-review.json"), "");
    }
    if (!closes) assert.doesNotMatch(readFileSync(f.env.RECEIPTS!, "utf8"), /pr merge .*--auto/);
  });
}

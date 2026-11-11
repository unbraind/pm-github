/** Execute the reusable workflow's real bash against SDK trackers and isolated Git remotes. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { runWithReproducibleProcessEnvironment, create, get, update } from "@unbrained/pm-cli/sdk";
import { jsonResponse, startMockGithub } from "./mock-github-server.ts";

export const repoRoot = resolve(import.meta.dirname, "../..");
export const workflow = readFileSync(join(repoRoot, ".github/workflows/pm-github-closeout.yml"), "utf8");
export const sync = readFileSync(join(repoRoot, ".github/workflows/pm-github-sync.yml"), "utf8");
export const cli = join(repoRoot, "node_modules/.bin/pm");
export const branch = "pm-github/closeout";
export const title = "chore(pm): close items delivered by merged pull requests";
const version = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const packedRoot = mkdtempSync(join(tmpdir(), "closeout-package-"));
let archive: string;

/** Extract executable bash from a named real workflow step. */
export function shell(name: string, source = workflow): string {
  const step = source.split("      - name: ").find(part => part.startsWith(name + "\n"));
  assert.ok(step, name);
  const block = /        run: \|\n([\s\S]*)/.exec(step);
  if (block) return block[1]!.split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
  const single = /        run: (.+)/.exec(step);
  assert.ok(single, name);
  return single[1]!;
}

/** Await a real shell while the HTTP evidence fixture continues serving requests. */
export function bash(script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; stdout: string }> {
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
export function command(cwd: string, executable: string, args: string[], env = process.env): string {
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

export const claimKinds = ["closing keyword", "delivery tag", "commit claim", "mention-only", "link-only"] as const;
export type ClaimKind = typeof claimKinds[number];

/** One cell in the end-to-end item-decision table; only external evidence is synthetic. */
export interface DecisionCase {
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
export interface WorkflowFixture {
  root: string; base: string; pmRoot: string; id: string; env: NodeJS.ProcessEnv;
  run: (names: string[], source?: string) => ReturnType<typeof bash>;
  git: (...args: string[]) => string;
}

/** A real caller with one eligible item, nested npm dependencies, and a local publication boundary. */
export async function fixture(fn: (f: WorkflowFixture) => Promise<void>, cell?: DecisionCase) {
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
    "changelog:full": `node ${JSON.stringify(generator)} --pm-root ../../.agents/pm --mode replace --output ../../CHANGELOG.md --status closed --all-release-tags --date-from-version --release-version-from-package`,
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
  "api repos/acme/widgets")
    [[ "\${API_DENIED:-false}" != true ]] || exit 1
    if [[ "$*" == *'.allow_auto_merge'* ]]; then printf true; else printf '%s' "\${API_BRANCH:-trunk}"; fi ;;
  "api graphql") printf true ;;
  "api repos/acme/widgets/branches/"*) printf '{"protected":true,"protection":{"required_status_checks":{"contexts":["CI"],"checks":[]}}}' ;;
  "api repos/acme/widgets/rules/branches/"*) printf '[[]]' ;;
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

export const setup = ["Disarm previous closeout auto-merge", "Require caller default branch", "Validate closeout inputs", "Validate npm project directory", "Prepare sync branch from default branch",
  "Install dependencies", "Resolve sync commit scope", "Require clean setup artifacts", "Install pinned pm-github extension", "Configure PM merge drivers", "Isolate workflow setup artifacts", "Verify gate is available"];
export const finish = ["Close delivered tracker items", "Run caller post-closeout script", "Gate tracker and regenerated changelog", "Verify strict pm health",
  "Validate publication credentials", "Commit gated closeout changes and open review PR", "Dispatch caller CI and report parked runs"];

/** No remote bot ref is the publication invariant for every refused or no-op run. */
export function unpublished(git: (...args: string[]) => string): void {
  assert.equal(git("ls-remote", "origin", `refs/heads/${branch}`), "");
}

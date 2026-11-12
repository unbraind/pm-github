/** Contradictions and competing claims are refused against native SDK trackers on every write path. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import {
  init, create, get, readSettings, mutateItem, getItemPath, getHistoryPath, normalizeItemId,
  listAllComplete, WorkspaceTransactionInterruptedError, runWithActiveExtensions, setActiveExtensionHooks,
} from "@unbrained/pm-cli/sdk";
import {
  runImport, parseImportOptions, deriveAtomicItemId, prepareGithubImport, importGithubAtomic,
  readGithubImportPlan, resumeGithubImport, listUnfinishedGithubImports, fetchJSON, githubApiBase, parseNextLink,
  type GhIssue,
} from "../index.ts";
import { fetchImportTimeline, matchImportedIssue } from "../import-fidelity.ts";
import { mutateGithubOwnedItem } from "../import-ownership.ts";
import { runCloseout } from "../closeout.ts";
import { withEnv, captureStderr, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const source: GhIssue = { number: 7, title: "Remote updated", body: "Public source body", state: "open", labels: [], user: null,
  assignee: null, milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: "https://github.com/o/r/issues/7" };

/** Native tracker without git, except the two explicit gated-replay fixtures. */
async function tracker(run: (root: string, id: string) => Promise<void>, git = false, managed = true) {
  const directory = mkdtempSync(join(tmpdir(), "github-consistency-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    const id = managed ? deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId) : normalizeItemId("curated", (await readSettings(root)).id_prefix);
    await create({ id, title: "Original local title", type: "Issue", body: "Original local body", status: "in_progress",
      description: `GH issue #7: ${source.html_url}`, tags: "gh:o/r#7" }, { pmRoot: root });
    await change(root, id, { github_repo: repo, github_number: 7, github_url: source.html_url });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root, id));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Independent SDK mutation, also used to introduce a peer after the import's initial read. */
async function change(root: string, id: string, values: Record<string, unknown>, reset = false) {
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => mutateItem({ pmRoot: root, settings: await readSettings(root), id, author: "fixture", op: "update", message: "Fixture ownership edit",
    mutate: document => {
      if (reset) {
        for (const key of Object.keys(document.metadata)) if (/^github/i.test(key) || key === "external_ref") delete document.metadata[key];
        document.metadata.description = "Legacy local record"; document.metadata.tags = [];
      }
      Object.assign(document.metadata, values);
      return { changedFields: Object.keys(values) };
    } }));
}

/** Preserve both native data and audit bytes on a refused write. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "utf8"), readFileSync(getHistoryPath(root, id), "utf8")];
}

/** Exercise real HTTP parsing; only GitHub itself is represented by a local server. */
async function github<T>(id: string, run: () => Promise<T>): Promise<T> {
  return withMockGithub((request, response) => {
    const path = request.url!;
    const sha = "a".repeat(40);
    jsonResponse(response, 200, path.includes("/pulls/") ? path.includes("/commits?") ? [] : {
      number: 1, commits: 0, merged: true, merged_at: "2099-01-01T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: `https://github.com/${repo}/pull/1`,
      body: `Closes https://github.com/${repo}/blob/main/.agents/pm/issues/${id}.toon`, head: { sha }, base: { ref: "main", repo: { full_name: repo } },
    } : path.includes("/protection/") ? { contexts: ["CI"], checks: [] }
      : path.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "success", app: { id: 1 } }] }
        : /\/issues\?/.test(path) ? [source] : []);
  }, run);
}

/** Real fetch, matching, mapping and SDK writes. */
async function sync(root: string, atomic = false, gate = false) {
  return captureStderr(() => runImport(repo, root, parseImportOptions({ atomic, gate })));
}

/** Persist a real SDK journal and its original recovery plan before introducing the conflict. */
async function interrupt(root: string, id: string) {
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), "fixture-token", items.find(item => item.id === id), undefined,
    { items, releases: [], timeline: issue => fetchImportTimeline(issue, repo, "fixture-token") }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => {
    if (context.transition === "prepared") throw new WorkspaceTransactionInterruptedError("Fixture interruption");
  } }));
  const pending = (await listUnfinishedGithubImports(root))[0]!;
  const plan = (await readGithubImportPlan(root, pending.transactionId))!;
  return plan;
}

interface Shape { name: string; values?: Record<string, unknown>; reset?: boolean; peer?: Record<string, unknown>; claim: string }
const shapes: Shape[] = [
  { name: "repository versus URL", values: { github_repo: "other/project" }, claim: "other/project#7" },
  { name: "number versus URL", values: { github_number: 8 }, claim: "o/r#8" },
  { name: "contradictory URL alias", values: { GitHubURL: "https://github.com/other/project/pull/8" }, claim: "other/project#8" },
  { name: "contradictory legacy link", values: { external_links: ["https://github.com/other/project/issues/8"] }, claim: "other/project#8" },
  { name: "contradictory native declaration", values: { description: "GitHub issue https://github.com/other/project/issues/8" }, claim: "other/project#8" },
  { name: "external-ref repository", values: { external_ref: "gh:other/project#8" }, claim: "other/project#8" },
  { name: "external-ref number", values: { external_ref: "https://github.com/O/R/pull/8/" }, claim: "o/r#8" },
  { name: "number-only multi-repository legacy", reset: true, values: { github_number: 7, tags: ["gh:o/r#7", "gh:other/project#7"] }, claim: "other/project#7" },
  { name: "number-only mismatched reference", reset: true, values: { github_number: 7, tags: ["gh:o/r#8"] }, claim: "o/r#8" },
  { name: "partial repository contradicts reference", reset: true, values: { github_repo: "other/project", github_link_only: false, tags: ["gh:o/r#7"] }, claim: "other/project#7" },
  { name: "full owner contradicts reference", values: { tags: ["gh:o/r#7", "gh:other/project#8"] }, claim: "other/project#8" },
  { name: "generated legacy number contradicts URL", reset: true, values: { description: `GH issue #8: ${source.html_url}`, tags: ["gh:o/r#7"] }, claim: "o/r#8" },
  { name: "competing URL alias", peer: { GitHubURL: "https://www.github.com/O/R/pull/7/" }, claim: "claimed by" },
  { name: "competing external-ref", peer: { external_ref: "gh:O/R#7" }, claim: "claimed by" },
];

/** Typed diagnostics name every contradictory claim and the remedy, rather than just refusing a generic collision. */
function refusal(error: unknown, shape: Shape) {
  assert.equal((error as { code: string })?.code, "github_import_owner_conflict");
  assert.match(String(error), /o\/r#7/);
  assert.ok(String(error).includes(shape.claim), String(error));
  assert.match(String(error), /Restore the intended GitHub provenance/);
  return true;
}

for (const path of ["match", "plain", "atomic", "closeout", "replay"] as const) for (const shape of shapes) {
  test(`Ownership matrix ${path}: refuses ${shape.name}`, async () => tracker(async (root, id) => github(id, async () => {
    const plan = path === "replay" ? await interrupt(root, id) : undefined;
    if (shape.peer) {
      const peer = (await create({ title: "Peer claimant", type: "Chore" }, { pmRoot: root })).item;
      await change(root, peer.id, shape.peer);
    } else await change(root, id, shape.values!, shape.reset);
    const before = await bytes(root, id);
    if (path === "closeout") {
      const result = await runCloseout(root, repo, { pr: "1", apply: true }, { base: githubApiBase(), next: parseNextLink, get: url => fetchJSON(url, "fixture-token") });
      assert.equal(result.closed, 0);
      assert.equal(result.plan[0]!.code, "github_import_owner_conflict");
      assert.ok(result.plan[0]!.reason.includes(shape.claim), result.plan[0]!.reason);
    } else if (path === "match") {
      const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
      assert.throws(() => matchImportedIssue(items, source), error => refusal(error, shape));
    } else await assert.rejects(() => path === "replay" ? sync(root, true, true) : sync(root, path === "atomic"), error => refusal(error, shape));
    assert.deepEqual(await bytes(root, id), before);
    if (plan) assert.deepEqual(await readGithubImportPlan(root, plan.transactionId), plan, "A native journal requires the original plan to remain available");
  }), path === "replay", path !== "closeout"));
}

for (const legacy of [false, true]) test(`Ownership matrix allows consistent ${legacy ? "legacy" : "full"} record and idempotent re-import`, async () => tracker(async (root, id) => github(id, async () => {
  await change(root, id, legacy ? { github_repo: " O/R/// ", github_link_only: false, tags: ["gh:O/R#7"] }
    : { github_repo: " O/R/// ", github_number: 7, github_url: "https://www.github.com/O/R/pull/7/?a=1#fragment", external_ref: "gh:o/r#7", tags: ["gh:O/R#7"] }, legacy);
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  assert.equal(matchImportedIssue(items, source).item?.id, id);
  await sync(root, true);
  const before = await bytes(root, id);
  await sync(root, true);
  assert.deepEqual(await bytes(root, id), before);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
})));

test("Ownership matrix reference-only tags remain non-owning", async () => tracker(async (root, id) => github(id, async () => {
  for (let n = 0; n < 2; n++) await create({ title: `Reference Chore ${n}`, type: "Chore", tags: "gh:o/r#7" }, { pmRoot: root });
  await sync(root, true);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 3);
  assert.equal((await get(id, {}, { pmRoot: root })).item.title, source.title);
})));

for (const replay of [false, true]) test(`Ownership matrix locked ${replay ? "replay" : "plain"} rejects a newly competing owner`, async () => tracker(async (root, id) => github(id, async () => {
  const plan = replay ? await interrupt(root, id) : undefined;
  const peer = (await create({ title: "Initially unowned peer", type: "Chore" }, { pmRoot: root })).item;
  const before = await bytes(root, id);
  let introduced = false;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "fixture-peer", run: async context => {
      if (!introduced && context.before?.metadata.id === id) { introduced = true; await change(root, peer.id, { external_ref: "gh:o/r#7" }); }
    } }] });
    await assert.rejects(() => plan ? resumeGithubImport(root, plan) : mutateGithubOwnedItem(root, { id, repo, number: 7 }, "update", { title: "Rejected title" }), /github_import_owner_conflict|claimed by/);
  });
  assert.equal(introduced, true);
  assert.deepEqual(await bytes(root, id), before);
})));

test("Ownership preflight removes a staged plan only when no SDK journal exists", async () => tracker(async (root, id) => github(id, async () => {
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), "fixture-token", items[0], undefined, { items, releases: [], timeline: async () => [] }))!;
  let file = ""; let before: string[] = [];
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: async context => {
    file = context.file; await change(root, id, { external_ref: "gh:other/project#8" }); before = await bytes(root, id);
  } }), error => refusal(error, shapes.find(shape => shape.name === "external-ref repository")!));
  assert.equal(existsSync(file), false);
  assert.deepEqual(await listUnfinishedGithubImports(root), []);
  assert.deepEqual(await bytes(root, id), before);
  await change(root, id, { external_ref: "gh:o/r#7" });
  await sync(root, true);
  assert.equal((await get(id, {}, { pmRoot: root })).item.title, source.title);
})));

test("Recovery-plan deletion flushes its directory through the durable-state policy", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => tracker(async (root, id) => github(id, async () => {
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), "fixture-token", items[0], undefined, { items, releases: [], timeline: async () => [] }))!;
  let file = "";
  try {
    await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: context => { file = context.file; }, onTransition: context => {
      if (context.transition === "committed") chmodSync(dirname(file), 0o300);
    } }), { code: "EACCES" });
    assert.equal(existsSync(file), false, "Unlink succeeds before the directory flush refusal");
    assert.equal((await get(id, {}, { pmRoot: root })).item.title, source.title);
  } finally { if (file) chmodSync(dirname(file), 0o700); }
})));

for (const legacy of [false, true]) test(`Ownership matrix closeout allows consistent ${legacy ? "legacy" : "full"} owner`, async () => tracker(async (root, id) => github(id, async () => {
  if (legacy) await change(root, id, { github_number: 7, tags: ["gh:o/r#7"] }, true);
  const result = await runCloseout(root, repo, { pr: "1", apply: true }, { base: githubApiBase(), next: parseNextLink, get: url => fetchJSON(url, "fixture-token") });
  assert.equal(result.closed, 1);
  assert.equal(result.plan[0]!.action, "close");
}), false, false));

test("Ownership matrix locked closeout refuses a newly competing owner", async () => tracker(async (root, id) => github(id, async () => {
  const peer = (await create({ title: "Initially unowned peer", type: "Chore" }, { pmRoot: root })).item;
  const before = await bytes(root, id);
  let introduced = false;
  const result = await runCloseout(root, repo, { pr: "1", apply: true }, { base: githubApiBase(), next: parseNextLink, get: url => fetchJSON(url, "fixture-token") }, async phase => {
    if (!introduced && phase === "locked") { introduced = true; await change(root, peer.id, { external_ref: "gh:o/r#7" }); }
  });
  assert.equal(introduced, true); assert.equal(result.closed, 0);
  assert.equal(result.plan[0]!.code, "github_import_owner_conflict");
  assert.match(result.plan[0]!.reason, /claimed by/);
  assert.deepEqual(await bytes(root, id), before);
}), false, false));

test("Ownership matrix gated replay allows a consistent owner and remains idempotent", async () => tracker(async (root, id) => github(id, async () => {
  await interrupt(root, id);
  await sync(root, true, true);
  const before = await bytes(root, id);
  await sync(root, true, true);
  assert.deepEqual(await bytes(root, id), before);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}), true));

test("Ownership matrix locked plain creation refuses a newly competing owner", async () => tracker(async (root, id) => github(id, async () => {
  const peer = (await create({ title: "Initially unowned peer", type: "Chore" }, { pmRoot: root })).item;
  const number = 9;
  const destination = deriveAtomicItemId(repo, number, (await readSettings(root)).id_prefix, normalizeItemId);
  let introduced = false;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "fixture-peer", run: async context => {
      if (!introduced && context.after?.metadata.id === destination) { introduced = true; await change(root, peer.id, { external_ref: "gh:o/r#9" }); }
    } }] });
    await assert.rejects(() => mutateGithubOwnedItem(root, { id: destination, repo, number, allowCreate: true }, "create", {
      title: "Rejected title", type: "Issue", description: "GH issue #9: https://github.com/o/r/issues/9", tags: "gh:o/r#9",
    }), /github_import_owner_conflict|claimed by/);
  });
  assert.equal(introduced, true);
  await assert.rejects(() => get(destination, {}, { pmRoot: root }), /not found/);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
})));

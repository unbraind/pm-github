/** Contradictions and competing claims are refused against native SDK trackers on every write path. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import {
  init, create, get, docs as nativeDocs, readSettings, mutateItem, getItemPath, getHistoryPath, normalizeItemId,
  listAllComplete, WorkspaceTransactionInterruptedError, runWithActiveExtensions, setActiveExtensionHooks,
} from "@unbrained/pm-cli/sdk";
import extension, {
  runImport, parseImportOptions, deriveAtomicItemId, prepareGithubImport, importGithubAtomic,
  readGithubImportPlan, resumeGithubImport, listUnfinishedGithubImports, fetchJSON, githubApiBase, parseNextLink,
  linkImportedDependencies, indexByProvenance, collectBlockerReferences, buildExportPlan, applyExportPlan,
  type PmItem, type BlockerPmItem,
  type GhIssue,
} from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { fetchImportTimeline, matchImportedIssue } from "../import-fidelity.ts";
import { mutateGithubOwnedItem, assertGithubOwnershipConsistency, githubOwnershipClaims } from "../import-ownership.ts";
import { selectRefreshTargets } from "../refresh.ts";
import { indexPmByIssue, buildProjectPushPlan, buildProjectPullPlan, buildProjectImportPlan } from "../projects.ts";
import { runCloseout } from "../closeout.ts";
import { withEnv, captureStderr, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const source: GhIssue = { number: 7, title: "Remote updated", body: "Public source body", state: "open", labels: [], user: null,
  assignee: null, milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: "https://github.com/o/r/issues/7" };

/** Native tracker without git, except the two explicit gated-replay fixtures. */
async function tracker(run: (root: string, id: string) => Promise<void>, git = false, managed = true, createdByImporter = managed) {
  const directory = mkdtempSync(join(tmpdir(), "github-consistency-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    const id = managed ? deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId) : normalizeItemId("curated", (await readSettings(root)).id_prefix);
    await create({ id, author: createdByImporter ? "pm-github" : "fixture", title: "Original local title", type: managed && !createdByImporter ? "Chore" : "Issue", body: "Original local body", status: "in_progress",
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
  { name: "partial repository versus URL", reset: true, values: { github_repo: "other/project", github_url: source.html_url }, claim: "other/project#7" },
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

for (const atomic of [false, true]) test(`Creation proof: curated deterministic ID never grants mirroring (atomic=${atomic})`, async () => tracker(async (root, id) => github(id, async () => {
  await change(root, id, { tags: ["gh:o/r#7", "keep-curated"] });
  const before = (await get(id, {}, { pmRoot: root })).item;
  await sync(root, atomic);
  const after = (await get(id, {}, { pmRoot: root })).item;
  for (const field of ["title", "description", "type", "body", "created_at", "tags"] as const) assert.deepEqual(after[field], before[field], field);
  assert.equal(existsSync(getItemPath(root, "Chore", id)), true);
  assert.equal(after.github_state, "open");
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}), false, true, false));

for (const atomic of [false, true]) test(`Creation proof: importer author mirrors without a naming pattern (atomic=${atomic})`, async () => tracker(async (root, id) => github(id, async () => {
  assert.doesNotMatch(id, /-github-/);
  assert.equal((await get(id, {}, { pmRoot: root })).item.author, "pm-github");
  await sync(root, atomic);
  const after = (await get(id, {}, { pmRoot: root })).item;
  assert.equal(after.title, source.title);
  assert.equal(after.body, source.body);
  assert.equal(after.author, "pm-github");
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}), false, false, true));

test("Creation proof: an original mirroring plan refuses a late curated linked occupant", async () => tracker(async (root, id) => github(id, async () => {
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), "fixture-token", items[0], undefined, { items, releases: [], timeline: async () => [] }))!;
  let before: string[] = [];
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: async () => {
    await change(root, id, { author: "fixture", title: "Curated after planning" }); before = await bytes(root, id);
  } }), /importer creation provenance missing/);
  assert.deepEqual(await bytes(root, id), before);
})));

test("PR tracker records retain references without contradictory GitHub identity tags", async () => {
  const ids = ["pm-github-blocker-format-followup", "pm-github-curated-reopen-followup", "pm-github-pr-url-alias-followup",
    "pm-github-project-reference-followup", "pm-github-reference-identity-followup", "pm-github-reference-identity", "pm-github-search-reference-followup"];
  const root = join(import.meta.dirname, "../.agents/pm");
  for (const id of ids) {
    const { item } = await get(id, {}, { pmRoot: root, noExtensions: true });
    assert.doesNotThrow(() => assertGithubOwnershipConsistency(item), id);
    for (const tag of item.tags ?? []) if (tag.startsWith("gh:")) {
      assert.ok(githubOwnershipClaims(item).owners.includes(tag.slice(3)), `${id}: contextual references belong in docs`);
    }
  }
  const references = await nativeDocs("pm-github-reference-identity-followup", {}, { pmRoot: root, noExtensions: true });
  assert.ok(references.docs.some(doc => doc.path === "https://github.com/unbraind/pm-github/pull/233"));
});

for (const atomic of [false, true]) test(`Creation proof: dedicated importer metadata mirrors without a naming pattern (atomic=${atomic})`, async () => tracker(async (root, id) => github(id, async () => {
  await change(root, id, { github_import: true });
  assert.equal((await get(id, {}, { pmRoot: root })).item.author, "fixture");
  await sync(root, atomic);
  const after = (await get(id, {}, { pmRoot: root })).item;
  assert.equal(after.title, source.title); assert.equal(after.body, source.body);
  assert.equal(after.github_import, true);
}), false, false, false));


const extensionHarness = createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });

for (const command of ["sync", "export"] as const) for (const shape of shapes) {
  test(`Outbound ownership ${command}: refuses ${shape.name} without HTTP writes`, async () => tracker(async (root, id) => {
    if (shape.peer) {
      const peer = (await create({ title: "Other upstream claimant", type: "Chore" }, { pmRoot: root })).item;
      await change(root, peer.id, shape.peer);
    } else await change(root, id, shape.values!, shape.reset);
    const before = await bytes(root, id);
    const writes: string[] = [];
    await withMockGithub((request, response) => {
      if (request.method !== "GET") writes.push(`${request.method} ${request.url}`);
      jsonResponse(response, 200, { ...source, state: "closed" });
    }, async () => {
      const harness = await extensionHarness;
      await assert.rejects(() => harness.runCommand({ command: `github ${command}`, options: { repo, ids: id, apply: true }, pmRoot: root, global: { json: true } }), error => refusal(error, shape));
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(await bytes(root, id), before);
  }));
}

for (const command of ["sync", "export"] as const) test(`Outbound ownership ${command}: allows consistent external-ref owner in place`, async () => tracker(async (root, id) => {
  await change(root, id, { external_ref: "gh:O/R#7" }, true);
  const writes: string[] = [];
  await withMockGithub((request, response) => {
    if (request.method !== "GET") writes.push(`${request.method} ${request.url}`);
    jsonResponse(response, 200, { ...source, state: "closed" });
  }, async () => {
    const harness = await extensionHarness;
    await harness.runCommand({ command: `github ${command}`, options: { repo, ids: id, apply: true }, pmRoot: root, global: { json: true } });
  });
  assert.deepEqual(writes, ["PATCH /repos/o/r/issues/7"]);
}));

test("Outbound ownership sync: rechecks claims after upstream read before PATCH", async () => tracker(async (root, id) => {
  const writes: string[] = [];
  let serverFailure: unknown;
  await withMockGithub((request, response) => {
    if (request.method !== "GET") { writes.push(`${request.method} ${request.url}`); jsonResponse(response, 200, source); return; }
    void change(root, id, { github_repo: "other/project" }).then(() => jsonResponse(response, 200, { ...source, state: "closed" }), error => {
      serverFailure = error; jsonResponse(response, 500, {});
    });
  }, async () => {
    const harness = await extensionHarness;
    await assert.rejects(() => harness.runCommand({ command: "github sync", options: { repo, ids: id }, pmRoot: root, global: { json: true } }), error => refusal(error, shapes[0]!));
  });
  assert.equal(serverFailure, undefined);
  assert.deepEqual(writes, []);
}));

/** Both endpoints and every competing claimant come from a real complete SDK metadata read. */
async function dependencySource(root: string) {
  const item = (await create({ author: "pm-github", title: "Dependent issue", type: "Issue" }, { pmRoot: root })).item;
  await change(root, item.id, { github_url: "https://github.com/o/r/issues/9" });
  return { id: item.id, issue: { ...source, number: 9, html_url: "https://github.com/o/r/issues/9", body: "Blocked by #7" } };
}

for (const shape of shapes.filter(shape => !["repository versus URL", "number versus URL", "contradictory URL alias", "competing URL alias"].includes(shape.name))) test(`Dependency ownership: refuses ${shape.name} without an edge`, async () => tracker(async (root, id) => {
  const dependent = await dependencySource(root);
  if (shape.peer) {
    const peer = (await create({ title: "Other dependency owner", type: "Chore" }, { pmRoot: root })).item;
    await change(root, peer.id, shape.peer);
  } else await change(root, id, shape.values!, shape.reset);
  const before = await bytes(root, dependent.id);
  const result = await linkImportedDependencies(repo, [dependent.issue], root);
  assert.equal(result.linked, 0);
  assert.match(result.failures.join("\n"), /ambiguous_github_dependency_owner: o\/r#7/);
  assert.deepEqual(await bytes(root, dependent.id), before);
}));

test("Dependency ownership: allows one consistent external-ref owner", async () => tracker(async (root, id) => {
  const dependent = await dependencySource(root);
  await change(root, id, { external_ref: "https://www.github.com/O/R/pull/7/?q=1#fragment" }, true);
  const result = await linkImportedDependencies(repo, [dependent.issue], root);
  assert.equal(result.linked, 1, JSON.stringify(result));
  assert.deepEqual(result.failures, []);
  assert.ok((await get(dependent.id, {}, { pmRoot: root })).item.dependencies!.some(dependency => dependency.id === id));
}));

test("Dependency ownership: rechecks endpoint uniqueness inside the source mutation lock", async () => tracker(async (root, id) => {
  const dependent = await dependencySource(root);
  const peer = (await create({ title: "Late dependency claimant", type: "Chore" }, { pmRoot: root })).item;
  const before = await bytes(root, dependent.id);
  let introduced = false;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "late-dependency-owner", run: async context => {
      if (!introduced && context.before?.metadata.id === dependent.id) {
        introduced = true;
        await change(root, peer.id, { external_ref: "gh:o/r#7" });
      }
    } }] });
    const result = await linkImportedDependencies(repo, [dependent.issue], root);
    assert.equal(introduced, true);
    assert.equal(result.linked, 0);
    assert.match(result.failures.join("\n"), /ambiguous_github_dependency_owner/);
  });
  assert.deepEqual(await bytes(root, dependent.id), before);
}));


/** The remaining operational indexes share the exact corpus and claims used by import and export. */
function selectorChecks(items: PmItem[], id: string) {
  const item = items.find(item => item.id === id)!;
  const board = [{ id: "fixture-board-item", statusName: "Done", content: { typename: "Issue" as const, title: "Remote", repo, number: 7 } }];
  return {
    refresh: () => selectRefreshTargets(items, repo),
    search: () => indexByProvenance(items),
    projects: () => indexPmByIssue(items),
    "project push": () => buildProjectPushPlan(items, { owner: "o", number: 1 }, board, undefined),
    "project pull": () => buildProjectPullPlan(items, { owner: "o", number: 1 }, board),
    "project import": () => buildProjectImportPlan(board, { owner: "o", number: 1 }, items),
    "blocker self-exclusion": () => collectBlockerReferences({ ...item, dependencies: [], comments: [], blockedReason: "Blocked by #8" } as BlockerPmItem, repo, items),
  };
}

for (const shape of shapes) test(`Ownership routing inventory: refuses ${shape.name} in every operational index`, async () => tracker(async (root, id) => {
  if (shape.peer) {
    const peer = (await create({ title: "Other index claimant", type: "Chore" }, { pmRoot: root })).item;
    await change(root, peer.id, shape.peer);
  } else await change(root, id, shape.values!, shape.reset);
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  for (const [name, run] of Object.entries(selectorChecks(items, id))) {
    assert.throws(run, error => { try { return refusal(error, shape); } catch (failure) { throw new Error(`${name}: ${String(failure)}`); } }, name);
  }
}));

test("Ownership routing inventory: consistent external-ref owner and reference-only items remain distinct", async () => tracker(async (root, id) => {
  await change(root, id, { external_ref: "gh:O/R#7" }, true);
  const reference = (await create({ title: "Mention", type: "Chore", tags: "gh:o/r#7" }, { pmRoot: root })).item;
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  assert.equal(selectRefreshTargets(items, repo)[0]!.id, id);
  assert.equal(indexByProvenance(items).get("o/r#7")!.id, id);
  assert.equal(indexPmByIssue(items).get("o/r#7")!.id, id);
  const board = [{ id: "fixture-board-item", statusName: "Done", content: { typename: "Issue" as const, title: "Remote", repo, number: 7 } }];
  const push = buildProjectPushPlan(items, { owner: "o", number: 1 }, board, undefined).entries;
  assert.equal(push.find(entry => entry.pmId === id)!.action, "noop");
  assert.equal(push.find(entry => entry.pmId === reference.id)!.action, "add-draft");
  assert.equal(buildProjectPullPlan(items, { owner: "o", number: 1 }, board).entries[0]!.pmId, id);
  assert.equal(buildProjectImportPlan(board, { owner: "o", number: 1 }, items)[0]!.pmId, id);
}));

test("Outbound ownership export: the public executor revalidates its original ownership context", async () => tracker(async (root, id) => {
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const plan = buildExportPlan(items, repo);
  items[0]!.github_repo = "other/project";
  await withMockGithub((_request, response) => jsonResponse(response, 200, source), async server => {
    await assert.rejects(() => applyExportPlan(plan, repo, "fixture-token", (method, url, token, body) => fetch(url, { method, headers: { authorization: `Bearer ${token}` }, body })), error => refusal(error, shapes[0]!));
    assert.deepEqual(server.requests, []);
  });
}));

test("Refresh ownership kind: every supported URL owner excludes PRs from issue queries", async () => tracker(async (root, id) => {
  for (const values of [{ external_ref: "https://github.com/o/r/pull/7" }, { links: ["https://github.com/o/r/pull/7"] }, { GitHubURL: "https://github.com/o/r/pull/7" }]) {
    await change(root, id, values, true);
    const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
    assert.deepEqual(selectRefreshTargets(items, repo), []);
    await change(root, id, JSON.parse(JSON.stringify(values).replaceAll("/pull/", "/issues/")) as Record<string, unknown>, true);
    const issues = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
    assert.equal(selectRefreshTargets(issues, repo)[0]!.id, id);
  }
}));


for (const conflict of [false, true]) test(`Ownership sync hint uses shared claims (${conflict ? "conflict" : "consistent external-ref"})`, async () => tracker(async (root, id) => {
  await change(root, id, conflict ? { github_repo: "other/project", github_url: source.html_url } : { external_ref: "gh:o/r#7" }, true);
  await withEnv({ PM_GITHUB_SYNC: "1" }, async () => {
    const harness = await extensionHarness;
    const { stderr } = await captureStderr(() => harness.runHook({ kind: "after_command", context: { command: "update", args: [id], pm_root: root, ok: true } }));
    assert.match(stderr.join("\n"), conflict ? /github_import_owner_conflict/ : /pm github sync --repo o\/r/);
    if (conflict) assert.doesNotMatch(stderr.join("\n"), /is linked to/);
  });
}));

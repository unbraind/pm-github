/** Every importer write path uses real SDK storage, including relinks between planning and commit. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import {
  init, create, get, readSettings, mutateItem, getItemPath, getHistoryPath, normalizeItemId,
  listAllComplete, listAllItemMetadata, WorkspaceTransactionInterruptedError, runWithActiveExtensions, setActiveExtensionHooks,
  readHistoryEntries, verifyHistoryEntries,
} from "@unbrained/pm-cli/sdk";
import {
  runImport, parseImportOptions, deriveAtomicItemId, prepareGithubImport, importGithubAtomic,
  readGithubImportPlan, resumeGithubImport, listUnfinishedGithubImports, syncGithubCommentsToAnnotations,
  linkImportedDependencies, type GhIssue, type PmItem,
} from "../index.ts";
import { persistImportFidelity, buildImportFidelity } from "../import-fidelity.ts";
import { mutateGithubOwnedItem } from "../import-ownership.ts";
import { runRefresh } from "../refresh.ts";
import { runCloseout, type CloseoutApi } from "../closeout.ts";
import { withEnv, captureStderr, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const issue: GhIssue = { number: 7, title: "Original source", body: "Original source body", state: "open", labels: [], user: null,
  assignee: null, milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: "https://github.com/o/r/issues/7" };
const changed = { ...issue, title: "Changed source", body: "Changed source body", updated_at: "2025-03-01T00:00:00Z" };

/** Isolate native files/history and pin every child CLI; some cases also exercise the Git-backed gate. */
async function tracker(run: (root: string) => Promise<void>, git = false) {
  const directory = mkdtempSync(join(tmpdir(), "github-owner-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Run the real import core; only the external GitHub source is supplied. */
async function sync(root: string, source: GhIssue = issue, options: Record<string, unknown> = {}) {
  return captureStderr(() => runImport(repo, root, parseImportOptions(options), {
    resolveToken: () => undefined, fetchIssues: async () => [source], fetchIssueTimeline: async () => [],
  }));
}

/** Read both authoritative streams so refusals cannot conceal metadata or history writes. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "utf8"), readFileSync(getHistoryPath(root, id), "utf8")];
}

/** An independent SDK request relinks the live item under its normal item/history lock. */
async function relink(root: string, id: string, owner = "other/project", number = 8, alias = "github_url", urlOnly = false) {
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => mutateItem({ pmRoot: root, id, settings: await readSettings(root),
    author: "fixture", op: "update", message: "Explicit relink", mutate: document => {
      for (const field of Object.keys(document.metadata)) if (/^github_?url$/i.test(field)) delete document.metadata[field];
      document.metadata.github_repo = owner; document.metadata.github_number = number;
      if (alias !== "number_only") document.metadata[alias] = `https://github.com/${owner}/issues/${number}`;
      if (urlOnly) { delete document.metadata.github_repo; delete document.metadata.github_number; }
      return { changedFields: ["github_url", "github_repo", "github_number", ...(alias !== "number_only" ? [alias] : [])] };
    } }));
  const current = await get(id, {}, { pmRoot: root });
  const history = verifyHistoryEntries(await readHistoryEntries(getHistoryPath(root, id), id));
  assert.equal(history.ok, true, history.errors.join("; "));
  assert.equal(history.latest_after_hash, current.item_hash);
  return current.item;
}

/** The original plan sees its legitimate owner; later callers must check the live target again. */
async function prepared(root: string, item: PmItem) {
  return (await prepareGithubImport(changed, repo, parseImportOptions({}), undefined, item, undefined,
    { items: [item], releases: [], timeline: async () => [] }))!;
}

/** Refusals identify both normalized owners and the operator's recovery step. */
function conflict(error: unknown) {
  assert.equal((error as { code: string }).code, "github_import_owner_conflict");
  assert.match(String(error), /o\/r#7/);
  assert.match(String(error), /other\/project#8|curated\/unowned/);
  assert.match(String(error), /Restore the intended GitHub provenance/);
  return true;
}

for (const atomic of [false, true]) test(`Ownership deterministic upsert refuses a relinked ID (atomic=${atomic})`, async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  await relink(root, id, "other/project", 8, "github_url", true);
  const before = await bytes(root, id);
  let refusal: unknown;
  try { await sync(root, changed, { atomic, gate: true }); } catch (error: unknown) { refusal = error; }
  assert.deepEqual(await bytes(root, id), before);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  conflict(refusal);
}, true));

for (const referenced of [false, true]) test(`Ownership curated deterministic-ID collision refuses before any batch write (reference=${referenced})`, async () => tracker(async root => {
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  await create({ id, title: "Curated Chore", type: "Chore", body: "Curated body", tags: referenced ? "keep,gh:o/r#7" : "keep" }, { pmRoot: root });
  const before = await bytes(root, id);
  let refusal: unknown;
  try { await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true }), {
    resolveToken: () => undefined, fetchIssues: async () => [{ ...changed, number: 1, html_url: "https://github.com/o/r/issues/1" }, changed], fetchIssueTimeline: async () => [],
  })); } catch (error: unknown) { refusal = error; }
  assert.deepEqual(await bytes(root, id), before);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  conflict(refusal);
}));

for (const alias of ["number_only", "github_url", "GitHubURL", "external_links"]) for (const atomic of [false, true]) {
  test(`Ownership selected URL target rechecks its live owner (${alias}, atomic=${atomic})`, async () => tracker(async root => {
    const item = (await create({ title: "Curated URL owner", type: "Chore", body: "Curated body" }, { pmRoot: root })).item;
    await relink(root, item.id, repo, 7, alias, alias !== "number_only");
    let before: string[] = [];
    await assert.rejects(() => captureStderr(() => runImport(repo, root, parseImportOptions({ atomic }), {
      resolveToken: () => undefined, fetchIssues: async () => [changed], fetchIssueTimeline: async () => {
        // Keep all explicit URL aliases consistent while transferring authority.
        const current = await relink(root, item.id, "other/project", 8, alias, alias !== "number_only");
        if (alias === "number_only") assert.equal(current.github_number, 8);
        else assert.equal(current[alias], "https://github.com/other/project/issues/8");
        before = await bytes(root, item.id); return [];
      },
    })), conflict);
    assert.deepEqual(await bytes(root, item.id), before);
  }));
}

test("Ownership locked atomic upsert refuses an occupant arriving after preflight", async () => tracker(async root => {
  const entry = (await prepareGithubImport(changed, repo, parseImportOptions({}), undefined, undefined, undefined,
    { items: [], releases: [], timeline: async () => [] }))!;
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  let before: string[] = [];
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: async context => {
    if (context.transition === "prepared") {
      await runWithActiveExtensions({ path: root, noExtensions: true }, () => create({ id, title: "Peer Chore", type: "Chore", body: "Peer body" }, { pmRoot: root }));
      await relink(root, id); before = await bytes(root, id);
    }
  } }), conflict);
  assert.deepEqual(await bytes(root, id), before);
}));

test("Ownership malformed creation plan refuses before publishing an unowned record", async () => tracker(async root => {
  const entry = (await prepareGithubImport(changed, repo, parseImportOptions({}), undefined, undefined, undefined,
    { items: [], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [{ ...entry, description: "A curated description without a source marker" }]), { code: "github_import_plan_ownership_invalid" });
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
  assert.deepEqual(await listUnfinishedGithubImports(root), []);
}));

test("Ownership native SDK revision fence refuses a peer edit after the owner read", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const item = (await listAllComplete({}, { pmRoot: root })).items[0]!;
  const original = await get(item.id, {}, { pmRoot: root });
  await mutateItem({ pmRoot: root, id: item.id, settings: await readSettings(root), author: "fixture", op: "update", message: "Peer content edit",
    mutate: document => { document.metadata.title = "Peer title"; return { changedFields: ["title"] }; } });
  const before = await bytes(root, item.id);
  await assert.rejects(() => mutateGithubOwnedItem(root, { id: item.id, repo, number: 7 }, "update", { title: changed.title }, original.item_hash), /revision|hash|changed/i);
  assert.deepEqual(await bytes(root, item.id), before);
}));

test("Ownership refresh refuses a target relinked during its GitHub read", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  let before: string[] = [];
  await withMockGithub(async (_request, response) => {
    await relink(root, id); before = await bytes(root, id);
    jsonResponse(response, 200, { data: { repository: { i7: { number: 7, title: changed.title, body: changed.body, state: "OPEN", stateReason: null,
      createdAt: issue.created_at, updatedAt: changed.updated_at, closedAt: null, url: issue.html_url, author: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  }, () => assert.rejects(() => runRefresh(repo, root, {}), conflict));
  assert.deepEqual(await bytes(root, id), before);
}));

test("Ownership recovery refuses a recorded target that was subsequently relinked", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const item = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items[0]!;
  const entry = await prepared(root, item);
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => {
    if (context.transition === "prepared") throw new WorkspaceTransactionInterruptedError("Fixture interruption");
  } }));
  const journal = (await listUnfinishedGithubImports(root))[0]!;
  const record = (await readGithubImportPlan(root, journal.transactionId))!;
  await relink(root, item.id);
  const before = await bytes(root, item.id);
  await assert.rejects(() => resumeGithubImport(root, record), conflict);
  assert.deepEqual(await bytes(root, item.id), before);
}));

test("Ownership source finalizer refuses a different current owner inside its item lock", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const item = (await listAllComplete({}, { pmRoot: root })).items[0]!;
  await relink(root, item.id);
  const before = await bytes(root, item.id);
  await assert.rejects(() => persistImportFidelity(root, item.id, buildImportFidelity(changed, [], []), false), conflict);
  assert.deepEqual(await bytes(root, item.id), before);
}));

test("Ownership annotations refuse a different current owner", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const item = (await listAllComplete({}, { pmRoot: root })).items[0]!;
  await relink(root, item.id);
  const before = await bytes(root, item.id);
  await assert.rejects(() => syncGithubCommentsToAnnotations(item.id, [{ id: 1, body: "Incoming source note", created_at: issue.updated_at, user: null }], root, 7,
    { id: item.id, repo, number: 7 }), conflict);
  assert.deepEqual(await bytes(root, item.id), before);
}));

test("Ownership dependency writes recheck their selected source", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  await sync(root, { ...issue, number: 9, html_url: "https://github.com/o/r/issues/9" }, { atomic: true });
  const items = (await listAllComplete({}, { pmRoot: root })).items;
  const source = items.find(item => item.github_number === 7)!;
  let before: string[] = [];
  let reads = 0;
  const result = await linkImportedDependencies(repo, [{ ...issue, body: "Blocked by #9" }], root, {
    listItemMetadata: async pmRoot => {
      const snapshot = await listAllItemMetadata(pmRoot);
      if (reads++ === 0) { await relink(root, source.id); before = await bytes(root, source.id); }
      return snapshot;
    },
  });
  assert.equal(result.linked, 0);
  assert.match(result.failures.join(""), /other\/project#8/);
  assert.deepEqual(await bytes(root, source.id), before);
}));

/** Supply only external PR evidence; selection, snapshot fences and closure are the real SDK operations. */
function deliveryApi(id: string): CloseoutApi {
  const sha = "a".repeat(40);
  return { base: "https://api.github.com", next: () => undefined, get: async endpoint => ({ body: JSON.stringify(
    endpoint.includes("/pulls/") ? endpoint.includes("/commits?") ? [] : {
      number: 1, commits: 0, merged: true, merged_at: "2027-01-01T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: `https://github.com/${repo}/pull/1`,
      body: `Closes https://github.com/${repo}/blob/main/.agents/pm/issues/${id}.toon`, head: { sha }, base: { ref: "main", repo: { full_name: repo } },
    } : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
      : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "success", app: { id: 1 } }] } : []),
  }) };
}

for (const owner of ["other/project", repo]) test(`Ownership closeout refuses a relinked issue despite passing delivery evidence (${owner})`, async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const item = (await listAllComplete({}, { pmRoot: root })).items[0]!;
  const beforeRelink = await runCloseout(root, repo, { pr: "1" }, deliveryApi(item.id));
  assert.equal(beforeRelink.plan[0]!.action, "close", "Passing evidence must otherwise select this item");
  await relink(root, item.id, owner);
  const before = await bytes(root, item.id);
  const result = await runCloseout(root, repo, { pr: "1", apply: true }, deliveryApi(item.id));
  assert.equal(result.closed, 0);
  assert.equal(result.plan[0]!.code, "github_import_owner_conflict");
  assert.ok(result.plan[0]!.reason.includes(`${owner}#8`));
  assert.deepEqual(await bytes(root, item.id), before);
}));

for (const atomic of [false, true]) test(`Ownership matching-owner control stays idempotent (atomic=${atomic})`, async () => tracker(async root => {
  await sync(root, issue, { atomic });
  const item = (await listAllComplete({}, { pmRoot: root })).items[0]!;
  const before = await bytes(root, item.id);
  await sync(root, issue, { atomic });
  assert.deepEqual(await bytes(root, item.id), before);
  await sync(root, changed, { atomic });
  const all = (await listAllComplete({}, { pmRoot: root })).items;
  assert.equal(all.length, 1); assert.equal(all[0]!.id, item.id); assert.equal(all[0]!.title, changed.title);
}));

test("Ownership matching-owner legacy control retains its generated-source marker", async () => tracker(async root => {
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  await create({ id, title: issue.title, type: "Issue", body: issue.body!, description: `GH issue #7: ${issue.html_url}`, tags: "gh:o/r#7" }, { pmRoot: root });
  await sync(root, issue, { atomic: true });
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  assert.equal((await get(id, {}, { pmRoot: root })).item.github_number, 7);
  const before = await bytes(root, id);
  await sync(root, issue, { atomic: true });
  assert.deepEqual(await bytes(root, id), before);
}));

test("Ownership guard preserves ambient mutation guards", async () => tracker(async root => {
  await sync(root, issue, { atomic: true });
  const item = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items[0]!;
  const entry = await prepared(root, item);
  const before = await bytes(root, item.id);
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "fixture-policy", run: () => ({ allow: false, code: "fixture_denied", remediation: "Fixture refusal" }) }] });
    await assert.rejects(() => importGithubAtomic(root, repo, [entry]), /fixture_denied|fixture-policy/);
  });
  assert.deepEqual(await bytes(root, item.id), before);
}));

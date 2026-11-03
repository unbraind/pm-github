/** Byte-level regressions for the scheduled atomic gated import, using the real SDK store. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init, create, get, update, getHistoryPath, getItemPath, WorkspaceTransactionInterruptedError, setActiveExtensionRegistrations, listAllComplete, normalizeItemId } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { runImport, parseImportOptions, importGithubAtomic, prepareGithubImport, deriveAtomicItemId, type GhIssue, type GhComment, type AtomicImportOptions } from "../index.ts";
import { refreshChanges } from "../refresh.ts";
import { persistImportFidelity, buildImportFidelity, selectImportContextIndex } from "../import-fidelity.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

const repo = "fixture/widgets";
/** Keep creation, completion and later source edits distinct. */
function issue(number: number, postCloseEdit = false): GhIssue {
  return { number, title: `Issue ${number}`, body: `Body ${number}`, state: "closed", state_reason: "completed",
    labels: [{ name: "bug" }], user: null, assignee: null, milestone: null,
    created_at: "2025-01-01T00:00:00Z", closed_at: "2025-02-01T00:00:00Z",
    updated_at: postCloseEdit ? "2025-03-01T00:00:00Z" : "2025-02-01T00:00:00Z",
    html_url: `https://github.com/${repo}/issues/${number}` };
}
/** Isolate every case, including Git and environment-dependent gate reads. */
async function tracker(run: (pmRoot: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "repeat-import-"));
  const pmRoot = join(directory, ".agents/pm");
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot, cwd: directory, noExtensions: true });
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
    setActiveExtensionRegistrations(harness.activation.registrations);
    await withEnv({ PM_PATH: pmRoot, PM_AUTHOR: "fixture" }, () => run(pmRoot));
  } finally { setActiveExtensionRegistrations(null); rmSync(directory, { recursive: true, force: true }); }
}
/** Fake only GitHub transport; all PM planning, writes, journals and gate scans are real. */
async function importing(pmRoot: string, issues: GhIssue[], comments: GhComment[] = [], onTransition?: AtomicImportOptions["onTransition"]) {
  return (await captureStderr(() => runImport(repo, pmRoot,
    parseImportOptions({ state: "all", atomic: true, gate: true, "with-comments": true }), {
      resolveToken: () => undefined, fetchIssues: async () => issues, fetchIssueComments: async () => comments,
      ...(onTransition ? { commitAtomic: (root, name, entries) => importGithubAtomic(root, name, entries, { onTransition }) } : {}),
    }))).result as Record<string, unknown>;
}
/** Snapshot both durable streams, retaining byte equality rather than comparing projections. */
async function bytes(pmRoot: string, id: string) {
  const item = (await get(id, {}, { pmRoot })).item;
  return { item: readFileSync(getItemPath(pmRoot, item.type!, id), "utf8"), history: readFileSync(getHistoryPath(pmRoot, id), "utf8") };
}
/** Assert a genuine change is followed by an entirely read-only identical repeat. */
async function repeat(pmRoot: string, issues: GhIssue[], id: string, comments: GhComment[] = []) {
  const before = await bytes(pmRoot, id);
  const result = await importing(pmRoot, issues, comments);
  assert.equal(result.unchanged, true);
  assert.deepEqual(await bytes(pmRoot, id), before);
}

/** Import history must never claim that an old GitHub closure happened at import time. */
function assertSourceClosures(pmRoot: string, id: string, skip = 0, dates: readonly unknown[] = [issue(1).closed_at]) {
  const events = readFileSync(getHistoryPath(pmRoot, id), "utf8").trim().split("\n").map(line => JSON.parse(line) as { patch: Array<{ path: string; value?: unknown }> });
  const writes = events.flatMap(event => event.patch).filter(patch => patch.path === "/metadata/closed_at" && patch.value);
  assert.ok(writes.slice(skip).every(patch => dates.includes(patch.value)), "every import closure must retain the exact source instant");
}

test("mixed new and linked closed issues plus an open issue repeat with identical item and history bytes", async () => tracker(async pmRoot => {
  const linked = (await create({ title: "Previously linked", type: "Chore", status: "closed", closeReason: "Original closure",
    completedAt: "2025-02-01T00:00:00Z", tags: `gh:${repo}#1` }, { pmRoot })).item;
  await persistImportFidelity(pmRoot, linked.id, buildImportFidelity(issue(1), [], []), false);
  const issues = [issue(1), issue(2), issue(3, true), { ...issue(4), state: "open" as const, state_reason: null, closed_at: null }];
  const first = await importing(pmRoot, issues);
  assert.equal(first.imported, 3);
  assert.equal(first.updated, 1);
  // Inspect every target via its normal provenance-aware plan, not result formatting.
  const items = (await listAllComplete({ includeBody: true }, { pmRoot, noExtensions: true })).items;
  const before = await Promise.all(items.map(item => bytes(pmRoot, item.id)));
  const second = await importing(pmRoot, issues);
  assert.equal(second.unchanged, true, JSON.stringify(second.plan));
  assert.deepEqual(await Promise.all(items.map(item => bytes(pmRoot, item.id))), before);
  assert.equal(items.length, 4);
  for (const item of items) {
    assert.equal(item.created_at, issue(1).created_at);
    if (item.status === "closed") {
      assert.equal(item.closed_at, issue(1).closed_at);
      assert.equal(item.completed_at, issue(1).closed_at);
    }
  }
  assert.equal((await get(linked.id, {}, { pmRoot })).item.created_at, issue(1).created_at);
  for (const item of items) assertSourceClosures(pmRoot, item.id, item.id === linked.id ? 1 : 0);
}));

test("closed finalization writes only changed values and retains the native mutation clock", async () => tracker(async pmRoot => {
  await importing(pmRoot, [issue(1, true)]);
  const id = deriveAtomicItemId(repo, 1, "fixture-", normalizeItemId);
  const item = (await get(id, {}, { pmRoot })).item;
  const entry = await prepareGithubImport(issue(1, true), repo, parseImportOptions({}), undefined, item, undefined,
    { items: [item], releases: [], timeline: async () => [] });
  assert.deepEqual(refreshChanges(entry!), []);
  const before = await bytes(pmRoot, id);
  await persistImportFidelity(pmRoot, id, entry!.fidelity!, false);
  assert.deepEqual(await bytes(pmRoot, id), before);
  await persistImportFidelity(pmRoot, id, { ...entry!.fidelity!, github_created_at: "2025-01-01T00:00:00.000Z" }, false, true);
  assert.deepEqual(await bytes(pmRoot, id), before, "refresh-equivalent date spellings must not create history");
  assert.equal(item.closed_at, issue(1).closed_at);
  assert.equal(item.completed_at, issue(1).closed_at);
  assert.ok(Date.parse(item.updated_at!) > Date.parse(issue(1, true).updated_at));
  assertSourceClosures(pmRoot, id);
  const content = { context: { item_transaction_step: "bulk-item-transaction github-import-test 1-update apply" }, patch: [] };
  assert.equal(selectImportContextIndex([content], "closed"), -1);
  for (const step of [123, "bulk-item-transaction other 1-update apply"]) {
    assert.equal(selectImportContextIndex([{ ...content, context: { item_transaction_step: step } }], "closed"), 0);
  }
  const reopened = { message: "bulk-item-transaction github-import-open 1-update apply", patch: [{ path: "/metadata/status", value: "open" }] };
  assert.equal(selectImportContextIndex([reopened, content], "closed"), 0);
  assert.equal(selectImportContextIndex([reopened, { message: content.context.item_transaction_step, patch: [] }], "closed"), 0);
  const openFidelity = buildImportFidelity({ ...issue(1, true), state: "open", state_reason: "reopened", closed_at: null }, [], []);
  await persistImportFidelity(pmRoot, id, openFidelity, false);
  const open = (await get(id, {}, { pmRoot })).item;
  assert.equal(open.status, "open");
  for (const field of ["closed_at", "completed_at", "close_reason"] as const) assert.equal(open[field], undefined);
  const openBytes = await bytes(pmRoot, id);
  await persistImportFidelity(pmRoot, id, openFidelity, false);
  assert.deepEqual(await bytes(pmRoot, id), openBytes);
}));

for (const field of ["title", "body", "labels", "comments", "state"] as const) {
  test(`real upstream ${field} edit lands once without fabricating a closure`, async () => tracker(async pmRoot => {
    const source = issue(1, true);
    await importing(pmRoot, [source]);
    const id = deriveAtomicItemId(repo, 1, "fixture-", normalizeItemId);
    const before = await bytes(pmRoot, id);
    const changed = { ...source, updated_at: "2025-04-01T00:00:00Z",
      ...(field === "title" ? { title: "Changed title" } : {}),
      ...(field === "body" ? { body: "Changed body" } : {}),
      ...(field === "labels" ? { labels: [{ name: "enhancement" }] } : {}),
      ...(field === "state" ? { state_reason: "not_planned" as const } : {}),
    };
    const comments = field === "comments" ? [{ id: 1, body: "New comment", user: { login: "fixture" }, created_at: changed.updated_at }] : [];
    await importing(pmRoot, [changed], comments);
    assert.notDeepEqual(await bytes(pmRoot, id), before);
    const item = (await get(id, {}, { pmRoot })).item;
    assert.equal(item.github_updated_at, changed.updated_at);
    assert.equal(item.closed_at, source.closed_at);
    assert.equal(item.completed_at, source.closed_at);
    assert.ok(Date.parse(item.updated_at!) > Date.parse(changed.updated_at));
    if (field === "title") assert.equal(item.title, changed.title);
    if (field === "labels") assert.ok(item.tags?.includes("enhancement"));
    if (field === "state") assert.equal(item.status, "canceled");
    if (field === "body" || field === "comments") assert.match((await bytes(pmRoot, id)).item, field === "body" ? /Changed body/ : /New comment/);
    await repeat(pmRoot, [changed], id, comments);
    assertSourceClosures(pmRoot, id);
  }));
}

test("GitHub reopen clears source closure and a later close retains the original source instant", async () => tracker(async pmRoot => {
  const source = issue(1);
  await importing(pmRoot, [source]);
  const id = deriveAtomicItemId(repo, 1, "fixture-", normalizeItemId);
  const opened = { ...source, state: "open" as const, state_reason: "reopened" as const, closed_at: null, updated_at: "2025-03-01T00:00:00Z" };
  await importing(pmRoot, [opened]);
  const item = (await get(id, {}, { pmRoot })).item;
  assert.equal(item.status, "open");
  for (const key of ["closed_at", "completed_at", "close_reason"] as const) assert.equal(item[key], undefined);
  await repeat(pmRoot, [opened], id);
  const closedAgain = { ...source, closed_at: "2025-04-01T00:00:00Z", updated_at: "2025-04-01T00:00:00Z" };
  await importing(pmRoot, [closedAgain]);
  const closed = (await get(id, {}, { pmRoot })).item;
  assert.equal(closed.closed_at, closedAgain.closed_at);
  assert.equal(closed.completed_at, closedAgain.closed_at);
  await repeat(pmRoot, [closedAgain], id);
  assertSourceClosures(pmRoot, id, 0, [source.closed_at, closedAgain.closed_at]);
}));

test("local reopen and interrupted transaction replay restore GitHub close without duplicate effects", async () => tracker(async pmRoot => {
  let source = issue(1, true);
  const first = await importing(pmRoot, [source]);
  const id = deriveAtomicItemId(repo, 1, "fixture-", normalizeItemId);
  for (const transition of ["step_recorded", "committing"] as const) {
    await update(id, { status: "open", author: "fixture", message: "Local reopen" }, { pmRoot });
    source = { ...source, title: `Edited before ${transition}` };
    let transactionId = "";
    await assert.rejects(importing(pmRoot, [source], [], context => {
      if (context.transition === transition && (transition === "committing" || context.stepId?.includes("update"))) {
        transactionId = context.transactionId;
        throw new WorkspaceTransactionInterruptedError("Interrupt governed import");
      }
    }), /journal is resumable/);
    assert.ok(transactionId);
    assert.notEqual(transactionId, first.transactionId);
    const finalized = transition === "committing" ? await bytes(pmRoot, id) : undefined;
    const recovered = await importing(pmRoot, [source]);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.transactionId, transactionId);
    const item = (await get(id, {}, { pmRoot })).item;
    assert.equal(item.status, "closed");
    assert.equal(item.title, source.title);
    if (finalized) assert.deepEqual(await bytes(pmRoot, id), finalized, "replaying finalized steps must not duplicate any item or history effect");
    await repeat(pmRoot, [source], id);
  }
  assertSourceClosures(pmRoot, id);
}));

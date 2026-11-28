import { seedExistingItem } from "./helpers/import-mirror.ts";
/** Reference tags never transfer curated content ownership; all storage is real SDK storage. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { init, create, get, getItemPath, getHistoryPath, listAllComplete, update, runWithActiveExtensions, setActiveExtensionHooks, setActiveExtensionRegistrations, normalizeItemId, commitItemMutations } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { runImport, parseImportOptions, deriveAtomicItemId, type GhIssue } from "../index.ts";
import { applyLocalIssueReferences, planLocalIssueReferences } from "../import-references.ts";
import { selectRefreshTargets } from "../refresh.ts";
import { buildGithubOwnershipIndex, ownershipStateOf } from "../import-ownership.ts";
import { exploreGithubIdentities } from "../identity.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const tag = "gh:o/r#7";
const issue: GhIssue = { number: 7, title: "Source issue", body: "Source body", state: "open", labels: [{ name: "source-label" }],
  assignee: null, milestone: null, user: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z", html_url: "https://github.com/o/r/issues/7" };

/** Initialize isolated SDK storage, including the supported non-git case. */
async function tracker(git: boolean, run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "reference-identity-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Mock transport only; planner, transactions, metadata, history and the gate use their actual implementations. */
async function sync(root: string, source = issue, atomic = true, gate = true, dryRun = false) {
  return (await captureStderr(() => runImport(repo, root, parseImportOptions({ state: "all", atomic, gate, "dry-run": dryRun }), {
    resolveToken: () => undefined, fetchIssues: async () => [source], fetchIssueTimeline: async () => [],
  }))).result as Record<string, unknown>;
}
/** Capture current native bytes and history to prove zero-change compatibility. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "utf8"), readFileSync(getHistoryPath(root, id), "utf8")];
}

for (const atomic of [true, false]) {
  test(`one reference-only Chore keeps all curated fields (${atomic})`, async () => tracker(true, async root => {
    const local = (await create({ title: "Curated local Chore", type: "Chore", description: "Local description", body: "Local body", tags: `${tag},curated` }, { pmRoot: root })).item;
    const before = await bytes(root, local.id);
    const result = await sync(root, issue, atomic);
    assert.deepEqual(await bytes(root, local.id), before);
    assert.equal(result.imported, 1);
    const items = (await listAllComplete({}, { pmRoot: root })).items;
    const mirror = items.find(item => item.github_number === 7)!;
    assert.deepEqual(mirror.dependencies?.map(({ id, kind }) => ({ id, kind })), [{ id: local.id, kind: "related" }]);
    assert.equal(mirror.title, issue.title);
    assert.equal(mirror.status, "open");
    assert.ok(existsSync(getItemPath(root, "Chore", local.id)));
    assert.equal((await get(local.id, {}, { pmRoot: root })).item.created_at, local.created_at);
  }));
  test(`two shared references import exactly once and do not collide (${atomic})`, async () => tracker(true, async root => {
    for (const title of ["Local A", "Local B"]) await create({ title, type: "Task", tags: tag }, { pmRoot: root });
    const preview = await sync(root, issue, atomic, true, true);
    const result = await sync(root, issue, atomic);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.local_issue_references, preview.local_issue_references);
    const items = (await listAllComplete({}, { pmRoot: root, noExtensions: true })).items;
    assert.equal(items.length, 3);
    assert.equal(items.filter(item => item.github_number === 7).length, 1);
    const mirror = items.find(item => item.github_number === 7)!;
    const locals = items.filter(item => item.id !== mirror.id);
    assert.deepEqual(mirror.dependencies?.map(dep => dep.id).sort(), locals.map(item => item.id).sort());
    const before = await Promise.all(items.map(item => bytes(root, item.id)));
    const repeat = await sync(root, issue, atomic);
    assert.equal(repeat.imported, 0);
    assert.equal(repeat.local_issue_references, undefined);
    assert.deepEqual(await Promise.all(items.map(item => bytes(root, item.id))), before);
    assert.equal((await exploreGithubIdentities(root)).collisions, 0);
  }));
  test(`importer-created mirror still refreshes title beside reference items (${atomic})`, async () => tracker(true, async root => {
    await sync(root, issue, atomic);
    const imported = (await listAllComplete({}, { pmRoot: root })).items[0]!;
    await create({ title: "Related delivery", type: "Chore", tags: tag }, { pmRoot: root });
    const result = await sync(root, { ...issue, title: "New source title" }, atomic);
    assert.equal(result.updated, 1);
    assert.equal((await get(imported.id, {}, { pmRoot: root })).item.title, "New source title");
  }));
}

test("a closed pre-existing mirror backfills tag and URL citations in a non-git tracker", async () => tracker(false, async root => {
  const source = { ...issue, state: "closed" as const, state_reason: "completed" as const,
    closed_at: "2025-01-02T00:00:00Z" };
  await sync(root, source, true, false);
  const [mirror] = (await listAllComplete({}, { pmRoot: root })).items;
  const tagged = (await create({ title: "Tagged", type: "Chore", status: "in_progress", tags: "gh:O/R#7" }, { pmRoot: root })).item;
  const url = (await create({ title: "URL", type: "Chore", body: "Keep me" }, { pmRoot: root })).item;
  await seedExistingItem(root, url.id, { metadata: { ...url, github_url: "https://www.github.com/O/R/issues/7/?a=b#note" }, body: "Keep me" }, "Seed URL citation");
  const unrelated = (await create({ title: "Unrelated", type: "Chore", tags: "gh:o/r#70,gh:other/r#7" }, { pmRoot: root })).item;
  const ids = [tagged.id, url.id, unrelated.id];
  const localBytes = await Promise.all(ids.map(id => bytes(root, id)));
  const before = await bytes(root, mirror!.id);
  const preview = await sync(root, source, true, false, true);
  assert.deepEqual(await bytes(root, mirror!.id), before);
  const applied = await sync(root, source, true, false);
  assert.equal(applied.imported, 0);
  assert.equal(applied.updated, 0);
  assert.equal(applied.unchanged, undefined);
  assert.deepEqual(applied.local_issue_references, preview.local_issue_references);
  const linked = (await get(mirror!.id, {}, { pmRoot: root })).item;
  assert.deepEqual(linked.dependencies?.map(edge => edge.id).sort(), [tagged.id, url.id].sort());
  for (const field of ["title", "status", "created_at", "closed_at", "completed_at"] as const) assert.equal(linked[field], mirror![field]);
  const after = await bytes(root, mirror!.id);
  assert.equal((await sync(root, source, true, false)).unchanged, true);
  assert.deepEqual(await bytes(root, mirror!.id), after);
  assert.deepEqual(await Promise.all(ids.map(id => bytes(root, id))), localBytes);
  assert.equal((await exploreGithubIdentities(root)).collisions, 0);
}));

test("an existing reverse related edge is preserved without a second write", async () => tracker(false, async root => {
  await sync(root, issue, true, false);
  const [mirror] = (await listAllComplete({}, { pmRoot: root })).items;
  const local = (await create({ title: "Linked", tags: tag }, { pmRoot: root })).item;
  await update(local.id, { dep: [`id=${mirror!.id},kind=related`] }, { pmRoot: root });
  const ids = [mirror!.id, local.id];
  const before = await Promise.all(ids.map(id => bytes(root, id)));
  assert.equal((await sync(root, issue, true, false)).unchanged, true);
  assert.deepEqual(await Promise.all(ids.map(id => bytes(root, id))), before);
}));

test("reference linking rechecks a citation changed under the native writer lock", async () => tracker(false, async root => {
  await sync(root, issue, true, false);
  const [mirror] = (await listAllComplete({}, { pmRoot: root })).items;
  const local = (await create({ title: "Delivery edited during import", type: "Chore", tags: tag }, { pmRoot: root })).item;
  const before = await bytes(root, mirror!.id);
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [],
      beforeMutation: [{ layer: "project", name: "fixture-remove-reference", run: async context => {
        if (context.before?.metadata.id === mirror!.id) await update(local.id, { removeTags: [tag] }, { pmRoot: root });
      } }] });
    await assert.rejects(sync(root, issue, true, false), /Local references to GitHub issue #7 changed during import/);
  });
  assert.deepEqual(await bytes(root, mirror!.id), before);
  assert.equal((await sync(root, issue, true, false)).unchanged, true);
  await update(local.id, { addTags: [tag] }, { pmRoot: root });
  assert.deepEqual((await sync(root, issue, true, false)).local_issue_references, [
    { item: mirror!.id, issue: 7, local_item: local.id, kind: "related" },
  ]);
}));

test("reference plans skip unavailable endpoints and unrelated legacy metadata", async () => tracker(false, async root => {
  const local = (await create({ title: "Local delivery awaiting a mirror", type: "Chore", tags: tag }, { pmRoot: root })).item;
  const mirror = { item: "fixture-missing-mirror", issue: 7 };
  const planned = planLocalIssueReferences([
    local,
    { tags: [tag] },
    { id: "fixture-untagged" },
    { id: "fixture-api", github_url: "https://api.github.com/repos/o/r/issues/7", tags: ["gh:o/r#invalid"] },
    { id: "fixture-legacy", tags: [tag], dependencies: [null, false, {}, { id: mirror.item }, { id: mirror.item, kind: 1 }] },
  ], repo, [mirror]);
  assert.deepEqual(planned.map(edge => edge.local_item), ["fixture-legacy", local.id].sort());
  const before = await bytes(root, local.id);
  assert.deepEqual(await applyLocalIssueReferences(root, repo, [mirror], planned), []);
  assert.deepEqual(await bytes(root, local.id), before);
}));

for (const atomic of [false, true]) {
  test(`projected same-batch citations link on the first import (${atomic})`, async () => tracker(false, async root => {
    const batch = [
      { ...issue, labels: [{ name: "gh:o/r#8" }] },
      { ...issue, number: 8, title: "Same-batch mirror", html_url: "https://github.com/o/r/issues/8" },
    ];
    const run = (dryRun: boolean) => runImport(repo, root, parseImportOptions({ atomic, "dry-run": dryRun }), {
      fetchIssues: async () => batch, resolveToken: () => undefined,
    });
    const preview = await run(true);
    const [citing, cited] = batch.map(item => deriveAtomicItemId(repo, item.number, "fixture-", normalizeItemId));
    const expected = [{ item: cited, issue: 8, local_item: citing, kind: "related" }];
    assert.deepEqual("local_issue_references" in preview && preview.local_issue_references, expected);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
    const result = await run(false);
    assert.deepEqual("local_issue_references" in result && result.local_issue_references, expected);
    const ids = [citing!, cited!];
    const before = await Promise.all(ids.map(id => bytes(root, id)));
    await run(false);
    assert.deepEqual(await Promise.all(ids.map(id => bytes(root, id))), before);
  }));

  test(`reciprocal citations choose one stable edge regardless of input order (${atomic})`, async () => tracker(false, async root => {
    const batch = [
      { ...issue, labels: [{ name: "gh:o/r#8" }, { name: tag }] },
      { ...issue, number: 8, title: "Reciprocal mirror", html_url: "https://github.com/o/r/issues/8", labels: [{ name: tag }] },
    ];
    const local = (await create({ title: "Distinct local citation", tags: "gh:o/r#8" }, { pmRoot: root })).item;
    const run = (dryRun: boolean) => runImport(repo, root, parseImportOptions({ atomic, "dry-run": dryRun }), {
      fetchIssues: async () => batch, resolveToken: () => undefined,
    });
    const preview = await run(true);
    assert.ok("local_issue_references" in preview);
    assert.equal(preview.local_issue_references?.length, 2);
    assert.deepEqual(preview.local_issue_references?.map(edge => edge.issue), [7, 8]);
    assert.equal(preview.local_issue_references?.[1]?.local_item, local.id);
    batch.reverse();
    const result = await run(false);
    assert.deepEqual("local_issue_references" in result && result.local_issue_references, preview.local_issue_references);
    const items = (await listAllComplete({}, { pmRoot: root })).items;
    assert.equal(items.flatMap(item => item.dependencies ?? []).filter(edge => edge.kind === "related").length, 2);
  }));
}

test("link-only imports use a fresh journal after an explicitly removed edge", async () => tracker(false, async root => {
  await sync(root, issue, true, false);
  const [mirror] = (await listAllComplete({}, { pmRoot: root })).items;
  const local = (await create({ title: "Curated repeat target", type: "Chore", tags: tag }, { pmRoot: root })).item;
  const first = await sync(root, issue, true, false);
  await commitItemMutations({ pmRoot: root, transactionId: "github-import-fixture-removal", author: "pm-github",
    mutations: [{ op: "update", id: mirror!.id, options: { depRemove: [`id=${local.id},kind=related`] } }] });
  const second = await sync(root, issue, true, false);
  assert.notEqual(second.transactionId, first.transactionId);
  assert.deepEqual((await get(mirror!.id, {}, { pmRoot: root })).item.dependencies?.map(dep => dep.id), [local.id]);
  assert.equal((await sync(root, issue, true, false)).unchanged, true);
}));

test("legacy importer proof classifies bare URL citations without a source URL", async () => tracker(true, async root => {
  const id = deriveAtomicItemId(repo, issue.number, "fixture-", normalizeItemId);
  await create({ id, title: issue.title, type: "Issue", author: "pm-github", tags: tag, body: issue.body! }, { pmRoot: root });
  const local = (await create({ title: "Citing local chore", type: "Chore" }, { pmRoot: root })).item;
  await seedExistingItem(root, local.id, { metadata: { ...local, github_url: issue.html_url }, body: "" }, "Seed bare citation URL");
  const before = await bytes(root, local.id);
  const items = (await listAllComplete({}, { pmRoot: root })).items;
  const index = buildGithubOwnershipIndex(items, [repo]);
  const copy = { ...items.find(item => item.id === local.id)! };
  assert.deepEqual(ownershipStateOf(index, copy).owners, []);
  assert.deepEqual(selectRefreshTargets(items, repo).map(target => target.id), [id]);
  assert.deepEqual((await sync(root, issue, true, true, true)).local_issue_references, [{ item: id, issue: 7, local_item: local.id, kind: "related" }]);
  assert.equal((await sync(root)).imported, 0);
  assert.deepEqual(await bytes(root, local.id), before);
  assert.equal((await get(id, {}, { pmRoot: root })).item.dependencies?.[0]?.id, local.id);
}));

for (const ambiguity of ["multiple mirrors", "inconsistent source kinds"]) {
  test(`bare URL citations retain conflict protection with ${ambiguity}`, async () => tracker(false, async root => {
    const id = deriveAtomicItemId(repo, issue.number, "fixture-", normalizeItemId);
    const mirror = (await create({ id, title: issue.title, type: "Issue", author: "pm-github", tags: tag }, { pmRoot: root })).item;
    if (ambiguity === "multiple mirrors") {
      await create({ id: id.replace("github-", "other-github-"), title: "Second proven mirror", type: "Issue", author: "pm-github", tags: tag }, { pmRoot: root });
    } else {
      await seedExistingItem(root, mirror.id, { metadata: { ...mirror, github_url: issue.html_url,
        external_ref: "https://github.com/o/r/pull/7" }, body: "" }, "Seed ambiguous source kind");
    }
    const local = (await create({ title: "Citing local", type: "Chore" }, { pmRoot: root })).item;
    await seedExistingItem(root, local.id, { metadata: { ...local, github_url: issue.html_url }, body: "" }, "Seed citation URL");
    const before = await bytes(root, local.id);
    await assert.rejects(sync(root, issue, true, false), { code: "github_import_owner_conflict" });
    assert.deepEqual(await bytes(root, local.id), before);
  }));
}

test("workspace-defined relationships coexist with builtin related edges in either direction", async () => tracker(false, async root => {
  await sync(root, issue, true, false);
  const [mirror] = (await listAllComplete({}, { pmRoot: root })).items;
  const local = (await create({ title: "Cites and documents", type: "Chore", tags: tag }, { pmRoot: root })).item;
  const harness = await createExtensionTestHarness({
    manifest: { name: "reference-fixture", version: "1.0.0", capabilities: ["schema"] },
    activate(api: ExtensionApi) {
      api.registerRelationshipKinds([{ kind: "documents", direction: "directed", ordering: false, hierarchy: false,
        outgoing: "many", incoming: "many", lifecycle: "persistent", compatibilityVersion: 1, allowSelf: false }]);
    },
  }, { capabilities: ["schema"] });
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionRegistrations(harness.activation.registrations);
    await update(local.id, { dep: [`id=${mirror!.id},kind=documents`] }, { pmRoot: root });
    await update(mirror!.id, { dep: [`id=${local.id},kind=documents`] }, { pmRoot: root });
    const before = await bytes(root, local.id);
    const preview = await sync(root, issue, true, false, true);
    const actual = await sync(root, issue, true, false);
    assert.deepEqual(actual.local_issue_references, preview.local_issue_references);
    assert.ok(actual.local_issue_references);
    assert.deepEqual((await get(mirror!.id, {}, { pmRoot: root })).item.dependencies?.map(edge => edge.kind).sort(), ["documents", "related"]);
    assert.deepEqual(await bytes(root, local.id), before);
  });
}));

test("released legacy snapshot resyncs with zero changes beside shared references", async () => tracker(true, async root => {
  // These are the exact native fields emitted by the released importer, not a plan made by the new code.
  const local = (await create({ title: issue.title, type: "Issue", status: "open", tags: `${tag},source-label`,
    description: `GH issue #7: ${issue.html_url} · created ${issue.created_at} · updated ${issue.updated_at}`, body: issue.body! }, { pmRoot: root })).item;
  await seedExistingItem(root, local.id, { metadata: { ...local, github_number: 7, github_url: issue.html_url, github_link_only: false,
      github_state: "open", github_state_reason: "unspecified", github_created_at: issue.created_at, github_updated_at: issue.updated_at,
      github_closed_at: "", github_close_reason: "", github_release: "", created_at: issue.created_at }, body: issue.body! }, "Released importer snapshot");
  await create({ title: "Reference to old import", type: "Chore", tags: tag }, { pmRoot: root });
  const before = await bytes(root, local.id);
  const result = await sync(root);
  assert.equal(result.unchanged, true);
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 0);
  assert.deepEqual(await bytes(root, local.id), before);
}));

for (const git of [true, false]) test(`explicit local link merges lifecycle while preserving curated content (git=${git})`, async () => tracker(git, async root => {
  const local = (await create({ title: "Curated title", type: "Chore", description: "Keep description", body: "Keep body", tags: "keep" }, { pmRoot: root })).item;
  await seedExistingItem(root, local.id, { metadata: { ...local, github_url: issue.html_url }, body: "Keep body" }, "Explicit link");
  const source = { ...issue, state: "closed" as const, state_reason: "completed" as const, closed_at: "2027-01-01T00:00:00Z", updated_at: "2027-01-01T00:00:00Z" };
  const result = await sync(root, source, true, git);
  const actual = (await get(local.id, {}, { pmRoot: root })).item;
  for (const field of ["title", "description", "type", "created_at"] as const) assert.equal(actual[field], local[field]);
  assert.equal(actual.body, "Keep body");
  assert.deepEqual(actual.tags, [tag, "keep"].sort());
  assert.equal(actual.status, "closed");
  assert.equal(actual.closed_at, source.closed_at);
  assert.equal(actual.completed_at, source.closed_at);
  assert.equal(((result.plan as Array<{ identity: { title_conflict?: boolean } }> | undefined)?.[0]?.identity.title_conflict) ?? !git, true);
  assert.equal((await sync(root, source, true, git)).unchanged, true);
  assert.equal(selectRefreshTargets([{ ...actual, tags: [tag, "gh:o/r#99"] }], repo)[0]?.number, 7);
  assert.equal(selectRefreshTargets([actual], repo)[0]?.number, 7);
}));

for (const fields of [
  { github_repo: "O/R", github_number: 7 },
  { github_repo: repo, github_number: 7 },
  { github_link_only: true, github_url: issue.html_url },
  { github_link_only: true, description: `GH issue #7: ${issue.html_url}` },
  { github_link_only: true, description: "GH issue #7: https://github.com/O/R/issues/7" },
]) test(`legacy explicit provenance resolves its original item: ${Object.keys(fields).join(",")}`, async () => tracker(true, async root => {
  const local = (await create({ title: "Legacy curated owner", type: "Chore", tags: tag }, { pmRoot: root })).item;
  await seedExistingItem(root, local.id, { metadata: { ...local, ...fields }, body: "Retain legacy context" }, "Legacy link snapshot");
  const result = await sync(root);
  assert.equal(result.imported, 0);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  const actual = (await get(local.id, {}, { pmRoot: root })).item;
  assert.equal(actual.title, local.title);
  assert.equal(actual.type, "Chore");
  assert.equal(actual.created_at, local.created_at);
  assert.equal((await sync(root)).unchanged, true);
}));

test("references on an already linked owner permit another import without rebinding", async () => tracker(true, async root => {
  const local = (await create({ title: "Owner", type: "Chore", tags: `${tag},gh:o/r#99` }, { pmRoot: root })).item;
  await seedExistingItem(root, local.id, { metadata: { ...local, github_url: issue.html_url, github_number: 7, github_link_only: false }, body: "Local" }, "Linked owner with references");
  const source = { ...issue, number: 99, html_url: "https://github.com/o/r/issues/99" };
  const before = await get(local.id, {}, { pmRoot: root });
  const history = readFileSync(getHistoryPath(root, local.id), "utf8");
  await sync(root, source);
  assert.equal((await get(local.id, {}, { pmRoot: root })).item_hash, before.item_hash);
  assert.equal(readFileSync(getHistoryPath(root, local.id), "utf8"), history);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
}));

test("dependency references resolve importer identities beside related local references", async () => tracker(true, async root => {
  await sync(root);
  const delivery = (await create({ title: "Related local work", type: "Chore", tags: tag }, { pmRoot: root })).item;
  await seedExistingItem(root, delivery.id, { metadata: { ...delivery, github_url: issue.html_url }, body: "" }, "Cite with tag and URL");
  const dependent = { ...issue, number: 8, html_url: "https://github.com/o/r/issues/8", body: "Blocked by #7" };
  await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true, gate: true, "link-deps": true }), {
    resolveToken: () => undefined, fetchIssues: async () => [issue, dependent], fetchIssueTimeline: async () => [],
  }));
  const items = (await listAllComplete({}, { pmRoot: root })).items;
  const target = items.find(item => item.github_number === 7)!;
  const source = items.find(item => item.github_number === 8)!;
  assert.equal(source.dependencies?.[0]?.id, target.id);
  assert.equal(items.find(item => item.type === "Chore")!.dependencies?.length ?? 0, 0);
}));

test("seeded curated-link previews agree with the actual SDK lifecycle projection", async () => {
  let seed = 230;
  for (let sample = 0; sample < 8; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const closed = (seed & 4) !== 0;
    const active = (seed & 16) !== 0;
    await tracker(true, async root => {
      const local = (await create({ title: `Curated ${seed}`, type: active ? "Chore" : "Task", status: active ? "in_progress" : "open", tags: `native-${seed}` }, { pmRoot: root })).item;
      await seedExistingItem(root, local.id, { metadata: { ...local, github_url: issue.html_url }, body: "Native body" }, "Seed curated projection");
      const source = { ...issue, title: `Source ${seed}`, state: closed ? "closed" as const : "open" as const,
        state_reason: closed ? "completed" as const : null, closed_at: closed ? "2027-01-01T00:00:00Z" : null, updated_at: "2027-01-01T00:00:00Z" };
      const preview = (await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true, gate: true, "dry-run": true }), {
        resolveToken: () => undefined, fetchIssues: async () => [source], fetchIssueTimeline: async () => [],
      }))).result as { plan: Array<{ status: string; created_at: string; closed_at?: string }> };
      const projected = preview.plan[0]!;
      await sync(root, source);
      const actual = (await get(local.id, {}, { pmRoot: root })).item;
      assert.equal(actual.status, projected.status);
      assert.equal(actual.created_at, projected.created_at);
      assert.equal(actual.closed_at, projected.closed_at);
      assert.equal(actual.title, local.title);
      assert.equal(actual.type, local.type);
      assert.equal(actual.body, "Native body");
      assert.equal((await sync(root, source)).unchanged, true);
    });
  }
});

/** Complete review regressions use real SDK trackers, native writes and HTTP transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import {
  init, create, get, comments, mutateItem, readSettings, getItemPath, getHistoryPath,
  listAllComplete, normalizeItemId, runWithActiveExtensions, setActiveExtensionHooks, WorkspaceTransactionInterruptedError,
} from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { runImport, parseImportOptions, prepareGithubImport, importGithubAtomic, deriveAtomicItemId,
  readGithubImportPlan, listRetainedGithubImportPlans, applyPullEntry, type GhIssue, type PmItem, type GhComment } from "../index.ts";
import { selectRefreshTargets, runRefresh } from "../refresh.ts";
import { githubOwnershipClaims, withGithubImportOwners, withGithubOwnershipWork, type GithubOwnershipWork } from "../import-ownership.ts";
import { buildProjectPullPlan, buildProjectPushPlan, indexPmByIssue } from "../projects.ts";
import { writeGithubStateAtomic } from "../durable-state.ts";
import { captureStderr, withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const source: GhIssue = { number: 7, title: "Public source", body: "Public body", state: "open", labels: [], user: null,
  assignee: null, milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: "https://github.com/o/r/issues/7" };
const harness = createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });

/** Real non-git storage also exercises the package's required plain-tracker boundary. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-r12-")), root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Alter stored provenance independently through the SDK, without substituting persistence APIs. */
async function change(root: string, id: string, fields: Record<string, unknown>, reset = false) {
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => mutateItem({ pmRoot: root, id, settings: await readSettings(root),
    author: "fixture", op: "update", mutate: document => {
      if (reset) for (const key of Object.keys(document.metadata)) if (/^github/i.test(key) || key === "external_ref") delete document.metadata[key];
      Object.assign(document.metadata, fields); return { changedFields: Object.keys(fields) };
    } }));
}
/** Refused mutations preserve the target's complete item and append-only audit bytes. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "hex"), readFileSync(getHistoryPath(root, id), "hex")];
}
/** Supply only external source data; preparation, ownership and native writes remain real. */
async function importing(root: string, issue = source, atomic = false) {
  return captureStderr(() => runImport(repo, root, parseImportOptions({ atomic }), {
    resolveToken: () => undefined, fetchIssues: async () => [issue], fetchIssueTimeline: async () => [],
  }));
}

for (const field of ["github_url", "links", "provenance", "external_url"]) for (const api of [true, false]) test(`Round12 owner links ${field}: ${api ? "API mention refuses lifecycle ownership" : "web link allows lifecycle"}`, async () => tracker(async root => {
  const local = (await create({ title: "Curated Chore", type: "Chore", status: "open", tags: "keep,gh:o/r#7" }, { pmRoot: root })).item;
  await change(root, local.id, { [field]: api ? "https://api.github.com/repos/o/r/issues/7" : "https://www.github.com/O/R/issues/7/" });
  const before = await bytes(root, local.id);
  const result = await importing(root, { ...source, state: "closed", updated_at: "2027-01-01T00:00:00Z", closed_at: "2027-01-01T00:00:00Z", state_reason: "completed" });
  const actual = (await get(local.id, {}, { pmRoot: root })).item;
  assert.equal(actual.title, local.title); assert.equal(actual.type, "Chore");
  assert.ok("imported" in result.result); assert.equal(result.result.imported, api ? 1 : 0);
  if (api) assert.deepEqual(await bytes(root, local.id), before);
  else assert.equal(actual.status, "closed");
}));

for (const kind of ["pull", "issues"]) test(`Round12 verified legacy ID retains source kind ${kind}`, async () => tracker(async root => {
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  await create({ id, author: "pm-github", title: "Legacy import", type: "Issue", description: `GH ${kind === "pull" ? "PR" : "issue"} #7: https://github.com/o/r/${kind}/7`, tags: "gh:o/r#99" }, { pmRoot: root });
  const item = (await get(id, {}, { pmRoot: root })).item;
  assert.equal(item.github_number, undefined);
  assert.deepEqual(githubOwnershipClaims(item).owners, ["o/r#7"]);
  assert.deepEqual(selectRefreshTargets([item], repo).map(target => target.id), kind === "pull" ? [] : [id]);
  await change(root, id, { description: "GH PR #8: https://github.com/o/r/pull/8" });
  assert.equal(githubOwnershipClaims((await get(id, {}, { pmRoot: root })).item).kinds.includes("pull"), false, "A mismatched prose PR does not classify the verified ID");
}));

for (const relink of [false, true]) test(`Round12 atomic annotations recheck ownership during comment sync (${relink})`, async () => tracker(async root => {
  let committed = false, pending: Promise<void> | undefined;
  const id = deriveAtomicItemId(repo, 7, (await readSettings(root)).id_prefix, normalizeItemId);
  const incoming = new Proxy<GhComment[]>([{ id: 1, body: "Source comment", created_at: source.updated_at, user: { login: "fixture" } }], {
    get(target, key, receiver) {
      if (key === "length" && committed && relink && !pending) pending = change(root, id, { github_repo: "other/project", github_number: 8, github_url: "https://github.com/other/project/issues/8" });
      return Reflect.get(target, key, receiver);
    },
  });
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({ "with-comments": true, "comments-mode": "annotations" }), undefined, undefined, async () => incoming, { items: [], releases: [], timeline: async () => [] }))!;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], beforeMutation: [], onWrite: [], onIndex: [], onRead: [{ layer: "project", name: "await-peer-relink", run: async context => {
      if (pending && context.path.endsWith(`${id}.toon`)) await pending;
    } }] });
    const action = () => importGithubAtomic(root, repo, [entry], { onTransition: context => { if (context.transition === "committed") committed = true; } });
    if (relink) await assert.rejects(action, /current owner|ownership|committed journal/);
    else await action();
  });
  if (pending) await pending;
  assert.equal((await comments(id, {}, { pmRoot: root })).comments.length, relink ? 0 : 1);
}));

for (const field of ["sourceBody", "dependencyIssues", "match", "comments"]) test(`Round12 durable preflight scans persisted ${field}`, async () => tracker(async root => {
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  const secret = "ghp_" + "A".repeat(36);
  if (field === "sourceBody") entry.sourceBody = secret;
  if (field === "match") { const local = (await create({ title: "Curated", type: "Chore" }, { pmRoot: root })).item; await change(root, local.id, { github_url: source.html_url }); entry.match = { ...local, github_url: source.html_url, extra_source: secret }; entry.preserveContent = true; }
  if (field === "comments") { entry.syncAnnotations = false; entry.comments = [{ id: 1, body: secret, created_at: source.updated_at, user: null }]; }
  const opts = field === "dependencyIssues" ? { linkDeps: true, dependencyIssues: [{ ...source, body: secret }] } : {};
  let stages = 0;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { ...opts, onPlanStaged: () => { stages++; } }), { code: "github_import_preflight_failed" });
  assert.equal(stages, 0); assert.equal(existsSync(join(root, "transactions")), false);
  const clean = { ...entry, sourceBody: source.body!, comments: [], ...(entry.match ? { match: { ...entry.match, extra_source: "Public" } } : {}) };
  await importGithubAtomic(root, repo, [clean], { ...opts, dependencyIssues: [source], onPlanStaged: () => { stages++; } });
  assert.equal(stages, 1);
}));

for (const removed of [true, false]) test(`Round12 retained refresh plan never disappears from recovery (${removed})`, async () => tracker(async root => {
  const local = (await create({ title: "Curated link", type: "Chore", status: "open" }, { pmRoot: root })).item;
  await change(root, local.id, { github_url: source.html_url });
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), undefined, items[0], undefined, { items, releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { updateOnly: true, onTransition: context => {
    if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain finalization plan");
  } }), /committed journal/);
  const record = (await listRetainedGithubImportPlans(root))[0]!;
  if (removed) await change(root, local.id, { tags: ["gh:o/r#7"] }, true);
  const before = await bytes(root, local.id);
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { repository: { i7: {
    number: 7, title: source.title, body: source.body, state: "OPEN", stateReason: null, createdAt: source.created_at, updatedAt: source.updated_at, closedAt: null,
    url: source.html_url, author: null, labels: { nodes: [], pageInfo: { hasNextPage: false } },
  } } } }), async () => {
    if (removed) {
      await assert.rejects(() => runRefresh(repo, root, {}), error => {
        assert.equal((error as { code: string }).code, "github_import_owner_conflict"); assert.ok(String(error).includes(record.transactionId)); assert.ok(String(error).includes(local.id)); return true;
      });
      assert.deepEqual(await bytes(root, local.id), before); assert.ok(await readGithubImportPlan(root, record.transactionId));
    } else assert.equal((await runRefresh(repo, root, {})).resumed, 1);
  });
}));

for (const fail of [true, false]) test(`Round12 failed staging flushes created ancestors and exposes sync errors (${fail})`, { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => tracker(async root => {
  const ancestor = join(root, "new"), file = join(ancestor, "nested/state.json");
  try {
    await assert.rejects(() => writeGithubStateAtomic(file, "candidate", { onStaged: () => {
      if (fail) chmodSync(ancestor, 0o111);
      throw Object.assign(new Error("Staging interrupted"), { code: "staged_interruption" });
    } }), (error: unknown) => (error as { code: string }).code === (fail ? "EACCES" : "staged_interruption"));
  } finally { if (existsSync(ancestor)) chmodSync(ancestor, 0o755); }
  assert.equal(existsSync(file), false);
  await writeGithubStateAtomic(file, "complete"); assert.equal(readFileSync(file, "utf8"), "complete");
}));

for (const duplicate of [true, false]) test(`Round12 scoped project pull checks unselected ownership peers (${duplicate})`, async () => tracker(async root => {
  const first = (await create({ title: "Selected", type: "Chore", status: "open", tags: "gh-project:o/1#board" }, { pmRoot: root })).item;
  await change(root, first.id, { github_url: source.html_url });
  const other = (await create({ title: "Peer", type: "Chore" }, { pmRoot: root })).item;
  await change(root, other.id, { external_ref: duplicate ? "gh:o/r#7" : "gh:o/r#8" });
  const before = await bytes(root, first.id);
  await withMockGithub((_request, response, body) => {
    const query = JSON.parse(body).query as string;
    jsonResponse(response, 200, query.includes("projectV2(number:") ? { data: { user: { projectV2: { id: "project", title: "Board", url: "https://example.test/board", statusField: { id: "status", name: "Status", options: [{ id: "progress", name: "In Progress" }] } } } } }
      : { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [{ id: "board", fieldValueByName: { name: "In Progress", optionId: "progress" }, content: { __typename: "Issue", title: "Board source", number: 7, repository: { nameWithOwner: repo } } }] } } } });
  }, async () => {
    const action = () => harness.then(h => h.runCommand({ command: "github project sync", args: ["o/1"], options: { pull: true, apply: true, ids: first.id }, pmRoot: root, global: { json: true } }));
    if (duplicate) await assert.rejects(action, { code: "github_import_owner_conflict" });
    else await action();
  });
  if (duplicate) assert.deepEqual(await bytes(root, first.id), before);
  else assert.equal((await get(first.id, {}, { pmRoot: root })).item.status, "in_progress");
}));

for (const same of [true, false]) test(`Round12 concurrent first links serialize across item ids (${same})`, async () => tracker(async root => {
  const settings = await readSettings(root);
  const locals = await Promise.all(["First", "Second"].map(title => create({ title, type: "Chore" }, { pmRoot: root })));
  const attempts = locals.map((local, i) => {
    const number = same ? 7 : 7 + i;
    return withGithubImportOwners(root, [{ id: local.item.id, repo, number, initialLink: () => true }], () => mutateItem({ pmRoot: root, id: local.item.id, settings, author: "fixture", op: "update", mutate: document => {
      document.metadata.github_url = `https://github.com/o/r/issues/${number}`;
      return { changedFields: ["github_url"] };
    } }));
  });
  const outcomes = await Promise.allSettled(attempts);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, same ? 1 : 2);
  if (same) assert.equal((outcomes.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code, "github_import_owner_conflict");
}));

test("Round12 project planners already parse one claim snapshot per corpus", async () => tracker(async root => {
  const items: PmItem[] = [];
  for (let i = 1; i <= 40; i++) { const item = (await create({ title: `Owner ${i}`, type: "Chore" }, { pmRoot: root })).item; await change(root, item.id, { github_url: `https://github.com/o/r/issues/${i}` }); items.push((await get(item.id, {}, { pmRoot: root })).item); }
  const work: GithubOwnershipWork = {};
  withGithubOwnershipWork(work, () => { assert.equal(indexPmByIssue(items).size, 40); buildProjectPushPlan(items, { owner: "o", number: 1 }, [], undefined); buildProjectPullPlan(items, { owner: "o", number: 1 }, []); });
  assert.equal(work.claimParses, 120);
}));


for (const conflicting of [true, false]) test(`Round12 project pull rechecks peer claims inside the native write (${conflicting})`, async () => tracker(async root => {
  const local = (await create({ title: "Curated board owner", type: "Chore", status: "open" }, { pmRoot: root })).item;
  await change(root, local.id, { github_url: source.html_url });
  const peer = (await create({ title: "Initially unowned peer", type: "Chore" }, { pmRoot: root })).item;
  const items = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const entry = buildProjectPullPlan(items, { owner: "o", number: 1 }, [{ id: "board", statusName: "In Progress", content: { typename: "Issue", title: "Board", repo, number: 7 } }]).entries[0]!;
  await change(root, peer.id, { external_ref: conflicting ? "gh:o/r#7" : "gh:o/r#8" });
  const before = await bytes(root, local.id);
  const result = await applyPullEntry(entry, root);
  assert.equal(result.changed, !conflicting);
  if (conflicting) { assert.match(result.error!, /claimed by/); assert.deepEqual(await bytes(root, local.id), before); }
  else assert.equal((await get(local.id, {}, { pmRoot: root })).item.status, "in_progress");
}));

for (const selectedConflicts of [false, true]) test(`Round12 scoped project pull ignores conflicts confined to unselected items (selected conflicts: ${selectedConflicts})`, async () => tracker(async root => {
  const selected = (await create({ title: "Selected board owner", type: "Chore", status: "open" }, { pmRoot: root })).item;
  await change(root, selected.id, { github_url: source.html_url });
  // Two unselected items claim another issue, which is not on the board.
  for (const title of ["Unselected owner A", "Unselected owner B"]) {
    const peer = (await create({ title, type: "Chore" }, { pmRoot: root })).item;
    await change(root, peer.id, { github_url: selectedConflicts ? source.html_url : "https://github.com/o/r/issues/9" });
  }
  const corpus = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  const scoped = corpus.filter(item => item.id === selected.id);
  const board = [{ id: "board", statusName: "In Progress", content: { typename: "Issue" as const, title: "Board", repo, number: 7 } }];
  if (selectedConflicts) {
    // Must refuse: an unselected peer claiming the selected item's own issue still stops the scoped pull.
    assert.throws(() => buildProjectPullPlan(scoped, { owner: "o", number: 1 }, board, undefined, undefined, corpus), /claimed by|conflict/i);
  } else {
    const plan = buildProjectPullPlan(scoped, { owner: "o", number: 1 }, board, undefined, undefined, corpus);
    assert.deepEqual(plan.entries.map(entry => entry.pmId), [selected.id]);
  }
}));

// Documentation is part of the public identity contract, including these deliberate limits.
test("Round twelve docs distinguish consistency from positive ownership and revisions", () => {
  const inventory = readFileSync(new URL("../docs/identity-ownership-inventory.md", import.meta.url), "utf8");
  assert.match(inventory, /may return an empty owner list for an unowned item/);
  assert.match(inventory, /does not enforce positive ownership or revisions/);
  assert.match(inventory, /assertGithubImportOwner enforces a matching positive owner/);
  assert.match(inventory, /readGithubImportOwner captures the revision/);
});
test("Round twelve README post-write gate allows shared reference tags", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /Any number of items may share its reference tag/);
  assert.doesNotMatch(readme, /exactly one provenance tag/);
});

test("Round12 preflight refuses with structured redacted evidence and allows clean data", async () => tracker(async root => {
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({}), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  const secret = "ghp_" + "B".repeat(36);
  entry.sourceBody = secret;
  let staged = 0;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: () => { staged++; } }), error => {
    assert.equal((error as { code: string }).code, "github_import_preflight_failed");
    const message = (error as Error).message;
    assert.equal(message[0], "{", "typed preflight errors retain the gate JSON envelope");
    const report = JSON.parse(message) as { findings: Array<{ rule: string; field: string; excerpt: string }> };
    assert.ok(Array.isArray(report.findings));
    assert.ok(report.findings.some(hit => hit.rule === "github-token-classic" && hit.field === "sourceBody"));
    assert.equal(message.includes(secret), false);
    return true;
  });
  assert.equal(staged, 0);
  await importGithubAtomic(root, repo, [{ ...entry, sourceBody: source.body! }], { onPlanStaged: () => { staged++; } });
  assert.equal(staged, 1);
}));

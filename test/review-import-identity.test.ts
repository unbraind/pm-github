/** Review regressions use real isolated SDK trackers; only GitHub transport is supplied. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { init, create, update, get, comments, commitImportedItem, readSettings, getItemPath, getHistoryPath, WorkspaceTransactionInterruptedError, listAllComplete } from "@unbrained/pm-cli/sdk";
import extension, { runImport, parseImportOptions, importGithubAtomic, readGithubImportPlan, resumeGithubImport, listUnfinishedGithubImports, planSync, buildExportPlan, type GhIssue, type GhComment } from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { importIdentityKeys } from "../import-fidelity.ts";
import { selectRefreshTargets } from "../refresh.ts";
import { captureStderr, withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const repo = "fixture/review";
const issue: GhIssue = { number: 7, title: "Remote title", body: "Remote body", state: "open", labels: [], user: null, assignee: null, milestone: null,
  created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: `https://github.com/${repo}/issues/7` };
/** Give every test isolated native files, history, journals and a pinned child CLI. */
async function tracker(run: (root: string) => Promise<void>, git = true) {
  const dir = mkdtempSync(join(tmpdir(), "github-review-"));
  const root = join(dir, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: dir, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** Seed explicit provenance through the public SDK without relinquishing curated content. */
async function linked(root: string, fields: Record<string, unknown> = {}) {
  const item = (await create({ title: "Curated Chore", type: "Chore", description: "Curated description", body: "Curated body", tags: "keep" }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: item.id, itemPath: getItemPath(root, "Chore", item.id), settings: await readSettings(root),
    document: { metadata: { ...item, github_url: issue.html_url, ...fields }, body: "Curated body" }, author: "fixture", message: "Explicit linked fixture", conflictWarningPrefix: "fixture" });
  return (await get(item.id, {}, { pmRoot: root })).item;
}
/** Read the native item and immutable history together. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "utf8"), readFileSync(getHistoryPath(root, id), "utf8")];
}

for (const mode of ["body", "annotations", "both"] as const) for (const atomic of [false, true]) {
  test(`curated side data receives new comments without replacing content (${mode}, atomic=${atomic})`, async () => tracker(async root => {
    const owner = await linked(root);
    let source = issue;
    const incoming: GhComment[] = [{ id: 1, body: "First source note", created_at: "2025-02-01T00:00:00Z", user: { login: "fixture" } }];
    const sync = () => captureStderr(() => runImport(repo, root, parseImportOptions({ atomic, gate: true, "with-comments": mode === "body", "comments-mode": mode }), {
      resolveToken: () => undefined, fetchIssues: async () => [source], fetchIssueTimeline: async () => [], fetchIssueComments: async () => incoming,
    }));
    await sync();
    source = { ...issue, updated_at: "2027-01-01T00:00:00Z", closed_at: "2027-01-01T00:00:00Z", state: "closed", state_reason: "completed" };
    incoming.push({ id: 2, body: "Second source note", created_at: source.updated_at, user: { login: "fixture" } });
    await sync();
    const actual = (await get(owner.id, {}, { pmRoot: root })).item;
    for (const field of ["title", "type", "description", "body", "created_at"] as const) assert.equal(actual[field], owner[field]);
    assert.deepEqual(actual.tags, [`gh:${repo}#7`, "keep"]);
    assert.equal(actual.status, "closed");
    assert.equal(actual.closed_at, source.closed_at);
    assert.equal(actual.github_state, "closed");
    assert.equal(actual.github_updated_at, source.updated_at);
    const notes = (await comments(owner.id, {}, { pmRoot: root })).comments;
    assert.equal(notes.length, 2);
    assert.match(JSON.stringify(notes), /First source note/);
    assert.match(JSON.stringify(notes), /Second source note/);
    const before = await bytes(root, owner.id);
    await sync();
    assert.deepEqual(await bytes(root, owner.id), before);
  }));
}

for (const git of [false, true]) for (const atomic of [false, true]) {
  test(`contradictory explicit identities refuse before writes (git=${git}, atomic=${atomic})`, async () => tracker(async root => {
    const owner = await linked(root, { github_repo: repo, github_number: 8 });
    const before = await bytes(root, owner.id);
    const refusal = (error: unknown) => {
      assert.equal((error as { code: string }).code, "github_identity_conflict");
      assert.match(String(error), /fixture\/review#7.*versus.*fixture\/review#8/);
      assert.match(String(error), /Correct the explicit GitHub provenance/);
      return true;
    };
    assert.throws(() => importIdentityKeys(owner), refusal);
    assert.throws(() => selectRefreshTargets([owner], repo), { code: "github_import_owner_conflict" });
    await assert.rejects(() => captureStderr(() => runImport(repo, root, parseImportOptions({ atomic, gate: true }), {
      resolveToken: () => undefined, fetchIssues: async () => [issue], fetchIssueTimeline: async () => [],
    })), error => {
      assert.equal((error as { code: string }).code, "github_import_owner_conflict");
      assert.match(String(error), /fixture\/review#7.*versus.*fixture\/review#8/);
      assert.match(String(error), /Restore the intended GitHub provenance/);
      return true;
    });
    assert.deepEqual(await bytes(root, owner.id), before);
    assert.deepEqual(await listUnfinishedGithubImports(root), []);
  }, git));
}

for (const url of ["HTTPS://GITHUB.COM/Fixture/Review/issues/7/", "https://github.com/FIXTURE/REVIEW/pull/7/?view=1#note"]) {
  test(`agreeing normalized explicit identities remain compatible (${url.includes("pull") ? "pull" : "issues"})`, async () => tracker(async root => {
    const owner = await linked(root, { github_url: url, GitHubURL: issue.html_url, github_repo: " FIXTURE/Review/ ", github_number: 7 });
    assert.deepEqual(importIdentityKeys(owner), [`${repo}#7`]);
    await captureStderr(() => runImport(repo, root, parseImportOptions({}), {
      resolveToken: () => undefined, fetchIssues: async () => [issue], fetchIssueTimeline: async () => [],
    }));
    const all = await listAllComplete({}, { pmRoot: root });
    assert.equal(all.items.length, 1);
    assert.equal(all.items[0]!.id, owner.id);
  }, false));
}

test("two URL fields cannot disagree even without a number field", async () => tracker(async root => {
  const owner = await linked(root, { GitHubURL: `https://github.com/${repo}/pull/8` });
  const before = await bytes(root, owner.id);
  await assert.rejects(() => captureStderr(() => runImport(repo, root, parseImportOptions({ gate: true }), {
    resolveToken: () => undefined, fetchIssues: async () => [issue], fetchIssueTimeline: async () => [],
  })), { code: "github_import_owner_conflict" });
  assert.deepEqual(await bytes(root, owner.id), before);
}));

for (const curated of [true, false]) for (const boundary of ["step_applied", "step_recorded", "committing", "committed"] as const) {
  test(`atomic retry replays original input (${curated ? "curated" : "created"}, ${boundary})`, async () => tracker(async root => {
    const owner = curated ? await linked(root) : undefined;
    let polls = 0;
    let source = issue;
    let incoming: GhComment[] = [{ id: 1, body: "Original comment", created_at: issue.updated_at, user: { login: "fixture" } }];
    const deps = { resolveToken: () => undefined, fetchIssues: async () => { polls++; return [source]; }, fetchIssueTimeline: async () => [], fetchIssueComments: async () => incoming };
    const options = parseImportOptions({ atomic: true, "with-comments": true, "comments-mode": "annotations" });
    await assert.rejects(() => captureStderr(() => runImport(repo, root, options, { ...deps,
      commitAtomic: (pmRoot, repository, entries) => importGithubAtomic(pmRoot, repository, entries, { onTransition: context => {
        if (context.transition === boundary) throw new WorkspaceTransactionInterruptedError("Original plan crash fixture");
      } }),
    })), /interrupted|committed journal/);
    const pending = await listUnfinishedGithubImports(root);
    assert.equal(pending.length, boundary === "committed" ? 0 : 1);
    const savedNames = readdirSync(join(root, "transactions", "pm-github"));
    assert.equal(savedNames.length, 1);
    const transactionId = savedNames[0]!.slice(0, -5);
    const recorded = await readGithubImportPlan(root, transactionId);
    assert.ok(recorded);
    assert.equal(recorded.entries[0]!.title, issue.title);
    source = { ...issue, title: "Changed after crash", body: "Changed source body", labels: [{ name: "new-label" }], updated_at: "2027-01-01T00:00:00Z", state: "closed", closed_at: "2027-01-01T00:00:00Z", state_reason: "completed" };
    incoming = [{ id: 2, body: "Later comment", created_at: source.updated_at, user: { login: "fixture" } }];
    const { result: recovered } = await captureStderr(() => runImport(repo, root, options, deps));
    assert.ok("replayedOriginalPlan" in recovered);
    assert.equal(recovered.transactionId, transactionId);
    assert.equal(recovered.replayedOriginalPlan, true);
    assert.equal(polls, 1, "recovery must not poll changed input");
    const all = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
    assert.equal(all.length, 1);
    const actual = all[0]!;
    assert.equal(actual.title, owner?.title ?? issue.title);
    assert.equal(actual.github_state, "open");
    assert.equal(actual.github_updated_at, issue.updated_at);
    if (owner) { assert.equal(actual.type, "Chore"); assert.equal(actual.body, "Curated body"); }
    const notes = (await comments(actual.id, {}, { pmRoot: root })).comments;
    assert.equal(notes.length, 1);
    assert.match(JSON.stringify(notes), /Original comment/);
    assert.doesNotMatch(JSON.stringify(notes), /Later comment/);
    assert.deepEqual(await listUnfinishedGithubImports(root), []);
    assert.deepEqual(readdirSync(join(root, "transactions", "pm-github")), []);
    await captureStderr(() => runImport(repo, root, options, deps));
    assert.equal(polls, 2);
    const refreshed = (await get(actual.id, {}, { pmRoot: root })).item;
    assert.equal(refreshed.github_state, "closed");
    assert.equal(refreshed.title, owner?.title ?? source.title);
    assert.equal((await comments(actual.id, {}, { pmRoot: root })).comments.length, 2);
  }, false));
}

test("upstream plans ignore shared references and reject competing explicit owners", async () => tracker(async root => {
  const reference = (await create({ title: "Reference Chore", type: "Chore", tags: `gh:${repo}#7` }, { pmRoot: root })).item;
  const owner = await linked(root);
  const corpus = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  assert.deepEqual(planSync(corpus, repo).map(entry => entry.id), [owner.id]);
  assert.deepEqual(buildExportPlan([reference], repo).map(entry => entry.action), ["create"]);
  assert.deepEqual(buildExportPlan([owner], repo).map(entry => [entry.action, entry.number]), [["update", 7]]);
  assert.deepEqual(planSync([reference], repo, undefined, { allowReferenceTags: true }).map(entry => entry.number), []);
  assert.equal(buildExportPlan([reference], repo, undefined, undefined, { allowReferenceTags: true })[0]!.action, "create");
  assert.deepEqual(planSync([reference], repo, undefined, { allowReferenceTags: true, corpus }), []);
  await linked(root);
  const competing = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
  assert.throws(() => planSync([owner], repo, undefined, { corpus: competing }), { code: "github_import_owner_conflict" });
  assert.throws(() => buildExportPlan([owner], repo, undefined, undefined, { corpus: competing }), { code: "github_import_owner_conflict" });
}, false));

test("sync and applied export send writes only to explicit owners", async () => tracker(async root => {
  const reference = (await create({ title: "Reference Chore", type: "Chore", tags: `gh:${repo}#7` }, { pmRoot: root })).item;
  const owner = await linked(root);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((request, response) => {
    jsonResponse(response, 200, { ...issue, number: request.method === "POST" ? 9 : 7, state: "closed" });
  }, async server => {
    await captureStderr(() => harness.runCommand({ command: "github sync", options: { repo }, pmRoot: root, global: { json: true } }));
    assert.deepEqual(server.requests.filter(request => request.method === "PATCH").map(request => request.url), [`/repos/${repo}/issues/7`]);
    await captureStderr(() => harness.runCommand({ command: "github export", options: { repo, ids: owner.id, apply: true }, pmRoot: root, global: { json: true } }));
    const patches = server.requests.filter(request => request.method === "PATCH");
    assert.equal(patches.length, 2);
    assert.equal(JSON.parse(patches[1]!.body).title, "Curated Chore");
    await captureStderr(() => harness.runCommand({ command: "github export", options: { repo, ids: reference.id, apply: true }, pmRoot: root, global: { json: true } }));
    assert.equal(server.requests.filter(request => request.method === "PATCH").length, 2, "a shared reference must not PATCH issue #7");
    assert.equal(server.requests.filter(request => request.method === "POST").length, 1, "explicitly exporting an unlinked item creates its own upstream issue");
    await linked(root);
    const before = server.requests.length;
    for (const command of ["github sync", "github export"]) await assert.rejects(() => harness.runCommand({ command, options: { repo, ids: owner.id, apply: true }, pmRoot: root, global: { json: true } }), { code: "github_import_owner_conflict" });
    assert.equal(server.requests.length, before, "an unselected competing owner must refuse before any remote request");
  }));
}, false));

test("atomic recovery replays dependency inputs for unchanged items too", async () => tracker(async root => {
  let source = [issue, { ...issue, number: 8, title: "Dependent", body: "Blocked by #7", html_url: `https://github.com/${repo}/issues/8` }];
  const deps = { resolveToken: () => undefined, fetchIssues: async () => source, fetchIssueTimeline: async () => [] };
  await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true }), deps));
  const ids = new Map((await listAllComplete({}, { pmRoot: root })).items.map(item => [item.github_number, item.id]));
  assert.equal(((await get(ids.get(8)!, {}, { pmRoot: root })).item.dependencies ?? []).length, 0);
  source = [{ ...issue, title: "Original retry target", updated_at: "2025-03-01T00:00:00Z" }, source[1]!];
  const options = parseImportOptions({ atomic: true, "link-deps": true });
  await assert.rejects(() => captureStderr(() => runImport(repo, root, options, { ...deps,
    commitAtomic: (pmRoot, repository, entries) => importGithubAtomic(pmRoot, repository, entries, { linkDeps: true, dependencyIssues: source,
      onTransition: context => { if (context.transition === "step_recorded") throw new WorkspaceTransactionInterruptedError("Dependency recovery fixture"); },
    }),
  })), /interrupted/);
  source = [source[0]!, { ...source[1]!, body: "Blocked by #9", updated_at: "2025-04-01T00:00:00Z" }];
  await captureStderr(() => runImport(repo, root, options, deps));
  const dependent = (await get(ids.get(8)!, {}, { pmRoot: root })).item;
  assert.deepEqual((dependent.dependencies ?? []).map(edge => ({ id: edge.id, kind: edge.kind })), [{ id: ids.get(7)!, kind: "blocked_by" }]);
  assert.equal(dependent.github_updated_at, issue.updated_at);
}, false));

test("released refresh plans without mode or target-map fields still replay", async () => tracker(async root => {
  const owner = await linked(root);
  await assert.rejects(() => captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true }), {
    resolveToken: () => undefined, fetchIssues: async () => [issue], fetchIssueTimeline: async () => [],
    commitAtomic: (pmRoot, repository, entries) => importGithubAtomic(pmRoot, repository, entries, { updateOnly: true,
      onTransition: context => { if (context.transition === "step_recorded") throw new WorkspaceTransactionInterruptedError("Released refresh plan fixture"); },
    }),
  })), /interrupted/);
  const pending = (await listUnfinishedGithubImports(root))[0]!;
  const record = (await readGithubImportPlan(root, pending.transactionId))!;
  delete record.updateOnly;
  delete record.itemIds;
  delete record.linkDeps;
  delete record.dependencyIssues;
  writeFileSync(join(root, "transactions", "pm-github", `${record.transactionId}.json`), JSON.stringify(record));
  const recovered = await resumeGithubImport(root, record);
  assert.equal(recovered.transactionId, pending.transactionId);
  const actual = (await get(owner.id, {}, { pmRoot: root })).item;
  assert.equal(actual.title, owner.title);
  assert.equal(actual.github_number, 7);
  assert.deepEqual(await listUnfinishedGithubImports(root), []);
}, false));

for (const corruption of ["missing", "unreadable", "mismatched"] as const) {
  test(`atomic recovery refuses an unavailable original plan before writes (${corruption})`, async () => tracker(async root => {
    const owner = await linked(root);
    let polls = 0;
    const deps = { resolveToken: () => undefined, fetchIssues: async () => { polls++; return [issue]; }, fetchIssueTimeline: async () => [] };
    const options = parseImportOptions({ atomic: true });
    await assert.rejects(() => captureStderr(() => runImport(repo, root, options, { ...deps,
      commitAtomic: (pmRoot, repository, entries) => importGithubAtomic(pmRoot, repository, entries, {
        onTransition: context => { if (context.transition === "step_recorded") throw new WorkspaceTransactionInterruptedError("Missing original plan fixture"); },
      }),
    })), /interrupted/);
    const pending = (await listUnfinishedGithubImports(root))[0]!;
    const planFile = join(root, "transactions", "pm-github", `${pending.transactionId}.json`);
    const original = readFileSync(planFile, "utf8");
    if (corruption === "missing") rmSync(planFile);
    else writeFileSync(planFile, corruption === "unreadable" ? "{" : JSON.stringify({ ...JSON.parse(original), transactionId: "wrong-original-plan" }));
    const before = await bytes(root, owner.id);
    await assert.rejects(() => captureStderr(() => runImport(repo, root, options, deps)), error => {
      assert.equal((error as { code: string }).code, corruption === "missing" ? "github_import_plan_missing" : "github_import_plan_corrupt");
      assert.match(String(error), /Restore its original plan/);
      return true;
    });
    assert.equal(polls, 1, "a missing original plan cannot become a new import from fresh input");
    assert.deepEqual(await bytes(root, owner.id), before);
    writeFileSync(planFile, original);
    await captureStderr(() => runImport(repo, root, options, deps));
    assert.equal(polls, 1);
    assert.deepEqual(await listUnfinishedGithubImports(root), []);
  }, false));
}

test("upstream preview and apply agree across native fields while legacy tag opt-in remains a no-op", async () => tracker(async root => {
  const owner = await linked(root);
  const references = await Promise.all(["First", "Second"].map(title => create({ title, type: "Chore", tags: `gh:${repo}#7` }, { pmRoot: root })));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  let seed = 42;
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((request, response) => jsonResponse(response, 200, { number: request.method === "POST" ? 9 : 7 }), async server => {
    for (let iteration = 0; iteration < 8; iteration++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const allowReferenceTags = Boolean(seed & 1);
      await update(owner.id, { title: `Generated owner ${seed}`, body: `Generated context ${seed}` }, { pmRoot: root });
      await update(references[0]!.item.id, { addTags: [`context-${seed}`] }, { pmRoot: root });
      const options = { repo, "allow-reference-tags": allowReferenceTags };
      const start = server.requests.length;
      const command = (apply: boolean) => captureStderr(() => harness.runCommand({ command: "github export", options: { ...options, apply }, pmRoot: root, global: { json: true } }));
      const preview = (await command(false)).result.result as { plan: Array<{ id: string; action: string; payload: { title: string; body: string; labels: string[]; state: string } }> };
      assert.deepEqual(preview.plan.filter(entry => entry.action === "update").map(entry => entry.id), [owner.id]);
      await command(true);
      const writes = server.requests.slice(start);
      assert.equal(writes.length, 3);
      for (const [index, entry] of preview.plan.entries()) {
        const write = writes[index]!;
        assert.equal(write.method, entry.id === owner.id ? "PATCH" : "POST");
        assert.deepEqual(JSON.parse(write.body), entry.id === owner.id ? entry.payload : { title: entry.payload.title, body: entry.payload.body, labels: entry.payload.labels });
      }
    }
  }));
}, false));

test("atomic recovery refuses altered original mutation payloads before writes", async () => tracker(async root => {
  const owner = await linked(root);
  const deps = { resolveToken: () => undefined, fetchIssues: async () => [issue], fetchIssueTimeline: async () => [] };
  const options = parseImportOptions({ atomic: true });
  await assert.rejects(() => captureStderr(() => runImport(repo, root, options, { ...deps,
    commitAtomic: (pmRoot, repository, entries) => importGithubAtomic(pmRoot, repository, entries, {
      onTransition: context => { if (context.transition === "step_recorded") throw new WorkspaceTransactionInterruptedError("Original payload fixture"); },
    }),
  })), /interrupted/);
  const pending = (await listUnfinishedGithubImports(root))[0]!;
  const planFile = join(root, "transactions", "pm-github", `${pending.transactionId}.json`);
  const original = readFileSync(planFile, "utf8");
  const changed = JSON.parse(original);
  changed.mutations[0].options.title = "Altered original payload";
  writeFileSync(planFile, JSON.stringify(changed));
  const before = await bytes(root, owner.id);
  await assert.rejects(() => captureStderr(() => runImport(repo, root, options, deps)), { code: "github_import_plan_drift" });
  assert.deepEqual(await bytes(root, owner.id), before);
  writeFileSync(planFile, original);
  await captureStderr(() => runImport(repo, root, options, deps));
  assert.equal((await get(owner.id, {}, { pmRoot: root })).item.title, owner.title);
}, false));

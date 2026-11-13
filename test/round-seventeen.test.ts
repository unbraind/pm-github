/** Review regressions use native non-git trackers and bounded real transport probes. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, symlinkSync, copyFileSync, watch, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { init, create, get, listAllComplete, mutateItem, readSettings, getItemPath, getHistoryPath, WorkspaceTransactionInterruptedError, runWithActiveExtensions, setActiveExtensionHooks, runReindex, update, deleteItem } from "@unbrained/pm-cli/sdk";
import extension, { buildExportPlan, applyExportPlan, applyPullEntry, planSync, assertCurrentUpstreamTarget, acquireImportLock, gqlResolveIssueNodeId, applyPushEntry, githubImportTarget, linkImportedDependencies, runImport, prepareGithubImport, parseImportOptions, importGithubAtomic, readGithubImportPlan, listRetainedGithubImportPlans, listUnfinishedGithubImports, resumeGithubImport, acceptGithubWebhook, reconcileGithubWebhooks, validateGithubImportPlan, type GithubImportPlanRecord, type GhIssue, type PmItem } from "../index.ts";
import { githubOwnershipClaims, githubRepositoryHash, buildGithubOwnershipIndex, warnGithubOwnershipScope, assertGithubImportOwner, readGithubImportOwner, withGithubImportOwners, withGithubItemConsistency, readGithubOwnershipSnapshot, withGithubOwnershipWork, assertGithubOwnershipConsistency, type GithubOwnershipWork } from "../import-ownership.ts";
import { legacyGithubDescriptionIdentity, legacyGithubLinkClaims, parseLegacyGithubDescription, matchImportedIssue, githubLinkReferences, GithubIdentityConflictError, buildImportFidelity, importFidelityFields, importCloseReason } from "../import-fidelity.ts";
import { normalizeGithubRepository, parseGithubUrl, parseGithubIssueUrl, githubUrlTokens } from "../github-url.ts";
import { writeGithubStateAtomic } from "../durable-state.ts";
import { buildProjectImportPlan, buildProjectPullPlan, parseProjectRef } from "../projects.ts";
import { runRefresh, selectRefreshTargets } from "../refresh.ts";
import { assertCloseoutGithubOwner, closeoutOwnershipConflict, extractCloseoutItems } from "../closeout.ts";
import { captureStderr, withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { importTagArguments } from "../import-tags.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";

const repo = "o/r", url = "https://github.com/o/r/issues/7";
/** Own native tracker lifetime and every child command's package-local SDK. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-round-seventeen-")), root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Persist and decode legacy metadata through the public SDK. */
async function native(root: string, fields: Record<string, unknown> = {}) {
  const local = (await create({ title: "Curated owner", type: "Chore", tags: "retained" }, { pmRoot: root })).item;
  await mutateItem({ pmRoot: root, id: local.id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
    Object.assign(document.metadata, fields); return { changedFields: Object.keys(fields) };
  } });
  return (await listAllComplete({ includeBody: true }, { pmRoot: root, noExtensions: true })).items.find(item => item.id === local.id)!;
}
/** Snapshot both native authoritative streams around ownership decisions. */
function bytes(root: string, item: PmItem) { return [getItemPath(root, String(item.type), item.id!), getHistoryPath(root, item.id!)].map(file => readFileSync(file, "hex")); }
/** REST source and refresh GraphQL rows represent the same issue. */
function source(number = 7): GhIssue { return { number, title: `Source ${number}`, body: "Public source", state: "open", comments: 1, labels: [], user: null, assignee: null, milestone: null,
  created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: `https://github.com/o/r/issues/${number}` }; }
/** Sign only a synthetic delivery hint; reconciliation must fetch current provider state. */
function delivery(number: number) {
  const secret = "fixture-webhook-key", payload = Buffer.from(JSON.stringify({ action: "closed", repository: { full_name: repo }, issue: { number } }));
  return { repo, delivery: `deferred-${number}`, event: "issues", secret, payload, signature: "sha256=" + createHmac("sha256", secret).update(payload).digest("hex") };
}

for (const end of ['"', ">", ".", "<", "'", "`", ")".repeat(20_000)]) test(`shared declaration boundaries produce no warning (${end.length > 1 ? "20000 parentheses" : end})`, async () => tracker(async root => {
  const item = await native(root, { description: `GH issue #7: ${url}${end}` }), before = bytes(root, item);
  assert.equal(legacyGithubDescriptionIdentity(item)?.key, "o/r#7");
  assert.equal(matchImportedIssue([item], source()).item?.id, item.id);
  const result = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([item]), [item]));
  assert.deepEqual(result.stderr, []); assert.deepEqual(bytes(root, item), before);
}));

test("shared declaration diagnostics retain mismatches and keep API links reference-only", async () => tracker(async root => {
  for (const description of [`GH issue #8: ${url}>`, "GitHub issue https://api.github.com/repos/o/r/issues/7", "GH issue #7: https://github.com/o/r/issues/nope"]) {
    const item = await native(root, { description });
    assert.equal(legacyGithubDescriptionIdentity(item), undefined); assert.deepEqual(githubOwnershipClaims(item).owners, []);
    const result = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([item]), [item]));
    assert.equal(result.stderr.length, description.includes("api.github.com") ? 0 : 1);
    if (result.stderr.length) assert.equal(JSON.parse(result.stderr[0]!).code, "invalid_github_identity_number");
  }
  const anonymous = {};
  const empty = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([anonymous]), []));
  assert.deepEqual(empty.stderr, []);
  assert.equal(parseLegacyGithubDescription(anonymous), undefined);
  assert.equal(parseLegacyGithubDescription({ description: `See ${url}` }), undefined);
}));

test("native declaration diagnostics finish linearly on 20000 closing parentheses followed by text", async () => tracker(async root => {
  const item = await native(root, { description: `GH issue #7: ${url}${")".repeat(20_000)}x` });
  const program = `const module = await import(${JSON.stringify(new URL("../import-ownership.ts", import.meta.url).href)}); const item = ${JSON.stringify(item)};
    console.log("probe-ready"); setImmediate(() => { const warnings=[]; console.error = value => warnings.push(JSON.parse(value));
    for(let repeat=0;repeat<8;repeat++) module.warnGithubOwnershipScope(module.buildGithubOwnershipIndex([item]),[item]);
    if(warnings.length!==8 || warnings[0].code!=="invalid_github_identity_number") process.exitCode=1;
    console.log(JSON.stringify({warnings:warnings.length})); });`;
  const env = { ...process.env }; delete env.NODE_V8_COVERAGE;
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)) delete env[key];
  const result = await boundedCli(process.execPath, ["--input-type=module", "-e", program], root, env, 1200, 200, "probe-ready");
  assert.equal(result.timedOut, false, "The diagnostic must scan the declaration linearly, including a non-punctuation suffix");
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /"warnings":8/);
}));

test("legacy claim API deduplicates explicit aliases and ignores link-only references", async () => tracker(async root => {
  const item = await native(root, { github_url: url, GitHubURL: "https://github.com/O/R/pull/7/", links: `See https://github.com/other/project/issues/8` });
  assert.deepEqual(legacyGithubLinkClaims(item), ["o/r#7"]);
  const reference = await native(root, { links: url, tags: ["gh:o/r#7"] });
  assert.deepEqual(legacyGithubLinkClaims(reference), []);
}));

test("positive owner assertion refuses an unowned native item and allows only an explicit initial link", async () => tracker(async root => {
  const item = await native(root), before = bytes(root, item), target = { id: item.id!, repo, number: 7 };
  assert.throws(() => assertGithubImportOwner(item, target), { code: "github_import_owner_conflict" });
  assert.throws(() => assertGithubImportOwner(item, { ...target, initialLink: () => false }), { code: "github_import_owner_conflict" });
  assert.doesNotThrow(() => assertGithubImportOwner(item, { ...target, initialLink: () => true }));
  assert.deepEqual(bytes(root, item), before);
  await assert.rejects(() => readGithubImportOwner(root, { id: "fixture-missing", repo, number: 7 }), error => (error as { details?: { code?: string }; message: string }).message.includes("not found"));
}));

test("URL boundary inputs retain safe repositories, project locators and balanced query delimiters", () => {
  assert.equal(normalizeGithubRepository(" /// "), undefined);
  assert.equal(normalizeGithubRepository(" O/R/// "), "o/r");
  assert.equal(parseGithubUrl("https://github.com/o/r")?.kind, undefined);
  assert.equal(parseGithubUrl("https://api.github.com"), undefined);
  assert.equal(parseGithubIssueUrl("https://github.com/o/r"), undefined);
  const balanced = `${url}?filter=[a]{b}(c)`;
  assert.equal(githubUrlTokens(balanced)[0]!.raw, balanced);
  assert.deepEqual(parseProjectRef("https://github.com/orgs/o/projects/7"), { owner: "o", number: 7 });
  assert.equal(parseProjectRef("https://github.com/orgs/o/projects"), undefined);
});

test("deferred webhook issues stay pending while independent deliveries reconcile and later retry", async () => tracker(async root => {
  const owner7 = await native(root, { github_url: url }), owner8 = await native(root, { github_url: "https://github.com/o/r/issues/8" });
  await native(root, { github_url: "https://github.com/o/r/issues/9" });
  const items = [owner7, owner8], entries = await Promise.all(items.map((item, i) => prepareGithubImport(source(7 + i), repo, parseImportOptions({ atomic: true }), undefined, item, undefined,
    { items, releases: [], timeline: async () => [] })));
  await assert.rejects(() => importGithubAtomic(root, repo, entries.map(entry => entry!), { onTransition: context => {
    if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain original source plan");
  } }), /committed journal/);
  const [retained] = await listRetainedGithubImportPlans(root); assert.ok(retained);
  const record = (await readGithubImportPlan(root, retained.transactionId))!;
  const before = [owner7, owner8].map(item => bytes(root, item));
  for (const number of [7, 9]) await acceptGithubWebhook(root, delivery(number));
  await withMockGithub((request, response, body) => {
    if (request.method === "GET") { jsonResponse(response, 200, []); return; }
    const query = (JSON.parse(body) as { query: string }).query;
    if (query.includes("timelineItems")) { jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }); return; }
    const repository = Object.fromEntries([7, 9].filter(number => query.includes(`i${number}:`)).map(number => [`i${number}`, { number, title: `Current ${number}`, body: "Public source", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-03-01T00:00:00Z", closedAt: "2025-03-01T00:00:00Z", url: `https://github.com/o/r/issues/${number}`, author: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }]));
    jsonResponse(response, 200, { data: { repository } });
  }, async () => {
    const preview = await runRefresh(repo, root, { "dry-run": true }, { numbers: [7, 9] });
    assert.deepEqual(preview.deferred_imports![0]!.issue_numbers, [7, 8]); assert.deepEqual(preview.plan.map(row => row.number), [9]);
    const first = await reconcileGithubWebhooks(root, repo);
    assert.equal(first.selected, 2); assert.equal(first.reconciled, 1); assert.equal(first.retry, 1); assert.equal(first.unlinked, 0);
    assert.deepEqual(first.proposals.map(row => row.number), [9]);
    const pendingHash = createHash("sha256").update("deferred-7").digest("hex");
    assert.equal(readdirSync(join(root, "github-webhooks", createHash("sha256").update(repo).digest("hex"))).some(name => name === `${pendingHash}.done.json`), false);
    assert.deepEqual([owner7, owner8].map(item => bytes(root, item)), before);
    await resumeGithubImport(root, record);
    const retry = await reconcileGithubWebhooks(root, repo);
    assert.equal(retry.selected, 1); assert.equal(retry.reconciled, 1); assert.equal(retry.retry, 0); assert.deepEqual(retry.proposals.map(row => row.number), [7]);
  });
}));


test("shared consistency keeps closeout repository refusals and valid or unowned controls", async () => tracker(async root => {
  const unowned = await native(root), own = await native(root, { github_url: url }), other = await native(root, { github_url: "https://github.com/other/project/issues/7" });
  assert.doesNotThrow(() => assertCloseoutGithubOwner(unowned, repo, [unowned]));
  assert.doesNotThrow(() => assertCloseoutGithubOwner(own, repo, buildGithubOwnershipIndex([own])));
  assert.throws(() => assertCloseoutGithubOwner(other, repo, [other]), { code: "github_import_owner_conflict" });
  const contradictory = await native(root, { github_url: url, github_repo: "other/project", github_number: 8 });
  assert.throws(() => assertCloseoutGithubOwner(contradictory, repo, [contradictory]), { code: "github_import_owner_conflict" });
}));

test("refresh refuses invalid raw number provenance and duplicate records while retaining a valid control", async () => tracker(async root => {
  const invalid = await native(root, { github_url: url, github_repo: repo, github_number: -1 }), before = bytes(root, invalid);
  assert.throws(() => selectRefreshTargets([invalid], repo), /invalid issue number/); assert.deepEqual(bytes(root, invalid), before);
  const valid = await native(root, { github_url: url, github_repo: repo, github_number: 7 });
  assert.equal(selectRefreshTargets([valid], repo)[0]!.id, valid.id);
  assert.throws(() => selectRefreshTargets([valid, valid], repo), /multiple existing owners/);
}));

test("diagnostics name internal off-scope contradictions and zero-valued external references", async () => tracker(async root => {
  const conflict = await native(root, { github_url: url, github_repo: "other/project" }), external = await native(root, { external_ref: "gh:o/r#0" });
  const result = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([conflict, external]), []));
  assert.ok(result.stderr.some(line => line.includes("out_of_scope_github_owner_conflict") && line.includes(conflict.id!)));
  assert.ok(result.stderr.some(line => line.includes("invalid_github_identity_number") && line.includes(external.id!)));
  assert.deepEqual(githubOwnershipClaims(external).owners, []);
  const suffix = (await create({ id: `fixture-github-${githubRepositoryHash(repo)}-0`, title: "Invalid importer marker", type: "Task", author: "pm-github", tags: "gh:o/r#7" }, { pmRoot: root })).item;
  const invalid = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([suffix]), []));
  assert.ok(invalid.stderr.some(line => line.includes("invalid_github_identity_number")));
  assert.deepEqual(githubOwnershipClaims(suffix).owners, []);
}));


test("recovery refuses a non-directory plan store before any source request or tracker mutation", async () => tracker(async root => {
  const local = await native(root), before = bytes(root, local);
  mkdirSync(join(root, "transactions"), { recursive: true }); writeFileSync(join(root, "transactions/pm-github"), "occupied");
  await assert.rejects(() => runImport(repo, root, parseImportOptions({ atomic: true })), error => (error as NodeJS.ErrnoException).code === "ENOTDIR");
  assert.deepEqual(bytes(root, local), before); assert.equal(readFileSync(join(root, "transactions/pm-github"), "utf8"), "occupied");
}));

test("a real concurrently retained batch cannot silently lose current planned annotations", async () => tracker(async root => {
  let incoming = source(), first = true;
  await withMockGithub((request, response) => {
    jsonResponse(response, 200, request.url!.includes("/comments") ? [{ id: 71, body: "Public source comment", user: { login: "fixture" }, created_at: "2025-02-01T00:00:00Z" }]
      : request.url!.includes("/issues?") ? [incoming] : []);
  }, async () => {
    const result = await runImport(repo, root, parseImportOptions({ atomic: true, "with-comments": true, "comments-mode": "annotations" }), {
      commitAtomic: async (trackerRoot, repository, entries) => {
        assert.equal(first, true); first = false;
        const pending = (await prepareGithubImport(source(8), repository, parseImportOptions({}), undefined, undefined, undefined,
          { items: [], releases: [], timeline: async () => [] }))!;
        await assert.rejects(() => importGithubAtomic(trackerRoot, repository, [pending], { onTransition: context => {
          if (context.transition === "prepared") throw new WorkspaceTransactionInterruptedError("Concurrent producer interrupted before commit");
        } }), /interrupted/);
        return importGithubAtomic(trackerRoot, repository, entries);
      },
    });
    assert.equal("commentWriteFailures" in result && result.commentWriteFailures, 1);
    const firstItems = (await listAllComplete({}, { pmRoot: root })).items;
    assert.equal(firstItems.length, 1); assert.equal(firstItems[0]!.github_number, 8);
    incoming = source(9);
    const clean = await runImport(repo, root, parseImportOptions({ atomic: true, "with-comments": true, "comments-mode": "annotations" }));
    assert.equal("imported" in clean && clean.imported, 1);
    assert.equal("commentWriteFailures" in clean ? clean.commentWriteFailures : 0, 0);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
  });
}));


test("plain curated owner updates add the source reference without converting retained native tags", async () => tracker(async root => {
  const tags = ["area,api", '["json"]'], item = await native(root, { github_url: url, tags });
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url!.includes("/issues?") ? [source()] : []), async () => {
    await runImport(repo, root, parseImportOptions({}));
  });
  const written = (await get(item.id!, {}, { pmRoot: root })).item;
  assert.deepEqual(new Set(written.tags), new Set([...tags, "gh:o/r#7"]));
  assert.equal(written.title, item.title); assert.equal(written.type, item.type); assert.equal(written.created_at, item.created_at);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}));

test("atomic publication preserves the previous plan when a concurrent writer replaces its parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "github-parent-race-")), directory = join(root, "publisher"), held = join(root, "held"), file = join(directory, "plan.json");
  try {
    await writeGithubStateAtomic(file, "previous plan");
    let replaced = false;
    await assert.rejects(() => writeGithubStateAtomic(file, "new plan", { get exclusive() {
      if (!replaced) { renameSync(directory, held); writeFileSync(directory, "concurrent parent replacement"); replaced = true; }
      return true;
    } }), error => (error as NodeJS.ErrnoException).code === "ENOTDIR");
    assert.equal(readFileSync(join(held, "plan.json"), "utf8"), "previous plan");
    assert.equal(readFileSync(directory, "utf8"), "concurrent parent replacement");
    rmSync(directory); renameSync(held, directory);
    await writeGithubStateAtomic(file, "restored publisher"); assert.equal(readFileSync(file, "utf8"), "restored publisher");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("legacy retained refresh plans without routing tuples report their source numbers outside scope", async () => tracker(async root => {
  const owned = await native(root, { github_url: url });
  await native(root, { github_url: "https://github.com/o/r/issues/9" });
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, owned, undefined,
    { items: [owned], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { updateOnly: true, onTransition: context => {
    if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain legacy refresh transaction");
  } }), /committed journal/);
  const [retained] = await listRetainedGithubImportPlans(root); assert.ok(retained);
  const file = join(root, "transactions/pm-github", `${retained.transactionId}.json`), legacy = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete legacy.itemIds; writeFileSync(file, JSON.stringify(legacy));
  const before = bytes(root, owned);
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { repository: { i9: { number: 9, title: "Current source", body: "Public", state: "OPEN", stateReason: null,
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-03-01T00:00:00Z", closedAt: null, url: "https://github.com/o/r/issues/9", author: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), async () => {
    const preview = await runRefresh(repo, root, { "dry-run": true }, { numbers: [9] });
    assert.deepEqual(preview.deferred_imports![0]!.issue_numbers, [7]); assert.equal(preview.resumed, 0); assert.equal(preview.selected, 1);
  });
  assert.deepEqual(bytes(root, owned), before); assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), legacy);
}));


test("off-board metadata projections without tags remain outside board ownership scope", async () => tracker(async root => {
  const stored = await native(root, { github_url: "https://github.com/o/r/issues/8" });
  const { tags, ...view } = stored; assert.deepEqual(tags, ["retained"]);
  const board = [{ id: "board-seven", content: { typename: "Issue" as const, repo, number: 7, title: "Board issue" } }], ref = { owner: "o", number: 1 };
  assert.deepEqual(buildProjectPullPlan([view], ref, board, undefined, undefined, [stored]).entries, []);
  assert.equal(buildProjectImportPlan(board, ref, [view])[0]!.action, "create");
}));


test("fidelity boundary projections retain references without inventing ownership or completion", async () => tracker(async root => {
  const item = await native(root, { links: undefined, external_links: ["https://example.invalid/reference"] });
  assert.deepEqual(githubLinkReferences({ ...item, links: undefined }), []);
  assert.match(new GithubIdentityConflictError(undefined, ["o/r#7", "x/y#8"]).message, /<unknown>/);
  const closed: GhIssue = { ...source(), state: "closed", closed_at: "2025-02-01T00:00:00Z" };
  const { created_at: _created, ...withoutDate } = item;
  const fields = importFidelityFields(buildImportFidelity(closed, [], []), false, withoutDate);
  assert.equal(Object.hasOwn(fields, "completed_at"), false); assert.equal(Object.hasOwn(fields, "closed_at"), false);
  assert.match(importCloseReason(closed, [{ __typename: "ConnectedEvent", subject: { url: "https://github.com/o/r/commit" } }]), /Closed/);
  assert.equal(matchImportedIssue([{ ...item, description: "#7 plus /r#8" }], source()).item, undefined);
  const expanded = "İ".repeat(25) + " github.com/ o/r issues7";
  assert.equal(matchImportedIssue([{ ...item, description: expanded }], source()).item, undefined);
  const first = await native(root, { linear_url: "https://linear.app/fixture/issue/FIX-7" });
  const second = await native(root, { linear_url: "https://linear.app/fixture/issue/FIX-7" });
  assert.throws(() => matchImportedIssue([first, second], { ...source(), body: "https://linear.app/fixture/issue/FIX-7" }), { code: "github_import_owner_conflict" });
}));

test("plain tag arguments replace importer tags but add curated tags without loss", async () => tracker(async root => {
  const fresh = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  assert.deepEqual(importTagArguments(fresh), ["--tags", "gh:o/r#7"]);
  const item = await native(root, { github_url: url, tags: ["retained"] });
  const curated = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, item, undefined, { items: [item], releases: [], timeline: async () => [] }))!;
  assert.deepEqual(importTagArguments(curated), ["--add-tags", "gh:o/r#7"]);
}));

test("ownership diagnostics preserve missing-id caller and peer-conflict details", async () => tracker(async root => {
  const item = await native(root, { github_url: url, github_repo: "other/project" });
  const { id: _id, ...anonymous } = item;
  for (const target of [undefined, { id: "requested-owner", repo, number: 7 }]) {
    assert.throws(() => assertGithubOwnershipConsistency(anonymous, target), error => {
      assert.equal((error as { itemId: string }).itemId, target?.id ?? "<unknown>"); return true;
    });
  }
  const peer = await native(root, { github_url: url });
  const claimant = { ...anonymous, github_repo: repo };
  for (const target of [undefined, { id: "requested-owner", repo, number: 7 }]) assert.throws(() => assertGithubOwnershipConsistency(claimant, target, [peer]), { code: "github_import_owner_conflict" });
  const imported = { ...peer, id: `fixture-github-${githubRepositoryHash(repo)}-7`, author: "pm-github" };
  const { tags: _tags, ...untagged } = imported;
  assert.deepEqual(githubOwnershipClaims(untagged).owners, ["o/r#7"]);
}));

test("native ownership hooks forward indexing, count real reads and reject missing dependency endpoints", async () => tracker(async root => {
  const item = await native(root, { github_url: url }), target = { id: item.id!, repo, number: 7 };
  const observed: GithubOwnershipWork = {}, measured: GithubOwnershipWork = {};
  await withGithubOwnershipWork(observed, async () => {
    assert.equal((await readGithubOwnershipSnapshot(root, [repo])).byId.has(item.id!), true);
    await withGithubImportOwners(root, [target], async () => {
      await withGithubImportOwners(root, [{ ...target, expectedHash: await readGithubImportOwner(root, target) }], async () => {
        await update(item.id!, { title: "Allowed current owner" }, { pmRoot: root });
      }, measured);
    }, measured);
  });
  assert.ok(observed.corpusReads! >= 3); assert.ok(measured.corpusReads! >= 3);
  const before = bytes(root, item);
  await assert.rejects(() => withGithubImportOwners(root, [{ ...target, related: [{ ...target, id: "fixture-missing" }] }], () => update(item.id!, { title: "Must refuse" }, { pmRoot: root })), /missing dependency endpoint/);
  assert.deepEqual(bytes(root, item), before);
  let indexed = 0;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], beforeMutation: [], onRead: [], onWrite: [], onIndex: [{ layer: "project", name: "observe-index", run: () => { indexed++; } }] });
    await withGithubImportOwners(root, [target], () => runReindex({ mode: "keyword" }, { path: root }));
  });
  assert.ok(indexed > 0, "The native index event must reach the ambient delegate");
}));

test("board consistency scopes native mutation hooks and refuses ownership changes", async () => tracker(async root => {
  const owner = await native(root, { github_url: url }), unrelated = await native(root);
  await withGithubItemConsistency(root, owner.id!, ["o/r#7"], async () => {
    await update(unrelated.id!, { title: "Unrelated native update" }, { pmRoot: root });
    await update(owner.id!, { title: "Allowed owner update" }, { pmRoot: root });
  });
  const before = bytes(root, owner);
  await assert.rejects(() => withGithubItemConsistency(root, owner.id!, [], () => update(owner.id!, { title: "Refused wrong expected ownership" }, { pmRoot: root })), /original unowned project item/);
  assert.deepEqual(bytes(root, owner), before);
  const settings = await readSettings(root);
  await withGithubItemConsistency(root, unrelated.id!, [], () => create({ title: "Unrelated creation", type: "Chore" }, { pmRoot: root }));
  await assert.rejects(() => withGithubItemConsistency(root, unrelated.id!, [], () => mutateItem({ pmRoot: root, id: unrelated.id!, settings, author: "fixture", op: "update", mutate: document => {
    document.metadata.github_url = url; return { changedFields: ["github_url"] };
  } })), /original unowned project item|claimed by/);
}));

test("recovery validation rejects malformed original dependencies and target tuples before writes", async () => tracker(async root => {
  const item = await native(root, { github_url: url }), before = bytes(root, item);
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({ atomic: true }), undefined, item, undefined, { items: [item], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: () => { throw new Error("retain original fixture"); } }), /could not be published/);
  const files = join(root, "transactions", "pm-github");
  assert.deepEqual(readdirSync(files), []);
  await assert.rejects(() => importGithubAtomic(root, repo, [{ ...entry, preserveContent: false, match: { ...item, author: "fixture" } }]), { code: "github_import_plan_ownership_invalid" });
  assert.deepEqual(bytes(root, item), before);
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => { if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("retained"); } }), /committed journal/);
  const [record] = await listRetainedGithubImportPlans(root); assert.ok(record);
  const invalid: GithubImportPlanRecord[] = [
    { ...record, dependencyIssues: [{ ...source(), body: undefined } as unknown as GhIssue] },
    { ...record, itemIds: [[7, ""]] },
    { ...record, entries: [...record.entries, { ...entry, issueNumber: 8 }], itemIds: [[7, item.id!], [8, item.id!]] },
  ];
  for (const plan of invalid) assert.throws(() => validateGithubImportPlan(plan), { code: "github_import_plan_drift" });
  const file = join(files, `${record.transactionId}.json`), saved = readFileSync(file);
  writeFileSync(file, JSON.stringify(invalid[0]));
  await assert.rejects(() => readGithubImportPlan(root, record.transactionId), { code: "github_import_plan_drift" });
  writeFileSync(file, saved);
}));

test("recovery discovery refuses non-directory state and atomic dependency pass uses the original entries", async () => tracker(async root => {
  mkdirSync(join(root, "transactions"), { recursive: true }); writeFileSync(join(root, "transactions", "pm-github"), "not a directory");
  await assert.rejects(() => listRetainedGithubImportPlans(root), { code: "github_import_plan_missing" });
  rmSync(join(root, "transactions", "pm-github"));
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({ atomic: true }), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  const result = await importGithubAtomic(root, repo, [entry], { linkDeps: true });
  assert.equal(result.imported, 1); assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1); assert.ok(result.depLink);
}));


for (const mutation of ["remove", "relink"] as const) test(`sync refuses a native target that disappears or relinks after planning (${mutation})`, async () => tracker(async root => {
  const local = await native(root, { github_url: url }), settings = await readSettings(root);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  await withMockGithub(async (_request, response) => {
    if (mutation === "remove") await deleteItem(local.id!, {}, { pmRoot: root });
    else await mutateItem({ pmRoot: root, id: local.id!, settings, author: "fixture", op: "update", mutate: document => {
      document.metadata.github_url = "https://github.com/o/r/issues/8"; return { changedFields: ["github_url"] };
    } });
    jsonResponse(response, 200, { ...source(), state: "closed" });
  }, async server => {
    await assert.rejects(() => harness.runCommand({ command: "github sync", options: { repo, ids: local.id }, pmRoot: root }), { code: "github_import_owner_conflict" });
    assert.equal(server.requests.some(request => request.method !== "GET"), false);
  });
}));

test("export refuses a disappeared planning owner and distinguishes missing-id drafts", async () => tracker(async root => {
  const local = await native(root, { github_url: url }), items = [local];
  const plan = buildExportPlan(items, repo); items.pop();
  await withMockGithub((_request, response) => jsonResponse(response, 200, source()), async server => {
    await assert.rejects(() => applyExportPlan(plan, repo, "fixture", (method, target, _token, body) => fetch(target, { method, body })), { code: "github_import_owner_conflict" });
    assert.deepEqual(server.requests, []);
  });
  const { id: _id, ...anonymous } = await native(root);
  assert.deepEqual(planSync([anonymous], repo), []);
  assert.deepEqual(planSync([local], ""), []);
  const drafts = buildExportPlan([anonymous], repo);
  assert.equal(drafts[0]!.action, "create"); assert.equal(drafts[0]!.id, undefined);
  const anonymousItems = [anonymous], malformed = buildExportPlan(anonymousItems, repo); anonymousItems.pop();
  malformed[0]!.action = "update"; malformed[0]!.number = 7;
  await assert.rejects(() => applyExportPlan(malformed, repo, "fixture", async () => { throw new Error("Must not write"); }), { code: "github_import_owner_conflict" });
  const missingNumber = buildExportPlan([local], repo); delete missingNumber[0]!.number;
  await assert.rejects(() => applyExportPlan(missingNumber, repo, "fixture", async () => { throw new Error("Must not write"); }), { code: "github_import_owner_conflict" });
  await withMockGithub((_request, response) => jsonResponse(response, 201, source()), async server => {
    const applied = await applyExportPlan(drafts, repo, "fixture", (method, target, _token, body) => fetch(target, { method, body }));
    assert.equal(applied.created, 1); assert.equal(server.requests[0]!.method, "POST");
  });
  const { github_url: _url, ...unowned } = local;
  const ownerItems = [local], changed = buildExportPlan(ownerItems, repo); ownerItems[0] = unowned;
  await assert.rejects(() => applyExportPlan(changed, repo, "fixture", async () => { throw new Error("Must not request"); }), { code: "github_import_owner_conflict" });
}));

test("markdown export preview renders existing owners and project pull accepts a native unowned legacy entry", async () => tracker(async root => {
  const local = await native(root, { github_url: url }), harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const preview = await captureStderr(() => harness.runCommand({ command: "github export", pmRoot: root, options: { repo, ids: local.id, format: "md" }, global: { json: false } }));
  assert.ok(preview.stderr.some(line => line.includes("[update #7]")));
  const unowned = await native(root);
  const pulled = await applyPullEntry({ itemId: "board-item", pmId: unowned.id!, title: "Native local item", toStatus: "in_progress", fromStatus: "open" }, root);
  assert.equal(pulled.changed, true);
  assert.equal((await get(unowned.id!, {}, { pmRoot: root })).item.status, "in_progress");
}));

test("atomic plan staging refuses a competing publication without replacing original bytes", async () => tracker(async root => {
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({ atomic: true }), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  let target = "";
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: context => {
    target = context.file; writeFileSync(target, "competing durable plan");
  } }), { code: "github_import_plan_drift" });
  assert.equal(readFileSync(target, "utf8"), "competing durable plan");
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
}));


test("nested revision guards share only equivalent scopes and preserve unexpected failures", async () => tracker(async root => {
  const item = await native(root, { github_url: url }), target = { id: item.id!, repo, number: 7 }, hash = await readGithubImportOwner(root, target);
  await withGithubImportOwners(root, [{ ...target, expectedHash: hash }], () => withGithubImportOwners(root, [{ ...target, expectedHash: hash, related: [] }], () => update(item.id!, { title: "Equivalent fenced nested owner" }, { pmRoot: root })));
  const before = bytes(root, item), broken = { ...target };
  Object.defineProperty(broken, "related", { get: () => { throw new Error("caller endpoint inspection failed"); } });
  await assert.rejects(() => withGithubImportOwners(root, [broken], () => update(item.id!, { title: "Must not apply" }, { pmRoot: root })), /Extension mutation guard github-import-owner failed/);
  assert.deepEqual(bytes(root, item), before);
  const unowned = await native(root), settings = await readSettings(root);
  await withGithubImportOwners(root, [{ id: unowned.id!, repo, number: 9, initialLink: () => true }], () => mutateItem({ pmRoot: root, id: unowned.id!, settings, author: "fixture", op: "update", mutate: document => {
    delete (document.metadata as Record<string, unknown>).id; return { changedFields: ["id"] };
  } }));
  await assert.rejects(() => listAllComplete({}, { pmRoot: root }), error => (error as { code?: string }).code === "list_source_incomplete");
}));


test("closeout isolates typed ownership conflicts and propagates unrelated parser failures", async () => tracker(async root => {
  const item = await native(root), before = bytes(root, item);
  const conflict = new GithubIdentityConflictError(item.id, ["o/r#7", "other/project#8"]);
  const declared = { ...item };
  Object.defineProperty(declared, "github_url", { enumerable: true, configurable: true, get: () => { throw conflict; } });
  assert.equal(closeoutOwnershipConflict(declared as Parameters<typeof closeoutOwnershipConflict>[0], repo, []), conflict);
  Object.defineProperty(declared, "github_url", { enumerable: true, configurable: true, get: () => { throw new Error("identity reader failed"); } });
  assert.throws(() => closeoutOwnershipConflict(declared as Parameters<typeof closeoutOwnershipConflict>[0], repo, []), /identity reader failed/);
  assert.deepEqual(bytes(root, item), before);
  assert.deepEqual(extractCloseoutItems("Closes https://github.com/o/r/blob/main/.agents/pm/issues/.toon"), []);
}));

test("a dangling retained plan is reported missing without changing tracker bytes", async () => tracker(async root => {
  const item = await native(root), before = bytes(root, item), directory = join(root, "transactions", "pm-github");
  mkdirSync(directory, { recursive: true }); symlinkSync("missing-original.json", join(directory, "github-import-dangling.json"));
  await assert.rejects(() => listRetainedGithubImportPlans(root), { code: "github_import_plan_missing" });
  assert.deepEqual(bytes(root, item), before);
}));

test("publication-in-progress lock tokens are live before the final directory sync", async () => tracker(async root => {
  let contender: string | undefined;
  const owner = await acquireImportLock(root, "fixture-publishing", { waitMs: 0, onStaged: async ({ file, staged }) => {
    copyFileSync(staged, file);
    contender = (await acquireImportLock(root, "fixture-publishing", { waitMs: 0 })).status;
    rmSync(file);
  } });
  assert.equal(contender, "contended"); assert.equal(owner.status, "acquired");
  if (owner.status === "acquired") owner.lock.release();
}));


test("citation exclusions retain malformed repository fragments and undefined link fields", async () => tracker(async root => {
  const item = await native(root);
  assert.deepEqual(githubLinkReferences({ ...item, links: undefined }), []);
  for (const text of ["github.com/ issues7", "İ".repeat(11) + "github.com/ issues7", "İ".repeat(30) + "github.com/ issues7", "github.com/o/r/issues/7", "/r#7"]) {
    assert.equal(matchImportedIssue([{ ...item, description: text }], source()).item, undefined);
  }
}));

test("owner observers can reset counters before a native locked write", async () => tracker(async root => {
  const item = await native(root, { github_url: url }), target = { id: item.id!, repo, number: 7 }, observed: GithubOwnershipWork = {}, work: GithubOwnershipWork = {};
  await withGithubOwnershipWork(observed, () => withGithubImportOwners(root, [target], async () => {
    delete observed.corpusReads; delete work.corpusReads;
    await update(item.id!, { title: "Count the locked corpus" }, { pmRoot: root });
  }, work));
  assert.equal(observed.corpusReads, 1); assert.equal(work.corpusReads, 1);
}));

test("a retained import refuses a fresh dry run before fetching changed provider input", async () => tracker(async root => {
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({ atomic: true }), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => { if (context.transition === "prepared") throw new WorkspaceTransactionInterruptedError("retained original input"); } }), /interrupted/);
  let requests = 0;
  await withMockGithub((_request, response) => { requests++; jsonResponse(response, 200, [source()]); }, async () => {
    await assert.rejects(() => runImport(repo, root, parseImportOptions({ atomic: true, "dry-run": true })), { code: "github_import_plan_pending" });
  });
  assert.equal(requests, 0); assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
}));

test("an unexpected identity-field read during planning is preserved before any SDK write", async () => tracker(async root => {
  const item = await native(root, { github_url: url }), entry = (await prepareGithubImport(source(), repo, parseImportOptions({ atomic: true }), undefined, item, undefined, { items: [item], releases: [], timeline: async () => [] }))!;
  const input = { ...item, author: "pm-github" };
  Object.defineProperty(input, "github_url", { enumerable: true, get: () => { throw new Error("caller identity field unavailable"); } });
  const before = bytes(root, item);
  await assert.rejects(() => importGithubAtomic(root, repo, [{ ...entry, identity: undefined, preserveContent: false, match: input }]), /caller identity field unavailable/);
  assert.deepEqual(bytes(root, item), before);
}));


test("project helpers refuse missing coordinates or native targets before a GraphQL write", async () => tracker(async root => {
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { repository: { issueOrPullRequest: { id: "issue-node-7" } } } }), async server => {
    assert.equal(await gqlResolveIssueNodeId("invalid", 7, "fixture"), undefined); assert.deepEqual(server.requests, []);
    assert.equal(await gqlResolveIssueNodeId(repo, 7, "fixture"), "issue-node-7");
    assert.equal(server.requests.length, 1);
    const result = await applyPushEntry({ pmId: "fixture-missing", action: "add-draft", title: "Must not write" }, { id: "board-node", title: "Board", url: "https://github.com/orgs/o/projects/1", ownerType: "organization" }, { owner: "o", number: 1 }, new Map(), root, "fixture", []);
    assert.equal(result.changed, false); assert.match(result.error!, /missing tracker item/); assert.equal(server.requests.length, 1);
  });
}));

test("legacy atomic entries retain their body and fallback dependency source dates", async () => tracker(async root => {
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({ atomic: true }), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  const result = await importGithubAtomic(root, repo, [{ ...entry, sourceBody: undefined, fidelity: undefined }], { linkDeps: true });
  assert.equal(result.imported, 1); assert.equal(result.depLink!.linked, 0);
  assert.equal((await listAllComplete({ includeBody: true }, { pmRoot: root })).items[0]!.body, entry.body);
  const closedIssue: GhIssue = { ...source(8), state: "closed", closed_at: "2025-02-01T00:00:00Z" };
  const closed = (await prepareGithubImport(closedIssue, repo, parseImportOptions({}), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  assert.equal((await importGithubAtomic(root, repo, [closed], { linkDeps: true })).imported, 1);
}));

test("provider-linked legacy plans use the retained body when separate sourceBody is absent", async () => tracker(async root => {
  const local = await native(root, { linear_url: "https://linear.app/fixture/issue/FIX-7" }), issue = { ...source(), body: "https://linear.app/fixture/issue/FIX-7" };
  const entry = (await prepareGithubImport(issue, repo, parseImportOptions({ atomic: true }), undefined, local, undefined, { items: [local], releases: [], timeline: async () => [] }))!;
  const legacy = { ...entry, sourceBody: undefined };
  assert.equal(githubImportTarget(repo, legacy, local.id!).initialLink?.(local), true);
  const result = await importGithubAtomic(root, repo, [legacy]); assert.equal(result.updated, 1);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}));


test("dependency mutation policy failures retain native endpoints and report the SDK refusal", async () => tracker(async root => {
  const first = await native(root, { github_url: url }), second = await native(root, { github_url: "https://github.com/o/r/issues/8" }), before = [first, second].map(item => bytes(root, item));
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "dependency-policy", run: () => ({ allow: false, code: "fixture_dependency_denied", remediation: "Keep this native edge unchanged" }) }] });
    const result = await linkImportedDependencies(repo, [{ ...source(), body: "Blocked by #8" }, { ...source(8), body: null }], root);
    assert.equal(result.linked, 0); assert.equal(result.failures.length, 1); assert.match(result.failures[0]!, /fixture_dependency_denied|dependency-policy/);
  });
  assert.deepEqual([first, second].map(item => bytes(root, item)), before);
}));

test("native after-command hints tolerate normalized short ids and reference-only items", async () => tracker(async root => {
  const owner = await native(root, { github_url: url }), reference = await native(root, { tags: ["gh:o/r#7"] });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  await withEnv({ PM_GITHUB_SYNC: "1" }, async () => {
  for (const id of [owner.id!.slice((await readSettings(root)).id_prefix.length), reference.id!]) {
    const result = await captureStderr(() => harness.runHook({ kind: "after_command", context: { command: "update", args: [id], pm_root: root, ok: true } }));
    assert.deepEqual(result.stderr, []);
  }
  });
}));

test("atomic refresh skips another target's unfinished journal and refuses an unlinked update", async () => tracker(async root => {
  const first = await native(root, { github_url: url }), second = await native(root, { github_url: "https://github.com/o/r/issues/8" }), items = [first, second];
  const entries = await Promise.all(items.map((item, i) => prepareGithubImport(source(7 + i), repo, parseImportOptions({}), undefined, item, undefined, { items, releases: [], timeline: async () => [] })));
  await assert.rejects(() => importGithubAtomic(root, repo, [entries[0]!], { onTransition: context => { if (context.transition === "step_applied") throw new WorkspaceTransactionInterruptedError("Unselected native journal"); } }), /interrupted/);
  assert.ok((await listUnfinishedGithubImports(root))[0]!.itemIds.length > 0);
  const result = await importGithubAtomic(root, repo, [entries[1]!], { updateOnly: true }); assert.equal(result.updated, 1);
  const before = bytes(root, second);
  await assert.rejects(() => importGithubAtomic(root, repo, [{ ...entries[1]!, match: undefined }], { updateOnly: true }), /unlinked|requires|match/);
  assert.deepEqual(bytes(root, second), before);
}));

test("two independently retained native plans refuse implicit recovery until selected explicitly", async () => tracker(async root => {
  const items = [await native(root, { github_url: url }), await native(root, { github_url: "https://github.com/o/r/issues/8" })];
  const staged: Array<[string, Buffer]> = [];
  for (let i = 0; i < items.length; i++) {
    const entry = (await prepareGithubImport(source(7 + i), repo, parseImportOptions({}), undefined, items[i], undefined, { items, releases: [], timeline: async () => [] }))!;
    await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => { if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain completed native plan"); } }), /committed journal/);
    const [record] = await listRetainedGithubImportPlans(root); assert.ok(record);
    const file = join(root, "transactions", "pm-github", `${record.transactionId}.json`); staged.push([file, readFileSync(file)]); rmSync(file);
  }
  for (const [file, contents] of staged) writeFileSync(file, contents);
  const before = items.map(item => bytes(root, item));
  await assert.rejects(() => importGithubAtomic(root, repo, []), { code: "github_import_plan_drift" });
  assert.deepEqual(items.map(item => bytes(root, item)), before);
}));


test("upstream pre-write checks refuse absent caller coordinates and mismatched create ownership", async () => tracker(async root => {
  const item = await native(root, { github_url: url }), before = bytes(root, item);
  assert.throws(() => assertCurrentUpstreamTarget(root, repo, {}, {}), error => {
    assert.equal((error as { itemId: string }).itemId, "<unknown>"); assert.equal((error as { expected: string }).expected, "o/r#new"); return true;
  });
  assert.throws(() => assertCurrentUpstreamTarget(root, repo, { id: item.id }, {}), { code: "github_import_owner_conflict" });
  assert.doesNotThrow(() => assertCurrentUpstreamTarget(root, repo, { id: item.id, number: 7 }, {}));
  assert.deepEqual(bytes(root, item), before);
}));


for (const scoped of [false, true]) test(`a retained native plan replays and reselects its current owner (scoped=${scoped})`, async () => tracker(async root => {
  const local = await native(root, { github_url: url });
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, local, undefined, { items: [local], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => { if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain completed source plan"); } }), /committed journal/);
  await withMockGithub((request, response, body) => {
    if (request.method === "GET") { jsonResponse(response, 200, []); return; }
    const query = (JSON.parse(body) as { query: string }).query;
    jsonResponse(response, 200, { data: { repository: query.includes("timelineItems") ? { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } : { i7: {
      number: 7, title: source().title, body: source().body, state: "OPEN", stateReason: null,
      createdAt: source().created_at, updatedAt: source().updated_at, closedAt: null, url, author: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } } });
  }, async () => {
    const result = await runRefresh(repo, root, {}, scoped ? { numbers: [7] } : undefined); assert.equal(result.resumed, 1); assert.equal(result.selected, 1);
    assert.deepEqual(await listRetainedGithubImportPlans(root), []);
    const after = bytes(root, local), repeated = await runRefresh(repo, root, {}, scoped ? { numbers: [7] } : undefined);
    assert.equal(repeated.resumed, 0); assert.equal(repeated.updated, 0); assert.deepEqual(bytes(root, local), after);
  });
}));


test("a recovered target deleted before publication refuses without a provider request", async () => tracker(async root => {
  const local = await native(root, { github_url: url }), entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, local, undefined, { items: [local], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => { if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain committed source plan"); } }), /committed journal/);
  const [record] = await listRetainedGithubImportPlans(root); assert.ok(record);
  const directory = join(root, "transactions", "pm-github"), plan = join(directory, `${record.transactionId}.json`), itemFile = getItemPath(root, String(local.type), local.id!), history = readFileSync(getHistoryPath(root, local.id!));
  let deleted = false;
  const watcher = watch(directory, () => { if (!existsSync(plan) && !deleted) { deleted = true; rmSync(itemFile); } });
  try {
    await withMockGithub((_request, response) => jsonResponse(response, 200, [source()]), async server => {
      await assert.rejects(() => runImport(repo, root, parseImportOptions({ atomic: true, gate: true })), { code: "github_import_owner_conflict" });
      assert.deepEqual(server.requests, []);
    });
    assert.equal(deleted, true); assert.deepEqual(readFileSync(getHistoryPath(root, local.id!)), history);
  } finally { watcher.close(); }
}));


test("a different repository journal arriving during fetch preserves the complete new atomic batch", async () => tracker(async root => {
  let staged = false;
  await withMockGithub(async (request, response) => {
    if (request.url!.includes("/issues?") && !staged) {
      staged = true;
      const other = { ...source(99), html_url: "https://github.com/other/project/issues/99" };
      const entry = (await prepareGithubImport(other, "other/project", parseImportOptions({}), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
      await assert.rejects(() => importGithubAtomic(root, "other/project", [entry], { onTransition: context => { if (context.transition === "step_applied") throw new WorkspaceTransactionInterruptedError("Independent pending producer"); } }), /interrupted/);
    }
    jsonResponse(response, 200, request.url!.includes("/issues?") ? [source()] : []);
  }, async () => {
    const result = await runImport(repo, root, parseImportOptions({ atomic: true }));
    assert.equal("imported" in result && result.imported, 1); assert.equal(staged, true);
    assert.equal((await listRetainedGithubImportPlans(root))[0]!.repo, "other/project");
  });
}));


test("unrelated refresh leaves a malformed empty-target legacy plan and native owner bytes untouched", async () => tracker(async root => {
  const local = await native(root, { github_url: url }), other = await native(root, { github_url: "https://github.com/o/r/issues/9" });
  const entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, local, undefined, { items: [local, other], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { updateOnly: true, onTransition: context => { if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Retain legacy source record"); } }), /committed journal/);
  const [record] = await listRetainedGithubImportPlans(root); assert.ok(record);
  const file = join(root, "transactions", "pm-github", `${record.transactionId}.json`);
  const legacy = { ...record, itemIds: undefined, entries: [{ ...record.entries[0]!, match: { ...record.entries[0]!.match, id: "" } }], mutations: record.mutations.map(mutation => ({ ...mutation, id: "" })) };
  writeFileSync(file, JSON.stringify(legacy));
  const before = [local, other].map(item => bytes(root, item)), saved = readFileSync(file);
  await withMockGithub((request, response) => {
    assert.equal(request.method, "POST");
    jsonResponse(response, 200, { data: { repository: { i9: { number: 9, title: "Source 9", body: "Public source", state: "OPEN", stateReason: null,
      createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-02-01T00:00:00Z", closedAt: null, url: "https://github.com/o/r/issues/9", author: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  }, async () => { assert.equal((await runRefresh(repo, root, { "dry-run": true }, { numbers: [9] })).selected, 1); });
  assert.deepEqual([local, other].map(item => bytes(root, item)), before); assert.deepEqual(readFileSync(file), saved);
}));


test("native lease publication catches a peer relink after the plain import's revision read", async () => tracker(async root => {
  const local = await native(root, { github_url: url }), settings = await readSettings(root);
  let relinked = false, peerBytes: string[] | undefined;
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url!.includes("/issues?") ? [source()] : []), async server => {
    await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
      setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], beforeMutation: [], onRead: [], onIndex: [], onWrite: [{ layer: "project", name: "peer-at-lease-publication", run: async context => {
        if (relinked || !context.path.endsWith("github-ownership.lock")) return;
        relinked = true;
        await mutateItem({ pmRoot: root, id: local.id!, settings, author: "fixture-peer", op: "update", mutate: document => {
          document.metadata.github_url = "https://github.com/other/project/issues/8"; return { changedFields: ["github_url"] };
        } });
        peerBytes = bytes(root, local);
      } }] });
      await assert.rejects(() => runImport(repo, root, parseImportOptions({})), { code: "github_import_owner_conflict" });
    });
    assert.equal(relinked, true); assert.deepEqual(bytes(root, local), peerBytes);
    assert.equal(server.requests.some(request => request.method !== "GET"), false);
  });
}));

test("an optional atomic annotation receipt may be undefined without changing actual native writes", async () => tracker(async root => {
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url!.includes("/issues?") ? [source()] : []), async () => {
    const result = await runImport(repo, root, parseImportOptions({ atomic: true }), { commitAtomic: async (trackerRoot, repository, entries) => ({
      ...await importGithubAtomic(trackerRoot, repository, entries), commentWriteFailures: undefined,
    }) });
    assert.equal("imported" in result && result.imported, 1);
    assert.equal("commentWriteFailures" in result, false);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  });
}));

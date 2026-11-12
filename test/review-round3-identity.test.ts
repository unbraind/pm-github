/** Round-three regressions use real SDK trackers; only GitHub transport is supplied. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { init, create, get, comments, listAllComplete, commitImportedItem, getItemPath, readSettings, WorkspaceTransactionInterruptedError } from "@unbrained/pm-cli/sdk";
import { runImport, parseImportOptions, importGithubAtomic, readGithubImportPlan, listUnfinishedGithubImports, planSync, buildExportPlan, parseBlockerReferences, exploreGithubIdentities, prepareGithubImport, scanGithubImportPreflight, type GhIssue } from "../index.ts";
import { importIdentityKeys, legacyGithubIdentityConflict } from "../import-fidelity.ts";
import { normalizeGithubRepository, parseGithubIssueUrl, parseGithubUrl } from "../github-url.ts";
import { selectRefreshTargets, runRefresh } from "../refresh.ts";
import { captureStderr, withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

/** Isolate native documents, histories and journals, including in plain non-git directories. */
async function tracker(run: (root: string) => Promise<void>, git = false) {
  const directory = mkdtempSync(join(tmpdir(), "github-round3-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined, PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Seed released metadata through the public SDK without mocking native persistence. */
async function local(root: string, fields: Record<string, unknown>) {
  const item = (await create({ title: "Curated Chore", type: "Chore", description: "Curated description", body: "Curated body", tags: "keep" }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: item.id, itemPath: getItemPath(root, "Chore", item.id), settings: await readSettings(root),
    document: { metadata: { ...item, ...fields }, body: "Curated body" }, author: "fixture", message: "Released identity fixture", conflictWarningPrefix: "fixture" });
  return (await get(item.id, {}, { pmRoot: root })).item;
}
/** Capture every document, history and journal, excluding only transient locks. */
function snapshot(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
    .filter(file => !relative(root, file).startsWith("locks/")).sort().map(file => [relative(root, file), readFileSync(file, "utf8")]));
}
/** Supply an ordinary source issue with a canonical source repository identity. */
function issue(repo = "fixture/issues"): GhIssue {
  return { number: 7, title: "Remote title", body: "Remote body", state: "open", labels: [], user: null, assignee: null, milestone: null,
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: `https://github.com/${repo}/issues/7` };
}

for (const repo of ["fixture/issues", "fixture/pull", "issues/widgets"]) for (const kind of ["issues", "pull"] as const) for (const form of ["plain", "decorated", "www"] as const) {
  test(`URL segments retain owner/repository identity (${repo}, ${kind}, ${form})`, async () => tracker(async root => {
    const url = `${form === "www" ? "HTTPS://WWW.GITHUB.COM" : "https://github.com"}/${repo}/${kind}/7${form === "decorated" ? "/?view=all#issuecomment-12" : ""}`;
    const item = await local(root, { github_url: url, ...(form === "plain" ? {} : { github_number: 7 }) });
    assert.equal(parseGithubIssueUrl(url)?.key, `${repo}#7`);
    assert.deepEqual(importIdentityKeys(item), [`${repo}#7`]);
    assert.equal(selectRefreshTargets([item], repo).length, kind === "issues" ? 1 : 0);
    assert.equal(planSync([item], repo)[0]!.number, 7);
    assert.equal(buildExportPlan([item], repo)[0]!.action, "update");
    assert.equal(parseBlockerReferences(url)[0]!.repo, repo);
    const graph = await exploreGithubIdentities(root, { identity: `gh:${repo}#7` });
    assert.ok(graph.edges.some(edge => edge.identity === `gh:${repo}#7` && edge.strength === "claim"));
    await captureStderr(() => runImport(repo, root, parseImportOptions({}), { resolveToken: () => undefined, fetchIssues: async () => [issue(repo)], fetchIssueTimeline: async () => [] }));
    const all = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, item.id);
    assert.equal(all[0]!.type, "Chore");
    assert.equal(all[0]!.title, item.title);
  }));
}

test("URL helper rejects non-GitHub and incomplete identities while preserving API segment positions", () => {
  for (const url of ["https://github.com.evil.invalid/o/r/issues/7", "https://fixture@github.com/o/r/issues/7", "https://github.com/o/r/issues/7/extra", "https://github.com/o/r/issues/0", "https://github.com/o/r/pull", "https://github.com/o/r/issues/../issues/7"]) assert.equal(parseGithubIssueUrl(url), undefined);
  const api = parseGithubIssueUrl("https://api.github.com/repos/issues/pull/issues/7/?query=1#note")!;
  assert.equal(api.key, "issues/pull#7"); assert.equal(api.api, true);
  assert.equal(parseGithubUrl("https://github.com/issues/pull/commit/abcd")!.kind, "commit");
});

for (const mode of ["ambiguous", "single", "explicit"] as const) test(`number-only legacy provenance is bounded (${mode})`, async () => tracker(async root => {
  const tags = mode === "single" ? ["keep", "gh:original/project#7"] : ["keep", "gh:original/project#7", "gh:unrelated/project#7"];
  const item = await local(root, { github_number: 7, tags, ...(mode === "explicit" ? { github_repo: "original/project" } : {}) });
  const before = snapshot(root);
  const repo = mode === "single" ? "original/project" : "unrelated/project";
  const incoming = { ...issue(repo), state: "closed" as const, closed_at: "2027-01-01T00:00:00Z", updated_at: "2027-01-01T00:00:00Z", state_reason: "completed" as const };
  const { result } = await captureStderr(() => runImport(repo, root, parseImportOptions({}), { resolveToken: () => undefined, fetchIssues: async () => [incoming], fetchIssueTimeline: async () => [] }));
  const current = (await get(item.id, {}, { pmRoot: root })).item;
  assert.equal(current.title, item.title);
  if (mode === "single") assert.equal(current.status, "closed");
  else {
    assert.equal(current.status, item.status);
    assert.equal(current.github_url, undefined);
    for (const [path, value] of Object.entries(before)) if (path.endsWith(".toon") || path.startsWith("history/")) assert.equal(snapshot(root)[path], value);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
  }
  assert.deepEqual(importIdentityKeys(current), mode === "ambiguous" ? [] : ["original/project#7"]);
  assert.equal(Boolean(legacyGithubIdentityConflict(current)), mode === "ambiguous");
  if (mode === "ambiguous") {
    assert.ok("identity_conflicts" in result);
    assert.equal(result.identity_conflicts![0]!.code, "ambiguous_legacy_github_identity");
  }
}));

for (const mode of ["failed", "missing", "forged"] as const) test(`recovery preflight refuses before any write (${mode})`, async () => tracker(async root => {
  const source = issue();
  // Synthetic credential shape is assembled only inside the disposable fixture.
  const unsafe = { ...source, body: "fixture " + "ghp_" + "z".repeat(36) };
  const entry = (await prepareGithubImport(mode === "missing" ? source : unsafe, "fixture/issues", parseImportOptions({ atomic: true }), undefined, undefined, undefined,
    { items: [], releases: [], timeline: async () => [] }))!;
  if (mode === "failed") {
    const initial = snapshot(root);
    let enteredTransaction = false;
    await assert.rejects(() => importGithubAtomic(root, "fixture/issues", [entry], { gate: true, onTransition: () => { enteredTransaction = true; } }), { code: "github_import_preflight_failed" });
    assert.equal(enteredTransaction, false);
    assert.ok(JSON.stringify(snapshot(root)) === JSON.stringify(initial), "Fresh gated refusal must precede transaction and file writes");
  }
  // Seed a real interrupted clean transaction, then model a previously persisted unsafe plan.
  const clean = { ...entry, body: source.body ?? "" };
  await assert.rejects(() => importGithubAtomic(root, "fixture/issues", [clean], { onTransition: context => {
    if (context.transition === "prepared") throw new WorkspaceTransactionInterruptedError("Before the first native mutation");
  } }), /interrupted/);
  const pending = (await listUnfinishedGithubImports(root))[0]!;
  const file = join(root, "transactions/pm-github", `${pending.transactionId}.json`);
  const plan = (await readGithubImportPlan(root, pending.transactionId))!;
  assert.equal(plan.preflight?.verdict, "pass");
  if (mode !== "missing") {
    plan.entries[0]!.body = unsafe.body;
    for (const mutation of plan.mutations) if (mutation.op === "create" || mutation.op === "update") mutation.options.body = unsafe.body;
    plan.preflight = scanGithubImportPreflight(root, plan.entries, plan.mutations);
    assert.equal(plan.preflight.verdict, "fail");
  }
  if (mode === "missing") delete plan.preflight;
  if (mode === "forged") plan.preflight = { verdict: "pass", scanned_files: 1, findings: 0, allowlisted: 0 };
  writeFileSync(file, JSON.stringify(plan));
  const before = snapshot(root);
  let error: unknown;
  try { await captureStderr(() => runImport("fixture/issues", root, parseImportOptions({ atomic: true, gate: true }), { fetchIssues: async () => { throw new Error("Recovery cannot poll fresh input"); } })); }
  catch (caught) { error = caught; }
  assert.ok(JSON.stringify(snapshot(root)) === JSON.stringify(before), "Recovery changed tracker files or history before privacy approval");
  assert.equal((error as { code?: string } | undefined)?.code, "github_import_preflight_failed");
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
}, true));

test("passing saved preflight permits exact replay without git", async () => tracker(async root => {
  const entry = (await prepareGithubImport(issue(), "fixture/issues", parseImportOptions({ atomic: true }), undefined, undefined, undefined,
    { items: [], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, "fixture/issues", [entry], { onTransition: context => {
    if (context.transition === "prepared") throw new WorkspaceTransactionInterruptedError("Clean preflight fixture");
  } }), /interrupted/);
  const { result } = await captureStderr(() => runImport("fixture/issues", root, parseImportOptions({ atomic: true }), { fetchIssues: async () => { throw new Error("Original plan must replay"); } }));
  assert.ok("replayedOriginalPlan" in result && result.replayedOriginalPlan);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}));

for (const changed of [false, true]) test(`refresh recovers committed side data before fetching fresh input (${changed})`, async () => tracker(async root => {
  const source = issue();
  const item = await local(root, { github_url: source.html_url });
  const entry = (await prepareGithubImport(source, "fixture/issues", parseImportOptions({ "comments-mode": "annotations" }), undefined, item,
    async () => [{ id: 77, body: "Original planned annotation", created_at: source.updated_at, user: { login: "fixture" } }],
    { items: [item], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, "fixture/issues", [entry], { updateOnly: true, onTransition: context => {
    if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Committed before side data");
  } }), /committed journal/);
  assert.doesNotMatch(JSON.stringify((await comments(item.id, {}, { pmRoot: root })).comments), /Original planned annotation/);
  const updatedAt = changed ? "2025-03-01T00:00:00Z" : source.updated_at;
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url === "/graphql" ? { data: { repository: { i7: {
    number: 7, title: changed ? "New source title" : source.title, body: source.body, state: "OPEN", stateReason: null,
    createdAt: source.created_at, updatedAt, closedAt: null, url: source.html_url, author: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } } } : []), async () => {
    const result = await runRefresh("fixture/issues", root, {});
    assert.equal((await comments(item.id, {}, { pmRoot: root })).comments.filter(note => JSON.stringify(note).includes("Original planned annotation")).length, 1);
    assert.equal((await get(item.id, {}, { pmRoot: root })).item.github_updated_at, updatedAt);
    assert.equal(result.resumed, 1);
    assert.equal(result.updated, changed ? 1 : 0);
  });
  assert.equal((await comments(item.id, {}, { pmRoot: root })).comments.filter(note => JSON.stringify(note).includes("Original planned annotation")).length, 1);
  assert.equal((await get(item.id, {}, { pmRoot: root })).item.github_updated_at, updatedAt);
  assert.deepEqual(readdirSync(join(root, "transactions/pm-github")), []);
}));


test("repository normalization handles adversarial suffixes while preserving released keys", () => {
  assert.equal(normalizeGithubRepository(" FIXTURE/ISSUES" + "/".repeat(50000)), "fixture/issues");
  assert.equal(normalizeGithubRepository("FIXTURE/REPO,PART"), "fixture/repo,part");
  assert.equal(normalizeGithubRepository("fixture/issues/pull"), "fixture/issues/pull");
  // Bound the old quadratic failure in a child; the shared helper runs in linear time.
  const helper = new URL("../github-url.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { normalizeGithubRepository } from ${JSON.stringify(helper)}; const value = "fixture/issues" + "/".repeat(200000) + "x"; if (normalizeGithubRepository(value) !== value) process.exitCode = 1;`],
    { timeout: 8000, encoding: "utf8" });
  assert.equal(result.status, 0, "Repository suffix normalization must finish within its bounded child process");
});

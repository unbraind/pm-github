/** Exercise import entry points against the published SDK that persists native deferrals. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { get, getItemPath, getHistoryPath, init, normalizeItemId, readSettings, validate } from "@unbrained/pm-cli/sdk";
import { deriveAtomicItemId, importGithubAtomic, parseImportOptions, runImport, type GhIssue, type PreparedGithubImport } from "../../index.ts";
import { jsonResponse, withEnv, withMockGithub } from "./mock-github-server.ts";

const repo = "fixture/project";
const deferrableFields = ["acceptance_criteria", "assignee", "deadline", "estimated_minutes"] as const;

/** Give each case the real tracker defaults and a fresh Git workspace. */
async function tracker(preset: "strict" | "default", run: (pmRoot: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pm-github-admission-"));
  const pmRoot = join(directory, ".agents/pm");
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { preset, defaults: true, withPackages: false, agentGuidance: "skip" },
      { pmRoot, cwd: directory, noExtensions: true });
    assert.equal((await readSettings(pmRoot)).governance.create_mode_default, preset === "strict" ? "strict" : "progressive");
    await run(pmRoot);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Supply deterministic public issue records to the normal REST and GraphQL import flow. */
function issue(number: number): GhIssue {
  return {
    number, title: `Imported issue ${number}`, body: "Source description", state: "open", labels: [],
    assignee: null, milestone: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    closed_at: null, html_url: `https://github.com/${repo}/issues/${number}`,
  };
}

/** Write through the native SDK using a loopback-only GitHub source. */
async function run(pmRoot: string, issues: GhIssue[], atomic: boolean, dryRun = false) {
  return withEnv({ GITHUB_TOKEN: "fixture" }, () => withMockGithub((request, response) => {
    const data = request.url === "/graphql"
      ? { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }
      : request.url?.includes("/timeline") ? [] : issues;
    jsonResponse(response, 200, data);
  }, () => runImport(repo, pmRoot, parseImportOptions({ atomic, gate: true, dryRun }))));
}

/** Derive the item ID using the same configured prefix as the native SDK. */
async function itemId(pmRoot: string, number: number) {
  return deriveAtomicItemId(repo, number, (await readSettings(pmRoot)).id_prefix, normalizeItemId);
}

for (const atomic of [true, false]) {
  test(`strict ${atomic ? "atomic" : "plain"} import persists only genuine unknowns on new items`, async t => tracker("strict", async pmRoot => {
    const assigned: GhIssue = { ...issue(1), assignee: { login: "pm-github" } };
    await run(pmRoot, [assigned], atomic);
    const existing = await itemId(pmRoot, 1);
    const before = (await get(existing, {}, { pmRoot })).item;
    const beforeDeferred = Reflect.get(before, "deferred_fields");
    assert.ok(Array.isArray(beforeDeferred));
    const fields = deferrableFields.filter(field => field !== "assignee");
    assert.deepEqual(beforeDeferred.map((record: { field: string }) => record.field), fields);
    assert.equal(before.assignee, "pm-github");

    const next = [{ ...assigned, title: "Updated source title" }, issue(2)];
    const log = t.mock.method(console, "error", () => {});
    const preview = await run(pmRoot, next, atomic, true);
    const preflight = (message: unknown) => typeof message === "string" && message.includes("pm github import preflight:");
    assert.deepEqual(log.mock.calls.flatMap(call => call.arguments.filter(preflight)), [
      "pm github import preflight: strict creation policy — 1 issue(s) will be admitted with deferrals.",
    ]);
    const expectedCuration = [{
      item: await itemId(pmRoot, 2), issue: 2, fields: ["deadline", "acceptance_criteria", "estimated_minutes", "assignee"],
    }];
    assert.deepEqual(Reflect.get(preview, "needs_curation"), expectedCuration);
    assert.ok("wouldImport" in preview && preview.wouldImport === 1);
    assert.ok("wouldUpdate" in preview && preview.wouldUpdate === 1);
    const result = await run(pmRoot, next, atomic);
    assert.ok("imported" in result && result.imported === 1 && result.updated === 1);
    assert.deepEqual(Reflect.get(result, "needs_curation"), expectedCuration);
    const after = (await get(existing, {}, { pmRoot })).item;
    assert.equal(after.title, next[0]!.title);
    assert.deepEqual(Reflect.get(after, "deferred_fields"), beforeDeferred);

    const { item } = await get(await itemId(pmRoot, 2), {}, { pmRoot });
    for (const field of deferrableFields) assert.equal(item[field], undefined, field);
    assert.deepEqual(Reflect.get(item, "deferred_fields"), deferrableFields.map(field => ({
      field, reason: "Imported from GitHub issue #2. Required fields can be filled after triage.",
    })));
    const validation = await validate({}, { pmRoot, noExtensions: true });
    assert.match(JSON.stringify(validation.checks), /"deferred_fields":\{"items":2/);
  }));
}

test("default atomic import keeps a byte-identical repeat without curation output", async t => tracker("default", async pmRoot => {
  const log = t.mock.method(console, "error", () => {});
  const preview = await run(pmRoot, [issue(1)], true, true);
  const result = await run(pmRoot, [issue(1)], true);
  assert.equal(Reflect.get(preview, "needs_curation"), undefined);
  assert.equal(Reflect.get(result, "needs_curation"), undefined);
  assert.doesNotMatch(log.mock.calls.map(call => call.arguments.join(" ")).join("\n"), /pm github import preflight:/);
  const id = await itemId(pmRoot, 1);
  const receipts = [getItemPath(pmRoot, "Issue", id), getHistoryPath(pmRoot, id)];
  const before = receipts.map(path => readFileSync(path, "utf8"));
  assert.doesNotMatch(before[0]!, /deferred_fields/);
  assert.doesNotMatch(before[1]!, /Required fields can be filled after triage/);
  const repeat = await run(pmRoot, [issue(1)], true);
  assert.ok("unchanged" in repeat && repeat.unchanged);
  assert.deepEqual(receipts.map(path => readFileSync(path, "utf8")), before);
}));

test("progressive-only SDK writes the reason in an item note", async () => tracker("strict", async pmRoot => {
  const result = await run(pmRoot, [issue(1)], true);
  assert.ok("imported" in result && result.imported === 1);
  const id = await itemId(pmRoot, 1);
  const { item } = await get(id, {}, { pmRoot });
  for (const field of deferrableFields) assert.equal(item[field], undefined, field);
  const document = readFileSync(getItemPath(pmRoot, "Issue", id), "utf8");
  assert.match(document, /Required fields can be filled after triage/);
  assert.doesNotMatch(document, /deferred_fields/);
}));

test("another create failure compensates an already admitted strict create", async () => tracker("strict", async pmRoot => {
  const entries: PreparedGithubImport[] = [1, 2].map(number => ({
    issueNumber: number, title: number === 1 ? "Valid strict import" : "", itemType: "Issue", status: "open",
    description: `GH issue #${number}: ${issue(number).html_url}`, body: "", tags: [`gh:${repo}#${number}`],
    comments: [], syncAnnotations: false,
  }));
  const transitions: string[] = [];
  await assert.rejects(importGithubAtomic(pmRoot, repo, entries, {
    onTransition: ({ transition }) => { transitions.push(transition); },
  }), /no new partial committed state is expected.*Title cannot be empty/);
  assert.ok(transitions.includes("step_compensated"));
  await assert.rejects(get(await itemId(pmRoot, 1), {}, { pmRoot }), /was deleted/);
  await assert.rejects(get(await itemId(pmRoot, 2), {}, { pmRoot }), /not found/i);
}));

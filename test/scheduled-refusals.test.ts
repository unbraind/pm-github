/** Scheduled failures use real API transports and SDK trackers, including plain directories. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { create, update, commitItemMutations, WorkspaceTransactionInterruptedError, PmCliError } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { fetchJSON, githubApiBase, parseNextLink, parseImportOptions, runImport, importEntryUnchanged, type PreparedGithubImport } from "../index.ts";
import { buildImportFidelity, importFidelityFields, normalizeImportValue } from "../import-fidelity.ts";
import { runCloseout, closeoutFailureReason, checkCloseoutHead } from "../closeout.ts";
import { decodeWorkflowDiagnostic, readWorkflowFailure, workflowFailure } from "../workflow-diagnostic.ts";
import { withMockGithub, jsonResponse, nextLinkHeader } from "./helpers/mock-github-server.ts";

const cli = join(import.meta.dirname, "../node_modules/.bin/pm");

/** A real tracker without git exercises the package's portable read and import paths. */
async function tracker(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "scheduled-refusals-"));
  try {
    const result = spawnSync(cli, ["--path", root, "init", "fixture"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Compare durable item and append-only history bytes, excluding journals and locks. */
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true }).map(String).filter(file => file.endsWith(".toon") || /^history\/.*\.jsonl$/.test(file))
    .sort().map(file => [file, readFileSync(join(root, file), "utf8")]));
}

for (const failure of ["none", "foreign-id", "foreign-name", "unsafe-id", "wrong-endpoint", "named-foreign", "base-prefix", "foreign-origin", "cycle", "identity-denied", "network"] as const) {
  test(`scheduled numeric pagination ${failure} verifies identity before following the alias`, async () => tracker(async root => {
    const item = await create({ type: "Task", title: "Delivery", author: "fixture" }, { pmRoot: root });
    const before = snapshot(root);
    await withMockGithub((request, response, _body, base) => {
      const url = new URL(request.url!, base);
      if (url.pathname === "/repos/fixture/project") {
        if (failure === "identity-denied") { jsonResponse(response, 403, {}); return; }
        jsonResponse(response, 200, { id: failure === "foreign-id" ? 8 : failure === "unsafe-id" ? "7" : 7, full_name: failure === "foreign-name" ? "fixture/other" : "fixture/project" });
      } else if (url.pathname.endsWith("/repos/fixture/project/pulls")) {
        const next = failure === "wrong-endpoint" ? "/repositories/7/issues?page=2" : failure === "named-foreign" ? "/repos/fixture/other/pulls?page=2" : failure === "cycle" ? request.url! : "/repositories/7/pulls?page=2";
        jsonResponse(response, 200, [], { Link: failure === "foreign-origin" ? '<https://example.invalid/repositories/7/pulls?page=2>; rel="next"' : nextLinkHeader(base, next) });
      } else if (url.pathname === "/repositories/7/pulls") {
        // Two numeric pages verify that the identity lookup is cached per listing.
        jsonResponse(response, 200, [], url.searchParams.get("page") === "2" ? { Link: nextLinkHeader(base, "/repositories/7/pulls?page=3") } : {});
      } else jsonResponse(response, 500, {});
    }, async server => {
      const options = { since: "1970-01-01" };
      const api = { base: githubApiBase() + (failure === "base-prefix" ? "/api" : ""), next: parseNextLink, get: (url: string) => failure === "network" ? Promise.reject("private transport prose") : fetchJSON(url, "fixture") };
      if (failure === "none") {
        assert.equal((await runCloseout(root, "fixture/project", options, api)).closed, 0);
        assert.equal(server.requests.filter(r => r.url === "/repos/fixture/project").length, 1);
        assert.equal(server.requests.filter(r => r.url.startsWith("/repositories/")).length, 2);
      } else {
        await assert.rejects(runCloseout(root, "fixture/project", options, api), failure === "identity-denied" ? /GET \/repos\/fixture\/project.*HTTP 403/ : failure === "network" ? /GET .*failed/ : /Unverifiable GitHub pagination/);
        assert.equal(server.requests.filter(r => r.url.startsWith("/repositories/")).length, 0);
      }
      assert.equal(snapshot(root), before);
      assert.ok(item.item.id);
    });
  }));
}

test("malformed PR JSON remains private and holds linked active items", async () => tracker(async root => {
  await create({ type: "Task", title: "Active delivery", author: "fixture" }, { pmRoot: root });
  await withMockGithub((_request, response) => { response.writeHead(200); response.end("{private invalid JSON"); }, async () => {
    const report = await runCloseout(root, "fixture/project", { pr: "42" }, { base: githubApiBase(), get: url => fetchJSON(url, "fixture"), next: parseNextLink });
    assert.equal(report.closed, 0);
    assert.equal(report.plan[0]!.action, "needs_review");
    assert.ok(!JSON.stringify(report).includes("private invalid JSON"));
  });
}));

test("malformed policy objects and non-Error pagination failures never expose parser prose", async () => {
  for (const classic of [null, { contexts: [], checks: [] }]) await withMockGithub((request, response) => {
    jsonResponse(response, 200, request.url!.includes("/protection/") ? classic : []);
  }, async () => {
    const result = await checkCloseoutHead({ base: githubApiBase(), get: url => fetchJSON(url, "fixture"), next: () => { throw "private parser prose"; } }, "fixture/project",
      { number: 42, body: null, merged: true, merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: "https://github.com/fixture/project/pull/42",
        head: { sha: "a".repeat(40) }, base: { ref: "main", repo: { full_name: "fixture/project" } } });
    assert.equal(result.code, "head_evidence_unavailable");
    assert.ok(!result.reason.includes("private parser prose"));
  });
});

test("scheduled repeat import preserves item and history bytes after identical GitHub input", async () => tracker(async root => {
  const local = await create({ type: "Issue", title: "Native linked issue", author: "fixture", tags: "gh:fixture/project#2" }, { pmRoot: root });
  const issue = { number: 1, title: "Imported issue", body: "\n\nPublic content \n", state: "closed", state_reason: "completed", labels: [], assignee: null, milestone: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", closed_at: "2026-10-02T00:00:00Z", html_url: "https://github.com/fixture/project/issues/1" };
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url === "/graphql"
    ? { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }
    : request.url!.includes("/issues?") ? [issue, { ...issue, number: 2, html_url: "https://github.com/fixture/project/issues/2" }] : []), async () => {
    const opts = parseImportOptions({ atomic: true, withComments: true });
    await runImport("fixture/project", root, opts);
    const before = snapshot(root);
    const repeated = await runImport("fixture/project", root, opts);
    assert.ok(snapshot(root) === before, "An identical mixed create/update import must preserve item and history bytes.");
    assert.equal("unchanged" in repeated && repeated.unchanged, true);
    await update(local.item.id, { body: "Local drift" }, { pmRoot: root });
    const repaired = await runImport("fixture/project", root, opts);
    assert.ok(!("unchanged" in repaired));
    const pending = { pmRoot: root, transactionId: "github-import-pending-fixture", author: "fixture",
      mutations: [{ op: "update" as const, id: local.item.id, options: { description: "Public pending change" } }] };
    await assert.rejects(commitItemMutations({ ...pending, onTransition: context => {
      if (context.transition === "committing") throw new WorkspaceTransactionInterruptedError("Fixture interruption");
    } }), WorkspaceTransactionInterruptedError);
    // Keep the source projection matched while leaving a real journal unfinished.
    await runImport("fixture/project", root, opts);
    const held = await runImport("fixture/project", root, opts);
    assert.ok(!("unchanged" in held), "An unfinished journal cannot hide behind a no-op receipt.");
    await commitItemMutations(pending);
  });
}));

test("unchanged import comparison includes content, type and optional assignment fields", () => {
  const source = { number: 1, title: "Source", body: "Body", state: "open" as const, labels: [], assignee: null, milestone: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", html_url: "https://github.com/fixture/project/issues/1" };
  const fidelity = buildImportFidelity(source, [], []);
  const entry: PreparedGithubImport = { issueNumber: 1, title: source.title, itemType: "Issue", status: "open", description: "Description", body: source.body,
    tags: ["gh:fixture/project#1"], comments: [], syncAnnotations: false, fidelity };
  entry.match = { ...importFidelityFields(fidelity, false), id: "fixture-1", title: source.title, type: "Issue", status: "open", body: source.body,
    description: entry.description, tags: entry.tags };
  assert.equal(importEntryUnchanged(entry), true);
  assert.equal(importEntryUnchanged({ ...entry, match: undefined }), false);
  assert.equal(importEntryUnchanged({ ...entry, match: { ...entry.match, id: undefined } }), false);
  assert.equal(importEntryUnchanged({ ...entry, fidelity: undefined }), false);
  for (const field of ["title", "type", "body", "description", "tags"]) assert.equal(importEntryUnchanged({ ...entry, match: { ...entry.match, [field]: "changed" } }), false);
  assert.equal(importEntryUnchanged({ ...entry, match: { ...entry.match, body: undefined } }), false);
  assert.equal(importEntryUnchanged({ ...entry, assignee: "fixture", milestone: "Milestone" }), false);
  assert.equal(importEntryUnchanged({ ...entry, assignee: "fixture", milestone: "Milestone", match: { ...entry.match, assignee: "fixture", sprint: "Milestone" } }), true);
  assert.equal(importEntryUnchanged({ ...entry, body: "\n\nBody \n", assignee: " fixture ", milestone: " none ", match: { ...entry.match, assignee: "fixture" } }), true);
  assert.equal(importEntryUnchanged({ ...entry, body: " Body" }), false, "Leading content indentation must remain significant.");
  assert.equal(importEntryUnchanged({ ...entry, assignee: "none", milestone: "Milestone", match: { ...entry.match, sprint: " Milestone " } }), true);
  assert.deepEqual(normalizeImportValue("tags", [" X ", "x", ""]), ["x"]);
  assert.deepEqual(normalizeImportValue("tags", undefined), []);
  assert.equal(normalizeImportValue("status", "in-progress"), "in_progress");
  assert.equal(normalizeImportValue("status", "custom-status"), "custom-status");
  assert.equal(normalizeImportValue("body", undefined), undefined);
  assert.equal(normalizeImportValue("assignee", undefined), "");
  assert.equal(importEntryUnchanged({ ...entry, linkOnly: true, match: { ...entry.match, ...importFidelityFields(fidelity, true), body: "Preserved owner content" } }), true);
});

test("workflow diagnostics decode progress, host errors and bounded nested receipts", () => {
  for (const value of ["", "noise", "null", "[]", "3", '"text"', '{"detail":"untrusted reason"}', '{"detail":"{}"}']) assert.ok(decodeWorkflowDiagnostic(value));
  assert.deepEqual(decodeWorkflowDiagnostic('progress\n{"detail":"{\\"reason\\":\\"safe\\"}"}'), { reason: "safe" });
  assert.deepEqual(decodeWorkflowDiagnostic('{"detail":"ignored"}', 2), { detail: "ignored" });
  assert.deepEqual(decodeWorkflowDiagnostic(' {"plan":[]}'), { plan: [] });
  assert.deepEqual(decodeWorkflowDiagnostic(' {"detail":3}'), { detail: 3 });
});

test("one workflow diagnostic identifies privacy, close validation, API denial and repeat drift", () => {
  assert.match(workflowFailure({ findings: [{ item_id: "fixture-1", field: "body", rule: "absolute-host-path" }] }), /item fixture-1, field body, rule absolute-host-path/);
  assert.match(workflowFailure({ plan: [null, { action: "close", missing_evidence: [null, { code: "head_checks_failed" }] }, { item: "fixture-1", pr: 42, missing_evidence: [{ code: "close_failed", reason: "Supply required fields: reviewer." }] }] }), /item fixture-1, PR #42: Supply required fields: reviewer/);
  assert.match(workflowFailure({ plan: [{ item: "fixture-1", pr: 42, action: "skip", code: "required_checks_unverified", reason: "Declare required-checks." }] }), /Declare required-checks/);
  assert.match(workflowFailure({ reason: "GitHub GET /repos/fixture/project/pulls failed: HTTP 403" }), /GET .*pulls.*HTTP 403/);
  assert.match(workflowFailure({ plan: [{ action: "skip", code: "already_terminal" }] }), /no usable failure receipt/);
  assert.match(workflowFailure({ findings: [], plan: [] }), /no usable failure receipt/);
  assert.match(workflowFailure({}, 'diff --git a/.agents/pm/issues/fixture-1.toon b/.agents/pm/issues/fixture-1.toon\n-updated_at: old\n+updated_at: new'), /fixture-1 field updated_at/);
  assert.match(workflowFailure({}, "unparseable diff"), /tracker state/);
  assert.match(closeoutFailureReason(new PmCliError("Private policy prose", 1, { code: "workflow_policy_refused", policy_violations: [{ policy_id: "fixture", rule: "require_fields", missing_fields: ["reviewer", "invalid field", "reviewer"] }] })), /Supply required fields: reviewer/);
  assert.match(closeoutFailureReason(new PmCliError("Private validation prose", 1, { code: "close_validation_missing_fields", field: "resolution", recovery: { missing_required_fields: ["actual_result"] } })), /Supply required fields: actual_result, resolution/);
});

test("public workflow diagnostic command reads private files and tolerates missing receipts", async () => tracker(async root => {
  const report = join(root, "report.json");
  const error = join(root, "error.json");
  const diff = join(root, "repeat.patch");
  writeFileSync(report, '{"reason":"stdout failure"}');
  writeFileSync(error, 'progress\n{"detail":"stderr failure"}');
  writeFileSync(diff, "");
  assert.match(readWorkflowFailure(report, undefined, undefined).reason, /stdout failure/);
  assert.match(readWorkflowFailure(report, error, diff).reason, /stderr failure/);
  assert.match(readWorkflowFailure(undefined, undefined, undefined).reason, /no usable failure receipt/);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const result = await harness.runCommand({ command: "github workflow-diagnostic", pmRoot: root, options: { report, errorFile: error, diff } });
  assert.match(JSON.stringify(result), /stderr failure/);
  writeFileSync(report, JSON.stringify({ command: "github closeout", failed: 1, plan: [{ item: "fixture-1", pr: 42,
    missing_evidence: [{ code: "close_failed", reason: "Supply required fields: reviewer." }] }] }));
  assert.match(readWorkflowFailure(report, error, diff).reason, /item fixture-1, PR #42: Supply required fields: reviewer/);
  for (const failed of [0, "1"]) {
    writeFileSync(report, JSON.stringify({ command: "github closeout", failed }));
    assert.match(readWorkflowFailure(report, error, diff).reason, /stderr failure/);
  }
}));

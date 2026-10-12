// Tests for `pm github blockers` — revalidating blocked items against the
// live state of their GitHub blockers.
//
// Layers, mirroring the repo's established seams:
//   pure units — the reference parser (every documented form, foreign-locator
//     masking), hint resolution, candidate selection, the complete-read decoder
//     for the blocker fields, the GraphQL plan/batching, the verdict function,
//     the comment marker/idempotency helpers, and the report renderer;
//   transport units — `fetchBlockerReferenceStates` over injectable transports,
//     covering not-found repos, unexpected states, and per-batch failures;
//   end-to-end — the REAL command handler through the extension harness against
//     REAL throwaway pm trackers (no pm SDK mocks), with the REAL HTTP stack
//     pointed by `PM_GITHUB_API_BASE` at a local server that replays RECORDED
//     real GitHub GraphQL responses (see test/fixtures/blockers/*.json —
//     unbraind/pm-cli#854 is the closed issue that motivated the feature,
//     #1246 is open, PR #34 is merged, #999999 does not exist, and the
//     repository-not-found / data-null bodies are real error responses).
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comments as readComments } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, * as github from "../index.ts";
import type { MockGithubHandler } from "./helpers/mock-github-server.ts";
import { captureStderr, jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";
import { withReadOnlyDirectory } from "./helpers/read-only-directory.ts";

const harness = createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });

const PM_BIN = fileURLToPath(new URL(`../node_modules/.bin/pm${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/blockers", import.meta.url));
const runsAsRoot = process.platform !== "win32" && process.getuid?.() === 0;
const nonRootOnly = { skip: runsAsRoot && "permission-based fixture: root ignores directory write permissions" };

/** A recorded real GitHub GraphQL response body, verbatim. */
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

/** A complete `pm list --all --json` envelope, with caller overrides. */
function completeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [
      {
        id: "fixture-1",
        title: "Fixture",
        status: "open",
        body: "Body",
        description: "Description",
        tags: [],
        blocked_reason: "blocked on unbraind/pm-cli#854",
        dependencies: [{ id: "github:unbraind/pm-cli#854", kind: "blocked_by" }],
        comments: [{ text: "still waiting on GH-99" }],
      },
    ],
    count: 1,
    total: 1,
    has_more: false,
    truncated: false,
    next_cursor: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    projection: { mode: "full", fields: null },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
    ...overrides,
  };
}

/** A resolved reference for transport-level tests. */
function resolvedRef(repo: string, number: number, key = `${repo}#${number}`): github.ResolvedBlockerReference {
  return { key, repo, number, form: "repo_hash", raw: `${repo}#${number}` };
}

/** A live-state reference for verdict/comment/renderer tests. */
function refState(overrides: Partial<github.BlockerReferenceState> = {}): github.BlockerReferenceState {
  return { repo: "unbraind/pm-cli", number: 854, form: "repo_hash", raw: "unbraind/pm-cli#854", state: "closed", ...overrides };
}

// Real-tracker plumbing -------------------------------------------------------

/** Create a real throwaway pm tracker and return its pm data dir. */
function tracker(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-blockers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(PM_BIN, ["--path", root, "init", "fixture"], {
    encoding: "utf-8",
    cwd: root,
    env: { ...process.env, PM_AUTHOR: "pm-github-blockers-test" },
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

/** Run the real pm CLI inside a tracker, failing the test on a nonzero exit. */
function pm(root: string, args: string[]): string {
  const result = spawnSync(PM_BIN, ["--pm-path", root, ...args], {
    encoding: "utf-8",
    cwd: root,
    env: { ...process.env, PM_AUTHOR: "pm-github-blockers-test" },
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** Create a real item and return its id (parsed from real `pm create --json`). */
function createItem(root: string, title: string, args: string[] = []): string {
  const stdout = pm(root, ["create", "task", title, ...args, "--json"]);
  const id = github.parseCreatedItemId(stdout);
  assert.ok(id, "the real CLI must emit a parseable id");
  return id;
}

/** Run `pm github blockers` through the real extension handler. */
async function runBlockers(root: string, options: Record<string, unknown> = {}, json = false): Promise<github.BlockersReport & { exit_code?: number }> {
  const outcome = await (await harness).runCommand({ command: "github blockers", options, pmRoot: root, global: { json } });
  assert.equal(outcome.handled, true, outcome.errorMessage ?? "handler must succeed");
  return outcome.result as github.BlockersReport & { exit_code?: number };
}

/** Assert a runCommand rejection carries a specific exit code. */
async function assertRejectsWithExitCode(promise: Promise<unknown>, exitCode: number, message: RegExp): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof Error && message.test(err.message) && (err as { exitCode?: number }).exitCode === exitCode,
  );
}

/** Serve recorded GraphQL fixtures by matching a marker inside the query text. */
function graphqlFixtureHandler(bodies: ReadonlyArray<[marker: string, response: string]>): MockGithubHandler {
  return (req, res, body) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/graphql");
    const parsed = JSON.parse(body) as { query?: string };
    const query = parsed.query ?? "";
    for (const [marker, response] of bodies) {
      if (query.includes(marker)) {
        jsonResponse(res, 200, response);
        return;
      }
    }
    // A fixture miss must fail loudly, not silently serve the wrong state.
    jsonResponse(res, 200, JSON.stringify({ data: null, errors: [{ message: `fixture miss for query: ${query.slice(0, 120)}` }] }));
  };
}

// Parser ----------------------------------------------------------------------

test("parseBlockerReferences recognizes every reference form", () => {
  const refs = github.parseBlockerReferences(
    "blocked on unbraind/pm-cli#854; also https://github.com/unbraind/pm-cli/issues/1246 " +
    "and https://github.com/unbraind/pm-cli/pull/34; see GH-42 and gh-43; bare #7; short pm-cli#99",
  );
  assert.deepEqual(
    refs.map((r) => ({ repo: r.repo, number: r.number, form: r.form, raw: r.raw })),
    [
      { repo: "unbraind/pm-cli", number: 1246, form: "url", raw: "https://github.com/unbraind/pm-cli/issues/1246" },
      { repo: "unbraind/pm-cli", number: 34, form: "url", raw: "https://github.com/unbraind/pm-cli/pull/34" },
      { repo: "unbraind/pm-cli", number: 854, form: "repo_hash", raw: "unbraind/pm-cli#854" },
      { number: 42, form: "gh_dash", raw: "GH-42" },
      { number: 43, form: "gh_dash", raw: "GH-43" },
      { number: 99, form: "short_repo_hash", raw: "pm-cli#99" },
      { number: 7, form: "bare_hash", raw: "#7" },
    ].map((r) => ({ repo: undefined, ...r })),
  );
});

test("parseBlockerReferences masks foreign locators and unwraps the github: scheme", () => {
  const refs = github.parseBlockerReferences(
    "gitlab:gitlab-org/gitlab#1 jira:PROJ-9 linear:ENG-3 stay out; github:unbraind/pm-cli#12 unwraps",
  );
  assert.deepEqual(refs.map((r) => r.raw), ["unbraind/pm-cli#12"]);
  assert.equal(refs[0]?.repo, "unbraind/pm-cli");
});

test("parseBlockerReferences rejects lookalikes", () => {
  assert.deepEqual(
    github.parseBlockerReferences("issue/854 #854abc ###12 https://example.com/x#4 GH-12345678901"),
    [],
  );
  // A markdown heading with a number is not a reference, and a long digit run
  // cannot partially match.
  assert.deepEqual(github.parseBlockerReferences("### 854\nsee #12345678901"), []);
});

test("resolveBlockerReferences respects item provenance before fallback and deduplicates", () => {
  const parsed = github.parseBlockerReferences("#7 pm-cli#99 other#5 GH-12 unbraind/pm-cli#854 #854");
  const resolved = github.resolveBlockerReferences(parsed, "unbraind/pm-github", "unbraind/pm-cli");
  assert.deepEqual(resolved.filter(r => r.repo === "unbraind/pm-github").map(r => r.number), [12, 7, 854]);
  assert.ok(resolved.some(r => r.key === "unbraind/pm-cli#99"));
  assert.ok(resolved.some(r => r.repo === undefined));
  assert.equal(github.resolveBlockerReferences(github.parseBlockerReferences("#854 GH-854 unbraind/pm-cli#854"), "unbraind/pm-cli", undefined).length, 1);
});

test("resolveBlockerReferences leaves hint-dependent forms unresolved without a hint", () => {
  const parsed = github.parseBlockerReferences("#7 GH-12");
  const resolved = github.resolveBlockerReferences(parsed, undefined, undefined);
  assert.deepEqual(resolved.map((r) => [r.key, r.repo, r.form]), [
    ["unresolved:#12", undefined, "gh_dash"],
    ["unresolved:#7", undefined, "bare_hash"],
  ]);
  // An item repo hint alone is enough when --repo is absent.
  assert.deepEqual(
    github.resolveBlockerReferences(parsed, "unbraind/pm-cli", undefined).map((r) => r.repo),
    ["unbraind/pm-cli", "unbraind/pm-cli"],
  );
});

// Candidate selection ----------------------------------------------------------

test("selectBlockerCandidates keeps blocked items and external blocked_by dependencies, nothing else", () => {
  const item = (overrides: Partial<github.BlockerPmItem>): github.BlockerPmItem => ({
    id: "fixture-x",
    title: "t",
    status: "open",
    description: "d",
    dependencies: [],
    comments: [],
    ...overrides,
  });
  const items = [
    item({ id: "blocked", status: "blocked" }),
    item({ id: "open-external-dep", dependencies: [{ id: "github:unbraind/pm-cli#854", kind: "blocked_by" }] }),
    item({ id: "open-external-field", blockedBy: "https://github.com/unbraind/pm-cli/issues/854" }),
    item({ id: "closed-external", status: "closed", dependencies: [{ id: "github:unbraind/pm-cli#854", kind: "blocked_by" }] }),
    item({ id: "local-dep-only", dependencies: [{ id: "fixture-blocker", kind: "blocked_by" }] }),
    item({ id: "related-dep", dependencies: [{ id: "github:unbraind/pm-cli#854", kind: "related" }] }),
    item({ id: "plain-open" }),
  ];
  assert.deepEqual(
    github.selectBlockerCandidates(items).map((i) => i.id),
    ["blocked", "open-external-dep", "open-external-field"],
  );
});

// Complete-read decoder --------------------------------------------------------

test("decodeBlockerPmItems validates and carries the blocker fields", () => {
  const items = github.decodeBlockerPmItems(completeEnvelope());
  assert.equal(items.length, 1);
  assert.equal(items[0]?.blockedReason, "blocked on unbraind/pm-cli#854");
  assert.equal(items[0]?.blockedBy, undefined);
  assert.deepEqual(items[0]?.dependencies, [{ id: "github:unbraind/pm-cli#854", kind: "blocked_by" }]);
  assert.deepEqual(items[0]?.comments, [{ text: "still waiting on GH-99" }]);
  // Absent optional fields decode to empty, not errors.
  const bare = github.decodeBlockerPmItems(completeEnvelope({ items: [{ id: "fixture-2", title: "T", status: "blocked", body: "B", description: "D", tags: [] }] }));
  assert.deepEqual(bare[0]?.dependencies, []);
  assert.deepEqual(bare[0]?.comments, []);
  assert.equal(bare[0]?.blockedReason, undefined);
});

test("decodeBlockerPmItems fails closed on wrong-typed blocker fields", () => {
  const cases: ReadonlyArray<[field: string, value: unknown, message: RegExp]> = [
    ["blocked_reason", 7, /blocked_reason must be a string/],
    ["blocked_by", {}, /blocked_by must be a string/],
    ["dependencies", "nope", /dependencies must be an array/],
    ["comments", 3, /comments must be an array/],
  ];
  for (const [field, value, message] of cases) {
    assert.throws(
      () => github.decodeBlockerPmItems(completeEnvelope({ items: [{ id: "fixture-1", title: "T", status: "open", body: "B", description: "D", tags: [], [field]: value }] })),
      (err: unknown) => err instanceof github.CommandError && message.test(err.message),
    );
  }
  assert.throws(
    () => github.decodeBlockerPmItems(completeEnvelope({ items: [{ id: "fixture-1", title: "T", status: "open", body: "B", description: "D", tags: [], dependencies: [{ id: "x" }] }] })),
    /dependency rows must carry string id and kind/,
  );
  assert.throws(
    () => github.decodeBlockerPmItems(completeEnvelope({ items: [{ id: "fixture-1", title: "T", status: "open", body: "B", description: "D", tags: [], comments: [{ author: "x" }] }] })),
    /comment rows must carry string text/,
  );
});

test("readBlockerPmItems reads the complete real corpus including blocker fields", async (t) => {
  const root = tracker(t);
  const id = createItem(root, "Blocked on the guard", ["--blocked-reason", "Externally blocked on unbraind/pm-cli#854"]);
  pm(root, ["update", id, "--status", "blocked"]);
  pm(root, ["comment", id, "a comment naming GH-99"]);
  const items = await github.readBlockerPmItems(root);
  const blocked = items.find((item) => item.id === id);
  assert.ok(blocked);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blockedReason ?? "", /unbraind\/pm-cli#854/);
  assert.deepEqual(blocked.comments.map((c) => c.text), ["a comment naming GH-99"]);
  assert.ok(blocked.dependencies.length === 0);
});

// GraphQL plan, batching, and transport ----------------------------------------

test("buildBlockerStatesQueryPlan dedupes and sorts repos and numbers, exposing read-back aliases", () => {
  const plan = github.buildBlockerStatesQueryPlan([
    resolvedRef("unbraind/pm-cli", 999),
    resolvedRef("unbraind/pm-cli", 12),
    resolvedRef("acme/widgets", 3),
  ]);
  assert.deepEqual(plan.repos, ["acme/widgets", "unbraind/pm-cli"]);
  assert.match(plan.query, /r0: repository\(owner: "acme", name: "widgets"\)/);
  assert.match(plan.query, /r1: repository\(owner: "unbraind", name: "pm-cli"\)/);
  assert.match(plan.query, /i1_0: issue\(number: 12\)/);
  assert.match(plan.query, /i1_1: issue\(number: 999\)/);
  assert.deepEqual(
    plan.entries.map((entry) => [entry.ref.key, entry.repoAlias, entry.issueAlias, entry.pullAlias]),
    [
      ["acme/widgets#3", "r0", "i0_0", "p0_0"],
      ["unbraind/pm-cli#12", "r1", "i1_0", "p1_0"],
      ["unbraind/pm-cli#999", "r1", "i1_1", "p1_1"],
    ],
  );
});

test("chunkBlockerReferences splits consecutive fixed-size batches", () => {
  const refs = [1, 2, 3, 4, 5].map((n) => resolvedRef("unbraind/pm-cli", n));
  assert.deepEqual(github.chunkBlockerReferences(refs, 2).map((b) => b.map((r) => r.number)), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(github.chunkBlockerReferences([], 3), []);
  assert.equal(github.BLOCKER_STATES_BATCH_SIZE, 25);
});

test("fetchBlockerReferenceStates maps aliased nodes to live states", async () => {
  const transport = async () => ({ data: {
    r0: { i0_0: { state: "OPEN" }, p0_0: null },
    r1: { i1_0: { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-08-01T15:24:48Z", url: "u/i" }, p1_0: null },
    r2: { i2_0: null, p2_0: { state: "MERGED", mergedAt: "2026-05-20T21:09:52Z", closedAt: "2026-05-20T21:09:52Z", url: "u/p" } },
    r3: { i3_0: null, p3_0: { state: "CLOSED", closedAt: "2026-01-01T00:00:00Z", url: "u/c" } },
    r4: null,
    r5: { i5_0: null, p5_0: null },
    r6: { i6_0: { state: "DRAFT" }, p6_0: null },
    r7: { i7_0: null, p7_0: { state: "UNKNOWN" } },
  } });
  const refs = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => resolvedRef(`acme/repo${n}`, 1, `acme/repo${n}#1`));
  const plan = github.buildBlockerStatesQueryPlan(refs);
  const states = await github.fetchBlockerReferenceStates(refs, transport);
  assert.deepEqual([...states.values()].map((s) => s.state), [
    "open", "closed", "merged", "closed", "not_found", "not_found", "error", "error",
  ]);
  const closed = [...states.values()].find((s) => s.state === "closed" && s.closed_at === "2026-08-01T15:24:48Z");
  assert.equal(closed?.state_reason, "COMPLETED");
  assert.equal(plan.entries.length, 8);
});

test("fetchBlockerReferenceStates batches at BLOCKER_STATES_BATCH_SIZE and marks failed batches error", async () => {
  const refs = Array.from({ length: 26 }, (_, i) => resolvedRef("unbraind/pm-cli", i + 1));
  let calls = 0;
  const states = await github.fetchBlockerReferenceStates(refs, async () => {
    calls++;
    if (calls === 1) return { data: { r0: { i0_0: { state: "OPEN" }, p0_0: null } } };
    throw new github.CommandError("GraphQL error: bad token.", 2);
  });
  assert.equal(calls, 2);
  const values = [...states.values()];
  assert.equal(values[0]?.state, "open");
  assert.ok(values.slice(1).every((s) => s.state === "error" && /response|request failed/.test(s.error ?? "")));
});

// Verdict ----------------------------------------------------------------------

test("blockerItemVerdict covers all four outcomes", () => {
  const open = refState({ state: "open" });
  const closed = refState({ state: "closed" });
  const merged = refState({ state: "merged" });
  const notFound = refState({ state: "not_found" });
  const error = refState({ state: "error", error: "boom" });
  const unresolved = refState({ state: "unresolved" });
  assert.equal(github.blockerItemVerdict([]), "unresolvable");
  assert.equal(github.blockerItemVerdict([closed, merged]), "cleared");
  assert.equal(github.blockerItemVerdict([closed, open]), "partially_cleared");
  assert.equal(github.blockerItemVerdict([merged, notFound]), "partially_cleared");
  assert.equal(github.blockerItemVerdict([open, unresolved]), "still_blocked");
  assert.equal(github.blockerItemVerdict([notFound, error, unresolved]), "unresolvable");
});

// Comment helpers ----------------------------------------------------------------

test("blocker comments are built with a state-identity marker and detected idempotently", () => {
  const closed = refState({ closed_at: "2026-08-01T15:24:48Z" });
  const text = github.buildBlockerClearedComment(closed);
  assert.equal(
    text,
    "Blocker unbraind/pm-cli#854 closed on 2026-08-01; revalidate.\n\n" +
      "<!-- pm-github:blockers:unbraind/pm-cli#854:closed:2026-08-01T15:24:48Z -->",
  );
  const merged = refState({ state: "merged", merged_at: "2026-05-20T21:09:52Z" });
  assert.match(github.buildBlockerClearedComment(merged), /^Blocker unbraind\/pm-cli#854 merged on 2026-05-20; revalidate\./);
  assert.match(github.buildBlockerClearedComment(merged), /<!-- pm-github:blockers:unbraind\/pm-cli#854:merged:2026-05-20T21:09:52Z -->/);
  // A closed blocker GitHub sent no timestamp for still produces a comment
  // (with an honest unknown date) and a stable marker.
  const noDate = refState({ state: "merged" });
  assert.match(github.buildBlockerClearedComment(noDate), /merged on an unknown date/);
  assert.match(github.buildBlockerClearedComment(noDate), /:merged:unknown -->/);
  const markers = github.extractBlockerCommentMarkers([{ text }, { text: "hand-written" }, { text: undefined }]);
  assert.deepEqual([...markers], [github.blockerCommentMarker("unbraind/pm-cli", 854, "closed", "2026-08-01T15:24:48Z")]);
  // A different observed state (reopened and closed again later) is a NEW marker.
  const reopened = github.buildBlockerClearedComment(refState({ closed_at: "2026-10-01T00:00:00Z" }));
  assert.equal(github.extractBlockerCommentMarkers([{ text: reopened }]).size, 1);
  assert.ok(!github.extractBlockerCommentMarkers([{ text: reopened }]).has(github.blockerCommentMarker("unbraind/pm-cli", 854, "closed", "2026-08-01T15:24:48Z")));
});

// End-to-end: the real handler, real trackers, recorded real responses ----------

/** The full mixed scenario: one cleared (closed issue), one partially cleared
 * (closed + open), one cleared via a merged PR comment, one not-found, one
 * unresolved (no GitHub references at all), and one candidate selected only
 * through an external `blocked_by` dependency edge. */
function seedMixedScenario(root: string): Record<string, string> {
  const closed = createItem(root, "Blocked on the guard", ["--blocked-reason", "Externally blocked on unbraind/pm-cli#854"]);
  pm(root, ["update", closed, "--status", "blocked"]);
  const mixed = createItem(root, "Two blockers", [
    "--blocked-reason", "unbraind/pm-cli#854 plus an open one",
    "--description", "needs https://github.com/unbraind/pm-cli/issues/1246 before finishing",
  ]);
  pm(root, ["update", mixed, "--status", "blocked"]);
  const merged = createItem(root, "Waiting on the PR");
  pm(root, ["update", merged, "--status", "blocked"]);
  pm(root, ["comment", merged, "upstream landed https://github.com/unbraind/pm-cli/pull/34"]);
  const notFound = createItem(root, "Blocked on a ghost", ["--blocked-reason", "blocked on unbraind/pm-cli#999999"]);
  pm(root, ["update", notFound, "--status", "blocked"]);
  const local = createItem(root, "Blocked for a local reason", ["--blocked-reason", "waiting on the design review"]);
  pm(root, ["update", local, "--status", "blocked"]);
  const externalDep = createItem(root, "Externally blocked via a dependency edge");
  pm(root, ["update", externalDep, "--dep", "id=github:unbraind/pm-cli#854,kind=blocked_by", "--allow-unresolved-deps"]);
  return { "Blocked on the guard": closed, "Two blockers": mixed, "Waiting on the PR": merged,
    "Blocked on a ghost": notFound, "Blocked for a local reason": local, "Externally blocked via a dependency edge": externalDep };
}

test("pm github blockers revalidates a mixed scenario against recorded real states", async (t) => {
  const root = tracker(t);
  const seeded = seedMixedScenario(root);
  await withEnv({ GH_TOKEN: "ghp-test" }, async () => {
    await withMockGithub(graphqlFixtureHandler([
      ['owner: "unbraind", name: "pm-cli"', fixture("pm-cli-blockers-batch.json")],
    ]), async (server) => {
      const report = await runBlockers(root, {}, true);
      assert.equal(report.exit_code, 4);
      assert.equal(report.command, "github blockers");
      assert.equal(report.candidates, 6);
      assert.equal(report.counts.cleared, 3);
      assert.equal(report.counts.partially_cleared, 1);
      assert.equal(report.counts.still_blocked, 0);
      assert.equal(report.counts.unresolvable, 2);
      const byId = new Map(Object.entries(seeded).map(([title, id]) => [title, report.items.find(item => item.id === id)!]));
      const closed = byId.get("Blocked on the guard");
      assert.ok(closed);
      assert.equal(closed.verdict, "cleared");
      const reference = closed.references[0];
      assert.equal(reference?.state, "closed");
      assert.equal(reference?.state_reason, "COMPLETED");
      assert.equal(reference?.closed_at, "2026-08-01T15:24:48Z");
      assert.equal(reference?.url, "https://github.com/unbraind/pm-cli/issues/854");
      assert.equal(byId.get("Two blockers")?.verdict, "partially_cleared");

      const merged = byId.get("Waiting on the PR");
      assert.equal(merged?.verdict, "cleared");
      assert.equal(merged?.references[0]?.state, "merged");
      assert.equal(merged?.references[0]?.merged_at, "2026-05-20T21:09:52Z");
      const ghost = byId.get("Blocked on a ghost");
      assert.equal(ghost?.verdict, "unresolvable");
      assert.equal(ghost?.references[0]?.state, "not_found");
      assert.deepEqual(byId.get("Blocked for a local reason")?.references, []);
      assert.equal(byId.get("Externally blocked via a dependency edge")?.verdict, "cleared");
      // Exactly one batched GraphQL request resolved all four distinct references.
      assert.equal(server.requests.length, 1);
      assert.match(server.requests[0]?.body ?? "", /p0_3: pullRequest\(number: 999999\)/);
    });
  });
});

test("pm github blockers exits 0 with a report when nothing is cleared", async (t) => {
  const root = tracker(t);
  const id = createItem(root, "Blocked on an open issue", ["--blocked-reason", "blocked on https://github.com/unbraind/pm-cli/issues/1246"]);
  pm(root, ["update", id, "--status", "blocked"]);
  await withEnv({ GH_TOKEN: "ghp-test" }, () =>
    withMockGithub(graphqlFixtureHandler([
      ['owner: "unbraind", name: "pm-cli"', fixture("issue-1246-open.json")],
    ]), async () => {
      const { result, stderr } = await captureStderr(() => runBlockers(root));
      const report = result as github.BlockersReport;
      assert.equal(report.counts.still_blocked, 1);
      assert.equal(report.items[0]?.verdict, "still_blocked");
      assert.equal(stderr.length, 0);
    }));
});

test("pm github blockers reports a bare #N against --repo and an unresolvable repo as not found", async (t) => {
  const root = tracker(t);
  const bare = createItem(root, "Bare reference", ["--blocked-reason", "blocked on #854"]);
  pm(root, ["update", bare, "--status", "blocked"]);
  const ghostRepo = createItem(root, "Ghost repo", ["--blocked-reason", "waiting on unbraind/unbraind-no-such-repo-xyz#7"]);
  pm(root, ["update", ghostRepo, "--status", "blocked"]);
  await withEnv({ GH_TOKEN: "ghp-test" }, () =>
    withMockGithub(graphqlFixtureHandler([
      ['owner: "unbraind", name: "pm-cli"', fixture("bare-and-ghost-repo.json")],
      ['name: "unbraind-no-such-repo-xyz"', fixture("repository-not-found.json")],
    ]), async () => {
      const { result } = await captureStderr(() => runBlockers(root, { repo: "unbraind/pm-cli" }, true));
      const report = result as github.BlockersReport;
      assert.equal(report.items.length, 2);
      assert.equal(report.items.find(item => item.id === bare)?.verdict, "cleared");
      assert.equal(report.items.find(item => item.id === ghostRepo)?.references[0]?.state, "not_found");
      assert.equal(report.items.find(item => item.id === ghostRepo)?.verdict, "unresolvable");
    }));
});

test("pm github blockers exits 1 when every reference state failed to resolve", async (t) => {
  const root = tracker(t);
  const id = createItem(root, "Blocked on the guard", ["--blocked-reason", "Externally blocked on unbraind/pm-cli#854"]);
  pm(root, ["update", id, "--status", "blocked"]);
  await withEnv({ GH_TOKEN: "ghp-test" }, () =>
    withMockGithub(graphqlFixtureHandler([]), async () => {
      assert.equal((await runBlockers(root)).exit_code, 1);
    }));
});

test("pm github blockers exits 0 with an empty report when nothing is a candidate", async (t) => {
  const root = tracker(t);
  createItem(root, "Plain open item");
  await withEnv({ GH_TOKEN: "ghp-test" }, async () => {
    const { result, stderr } = await captureStderr(() => runBlockers(root));
    const report = result as github.BlockersReport;
    assert.equal(report.candidates, 0);
    assert.deepEqual(report.items, []);
    assert.equal(stderr.length, 0);
  });
});

test("--comment appends one idempotent comment per cleared item and --dry-run writes nothing", async (t) => {
  const root = tracker(t);
  const id = createItem(root, "Blocked on the guard", ["--blocked-reason", "Externally blocked on unbraind/pm-cli#854"]);
  pm(root, ["update", id, "--status", "blocked"]);
  await withEnv({ GH_TOKEN: "ghp-test" }, () =>
    withMockGithub(graphqlFixtureHandler([
      ['owner: "unbraind", name: "pm-cli"', fixture("issue-854-closed.json")],
    ]), async () => {
      // A dry run previews the comment and writes nothing.
      const preview = await runBlockers(root, { comment: true, "dry-run": true });
      assert.equal(preview.exit_code, 4);
      assert.equal(preview.comment?.added, 1);
      const before = await readComments(id, {}, { pmRoot: root });
      assert.equal(before.comments.length, 0);
      // The real run appends exactly one comment.
      assert.equal((await runBlockers(root, { comment: true })).exit_code, 4);
      const after = await readComments(id, {}, { pmRoot: root });
      assert.equal(after.comments.length, 1);
      assert.equal(after.comments[0]?.author, "pm-github");
      assert.match(after.comments[0]?.text ?? "", /Blocker unbraind\/pm-cli#854 closed on 2026-08-01; revalidate\./);
      assert.match(after.comments[0]?.text ?? "", /<!-- pm-github:blockers:unbraind\/pm-cli#854:closed:2026-08-01T15:24:48Z -->/);
      // Re-running --comment against the same observed state appends nothing.
      const repeated = await runBlockers(root, { comment: true }, true);
      assert.equal(repeated.exit_code, 4);
      assert.equal(repeated.comment?.skipped, 1);
      const again = await readComments(id, {}, { pmRoot: root });
      assert.equal(again.comments.length, 1);
    }));
});

test("--comment survives a contended lock, a degraded lock, and reports write failures", nonRootOnly, async (t) => {
  const root = tracker(t);
  const id = createItem(root, "Blocked on the guard", ["--blocked-reason", "Externally blocked on unbraind/pm-cli#854"]);
  pm(root, ["update", id, "--status", "blocked"]);
  const cleared = [{ itemId: id, states: [refState({ closed_at: "2026-08-01T15:24:48Z" })] }];
  // A live foreign process holding the item's comment lock makes the append
  // skip (never run unlocked into a duplicate risk window).
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    assert.ok(holder.pid && holder.pid > 0);
    const lockPath = github.importCommentSyncLockPath(root, id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, token: "held", created_at: new Date().toISOString() }) + "\n");
    const contended = await captureStderr(() => github.appendBlockerComments(root, cleared, false));
    assert.deepEqual(contended.result, { added: 0, skipped: 0, failed: 1 });
    assert.match(contended.stderr.join("\n"), /comment-sync lock unavailable/);
    fs.rmSync(lockPath, { force: true });

    // A missing item cannot have its comments read: the append fails closed.
    const missing = await captureStderr(() =>
      github.appendBlockerComments(root, [{ itemId: "fixture-missing", states: cleared[0].states }], false));
    assert.deepEqual(missing.result, { added: 0, skipped: 0, failed: 1 });
    assert.match(missing.stderr.join("\n"), /could not read existing comments/);

    // A read-only item directory turns the append into a reported failure.
    const tasksDir = path.join(root, "tasks");
    await withReadOnlyDirectory(tasksDir, async () => {
      const failed = await captureStderr(() => github.appendBlockerComments(root, cleared, false));
      assert.deepEqual(failed.result, { added: 0, skipped: 0, failed: 1 });
      assert.match(failed.stderr.join("\n"), /blocker comment failed/);
    });

    // When the lock is available again, the pending annotation can be appended.
    const degraded = await captureStderr(() => github.appendBlockerComments(root, cleared, false));
    assert.deepEqual(degraded.result, { added: 1, skipped: 0, failed: 0 });
    const stored = await readComments(id, {}, { pmRoot: root });
    assert.equal(stored.comments.length, 1);
  } finally {
    holder.kill("SIGKILL");
  }
});

// Usage and failure envelopes ----------------------------------------------------

test("pm github blockers rejects malformed --repo, empty --ids, unknown --ids, and a missing token", async (t) => {
  const root = tracker(t);
  await withEnv({ GH_TOKEN: "ghp-test" }, async () => {
    assert.equal((await runBlockers(root, { repo: "unbraind/.github" })).candidates, 0);
    await assertRejectsWithExitCode(runBlockers(root, { repo: "not-a-repo" }), 2, /--repo must be owner\/repo/);
    await assertRejectsWithExitCode(runBlockers(root, { ids: "" }), 2, /--ids requires at least one pm item id/);
    await assertRejectsWithExitCode(runBlockers(root, { ids: "fixture-nope" }), 3, /unknown pm item id\(s\): fixture-nope/);
  });
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "" }, async () => {
    await assertRejectsWithExitCode(runBlockers(root), 2, /needs a token/);
  });
});
test("partial GraphQL permission errors cannot clear a reference or hide a failure", async (t) => {
  const refs = [resolvedRef("unbraind/pm-cli", 854), resolvedRef("unbraind/pm-cli", 999999)];
  const states = await github.fetchBlockerReferenceStates(refs, async () => ({
    data: { r0: { i0_0: { state: "CLOSED" }, p0_0: null, i0_1: null, p0_1: null } },
    errors: [{ type: "FORBIDDEN", path: ["r0", "i0_1"], message: "Resource not accessible by integration" }],
  }));
  assert.equal(states.get(refs[0].key)?.state, "closed");
  assert.equal(states.get(refs[1].key)?.state, "error");
  const root = tracker(t);
  const id = createItem(root, "Mixed access", ["--blocked-reason", "unbraind/pm-cli#854 unbraind/pm-cli#999999"]);
  pm(root, ["update", id, "--status", "blocked"]);
  // Real recorded closed-issue data with a constructed permission error on
  // the other alias; access denial cannot be elicited safely from a public issue.
  const response = JSON.parse(fixture("issue-854-closed.json")) as { data: Record<string, unknown>; errors: unknown[] };
  response.errors.push({ type: "FORBIDDEN", path: ["r0", "i0_1"], message: "Resource not accessible by integration" });
  await withEnv({ GH_TOKEN: "ghp-test" }, () => withMockGithub(graphqlFixtureHandler([["query", JSON.stringify(response)]]), async () => {
    const report = await runBlockers(root, { comment: true });
    assert.equal(report.exit_code, 1);
    assert.equal(report.items[0].verdict, "partially_cleared");
    assert.equal(report.comment?.added, 0);
    assert.equal((await readComments(id, {}, { pmRoot: root })).comments.length, 0);
  }));
});

test("grouped blocker annotations remain idempotent across multiple references and later closure", async (t) => {
  const root = tracker(t);
  const id = createItem(root, "Both blockers resolved");
  const states = [refState({ closed_at: "2026-08-01T15:24:48Z" }), refState({ number: 34, state: "merged", merged_at: "2026-05-20T21:09:52Z" })];
  assert.deepEqual(await github.appendBlockerComments(root, [{ itemId: id, states }], false), { added: 1, skipped: 0, failed: 0 });
  assert.equal((await readComments(id, {}, { pmRoot: root })).comments.length, 1);
  assert.deepEqual(await github.appendBlockerComments(root, [{ itemId: id, states }], false), { added: 0, skipped: 1, failed: 0 });
  const changed = [refState({ closed_at: "2026-10-12T10:00:00Z" }), states[1]];
  assert.deepEqual(await github.appendBlockerComments(root, [{ itemId: id, states: changed }], false), { added: 1, skipped: 0, failed: 0 });
  const comments = (await readComments(id, {}, { pmRoot: root })).comments;
  assert.equal(comments.length, 2);
  assert.equal(github.extractBlockerCommentMarkers(comments).size, 3);
});

test("GitHub-only candidates and provenance hints cover each text source", () => {
  const item: github.BlockerPmItem = {
    id: "fixture-hints", title: "Hints", status: "open", description: "GH-854 #854",
    tags: ["ordinary", "gh:unbraind/pm-cli#1"], blockedBy: "github:unbraind/pm-cli#854",
    dependencies: [{ id: "github:unbraind/pm-cli#854", kind: "blocked_by" }],
    comments: [{ text: "Latest comment: https://github.com/unbraind/pm-cli/issues/854" }],
  };
  assert.deepEqual(github.collectBlockerReferences(item, undefined).map(r => r.key), ["unbraind/pm-cli#854"]);
  const foreign = { ...item, blockedBy: "gitlab:group/repo#1", dependencies: [{ id: "jira:TEST-1", kind: "blocked_by" }] };
  assert.deepEqual(github.selectBlockerCandidates([foreign]), []);
  assert.deepEqual(github.selectBlockerCandidates([{ ...item, status: "canceled" }]), []);
  assert.throws(() => github.chunkBlockerReferences([], 0), /positive integer/);
});

/** Run a real CLI asynchronously so the fixture HTTP server remains responsive. */
function cli(root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", root, ...args], {
      cwd: path.resolve(import.meta.dirname, ".."), env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("actual CLI renders cleared reports through the host in JSON and TOON with code 4", async (t) => {
  const root = tracker(t);
  // Copy the built extension into a scratch tracker; discovery skips directory symlinks.
  const extensions = path.join(root, "extensions");
  fs.mkdirSync(extensions, { recursive: true });
  const installed = path.join(extensions, "pm-github");
  fs.mkdirSync(installed);
  const source = path.resolve(import.meta.dirname, "..");
  fs.cpSync(path.join(source, "dist"), path.join(installed, "dist"), { recursive: true });
  for (const name of ["manifest.json", "package.json"]) fs.copyFileSync(path.join(source, name), path.join(installed, name));
  fs.symlinkSync(path.join(source, "node_modules"), path.join(installed, "node_modules"), "dir");
  const id = createItem(root, "Closed external blocker", ["--blocked-reason", "unbraind/pm-cli#854"]);
  pm(root, ["update", id, "--status", "blocked"]);
  const before = fs.readFileSync(path.join(root, "tasks", `${id}.toon`), "utf8");
  await withEnv({ GH_TOKEN: "ghp-test" }, () => withMockGithub(graphqlFixtureHandler([["query", fixture("issue-854-closed.json")]]), async () => {
    const json = await cli(root, ["github", "blockers", "--json"]);
    assert.equal(json.code, 4, json.stderr);
    const report = JSON.parse(json.stdout) as github.BlockersReport;
    assert.equal(report.items[0].verdict, "cleared");
    assert.equal(report.items[0].references[0].closed_at, "2026-08-01T15:24:48Z");
    const toon = await cli(root, ["github", "blockers"]);
    assert.equal(toon.code, 4, toon.stderr);
    assert.match(toon.stdout, /verdict: "cleared"/);
    assert.match(toon.stdout, /command: "github blockers"/);
  }));
  assert.equal(fs.readFileSync(path.join(root, "tasks", `${id}.toon`), "utf8"), before);
});

test("sparse states, partial permission paths and missing aliases fail closed", async () => {
  const refs = Array.from({ length: 7 }, (_, i) => resolvedRef(`acme/sparse${i}`, 1));
  const states = await github.fetchBlockerReferenceStates(refs, async () => ({ data: {
    r0: { i0_0: null, p0_0: { state: "OPEN" } },
    r1: { i1_0: { state: "CLOSED" }, p1_0: null },
    r2: { i2_0: null, p2_0: { state: "MERGED" } },
    r3: { i3_0: null, p3_0: { state: "CLOSED" } },
    r4: null,
    r5: { i5_0: null },
    r6: { p6_0: null },
  } }));
  assert.deepEqual([...states.values()].map(s => s.state), ["open", "closed", "merged", "closed", "not_found", "error", "error"]);
  const one = [refs[0]];
  for (const errors of [
    [{ type: "FORBIDDEN", message: "Denied" }],
    [{ type: "FORBIDDEN", message: "Denied", path: ["r0"] }],
    [{ type: "FORBIDDEN", message: "Denied", path: ["r0", "p0_0"] }],
  ]) {
    assert.equal((await github.fetchBlockerReferenceStates(one, async () => ({ data: { r0: null }, errors }))).get(one[0].key)?.state, "error");
  }
  assert.equal((await github.fetchBlockerReferenceStates(one, async () => ({ errors: [{ type: "FORBIDDEN", message: "Denied", path: ["other"] }] }))).get(one[0].key)?.state, "error");
  assert.equal((await github.fetchBlockerReferenceStates(one, async () => ({ data: { r0: { i0_0: null, p0_0: null } }, errors: [{ type: "FORBIDDEN", message: "Denied", path: ["r0", "other"] }] }))).get(one[0].key)?.state, "not_found");
});

test("optional metadata and marker whitespace are handled without inventing references", async (t) => {
  const item = github.decodeBlockerPmItems(completeEnvelope({ items: [{ id: "fixture-a", title: "A", status: "blocked", body: "", description: "", tags: [], blocked_by: "github:unbraind/pm-cli#854" }] }))[0];
  assert.equal(item.blockedBy, "github:unbraind/pm-cli#854");
  assert.equal(github.collectBlockerReferences({ ...item, tags: undefined }, undefined).length, 1);
  const malformed = refState({ repo: undefined });
  assert.match(github.buildBlockerClearedComment(malformed), /unknown date/);
  const root = tracker(t);
  const id = createItem(root, "Unknown historical state date");
  assert.deepEqual(await github.appendBlockerComments(root, [{ itemId: id, states: [malformed] }], true), { added: 1, skipped: 0, failed: 0 });
  const existing = "<!--pm-github:blockers:UNBRAIND/pm-cli#854:closed:unknown-->";
  assert.ok(github.extractBlockerCommentMarkers([{ text: existing }]).has(github.blockerCommentMarker("unbraind/pm-cli", 854, "closed", "unknown")));
});

test("partial-only alerts and unresolved bare references return complete reports with scoped ids", async (t) => {
  const root = tracker(t);
  const mixed = createItem(root, "Only partial clearance", ["--blocked-reason", "unbraind/pm-cli#854 unbraind/pm-cli#1246"]);
  pm(root, ["update", mixed, "--status", "blocked"]);
  const bare = createItem(root, "No repository hint", ["--blocked-reason", "GH-854"]);
  pm(root, ["update", bare, "--status", "blocked"]);
  const batch = JSON.parse(fixture("pm-cli-blockers-batch.json")) as { data: { r0: Record<string, unknown> } };
  const response = { data: { r0: { i0_0: batch.data.r0.i0_1, p0_0: null, i0_1: batch.data.r0.i0_2, p0_1: null } } };
  await withEnv({ GH_TOKEN: "ghp-test" }, () => withMockGithub(graphqlFixtureHandler([["query", JSON.stringify(response)]]), async () => {
    const partial = await runBlockers(root, { ids: mixed, comment: true });
    assert.equal(partial.items_read, 1);
    assert.equal(partial.exit_code, 4);
    assert.equal(partial.counts.partially_cleared, 1);
    assert.equal(partial.comment?.added, 0);
    const unresolved = await runBlockers(root, { ids: bare });
    assert.equal(unresolved.exit_code, undefined);
    assert.equal(unresolved.items[0].references[0].state, "unresolved");
  }));
});


test("marker extraction finishes on repeated unclosed marker prefixes", () => {
  const script = `import { extractBlockerCommentMarkers } from './index.ts';
    const text = '<!--pm-github:blockers:' + '<!--pm-github:blockers:!'.repeat(40000);
    console.log(extractBlockerCommentMarkers([{ text }]).size);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), "0");
});


test("reference resolution accepts GitHub repo names and rejects unsafe provenance hints", () => {
  const refs = github.parseBlockerReferences("UNBRAIND/.github#7 HTTP://GitHub.com/UNBRAIND/.github/issues/7 GH-7 #7 .github#7");
  assert.equal(github.resolveBlockerReferences(refs, undefined, "UNBRAIND/.github").length, 1);
  assert.equal(github.resolveBlockerReferences(github.parseBlockerReferences("GH-7 #7"), undefined, undefined).length, 1);
  assert.equal(github.resolveBlockerReferences(github.parseBlockerReferences("#7"), 'bad"/hint', undefined)[0].repo, undefined);
  const item: github.BlockerPmItem = { id: "fixture-hint", title: "Hint", status: "blocked", description: "GH-7", dependencies: [], comments: [], tags: ['gh:bad"/hint#1', "gh:UNBRAIND/.github#1"] };
  assert.equal(github.collectBlockerReferences(item, undefined)[0].repo, "unbraind/.github");
  const marker = github.buildBlockerClearedComment(refState({ repo: "unbraind/.github" }));
  assert.equal(github.extractBlockerCommentMarkers([{ text: marker }]).size, 1);
});

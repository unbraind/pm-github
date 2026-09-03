import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  CommandError,
  EXIT_CODE,
  applyClientFilters,
  applyExportPlan,
  applyLabelMap,
  applyOutcomeError,
  authorTag,
  buildExportPlan,
  buildPullEntryArgs,
  buildSearchUrl,
  collectProjectsV2Pages,
  exportWillApply,
  formatRateLimit,
  isDraftPr,
  isMutatingGithubCommand,
  listOwnerProjectsV2Nodes,
  indexByProvenance,
  searchDocumentToItem,
  resolveSearchCorpus,
  mapSearchHits,
  mapState,
  sameOrigin,
  optionCsv,
  parseImportOptions,
  parseLabelMap,
  parseNextLink,
  parseProvenanceTag,
  parseRateLimit,
  parseSince,
  planSync,
  resolveGitHubToken,
  resolveSearchRepo,
  scopeItemsByIds,
} from "../index.ts";
import type {
  ExportPlanEntry,
  GhIssue,
  ImportOptions,
  ProjectsV2Page,
} from "../index.ts";

// The extension registers against six surfaces (commands, importers, schema,
// hooks, preflight, search) — exactly the `capabilities` block in
// manifest.json. `createExtensionTestHarness` runs pm's real activation engine
// over that set, so every registration is validated (and a missing-capability
// drop fails fast) instead of being silently swallowed by an `activate(api as
// any)` test double that asserts against itself. The in-memory module export
// carries no `.capabilities` field, so we mirror manifest.json here.
const MANIFEST_CAPABILITIES = ["commands", "importers", "schema", "hooks", "preflight", "search"] as const;
const harnessPromise: Promise<ExtensionTestHarness> =
  createExtensionTestHarness(extension, { capabilities: [...MANIFEST_CAPABILITIES] });

// Shape of the `runExport` dry-run return value — narrowed so the assertion
// sites don't have to cast the `CommandHandlerResult.result` (typed `unknown`).
interface RunExportDryRunResult {
  dry_run: boolean;
  plan: unknown[];
  would_create: number;
  would_update: number;
  repo?: string;
  label_map?: Record<string, unknown>;
  scoped_ids?: string[];
}

// Structural stand-in for the unexported `PullPlanEntryLike` the buildPullEntry
// tests construct. Fields mirror index.ts verbatim so structural typing lines up.
interface TestPullEntry {
  itemId: string;
  pmId: string;
  title: string;
  fromStatus: string;
  toStatus: string;
}

// Minimal GhIssue factory for filter/field tests — typed so a typo on an
// override key fails the test compile instead of silently being dropped.
function issue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 1,
    title: "t",
    body: null,
    state: "open",
    labels: [],
    assignee: null,
    milestone: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/o/r/issues/1",
    ...overrides,
  };
}

// Base ImportOptions literal — applyClientFilters wants full ImportOptions, so
// the literal supplies every field (commentsMode, atomic, linkDeps default to
// their safe/no-op values, matching the import command's real defaults).
const baseOpts: ImportOptions = {
  state: "all",
  includePrs: false,
  skipDrafts: false,
  withComments: false,
  commentsMode: "body",
  itemType: "Issue",
  dryRun: false,
  atomic: false,
  linkDeps: false,
};

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", async () => {
  // Running the real activation engine proves the manifest grants every
  // capability the activate() registers against; the harness promotes any
  // dropped registration (from a missing capability) into a hard failure.
  const ext = await harnessPromise;
  ext.assertImporter({ name: "github" });
  ext.assertExporter({ name: "github" });
  ext.assertItemField({ name: "github_url" });
  ext.assertHook({ kind: "after_command" });
  ext.assertSearchProvider({ name: "github" });
  assert.ok(
    ext.activation.registrations.commands.length > 0,
    "extension should register commands",
  );
});

test("preflight override scope equals the mutating class of the declared command set", async () => {
  // The override MUST register as a scoped object (commands + run), not a bare
  // function: a global (unscoped) override collides pairwise with every other
  // installed package's preflight override (pm health reports
  // extension_preflight_override_collision). The runtime matches a command
  // against `commands` by exact normalized path, so the array must list the
  // full command paths pm-github mutates — not a bare top-level `github` (which
  // never matches `github sync` and would silently disable the early warning).
  const ext = await harnessPromise;
  const override = ext.assertPreflightOverride();
  assert.ok(
    Array.isArray(override.commands) && override.commands.length > 0,
    "preflight override must register as a scoped object with a non-empty commands array",
  );
  assert.equal(
    typeof override.run,
    "function",
    "scoped preflight override must expose a run function",
  );

  // ---------------------------------------------------------------------
  // Derive the declared command set from the REAL registration above — never
  // from a hand-maintained literal. Every path declared through
  // registerCommand, registerImporter and registerExporter is collected:
  // registerImporter/registerExporter wrap their handlers into "<name>
  // import"/"<name> export" command paths, exactly how the runtime names
  // them. This derived set is the single source of truth for the rest of the
  // test, so a newly registered command shows up here whether or not anyone
  // remembered to classify it (PR #42 review: Greptile 3789172153, CodeRabbit
  // 3789173850 — a guard that enumerates a literal cannot detect the drift it
  // was written for).
  // ---------------------------------------------------------------------
  const registrations = ext.activation.registrations;
  const declaredPaths = [...new Set([
    ...registrations.commands.map((c) => c.command),
    ...registrations.importers.map((i) => `${i.importer} import`),
    ...registrations.exporters.map((e) => `${e.exporter} export`),
  ])].sort();
  assert.ok(declaredPaths.length > 0, "activation should declare command paths");

  // Cross-check the registration metadata against the dispatch registry: the
  // paths that actually execute (commands.handlers — which is where importer
  // and exporter handlers land too) must equal the declared set. If a future
  // registration surface stopped landing in one of the two, the derived set
  // would be silently incomplete and every assertion below would narrow with
  // it — so the two derivations are required to agree.
  const dispatchedPaths = [...new Set(ext.activation.commands.handlers.map((h) => h.command))].sort();
  assert.deepEqual(
    dispatchedPaths,
    declaredPaths,
    "dispatch handler paths must equal the registration-derived declared command set",
  );

  // ---------------------------------------------------------------------
  // Partition the declared set with the SAME predicate production uses — the
  // preflight run() itself consults isMutatingGithubCommand — never a second
  // copy of the knowledge. The predicate is monotone in its option flags:
  // dry-run only ever disables a mutation branch, and apply/no-dry-run/push
  // only ever enable one, so a single maximally-mutating probe is exhaustive:
  // if the predicate can return true for a command under ANY option object,
  // it returns true under this one. "Can mutate GitHub at all" is therefore
  // derived from the classifier, not listed by hand.
  // ---------------------------------------------------------------------
  const MAXIMALLY_MUTATING_OPTIONS: Record<string, unknown> = {
    apply: true,
    "no-dry-run": true,
    push: true,
  };
  const canMutate = (command: string) =>
    isMutatingGithubCommand(command, MAXIMALLY_MUTATING_OPTIONS);
  const mutatingPaths = declaredPaths.filter(canMutate);
  const readOnlyPaths = declaredPaths.filter((command) => !canMutate(command));

  // Total partition: every declared path lands in exactly one class and the
  // two classes reconstruct the declared set EXACTLY. This is the assertion
  // that keeps the guard honest — a declared path that escapes both classes
  // (an unclassified new command, a normalization mismatch between the
  // registration and classification surfaces) fails here BY NAME instead of
  // passing unnoticed while it silently loses its credential gate.
  assert.deepEqual(
    [...mutatingPaths, ...readOnlyPaths].sort(),
    declaredPaths,
    "the mutating and read-only classes must reconstruct the declared command set exactly",
  );
  for (const command of mutatingPaths) {
    assert.ok(
      !readOnlyPaths.includes(command),
      `${command} landed in both the mutating and read-only classes`,
    );
  }
  assert.ok(
    mutatingPaths.length > 0 && readOnlyPaths.length > 0,
    "partition should classify commands on both sides (all-one-sided means the probe is broken)",
  );

  // The scope must EQUAL the derived mutating class — set equality in both
  // directions, each failing with a command-naming message:
  //   1. a declared path the classifier treats as mutating but the scope
  //      omits loses its early credential gate (the runtime matches by exact
  //      normalized path and simply never runs the override for it);
  //   2. a scope entry that is not a declared pm-github path, or that the
  //      classifier treats as read-only, is dead weight or a misclassification.
  const scopedPaths = [...(override.commands ?? [])].sort();
  assert.deepEqual(
    scopedPaths,
    mutatingPaths,
    "preflight override scope must equal the mutating class of the declared command set exactly",
  );
  for (const command of mutatingPaths) {
    assert.ok(
      scopedPaths.includes(command),
      `${command} is declared and isMutatingGithubCommand treats it as mutating, ` +
        "but it is missing from the preflight override's commands — it would execute " +
        "with no early credential warning",
    );
  }
  for (const command of scopedPaths) {
    assert.ok(
      declaredPaths.includes(command),
      `${command} is in the preflight override scope but is not a command path pm-github ` +
        "declares (registerCommand/registerImporter/registerExporter)",
    );
    assert.ok(
      canMutate(command),
      `${command} is in the preflight override scope but isMutatingGithubCommand treats it as read-only`,
    );
  }
  for (const command of readOnlyPaths) {
    assert.ok(
      !scopedPaths.includes(command),
      `${command} is read-only (isMutatingGithubCommand) and must not claim a preflight scope entry`,
    );
  }
});

test("parseNextLink extracts the rel=\"next\" page URL", () => {
  const header = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", '
    + '<https://api.github.com/repositories/1/issues?page=5>; rel="last"';
  assert.strictEqual(
    parseNextLink(header),
    "https://api.github.com/repositories/1/issues?page=2",
  );
});

test("parseNextLink rejects adversarial Link-header input without polynomial backtracking", () => {
  // CodeQL witness for js/polynomial-redos: a string starting with '<' followed
  // by many repetitions of '<=' makes the unbounded [^>]+ quantifier - retried
  // at every position by match() - do O(n²) work. Anchoring with ^ and bounding
  // the capture to 2048 characters removes both the multi-position scan and the
  // unbounded backtracking within a single attempt.
  //
  // The bound is deliberately generous rather than tight. A single cold
  // measurement on a contended CI runner carries JIT warm-up, GC pauses,
  // scheduler noise and coverage instrumentation, so a 50ms assertion would
  // measure the runner as much as the code and flake on a correct fix. 2000ms
  // cannot be reached by the linear implementation on any runner while still
  // failing decisively against the original expression, which took 25141ms on
  // an idle machine - a 12x margin below the defect and a 40x margin above the
  // real cost. A bound that can flake gets raised or deleted the first time it
  // does, which is how a regression test stops guarding anything.
  //
  // The scale-free half of the assertion is the ratio: doubling the witness
  // must not quadruple the time. That is the actual claim - linear rather than
  // polynomial growth - and it holds regardless of how fast the runner is.
  const witness = "<" + "<=".repeat(100_000);
  const doubleWitness = "<" + "<=".repeat(200_000);

  parseNextLink("<https://api.github.com/x>; rel=\"next\""); // warm up the JIT and the regex

  const startSingle = performance.now();
  assert.strictEqual(parseNextLink(witness), undefined, "adversarial input must not match");
  const single = performance.now() - startSingle;

  const startDouble = performance.now();
  assert.strictEqual(parseNextLink(doubleWitness), undefined, "adversarial input must not match");
  const double = performance.now() - startDouble;

  assert.ok(
    single < 2000,
    `a linear scan of a 200001-character header must not approach the quadratic cost `
      + `(25141ms before the fix); took ${single.toFixed(2)}ms`,
  );
  // Guard the ratio against a near-zero denominator: below a millisecond the
  // measurement is noise, and dividing by it would manufacture a huge ratio on
  // an idle machine. Both timings that small already prove the point.
  if (single >= 1) {
    assert.ok(
      double / single < 3,
      `doubling the input must not multiply the time superlinearly: `
        + `${single.toFixed(2)}ms then ${double.toFixed(2)}ms (ratio ${(double / single).toFixed(2)})`,
    );
  }
});

test("parseNextLink returns undefined when there is no next page", () => {
  assert.strictEqual(parseNextLink(undefined), undefined);
  assert.strictEqual(
    parseNextLink('<https://api.github.com/repositories/1/issues?page=1>; rel="prev"'),
    undefined,
  );
});

test("mapState preserves GitHub not-planned closures as canceled pm items", () => {
  assert.strictEqual(mapState("open"), "open");
  assert.strictEqual(mapState("closed", "completed"), "closed");
  assert.strictEqual(mapState("closed", "not_planned"), "canceled");
});

test("parseProvenanceTag normalizes repository casing", () => {
  assert.deepEqual(parseProvenanceTag("gh:Owner/Repo#123"), {
    repo: "owner/repo",
    number: 123,
  });
});

test("planSync matches provenance tags case-insensitively", () => {
  const plan = planSync([
    { id: "pm-1", status: "closed", tags: ["gh:Owner/Repo#123"] },
  ], "owner/repo");

  assert.deepEqual(plan, [{
    id: "pm-1",
    number: 123,
    title: "(untitled)",
    from: "open",
    to: "closed",
  }]);
});

test("resolveGitHubToken prefers the GITHUB_TOKEN env var", () => {
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  try {
    process.env.GITHUB_TOKEN = "test-token-123";
    delete process.env.GH_TOKEN;
    assert.strictEqual(resolveGitHubToken(), "test-token-123");
  } finally {
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
  }
});

test("buildExportPlan marks linked items update, unlinked items create", () => {
  const plan = buildExportPlan(
    [
      { id: "pm-1", title: "Linked", tags: ["bug", "gh:owner/repo#42"], status: "open" },
      { id: "pm-2", title: "New", tags: ["enhancement"], status: "closed" },
    ],
    "owner/repo",
  );
  assert.strictEqual(plan.length, 2);
  assert.deepEqual(
    { action: plan[0].action, number: plan[0].number },
    { action: "update", number: 42 },
  );
  // Provenance tag dropped from exported labels; pm status mapped to gh state.
  assert.deepEqual(plan[0].payload.labels, ["bug"]);
  assert.strictEqual(plan[1].action, "create");
  assert.strictEqual(plan[1].number, undefined);
  assert.strictEqual(plan[1].payload.state, "closed");
});

test("buildExportPlan treats every item as create when no repo is given", () => {
  const plan = buildExportPlan(
    [{ id: "pm-1", title: "x", tags: ["gh:owner/repo#42"], status: "open" }],
    undefined,
  );
  assert.strictEqual(plan[0].action, "create");
});

test("exportWillApply is safe by default and honors the precedence rules", () => {
  assert.strictEqual(exportWillApply({}), false, "default is dry-run (no write)");
  assert.strictEqual(exportWillApply({ apply: true }), true);
  assert.strictEqual(exportWillApply({ "no-dry-run": true }), true);
  assert.strictEqual(exportWillApply({ push: true }), true, "legacy --push still applies");
  // --dry-run always wins, even alongside an apply flag.
  assert.strictEqual(exportWillApply({ apply: true, "dry-run": true }), false);
});

test("buildSearchUrl scopes the query to issues in the target repo", () => {
  const url = buildSearchUrl("owner/repo", "memory leak");
  assert.ok(url.startsWith("https://api.github.com/search/issues?q="));
  const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
  assert.strictEqual(q, "memory leak repo:owner/repo type:issue");
});

test("optionCsv parses CSV options with trimming and dedupe", () => {
  assert.deepEqual(optionCsv({ ids: " pm-1, pm-2 ,pm-1 " }, "ids"), ["pm-1", "pm-2"]);
  assert.deepEqual(optionCsv({ ids: ["pm-1,pm-2", "pm-3"] }, "ids"), ["pm-1", "pm-2", "pm-3"]);
  assert.deepEqual(optionCsv({}, "ids"), []);
});

test("scopeItemsByIds selects requested items and reports unknown ids", () => {
  const all = [{ id: "pm-1" }, { id: "pm-2" }, { id: "pm-3" }];
  const scoped = scopeItemsByIds(all, ["pm-2", "pm-99"]);
  assert.deepEqual(scoped.selected.map((i) => i.id), ["pm-2"]);
  assert.deepEqual(scoped.missing, ["pm-99"]);
});

test("mapSearchHits maps remote issue numbers to local items, dropping unmatched", () => {
  const index = new Map<string, any>([
    ["owner/repo#10", { id: "pm-a", tags: ["gh:owner/repo#10"] }],
    ["owner/repo#20", { id: "pm-b", tags: ["gh:owner/repo#20"] }],
  ]);
  const hits = mapSearchHits([10, 999, 20], "Owner/Repo", index);
  assert.deepEqual(hits.map((h) => h.id), ["pm-a", "pm-b"]);
  // Earlier GitHub results rank higher.
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(hits[0].matched_fields, ["github:owner/repo#10"]);
});

test("resolveSearchRepo prefers --repo, then PM_GITHUB_REPO env", () => {
  const prev = process.env.PM_GITHUB_REPO;
  try {
    assert.strictEqual(resolveSearchRepo({ repo: "a/b" }), "a/b");
    delete process.env.PM_GITHUB_REPO;
    assert.strictEqual(resolveSearchRepo({}), undefined);
    process.env.PM_GITHUB_REPO = "c/d";
    assert.strictEqual(resolveSearchRepo({}), "c/d");
    assert.strictEqual(resolveSearchRepo({ repo: "a/b" }), "a/b", "option overrides env");
  } finally {
    if (prev === undefined) delete process.env.PM_GITHUB_REPO; else process.env.PM_GITHUB_REPO = prev;
  }
});

test("extension registers the github search provider when supported", async () => {
  const ext = await harnessPromise;
  ext.assertSearchProvider({ name: "github" });
  const provider = ext.activation.registrations.search_providers
    .find((p) => p.definition.name === "github");
  assert.ok(provider, "search provider should be registered");
  assert.strictEqual(
    typeof provider!.runtime_definition.query,
    "function",
    "search provider query must be a function",
  );
});

test("github validate command is registered", async () => {
  const ext = await harnessPromise;
  // `registrations.commands` carries the public metadata; `commands.handlers`
  // is the dispatch registry that owns the live `run` function.
  ext.assertCommandContract({ name: "github validate" });
  const handler = ext.activation.commands.handlers.find((h) => h.command === "github validate");
  assert.ok(handler, "github validate should be registered");
  assert.strictEqual(typeof handler!.run, "function");
});

test("isDraftPr only flags draft pull requests, never plain issues", () => {
  assert.strictEqual(isDraftPr(issue({ pull_request: {}, draft: true })), true);
  assert.strictEqual(isDraftPr(issue({ pull_request: {}, draft: false })), false);
  assert.strictEqual(isDraftPr(issue({ pull_request: {} })), false, "PR without draft flag is not a draft");
  assert.strictEqual(isDraftPr(issue({ draft: true })), false, "a plain issue is never a draft PR");
});

test("--skip-drafts excludes draft PRs only when --include-prs is set", () => {
  const plainIssue = issue({ number: 1 });
  const realPr = issue({ number: 2, pull_request: {}, draft: false });
  const draftPr = issue({ number: 3, pull_request: {}, draft: true });
  const all = [plainIssue, realPr, draftPr];

  // include-prs + skip-drafts: keep the issue and the ready PR, drop the draft.
  const kept = applyClientFilters(all, { ...baseOpts, includePrs: true, skipDrafts: true });
  assert.deepEqual(kept.map((i) => i.number), [1, 2]);

  // include-prs without skip-drafts: keep everything.
  const all3 = applyClientFilters(all, { ...baseOpts, includePrs: true, skipDrafts: false });
  assert.deepEqual(all3.map((i) => i.number), [1, 2, 3]);

  // No include-prs: PRs (drafts included) already filtered out regardless.
  const issuesOnly = applyClientFilters(all, { ...baseOpts, includePrs: false, skipDrafts: true });
  assert.deepEqual(issuesOnly.map((i) => i.number), [1]);
});

test("authorTag emits a github_author tag from user.login, undefined when absent", () => {
  assert.strictEqual(authorTag(issue({ user: { login: "octocat" } })), "github_author:octocat");
  assert.strictEqual(authorTag(issue({ user: null })), undefined);
  assert.strictEqual(authorTag(issue({ user: { login: "  " } })), undefined, "blank login emits no tag");
  assert.strictEqual(authorTag(issue()), undefined, "missing user emits no tag");
});

test("parseRateLimit reads X-RateLimit headers case-insensitively and flags low quota", () => {
  const healthy = parseRateLimit({
    "x-ratelimit-remaining": "4998",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-reset": "1780000000",
  });
  assert.deepEqual(
    { remaining: healthy.remaining, limit: healthy.limit, reset: healthy.reset, low: healthy.low },
    { remaining: 4998, limit: 5000, reset: 1780000000, low: false },
  );

  // Mixed-case header keys (as some runtimes normalize them).
  const mixed = parseRateLimit({ "X-RateLimit-Remaining": "3" });
  assert.strictEqual(mixed.remaining, 3);
  assert.strictEqual(mixed.low, true, "3 remaining is at/under the default low threshold");

  // No headers → undefined fields, not low.
  const none = parseRateLimit({});
  assert.strictEqual(none.remaining, undefined);
  assert.strictEqual(none.low, false);

  // Custom threshold.
  assert.strictEqual(parseRateLimit({ "x-ratelimit-remaining": "50" }, 100).low, true);
});

test("formatRateLimit renders a quota line, undefined when no quota present", () => {
  const line = formatRateLimit({ remaining: 4998, limit: 5000, reset: 1780000000, low: false });
  assert.ok(line);
  assert.match(line!, /GitHub API quota: 4998\/5000 remaining \(resets 20\d\d-/);
  assert.strictEqual(formatRateLimit({ low: false }), undefined, "no remaining → no line");
});

test("schema registers github_author / created_at / updated_at fields", async () => {
  const ext = await harnessPromise;
  // Assert each GitHub-provenance field is registered via the real schema
  // surface; the assertion fails if a field is missing from the manifest's
  // `schema` capability.
  for (const expected of [
    "github_url",
    "github_number",
    "github_state",
    "github_author",
    "github_created_at",
    "github_updated_at",
  ]) {
    ext.assertItemField({ name: expected });
  }
});

test("import command advertises the --skip-drafts flag", async () => {
  const ext = await harnessPromise;
  ext.assertCommandContract({ name: "gh-issues import", flags: ["--skip-drafts"] });
});

test("sync command advertises the --ids flag", async () => {
  const ext = await harnessPromise;
  ext.assertCommandContract({ name: "github sync", flags: ["--ids"] });
});

test("gh-issues import rejects a missing owner/repo argument", async () => {
  const ext = await harnessPromise;
  // runRegisteredCommandForTest propagates any thrown error carrying a numeric
  // `exitCode` — exactly how the runtime surfaces a `CommandError` — so the
  // host dispatch path is identical to `pm gh-issues import` with no argv.
  await assert.rejects(
    () => ext.runCommand({ command: "gh-issues import", args: [] }),
    (err: unknown) => {
      assert.match((err as Error).message, /owner\/repo/,
        "missing argv should surface the actionable usage message");
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE,
        "the handler must carry a numeric exitCode so pm treats it as a non-zero exit");
      return true;
    },
    "missing argument should throw a CommandError carrying a USAGE exit code",
  );
});

// ---------------------------------------------------------------------------
// applyExportPlan — per-item isolation on the --apply path.
//
// Regression guard for: one failed create/update used to throw and abandon
// every remaining item (no try/catch in the apply loop). The loop must now
// record the failure and CONTINUE, attempting all remaining items, and report
// a summary instead of aborting mid-batch.
// ---------------------------------------------------------------------------

function exportEntry(overrides: {
  id?: string;
  action?: "create" | "update";
  number?: number;
  title?: string;
} = {}): ExportPlanEntry {
  const action = overrides.action ?? "create";
  return {
    id: overrides.id ?? "github-1",
    action,
    ...(overrides.number === undefined ? {} : { number: overrides.number }),
    payload: {
      title: overrides.title ?? "t",
      body: "b",
      labels: [],
      state: "open" as const,
    },
  };
}

test("applyExportPlan continues after a per-item failure and counts it", async () => {
  const plan = [
    exportEntry({ id: "a", title: "first" }),
    exportEntry({ id: "b", title: "second" }),
    exportEntry({ id: "c", title: "third" }),
  ];
  const attempted: string[] = [];
  let call = 0;
  const requestFn = async (_m: string, url: string) => {
    call++;
    attempted.push(url);
    // Fail on the SECOND call; the loop must NOT abort.
    if (call === 2) throw new Error("GitHub API returned HTTP 422");
    return {};
  };

  const result = await applyExportPlan(plan, "o/r", "tok", requestFn);

  // All three items must have been attempted despite the 2nd throwing.
  assert.strictEqual(attempted.length, 3, "every item should be attempted, not abandoned on first failure");
  assert.strictEqual(call, 3, "loop should continue past the failed item");
  // Two succeeded (create), one recorded as a failure.
  assert.strictEqual(result.created, 2, "two creates should succeed");
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.failed, 1, "the failure should be counted, not thrown");
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].id, "b", "failure should capture the failed item id");
  assert.match(result.failures[0].error, /422/, "failure should capture the error message");
});

test("applyExportPlan never throws on a failing item (no mid-batch abort)", async () => {
  const plan = [exportEntry({ id: "a" }), exportEntry({ id: "b" })];
  const requestFn = async () => { throw new Error("boom"); };
  // The whole point: a failing write must resolve to a summary, not reject.
  const result = await applyExportPlan(plan, "o/r", "tok", requestFn);
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.failed, 2, "both failures counted");
  assert.strictEqual(result.failures.length, 2);
});

test("applyExportPlan happy path: all succeed, zero failures", async () => {
  const plan = [
    exportEntry({ id: "a", action: "create" }),
    exportEntry({ id: "b", action: "update", number: 7 }),
  ];
  const requestFn = async () => ({});
  const result = await applyExportPlan(plan, "o/r", "tok", requestFn);
  assert.strictEqual(result.created, 1);
  assert.strictEqual(result.updated, 1);
  assert.strictEqual(result.failed, 0, "happy path must report zero failures");
  assert.deepStrictEqual(result.failures, [], "happy path must have an empty failures list");
});

test("applyExportPlan: an update entry missing its number is a failure, not a silent create", async () => {
  // Regression (gemini review): a malformed "update" entry with no issue number
  // must NOT fall through to a POST (which would create a duplicate issue).
  const plan = [exportEntry({ id: "a", action: "update", number: undefined })];
  let posted = false;
  const requestFn = async (method: string) => {
    if (method === "POST") posted = true;
    return {};
  };
  const result = await applyExportPlan(plan, "o/r", "tok", requestFn);
  assert.strictEqual(posted, false, "must not POST (create) an update-without-number");
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.failed, 1, "the malformed update is counted as a failure");
  assert.match(result.failures[0].error, /number/i);
});

// ---------------------------------------------------------------------------
// applyOutcomeError — batch-level exit status of `export --apply`.
//
// Regression guard for: the --apply handler returned exit 0 regardless of
// outcome, so a non-empty plan that wrote NOTHING (every item failed) still
// reported success to the shell. Per-item-continue is preserved; partial and
// full success still exit 0. Only a non-empty all-fail batch must exit 1.
// ---------------------------------------------------------------------------

test("applyOutcomeError: a non-empty plan where every item fails throws CommandError with exit 1", async () => {
  // Simulate the real handler path: apply a plan whose every write 404s, then
  // run the same decision the handler runs on the result.
  const plan = [exportEntry({ id: "a" }), exportEntry({ id: "b" })];
  const requestFn = async () => { throw new Error("GitHub API returned HTTP 404"); };
  const result = await applyExportPlan(plan, "o/r", "tok", requestFn);
  assert.strictEqual(result.created, 0);
  assert.strictEqual(result.updated, 0);
  assert.strictEqual(result.failed, 2, "both items failed");

  const err = applyOutcomeError(plan, result, "o/r");
  assert.ok(err instanceof CommandError, "all-fail batch must surface a CommandError");
  assert.strictEqual(err!.exitCode, EXIT_CODE.GENERIC_FAILURE, "all-fail batch must exit 1");
  assert.match(err!.message, /failed to apply/i);
  assert.match(err!.message, /o\/r/, "message names the target repo");
});

test("applyOutcomeError: partial success (1 created, 1 failed) does NOT throw — still exit 0", async () => {
  // The whole point of per-item isolation: one bad item alongside a real write
  // must STILL succeed at the batch level.
  const plan = [exportEntry({ id: "ok" }), exportEntry({ id: "bad" })];
  let call = 0;
  const requestFn = async () => {
    call++;
    if (call === 2) throw new Error("GitHub API returned HTTP 422");
    return {};
  };
  const result = await applyExportPlan(plan, "o/r", "tok", requestFn);
  assert.strictEqual(result.created, 1, "one item should have been created");
  assert.strictEqual(result.failed, 1, "one item should have failed");

  assert.strictEqual(
    applyOutcomeError(plan, result, "o/r"),
    undefined,
    "partial success must NOT throw — the batch wrote a real change",
  );
});

test("applyOutcomeError: an empty plan (nothing to do) does NOT throw — still exit 0", () => {
  const result = { created: 0, updated: 0, failed: 0, failures: [] };
  assert.strictEqual(
    applyOutcomeError([], result, "o/r"),
    undefined,
    "an empty plan is a no-op success, not a failure",
  );
});

test("applyOutcomeError: full success (all created/updated, zero failures) does NOT throw", () => {
  const plan = [exportEntry({ id: "a" }), exportEntry({ id: "b", action: "update", number: 7 })];
  const result = { created: 1, updated: 1, failed: 0, failures: [] };
  assert.strictEqual(
    applyOutcomeError(plan, result, "o/r"),
    undefined,
    "full success must exit 0",
  );
});

// ---------------------------------------------------------------------------
// parseSince — relative durations + ISO 8601 timestamps for --since
// ---------------------------------------------------------------------------

test("parseSince accepts ISO 8601 timestamps (passed through, normalized)", () => {
  assert.strictEqual(
    parseSince("2026-01-01T00:00:00Z", Date.now()),
    "2026-01-01T00:00:00.000Z",
  );
});

test("parseSince resolves relative durations against now", () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0); // 2026-01-10T00:00:00Z
  assert.strictEqual(parseSince("7d", now), "2026-01-03T00:00:00.000Z");
  assert.strictEqual(parseSince("12h", now), "2026-01-09T12:00:00.000Z");
  assert.strictEqual(parseSince("30m", now), "2026-01-09T23:30:00.000Z");
  assert.strictEqual(parseSince("1w", now), "2026-01-03T00:00:00.000Z");
});

test("parseSince ignores whitespace and rejects garbage / zero durations", () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0);
  assert.strictEqual(parseSince("  7d ", now), "2026-01-03T00:00:00.000Z", "trims first");
  assert.strictEqual(parseSince("", now), undefined);
  assert.strictEqual(parseSince("   ", now), undefined);
  assert.strictEqual(parseSince("not-a-date", now), undefined, "garbage is undefined");
  assert.strictEqual(parseSince("0d", now), undefined, "zero duration is undefined");
  assert.strictEqual(parseSince("abc7d", now), undefined, "no leading digits is not relative");
});

test("parseSince rejects out-of-range relative durations without throwing", () => {
  assert.doesNotThrow(() => parseSince("999999999999d"));
  assert.strictEqual(parseSince("999999999999d"), undefined);
});

// ---------------------------------------------------------------------------
// parseImportOptions — wires parseSince + the --include-comments alias + --dry-run
// ---------------------------------------------------------------------------

test("parseImportOptions parses relative --since into an ISO timestamp", () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0);
  const orig = Date.now;
  // `Date.now` is a static-side readonly; we monkey-patch it via a cast on a
  // writeable structural view (no `any`) so callers cannot see the swap as a
  // type error and the cleanup in `finally` restores the original binding.
  (Date as { now: () => number }).now = () => now;
  try {
    const opts = parseImportOptions({ since: "7d" });
    assert.strictEqual(opts.since, "2026-01-03T00:00:00.000Z");
  } finally {
    (Date as { now: () => number }).now = orig;
  }
});

test("parseImportOptions honors --include-comments as an alias for --with-comments", () => {
  assert.strictEqual(
    parseImportOptions({ "include-comments": true }).withComments,
    true,
  );
  assert.strictEqual(
    parseImportOptions({ includeComments: "true" }).withComments,
    true,
  );
  assert.strictEqual(
    parseImportOptions({ "with-comments": true }).withComments,
    true,
  );
  assert.strictEqual(
    parseImportOptions({}).withComments,
    false,
  );
});

test("parseImportOptions surfaces --dry-run", () => {
  assert.strictEqual(parseImportOptions({ "dry-run": true }).dryRun, true);
  assert.strictEqual(parseImportOptions({ dryRun: "true" }).dryRun, true);
  assert.strictEqual(parseImportOptions({}).dryRun, false);
});

test("parseImportOptions rejects malformed --since instead of silently removing the filter", () => {
  assert.throws(
    () => parseImportOptions({ since: "nonsense" }),
    (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE,
  );
});

// ---------------------------------------------------------------------------
// parseLabelMap / applyLabelMap — --label-map support for export
// ---------------------------------------------------------------------------

test("parseLabelMap parses from=to pairs (CSV + repeated values), skipping invalid entries", () => {
  assert.deepEqual(
    parseLabelMap({ "label-map": "bug=kind/bug,enhancement=kind/enhancement" }),
    new Map([["bug", "kind/bug"], ["enhancement", "kind/enhancement"]]),
  );
  // Repeated values accumulate.
  assert.deepEqual(
    parseLabelMap({ "label-map": ["bug=kind/bug", "docs=kind/docs"] }),
    new Map([["bug", "kind/bug"], ["docs", "kind/docs"]]),
  );
  // Invalid entries are dropped; whitespace trimmed.
  assert.deepEqual(
    parseLabelMap({ "label-map": " bug = kind/bug , =nope ,missing= ,noseparator" }),
    new Map([["bug", "kind/bug"]]),
  );
  // Nothing usable → undefined (so callers can short-circuit).
  assert.strictEqual(parseLabelMap({ "label-map": "noseparator, =" }), undefined);
  assert.strictEqual(parseLabelMap({}, "label-map", "labelMap"), undefined);
});

test("applyLabelMap translates mapped labels and passes unmapped through unchanged", () => {
  const map = new Map([["bug", "kind/bug"], ["enhancement", "kind/enhancement"]]);
  assert.deepEqual(
    applyLabelMap(["bug", "enhancement", "question"], map),
    ["kind/bug", "kind/enhancement", "question"],
  );
});

test("applyLabelMap collapses two source labels that map to the same GitHub label", () => {
  // GitHub rejects duplicate labels with a 422; first-seen wins.
  const map = new Map([["bug", "kind/bug"], ["defect", "kind/bug"]]);
  assert.deepEqual(
    applyLabelMap(["bug", "defect", "question"], map),
    ["kind/bug", "question"],
  );
});

test("applyLabelMap with no map is a passthrough", () => {
  assert.deepEqual(applyLabelMap(["bug", "enhancement"], undefined), ["bug", "enhancement"]);
  assert.deepEqual(applyLabelMap(["bug"], new Map()), ["bug"]);
});

// ---------------------------------------------------------------------------
// buildExportPlan — label map integration
// ---------------------------------------------------------------------------

test("buildExportPlan applies --label-map to exported labels, dropping provenance first", () => {
  const labelMap = new Map([["bug", "kind/bug"], ["enhancement", "kind/enhancement"]]);
  const plan = buildExportPlan(
    [
      {
        id: "pm-1",
        title: "Linked",
        tags: ["bug", "gh:owner/repo#42"],
        status: "open",
      },
      {
        id: "pm-2",
        title: "New",
        tags: ["enhancement", "question"],
        status: "closed",
      },
    ],
    "owner/repo",
    labelMap,
  );
  // Provenance tag dropped, "bug" translated.
  assert.deepEqual(plan[0].payload.labels, ["kind/bug"]);
  // "enhancement" translated, "question" passed through.
  assert.deepEqual(plan[1].payload.labels, ["kind/enhancement", "question"]);
});

test("buildExportPlan without a label map preserves the existing behavior", () => {
  const plan = buildExportPlan(
    [{ id: "pm-1", title: "x", tags: ["bug", "gh:owner/repo#42"], status: "open" }],
    "owner/repo",
  );
  assert.deepEqual(plan[0].payload.labels, ["bug"]);
});

// Regression: an item linked to BOTH an issue (gh: provenance) and a GitHub
// Projects v2 board (gh-project: provenance) must drop BOTH internal provenance
// tags when exported to a GitHub issue, while user labels that merely contain
// similar text (e.g. "gh-project-notes") are preserved verbatim. See Greptile
// review 49e67dcf.
test("buildExportPlan strips both gh: and gh-project: provenance tags, keeps user labels with similar text", () => {
  // Valid project provenance tag: gh-project:unbraind/5#<hexItemId>.
  const projectTag =
    "gh-project:unbraind/5#505654495f6c41484f4142475a7463344264486a387a475966387055";
  const plan = buildExportPlan(
    [
      {
        id: "pm-1",
        title: "Dual-linked",
        // Normal user tag + issue provenance + project provenance + a user
        // label that merely contains similar text (not a real provenance tag).
        tags: ["bug", "gh:owner/repo#42", projectTag, "gh-project-notes"],
        status: "open",
      },
    ],
    "owner/repo",
  );
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].action, "update");
  assert.strictEqual(plan[0].number, 42);
  // Both provenance tags dropped; "bug" and the look-alike user label survive.
  assert.deepEqual(plan[0].payload.labels, ["bug", "gh-project-notes"]);
});

// ---------------------------------------------------------------------------
// pm github export command registration (new --export mode surface)
// ---------------------------------------------------------------------------

test("native github exporter declares --label-map and --dry-run metadata", async () => {
  const ext = await harnessPromise;
  ext.assertExporter({ name: "github" });
  // Importer/exporter-declared flags land in `registrations.flags` against the
  // generated `"github export"` command path — assert them via that surface so
  // the metadata is verified by the real host registration pipeline.
  ext.assertFlags({ targetCommand: "github export", flags: ["--label-map", "--dry-run", "--apply", "--repo"] });
  // The dispatch handler is the live function injected into commands.handlers.
  const handler = ext.activation.commands.handlers.find((h) => h.command === "github export");
  assert.ok(handler, "github exporter should register a command handler");
  assert.strictEqual(typeof handler!.run, "function");
});

test("native github importer advertises --include-comments as an alias for --with-comments", async () => {
  const ext = await harnessPromise;
  ext.assertImporter({ name: "github" });
  ext.assertFlags({ targetCommand: "github import", flags: ["--include-comments", "--since"] });
  // The dispatch handler is the live function injected into commands.handlers.
  const handler = ext.activation.commands.handlers.find((h) => h.command === "github import");
  assert.ok(handler, "github importer should register a command handler");
  assert.strictEqual(typeof handler!.run, "function");
});

test("manifest uses only runtime-supported capability names", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf-8"));
  assert.ok(!manifest.capabilities.includes("exporters"), "exporters is a registration, not a manifest capability");
});

test("sameOrigin only treats identical hosts as same-origin (token forwarding guard)", () => {
  assert.equal(sameOrigin("https://api.github.com/repos/x", "https://api.github.com/other"), true);
  assert.equal(sameOrigin("https://api.github.com/x", "https://evil.example.com/x"), false);
  assert.equal(sameOrigin("https://api.github.com/x", "https://API.GitHub.com/x"), true);
  assert.equal(sameOrigin("https://api.github.com/x", "http://api.github.com/x"), false);
  assert.equal(sameOrigin("https://api.github.com/x", "https://api.github.com:444/x"), false);
  assert.equal(sameOrigin("https://api.github.com/x", "not a url"), false);
});

test("buildPullEntryArgs routes terminal statuses through the pm close lifecycle", () => {
  const entry = (toStatus: string): TestPullEntry =>
    ({ itemId: "PVTI_1", pmId: "pm-1", title: "t", fromStatus: "open", toStatus });
  // `closed` uses `pm close`, which records closed_at + close_reason.
  assert.deepEqual(
    buildPullEntryArgs(entry("closed"), "/root"),
    ["--path", "/root", "close", "pm-1", "--reason", "GitHub project status → closed"],
  );
  // `canceled` keeps its distinct terminal state via `pm update --status
  // canceled` while recording `--close-reason` (the lifecycle metadata pm CLI
  // tracks for canceled items). It must NOT be routed through `pm close`, which
  // would conflate canceled with closed and fail on terminal→canceled.
  assert.deepEqual(
    buildPullEntryArgs(entry("canceled"), "/root"),
    ["--path", "/root", "update", "pm-1", "--status", "canceled", "--close-reason", "GitHub project status → canceled", "--message", "GitHub project status → canceled"],
  );
  // Active statuses are plain `pm update --status` with an audit message only.
  assert.deepEqual(
    buildPullEntryArgs(entry("in_progress"), "/root"),
    ["--path", "/root", "update", "pm-1", "--status", "in_progress", "--message", "GitHub project status → in_progress"],
  );
});

// ---------------------------------------------------------------------------
// GitHub Projects v2 listing pagination (Greptile 2006f478)
// ---------------------------------------------------------------------------
// `runProjectList` must paginate the projectsV2 connection beyond the first page
// (GitHub caps connections at 100/page) for both user and organization owners,
// threading the endCursor through pageInfo and never silently truncating.

// Build a minimal ProjectsV2 node literal the pagination tests inject. We
// derive the element type from `ProjectsV2Page.nodes` so the factory tracks
// the (unexported) `GraphqlProjectsV2Node` the runtime contract expects.
type ProjectsV2Node = NonNullable<NonNullable<ProjectsV2Page["nodes"]>[number]>;

function projNode(n: number): ProjectsV2Node {
  return { number: n, title: `P${n}`, url: `https://github.com/orgs/o/projects/${n}`, closed: false, shortDescription: null };
}

// Pure pagination contract: collectProjectsV2Pages threads the cursor through
// each fetch and stops only when pageInfo reports no more pages. A 150-project
// owner (page 1: 100, page 2: 50) must be fully collected, not truncated at 50
// or 100.
test("collectProjectsV2Pages pages through hasNextPage/endCursor with no silent truncation", async () => {
  const calls: Array<string | undefined> = [];
  let i = 0;
  const pages = [
    { nodes: Array.from({ length: 100 }, (_, k) => projNode(k + 1)), pageInfo: { hasNextPage: true, endCursor: "cursor-1" } },
    { nodes: Array.from({ length: 50 }, (_, k) => projNode(101 + k)), pageInfo: { hasNextPage: false, endCursor: "cursor-2" } },
  ];
  const out = await collectProjectsV2Pages(async (cursor) => {
    calls.push(cursor);
    return pages[i++];
  });
  // First call starts with no cursor; the second receives the page-1 endCursor.
  assert.deepEqual(calls, [undefined, "cursor-1"]);
  assert.equal(out.length, 150, "all 150 projects across two pages must be collected");
  assert.equal(out[0].number, 1);
  assert.equal(out[149].number, 150);
});

test("collectProjectsV2Pages stops on a single page with hasNextPage=false", async () => {
  let calls = 0;
  const out = await collectProjectsV2Pages(async () => {
    calls++;
    return { nodes: [projNode(1), projNode(2)], pageInfo: { hasNextPage: false, endCursor: "c" } };
  });
  assert.equal(calls, 1, "single-page owner must not over-page");
  assert.equal(out.length, 2);
});

test("collectProjectsV2Pages stops when pageInfo is missing (defensive, no infinite loop)", async () => {
  let calls = 0;
  const out = await collectProjectsV2Pages(async () => {
    calls++;
    return { nodes: [projNode(1)] }; // no pageInfo, no infinite loop
  });
  assert.equal(calls, 1);
  assert.equal(out.length, 1);
});

test("collectProjectsV2Pages stops when hasNextPage=true but endCursor is absent (no cursor to thread)", async () => {
  let calls = 0;
  const out = await collectProjectsV2Pages(async () => {
    calls++;
    return { nodes: [projNode(1)], pageInfo: { hasNextPage: true } };
  });
  assert.equal(calls, 1, "must not loop forever paging with the same (absent) cursor");
  assert.equal(out.length, 1);
});

test("collectProjectsV2Pages tolerates null nodes and a null/early-stop fetcher", async () => {
  // The runtime contract accepts null nodes; the page filter drops them.
  const out = await collectProjectsV2Pages(async () => ({ nodes: [null, projNode(1), null], pageInfo: { hasNextPage: false } }));
  assert.equal(out.length, 1, "null/undefined nodes are filtered out");
  const empty = await collectProjectsV2Pages(async () => undefined);
  assert.equal(empty.length, 0);
});

// Runtime listing path: listOwnerProjectsV2Nodes detects the owner type from the
// first page and keeps paginating the right connection (user OR organization)
// using the injected transport, so the multi-page behavior is verified end to
// end without any network calls.
test("listOwnerProjectsV2Nodes paginates an organization owner beyond the first page and threads the cursor", async () => {
  const calls: Array<{ cursor: string | null; owner: string }> = [];
  let page = 0;
  const nodes = await listOwnerProjectsV2Nodes("unbraind", async (_q, vars) => {
    calls.push({ cursor: vars.cursor as string | null, owner: vars.owner as string });
    // org login: user is null, organization resolves.
    if (page === 0) {
      page++;
      return {
        user: null,
        organization: {
          projectsV2: {
            nodes: Array.from({ length: 100 }, (_, k) => projNode(k + 1)),
            pageInfo: { hasNextPage: true, endCursor: "org-c1" },
          },
        },
      };
    }
    return {
      user: null,
      organization: {
        projectsV2: {
          nodes: Array.from({ length: 30 }, (_, k) => projNode(101 + k)),
          pageInfo: { hasNextPage: false, endCursor: "org-c2" },
        },
      },
    };
  });
  // Two pages, cursor threaded from page 1 (null) → page 2 ("org-c1").
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cursor, null);
  assert.equal(calls[1].cursor, "org-c1");
  assert.equal(calls[0].owner, "unbraind");
  assert.equal(nodes.length, 130, "org owner with 130 projects is fully listed, not truncated at 50/100");
  assert.equal(nodes[0].number, 1);
  assert.equal(nodes[129].number, 130);
});

test("listOwnerProjectsV2Nodes paginates a user owner and stops at hasNextPage=false", async () => {
  const calls: Array<string | null> = [];
  let page = 0;
  const nodes = await listOwnerProjectsV2Nodes("steve", async (_q, vars) => {
    calls.push(vars.cursor as string | null);
    if (page === 0) {
      page++;
      return {
        user: { projectsV2: { nodes: Array.from({ length: 100 }, (_, k) => projNode(k + 1)), pageInfo: { hasNextPage: true, endCursor: "u-c1" } } },
        organization: null,
      };
    }
    return {
      user: { projectsV2: { nodes: [projNode(101), projNode(102)], pageInfo: { hasNextPage: false, endCursor: "u-c2" } } },
      organization: null,
    };
  });
  assert.deepEqual(calls, [null, "u-c1"]);
  assert.equal(nodes.length, 102);
});

test("listOwnerProjectsV2Nodes resolves the owner type on the first page and does not switch connections mid-listing", async () => {
  // Once user is detected on page 1, a later page returning organization data
  // (defensive against a flaky API) must NOT cause the pager to switch to the
  // organization connection.
  let page = 0;
  const nodes = await listOwnerProjectsV2Nodes("mixed", async () => {
    page++;
    if (page === 1) {
      return { user: { projectsV2: { nodes: [projNode(1)], pageInfo: { hasNextPage: true, endCursor: "c1" } } }, organization: null };
    }
    if (page === 2) {
      return { user: { projectsV2: { nodes: [projNode(2)], pageInfo: { hasNextPage: false, endCursor: "c2" } } }, organization: { projectsV2: { nodes: [projNode(999)] } } };
    }
    // Page 3 is unreachable: `collectProjectsV2Pages` stops after page 2
    // (hasNextPage=false). Return a graphQL-valid empty page so the transport's
    // declared `Promise<GraphqlListOwnerProjectsData>` return type is satisfied
    // without an `as any` cast.
    return { user: null, organization: null };
  });
  assert.equal(nodes.length, 2, "organization node from page 2 must be ignored once user is pinned");
  assert.equal(nodes[1].number, 2);
});

// ---------------------------------------------------------------------------
// runExport dry-run preview routing — regression: stdout corruption
// ---------------------------------------------------------------------------
//
// `pm github export --format json` used to console.log the human preview to
// STDOUT while the SDK host ALSO renders the exporter's return object to
// STDOUT, so the combined stdout was JSON immediately followed by trailing
// YAML/markdown — not valid JSON (Python json.loads -> "Extra data"). The fix
// routes BOTH the md preview and the JSON.stringify(plan) preview to STDERR
// (console.error), mirroring the existing [dry-run] note, so STDOUT is always
// only the host render (parseable JSON when the caller passes the global
// --json).
//
// Deterministic + offline: spins up a throwaway pm workspace in the system
// temp dir via the local pm binary, then drives the real registered exporter
// handler and asserts the preview lands on stderr, never stdout.

// On Windows the npm shim is `pm.cmd`; the extensionless `pm` shell script is
// not directly executable via execFileSync (ENOENT/EINVAL). Resolve the
// platform-appropriate shim so the setup spawns work cross-platform.
const PM_BIN = fileURLToPath(
  new URL(`../node_modules/.bin/pm${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url),
);

function makeExportTestWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-github-export-test-"));
  const env = { ...process.env, PM_AUTHOR: "tester" };
  // Node refuses to spawn `.cmd`/`.bat` directly since the CVE-2024-27980
  // mitigation (EINVAL), so on win32 the pm.cmd shim must run through a shell.
  // Args are static test values (never user input), so shell:true is safe.
  const opts = { stdio: "ignore" as const, env, shell: process.platform === "win32" };
  // If any setup spawn fails, remove the freshly-created temp dir before
  // rethrowing so a setup failure never leaks a workspace (the caller's
  // try/finally only covers the dir once it has been returned).
  try {
    // pm init's workspace flag differs across pm-cli versions: newer builds
    // expose --workspace (tracker lands under <root>/.agents/pm); older builds
    // take the tracker target as a positional path (tracker lands in <root>
    // directly). Both then answer `pm --pm-path <root>`, so pm_root is <root>
    // either way — we just call whichever init form this pm understands.
    try {
      execFileSync(PM_BIN, ["init", "-y", "--force", "--workspace", root, "--author", "tester"], opts);
    } catch {
      execFileSync(PM_BIN, ["init", "-y", "--force", root, "--author", "tester"], opts);
    }
    execFileSync(PM_BIN, ["--pm-path", root, "create", "task", "Alpha", "--description", "first body"], opts);
    execFileSync(PM_BIN, ["--pm-path", root, "create", "task", "Beta", "--description", "second body"], opts);
    return root;
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

// Captures every console.log / console.error argument during `fn`. Returns the
// flat list of joined string arguments written to each stream. The override
// functions are explicitly typed and assigned via a `typeof console.log` cast —
// no `as any` — so the swap is type-checked (and the `unknown[]` arg signature
// prevents an implicit `any` sneaking past `strict: true`).
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ stdout: string[]; stderr: string[]; result: T }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = ((...args: unknown[]) => { stdout.push(args.map(String).join(" ")); }) as typeof console.log;
  console.error = ((...args: unknown[]) => { stderr.push(args.map(String).join(" ")); }) as typeof console.error;
  try {
    const result = await fn();
    return { stdout, stderr, result };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("runExport dry-run routes the md preview to STDERR, never STDOUT", async () => {
  const ext = await harnessPromise;
  const root = makeExportTestWorkspace();
  try {
    const { stdout, stderr, result } = await captureConsole(() =>
      ext.runExporter({ exporter: "github", pmRoot: root, options: { format: "md" }, global: { json: false } }),
    );
    // The whole point of the fix: the human preview must NOT touch stdout.
    assert.strictEqual(
      stdout.length,
      0,
      "md preview must not be written to stdout (would corrupt host-rendered JSON)",
    );
    // The preview header and the dry-run note both land on stderr.
    assert.ok(
      stderr.some((l) => l.includes("[create] Alpha")),
      "md preview header should appear on stderr",
    );
    assert.ok(
      stderr.some((l) => l.includes("[dry-run]")),
      "the existing [dry-run] note should remain on stderr",
    );
    // The machine-readable return object is still intact.
    assert.strictEqual(result.handled, true, "the exporter handler should run clean");
    const exported = result.result as RunExportDryRunResult;
    assert.strictEqual(exported.dry_run, true);
    assert.ok(Array.isArray(exported.plan), "return object should carry the plan array");
    assert.strictEqual(exported.would_create, 2, "both unlinked items are creates");
    assert.strictEqual(exported.would_update, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runExport dry-run routes the JSON preview to STDERR, never STDOUT", async () => {
  const ext = await harnessPromise;
  const root = makeExportTestWorkspace();
  try {
    const { stdout, stderr, result } = await captureConsole(() =>
      ext.runExporter({ exporter: "github", pmRoot: root, global: { json: false } }),
    );
    // Default format is JSON; the JSON.stringify(plan) preview must go to
    // stderr so stdout stays only the host render (valid JSON under --json).
    assert.strictEqual(
      stdout.length,
      0,
      "JSON preview must not be written to stdout (would corrupt host-rendered JSON)",
    );
    // The pretty-printed plan array is the first stderr line and parses back
    // to the same plan the return object carries.
    const jsonPreview = stderr.find((l) => l.trimStart().startsWith("["));
    assert.ok(jsonPreview, "a pretty-printed JSON array preview should be on stderr");
    const parsed = JSON.parse(jsonPreview!);
    assert.ok(Array.isArray(parsed), "stderr JSON preview should parse to the plan array");
    assert.strictEqual(parsed.length, 2);
    assert.ok(
      stderr.some((l) => l.includes("[dry-run]")),
      "the [dry-run] note should still be on stderr",
    );
    // Return object still carries the plan for the host to render.
    assert.strictEqual(result.handled, true, "the exporter handler should run clean");
    const exported = result.result as RunExportDryRunResult;
    assert.strictEqual(exported.dry_run, true);
    assert.ok(Array.isArray(exported.plan));
    assert.strictEqual(exported.plan.length, 2);
    assert.strictEqual(exported.would_create, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runExport dry-run with global --json writes NO preview to either stream", async () => {
  // In JSON mode the host renders the return object to stdout; the extension
  // must stay completely silent (no preview on either stream) so stdout is a
  // single valid JSON object.
  const ext = await harnessPromise;
  const root = makeExportTestWorkspace();
  try {
    const { stdout, stderr, result } = await captureConsole(() =>
      ext.runExporter({ exporter: "github", pmRoot: root, options: { format: "md" }, global: { json: true } }),
    );
    assert.strictEqual(stdout.length, 0, "nothing should be written to stdout in JSON mode");
    // No human preview lines (only the host renders). The [dry-run] note is
    // also gated behind !jsonMode, so stderr should be empty too.
    assert.ok(
      !stderr.some((l) => l.includes("[create]")),
      "no md preview should be emitted in JSON mode",
    );
    assert.ok(
      !stderr.some((l) => l.includes("[dry-run]")),
      "no human dry-run note should be emitted in JSON mode",
    );
    assert.strictEqual(result.handled, true, "the exporter handler should run clean");
    const exported = result.result as RunExportDryRunResult;
    assert.ok(Array.isArray(exported.plan), "return object should carry the plan array");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: the search provider must survive RAW pm items in
// `SearchProviderQueryContext.documents`.
//
// The SDK declares `documents: ItemDocument[]` with a REQUIRED `metadata`, so the
// typing refactor replaced the pre-existing guard (`d?.metadata ? d.metadata : d`)
// with a bare `d.metadata`. But `SearchProviderQueryContext` carries an
// `[key: string]: unknown` index signature and the runtime hands raw pm items
// straight through on some paths, so trusting the declared type yielded
// `undefined` entries and crashed `indexByProvenance` with a TypeError.
//
// Greptile's T-Rex run reproduced exactly that: a wrapped document produced a
// local hit while a raw document threw. These cases pin both shapes.
// ---------------------------------------------------------------------------

test("searchDocumentToItem unwraps a metadata-wrapped document", () => {
  const item = { id: "pm-1", title: "Wrapped", tags: ["gh:acme/repo#7"] };
  assert.deepEqual(searchDocumentToItem({ metadata: item, body: "" } as never), item);
});

test("searchDocumentToItem passes a RAW pm item through unchanged", () => {
  const raw = { id: "pm-2", title: "Raw", tags: ["gh:acme/repo#8"] };
  assert.deepEqual(searchDocumentToItem(raw as never), raw, "a raw item must be used as-is, not read through .metadata");
});

test("searchDocumentToItem skips values matching neither shape", () => {
  for (const bad of [undefined, null, {}, "nope", 42]) {
    assert.equal(searchDocumentToItem(bad as never), undefined, `${JSON.stringify(bad)} must be skipped, not indexed`);
  }
});

test("resolveSearchCorpus (the provider's REAL mapping) handles wrapped, raw and junk documents", () => {
  const wrapped = { id: "pm-1", title: "Wrapped", tags: ["gh:acme/repo#7"] };
  const raw = { id: "pm-2", title: "Raw", tags: ["gh:acme/repo#8"] };
  const documents = [{ metadata: wrapped, body: "" }, raw, undefined, null, {}];

  // This is the exact function the search provider calls, so reverting the guard
  // inside it fails this test — an inline expression at the call site could not be
  // reached without stubbing the provider's network I/O.
  const docs = resolveSearchCorpus(documents, ".agents/pm");
  assert.equal(docs.length, 2, "junk entries must be skipped, not indexed as undefined");

  const index = indexByProvenance(docs);
  assert.equal(index.get("acme/repo#7")?.id, "pm-1", "the wrapped document must be indexed");
  assert.equal(index.get("acme/repo#8")?.id, "pm-2", "the RAW document must be indexed, not dropped or thrown on");
  assert.equal(index.size, 2);
});

import assert from "node:assert/strict";
import test from "node:test";

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
  listOwnerProjectsV2Nodes,
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
} from "../dist/index.js";

// Minimal GhIssue factory for filter/field tests.
function issue(overrides: Record<string, unknown> = {}): any {
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

const baseOpts: any = {
  state: "all",
  includePrs: false,
  skipDrafts: false,
  withComments: false,
  itemType: "Issue",
  dryRun: false,
};

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", () => {
  const registered: string[] = [];
  // Mirror the real ExtensionApi surface so activate() can register every
  // capability the extension uses (commands, importers, exporters, schema
  // fields, hooks).
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerParser: () => { registered.push("parser"); },
    registerPreflight: () => { registered.push("preflight"); },
    registerService: () => { registered.push("service"); },
    registerFlags: () => { registered.push("flags"); },
    registerItemFields: () => { registered.push("itemFields"); },
    registerItemTypes: () => { registered.push("itemTypes"); },
    registerMigration: () => { registered.push("migration"); },
    registerRenderer: () => { registered.push("renderer"); },
    registerImporter: () => { registered.push("importer"); },
    registerExporter: () => { registered.push("exporter"); },
    registerSearchProvider: () => { registered.push("search"); },
    registerVectorStoreAdapter: () => { registered.push("vectorStore"); },
    hooks: {
      beforeCommand: () => { registered.push("hook:before"); },
      afterCommand: () => { registered.push("hook:after"); },
      onWrite: () => { registered.push("hook:onWrite"); },
      onRead: () => { registered.push("hook:onRead"); },
      onIndex: () => { registered.push("hook:onIndex"); },
    },
  };
  extension.activate(api as any);
  assert.ok(registered.includes("importer"), "should register the github importer");
  assert.ok(registered.includes("exporter"), "should register the github exporter");
  assert.ok(registered.includes("itemFields"), "should register github schema fields");
  assert.ok(registered.includes("hook:after"), "should register an afterCommand hook");
  assert.ok(registered.length > 0, `extension should register at least one capability, got: ${JSON.stringify(registered)}`);
});

test("parseNextLink extracts the rel=\"next\" page URL", () => {
  const header = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", '
    + '<https://api.github.com/repositories/1/issues?page=5>; rel="last"';
  assert.strictEqual(
    parseNextLink(header),
    "https://api.github.com/repositories/1/issues?page=2",
  );
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

test("extension registers the github search provider when supported", () => {
  let searchProvider: any;
  const noop = () => {};
  const api: any = {
    registerCommand: noop, registerParser: noop, registerPreflight: noop,
    registerService: noop, registerFlags: noop, registerItemFields: noop,
    registerItemTypes: noop, registerMigration: noop, registerRenderer: noop,
    registerImporter: noop, registerExporter: noop,
    registerSearchProvider: (def: any) => { searchProvider = def; },
    registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  assert.ok(searchProvider, "search provider should be registered");
  assert.strictEqual(searchProvider.name, "github");
  assert.strictEqual(typeof searchProvider.query, "function");
});

test("github validate command is registered", () => {
  let captured: any;
  const noop = () => {};
  const api: any = {
    registerCommand: (def: any) => { if (def?.name === "github validate") captured = def; },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop, registerImporter: noop,
    registerExporter: noop, registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  assert.ok(captured, "github validate should be registered");
  assert.strictEqual(typeof captured.run, "function");
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

test("schema registers github_author / created_at / updated_at fields", () => {
  let fields: any[] = [];
  const noop = () => {};
  const api: any = {
    registerCommand: noop, registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: (f: any[]) => { fields = f; }, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop, registerImporter: noop,
    registerExporter: noop, registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  const names = fields.map((f) => f.name);
  for (const expected of ["github_url", "github_number", "github_state", "github_author", "github_created_at", "github_updated_at"]) {
    assert.ok(names.includes(expected), `schema should declare ${expected}`);
  }
});

test("import command advertises the --skip-drafts flag", () => {
  let captured: any;
  const noop = () => {};
  const api: any = {
    registerCommand: (def: any) => { if (def?.name === "gh-issues import") captured = def; },
    registerParser: noop, registerPreflight: noop, registerService: noop, registerFlags: noop,
    registerItemFields: noop, registerItemTypes: noop, registerMigration: noop, registerRenderer: noop,
    registerImporter: noop, registerExporter: noop, registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  assert.ok(captured?.flags?.some((f: any) => f.long === "--skip-drafts"), "import should expose --skip-drafts");
});

test("sync command advertises the --ids flag", () => {
  let captured: any;
  const noop = () => {};
  const api: any = {
    registerCommand: (def: any) => { if (def?.name === "github sync") captured = def; },
    registerParser: noop, registerPreflight: noop, registerService: noop, registerFlags: noop,
    registerItemFields: noop, registerItemTypes: noop, registerMigration: noop, registerRenderer: noop,
    registerImporter: noop, registerExporter: noop, registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  assert.ok(captured?.flags?.some((f: any) => f.long === "--ids"), "sync should expose --ids");
});

test("gh-issues import rejects a missing owner/repo argument", async () => {
  let captured: { run: (ctx: any) => unknown } | undefined;
  const noop = () => {};
  const api = {
    registerCommand: (def: any) => { if (def?.name === "gh-issues import") captured = def; },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop, registerImporter: noop,
    registerExporter: noop, registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api as any);
  assert.ok(captured, "import command should be registered");
  await assert.rejects(
    async () => captured!.run({ args: [], options: {}, pm_root: ".agents/pm" }),
    (err: unknown) => {
      // The runtime only treats a thrown error as a cleanly handled non-zero
      // exit (no second handler invocation) when it carries a numeric exitCode.
      assert.match((err as Error).message, /owner\/repo/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
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

function exportEntry(overrides: Partial<{
  id: string;
  action: "create" | "update";
  number: number;
  title: string;
}> = {}): any {
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
  (Date as any).now = () => now;
  try {
    const opts = parseImportOptions({ since: "7d" });
    assert.strictEqual(opts.since, "2026-01-03T00:00:00.000Z");
  } finally {
    (Date as any).now = orig;
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
    (err: any) => err?.name === "CommandError" && err?.exitCode === 2,
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

test("native github exporter declares --label-map and --dry-run metadata", () => {
  let captured: any;
  let handler: unknown;
  const noop = () => {};
  const api: any = {
    registerCommand: noop,
    registerParser: noop, registerPreflight: noop, registerService: noop, registerFlags: noop,
    registerItemFields: noop, registerItemTypes: noop, registerMigration: noop, registerRenderer: noop,
    registerImporter: noop,
    registerExporter: (name: string, fn: unknown, options: unknown) => {
      if (name === "github") { handler = fn; captured = options; }
    },
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  assert.ok(captured, "github exporter should declare command metadata");
  assert.strictEqual(typeof handler, "function");
  const longs = captured.flags.map((f: any) => f.long);
  assert.ok(longs.includes("--label-map"), "export should advertise --label-map");
  assert.ok(longs.includes("--dry-run"), "export should advertise --dry-run");
  assert.ok(longs.includes("--apply"), "export should advertise --apply");
  assert.ok(longs.includes("--repo"), "export should advertise --repo");
});

test("native github importer advertises --include-comments as an alias for --with-comments", () => {
  let captured: any;
  let handler: unknown;
  const noop = () => {};
  const api: any = {
    registerCommand: noop,
    registerParser: noop, registerPreflight: noop, registerService: noop, registerFlags: noop,
    registerItemFields: noop, registerItemTypes: noop, registerMigration: noop, registerRenderer: noop,
    registerImporter: (name: string, fn: unknown, options: unknown) => {
      if (name === "github") { handler = fn; captured = options; }
    },
    registerExporter: noop, registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api);
  assert.ok(
    captured?.flags?.some((f: any) => f.long === "--include-comments"),
    "import should expose --include-comments as an alias",
  );
  assert.ok(
    captured?.flags?.some((f: any) => f.long === "--since"),
    "installed github import command should expose --since",
  );
  assert.strictEqual(typeof handler, "function");
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
  const entry = (toStatus: string): any => ({ itemId: "PVTI_1", pmId: "pm-1", title: "t", fromStatus: "open", toStatus });
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

function projNode(n: number): any {
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
    return { nodes: [projNode(1)] } as any; // no pageInfo
  });
  assert.equal(calls, 1);
  assert.equal(out.length, 1);
});

test("collectProjectsV2Pages stops when hasNextPage=true but endCursor is absent (no cursor to thread)", async () => {
  let calls = 0;
  const out = await collectProjectsV2Pages(async () => {
    calls++;
    return { nodes: [projNode(1)], pageInfo: { hasNextPage: true } as any };
  });
  assert.equal(calls, 1, "must not loop forever paging with the same (absent) cursor");
  assert.equal(out.length, 1);
});

test("collectProjectsV2Pages tolerates null nodes and a null/early-stop fetcher", async () => {
  const out = await collectProjectsV2Pages(async () => ({ nodes: [null, projNode(1), undefined], pageInfo: { hasNextPage: false } } as any));
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
    return null as any;
  });
  assert.equal(nodes.length, 2, "organization node from page 2 must be ignored once user is pinned");
  assert.equal(nodes[1].number, 2);
});

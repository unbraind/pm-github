import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  applyClientFilters,
  applyExportPlan,
  authorTag,
  buildExportPlan,
  buildSearchUrl,
  exportWillApply,
  formatRateLimit,
  isDraftPr,
  mapSearchHits,
  parseNextLink,
  parseProvenanceTag,
  parseRateLimit,
  planSync,
  resolveGitHubToken,
  resolveSearchRepo,
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

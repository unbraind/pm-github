import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  buildExportPlan,
  buildSearchUrl,
  exportWillApply,
  mapSearchHits,
  parseNextLink,
  parseProvenanceTag,
  planSync,
  resolveGitHubToken,
  resolveSearchRepo,
} from "../dist/index.js";

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

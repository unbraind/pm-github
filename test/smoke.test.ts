import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  parseNextLink,
  parseProvenanceTag,
  planSync,
  resolveGitHubToken,
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

import assert from "node:assert/strict";
import test from "node:test";

import extension, { parseNextLink, resolveGitHubToken } from "../dist/index.js";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", () => {
  const registered: string[] = [];
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerHook: () => { registered.push("hook"); },
    registerImporter: () => { registered.push("importer"); },
    registerSchema: () => { registered.push("schema"); },
    registerRenderer: () => { registered.push("renderer"); },
    registerSearchProvider: () => { registered.push("search"); },
    registerPreflight: () => { registered.push("preflight"); },
    registerService: () => { registered.push("service"); },
  };
  extension.activate(api as any);
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
  const api = {
    registerCommand: (def: any) => { if (def?.name === "gh-issues import") captured = def; },
    registerHook: () => {}, registerImporter: () => {}, registerSchema: () => {},
    registerRenderer: () => {}, registerSearchProvider: () => {},
    registerPreflight: () => {}, registerService: () => {},
  };
  extension.activate(api as any);
  assert.ok(captured, "import command should be registered");
  await assert.rejects(
    async () => captured!.run({ args: [], options: {}, pm_root: ".agents/pm" }),
    /owner\/repo/,
    "missing argument should throw (non-zero exit), not return silently",
  );
});

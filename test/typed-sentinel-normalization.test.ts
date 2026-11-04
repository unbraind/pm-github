/** Typed SDK identities must survive importer comparison and unchanged detection. */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { normalizeImportValue } from "../import-fidelity.ts";
import { parseImportOptions, runImport, type GhIssue } from "../index.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

test("GH-1614 importer normalization preserves literal typed assignee identities", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "github-typed-identities-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const client = new PmClient({ cwd, pmRoot: join(cwd, "tracker"), author: "fixture", noExtensions: true });
  await client.run("init", { prefix: "fixture", withPackages: false, agentGuidance: "skip" });
  const { item } = await client.create({ title: "Literal typed identity", type: "Task" });
  for (const assignee of ["none", "null", " Name "]) {
    await client.update(item.id, { assignee });
    const current = (await client.get(item.id)).item;
    assert.equal(current.assignee, assignee.trim());
    assert.equal(normalizeImportValue("assignee", assignee), current.assignee);
  }
  assert.equal(normalizeImportValue("sprint", "none"), "none");
  await client.update(item.id, { unset: ["assignee"] });
  assert.equal((await client.get(item.id)).item.assignee, undefined);
  assert.equal(normalizeImportValue("assignee", undefined), "");
});

test("GH-1614 plain create and update preserve literal assignments and repeat without writes", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "github-plain-identities-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, "tracker");
  const client = new PmClient({ cwd, pmRoot: root, author: "fixture", noExtensions: true });
  await client.run("init", { prefix: "fixture", withPackages: false, agentGuidance: "skip" });
  const owner = (await client.create({ title: "Existing owner", type: "Issue", tags: "gh:fixture/project#1" })).item;
  const source: GhIssue[] = ["none", "null", "none", "null"].map((login, index) => ({
    number: index + 1, title: `Literal source ${index + 1}`, body: "Source body", state: index < 2 ? "open" : "closed", labels: [],
    state_reason: index < 2 ? null : "completed", closed_at: index < 2 ? null : "2026-10-02T00:00:00Z",
    assignee: { login }, milestone: { title: index === 0 ? "null" : "none" },
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
    html_url: `https://github.com/fixture/project/issues/${index + 1}`,
  }));
  await withEnv({ PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH, PM_AUTHOR: "fixture" }, async () => {
    const options = parseImportOptions({ atomic: false });
    const deps = { fetchIssues: async () => source, resolveToken: () => undefined };
    const first = (await captureStderr(() => runImport("fixture/project", root, options, deps))).result;
    assert.equal("imported" in first && first.imported, 3);
    assert.equal("updated" in first && first.updated, 1);
    const items = (await client.list({ includeBody: true })).items;
    assert.equal(items.length, 4);
    for (const issue of source) {
      const item = items.find(item => Array.isArray(item.tags) && item.tags.includes(`gh:fixture/project#${issue.number}`))!;
      assert.equal(item.assignee, issue.assignee!.login);
      assert.equal(item.sprint, issue.milestone!.title);
    }
    assert.equal((await client.get(owner.id)).item.assignee, "none");
    const paths = readdirSync(root, { recursive: true }).map(String).filter(file => /\.toon$|^history\/.*\.jsonl$/.test(file)).sort();
    const before = paths.map(file => readFileSync(join(root, file), "utf8"));
    const second = (await captureStderr(() => runImport("fixture/project", root, options, deps))).result;
    assert.equal("imported" in second && second.imported, 0);
    assert.equal("updated" in second && second.updated, 0);
    assert.deepEqual(readdirSync(root, { recursive: true }).map(String).filter(file => /\.toon$|^history\/.*\.jsonl$/.test(file)).sort(), paths);
    assert.deepEqual(paths.map(file => readFileSync(join(root, file), "utf8")), before);
  });
});

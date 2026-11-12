/** Whole-value ownership and reference-only links use native trackers and the registered import command. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, create, get, mutateItem, readSettings, getItemPath, getHistoryPath, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type GhIssue } from "../index.ts";
import { explicitGithubIdentities, githubLinkReferences, legacyGithubLinkIdentities, matchImportedIssue } from "../import-fidelity.ts";
import { exploreGithubIdentities } from "../identity.ts";
import { githubOwnershipClaims } from "../import-ownership.ts";
import { withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const url = "https://github.com/o/r/issues/7";
const source: GhIssue = { number: 7, title: "Source title", body: "Public source", state: "open", labels: [], user: null,
  assignee: null, milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: url };

/** Seed arbitrary old metadata through real SDK persistence without relying on Git. */
async function tracker(values: Record<string, unknown>, run: (root: string, id: string) => Promise<void>, title = "Curated Chore", tags = "keep,gh:o/r#7") {
  const directory = mkdtempSync(join(tmpdir(), "github-whole-field-")), root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, async () => {
      const item = (await create({ title, type: "Chore", tags }, { pmRoot: root })).item;
      await mutateItem({ pmRoot: root, id: item.id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
        Object.assign(document.metadata, values); return { changedFields: Object.keys(values) };
      } });
      await run(root, item.id);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Snapshot curated documents and append-only history independently of SDK read projections. */
function bytes(root: string, id: string) {
  return [readFileSync(getItemPath(root, "Chore", id), "hex"), readFileSync(getHistoryPath(root, id), "hex")];
}

/** Mock external HTTP data only; command dispatch, matching, ownership and writes remain native. */
async function importing(root: string, adopt = false, issue = source) {
  return withMockGithub((request, response) => {
    assert.ok(request.method === "GET", "Import must not write to GitHub");
    jsonResponse(response, 200, request.url?.includes("/timeline") ? [] : [issue]);
  }, async () => {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
    return harness.runCommand({ command: "github import", args: ["o/r"], options: { atomic: true, "adopt-cited": adopt }, pmRoot: root, global: { json: true } });
  });
}

for (const field of ["github_url", "GitHubURL"]) for (const value of [`See ${url}`, `${url} followed by text`, [url], { url }]) {
  test(`Whole identity field refuses substring ownership: ${field} ${JSON.stringify(value)}`, async () => tracker({ [field]: value }, async (root, id) => {
    const item = (await get(id, {}, { pmRoot: root })).item, before = bytes(root, id);
    assert.deepEqual(explicitGithubIdentities(item), []);
    assert.deepEqual(legacyGithubLinkIdentities(item), []);
    assert.deepEqual(githubOwnershipClaims(item).owners, []);
    assert.equal(matchImportedIssue([item], source).item, undefined);
    const graph = await exploreGithubIdentities(root, { identity: "gh:o/r#7" });
    assert.equal(graph.edges.some(edge => edge.strength === "claim"), false);
    assert.ok(graph.edges.some(edge => edge.strength === "mention" && edge.source === "prose"));
    await importing(root);
    assert.deepEqual(bytes(root, id), before);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
  }, "Curated Chore", "keep"));
}

for (const field of ["github_url", "GitHubURL"]) test(`Whole identity field allows exact URL: ${field}`, async () => tracker({ [field]: url }, async (root, id) => {
  const item = (await get(id, {}, { pmRoot: root })).item;
  assert.deepEqual(githubOwnershipClaims(item).owners, ["o/r#7"]);
  assert.equal(matchImportedIssue([item], source).item?.id, id);
  await importing(root);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  const actual = (await get(id, {}, { pmRoot: root })).item;
  assert.equal(actual.title, item.title); assert.equal(actual.type, item.type); assert.equal(actual.created_at, item.created_at);
}));

for (const field of ["links", "external_links", "external_url", "provenance"]) test(`Other link fields preserve references without ownership: ${field}`, async () => tracker({ [field]: `See ${url} for context` }, async (root, id) => {
  const item = (await get(id, {}, { pmRoot: root })).item, before = bytes(root, id);
  assert.deepEqual(githubLinkReferences(item).map(reference => reference.key), ["o/r#7"]);
  assert.deepEqual(githubOwnershipClaims(item).owners, []);
  assert.equal(matchImportedIssue([item], source).item, undefined);
  const graph = await exploreGithubIdentities(root, { identity: "gh:o/r#7" });
  assert.ok(graph.edges.some(edge => edge.strength === "mention" && edge.source === "prose"));
  assert.equal(graph.edges.some(edge => edge.strength === "claim"), false);
  await importing(root);
  assert.deepEqual(bytes(root, id), before);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
}, "Curated Chore", "keep"));

for (const explicitOwner of [false, true]) test(`Reference prose does not bar explicit citation adoption (existing owner: ${explicitOwner})`, async () => tracker({ links: "See https://github.com/other/project/issues/8 for context", ...(explicitOwner ? { github_url: "https://github.com/other/project/issues/8" } : {}) }, async (root, id) => {
  const item = (await get(id, {}, { pmRoot: root })).item, before = bytes(root, id);
  assert.equal(matchImportedIssue([item], source, undefined, true).item?.id, explicitOwner ? undefined : id);
  await importing(root, true);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, explicitOwner ? 2 : 1);
  if (explicitOwner) assert.deepEqual(bytes(root, id), before);
}, "Closes o/r#7"));

for (const marker of [false, true]) for (const trailing of [false, true]) test(`Native link declaration requires the explicit legacy marker (${marker}, trailing: ${trailing})`, async () => tracker({ description: `GitHub issue ${url}${trailing ? " followed by prose" : ""}`, ...(marker ? { github_link_only: true } : {}) }, async (root, id) => {
  const item = (await get(id, {}, { pmRoot: root })).item;
  assert.deepEqual(githubOwnershipClaims(item).owners, marker && !trailing ? ["o/r#7"] : []);
  assert.equal(matchImportedIssue([item], source).item?.id, marker && !trailing ? id : undefined);
}));

for (const external of [false, true]) test(`Provider backlink ignores GitHub references (external provider: ${external})`, async () => {
  const backlink = external ? "https://linear.app/fixture/issue/ENG-7" : url;
  await tracker({ linear_id: "ENG-7", external_links: `See ${backlink}` }, async (root, id) => {
    const issue = { ...source, body: `Mirrored from ${backlink}` };
    const item = (await get(id, {}, { pmRoot: root })).item, before = bytes(root, id);
    assert.deepEqual(githubOwnershipClaims(item).owners, []);
    assert.equal(matchImportedIssue([item], issue).item?.id, external ? id : undefined);
    await importing(root, false, issue);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, external ? 1 : 2);
    if (!external) assert.deepEqual(bytes(root, id), before);
  });
});

for (const marker of [false, true]) test(`Identity graph derives native declaration claims from the shared marker (${marker})`, async () => tracker({ description: `GitHub issue ${url}`, ...(marker ? { github_link_only: true } : {}) }, async root => {
  const graph = await exploreGithubIdentities(root, { identity: "gh:o/r#7" });
  assert.equal(graph.edges.some(edge => edge.strength === "claim"), marker);
}));

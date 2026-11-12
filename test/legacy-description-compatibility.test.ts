/** Legacy declaration ownership and retained reference refusals use native SDK trackers and command dispatch. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, create, get, mutateItem, readSettings, getItemPath, getHistoryPath, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type GhIssue } from "../index.ts";
import { matchImportedIssue } from "../import-fidelity.ts";
import { githubOwnershipClaims } from "../import-ownership.ts";
import { withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const examples = [
  { name: "pm-github-z5z1", repo: "unbraind/pm-github", number: 129, description: "GitHub issue: https://github.com/unbraind/pm-github/issues/129. Add optional behavior." },
  { name: "pm-review-withdrawn-lineage", repo: "unbraind/pm-review", number: 30, description: "GH issue #30: https://github.com/unbraind/pm-review/issues/30 · author fixture · open" },
  { name: "pm-rust-oqst", repo: "unbraind/pm-rust", number: 86, description: "GitHub issue https://github.com/unbraind/pm-rust/issues/86: centralize behavior." },
];

/** Seed old-style metadata with no explicit number, URL, external ref or importer-created ID. */
async function tracker(values: Record<string, unknown>, run: (root: string, id: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-legacy-declaration-")), root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, async () => {
      const item = (await create({ title: "Curated Chore", type: "Chore", body: "Local context", status: "in_progress", tags: "keep" }, { pmRoot: root })).item;
      await mutateItem({ pmRoot: root, id: item.id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
        Object.assign(document.metadata, values); return { changedFields: Object.keys(values) };
      } });
      await run(root, item.id);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Ordinary API issue input, including the declaration's exact repository and number. */
function source(repo: string, number: number): GhIssue {
  return { number, title: "Source title", body: "Public source", state: "open", labels: [], user: null, assignee: null, milestone: null,
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: `https://github.com/${repo}/issues/${number}` };
}

/** Observe both the document and append-only audit record without relying on SDK projections. */
function bytes(root: string, id: string) { return [readFileSync(getItemPath(root, "Chore", id), "hex"), readFileSync(getHistoryPath(root, id), "hex")]; }

/** Only external GitHub transport is substituted; all command, identity and storage operations are real. */
async function importing(root: string, repo: string, issue: GhIssue) {
  return withMockGithub((request, response) => { assert.equal(request.method, "GET"); jsonResponse(response, 200, request.url?.includes("/timeline") ? [] : [issue]); }, async () => {
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
    return harness.runCommand({ command: "github import", args: [repo], options: { atomic: true }, pmRoot: root, global: { json: true } });
  });
}

for (const example of examples) test(`Legacy declaration allows ${example.name} without link-only metadata`, async () => tracker({ description: example.description }, async (root, id) => {
  const item = (await get(id, {}, { pmRoot: root })).item, issue = source(example.repo, example.number);
  for (const field of ["github_number", "github_url", "external_ref", "github_link_only"] as const) assert.equal(item[field], undefined);
  assert.deepEqual(githubOwnershipClaims(item).owners, [`${example.repo}#${example.number}`]);
  const match = matchImportedIssue([item], issue);
  assert.equal(match.item?.id, id); assert.equal(match.linkOnly, true);
  await importing(root, example.repo, issue);
  const after = (await get(id, {}, { pmRoot: root })).item;
  for (const field of ["title", "description", "type", "body", "created_at", "status"] as const) assert.deepEqual(after[field], item[field], field);
  assert.ok(after.tags!.includes("keep"));
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  const beforeRepeat = bytes(root, id); await importing(root, example.repo, issue); assert.deepEqual(bytes(root, id), beforeRepeat);
}));

for (const kind of ["middle-description", "prose-url-field", "reference-tag"] as const) test(`Reference refusal keeps ${kind} unowned`, async () => {
  const repo = "o/r", issue = source(repo, 7), url = issue.html_url;
  const fields = kind === "middle-description" ? { description: `Context. GitHub issue ${url}` }
    : kind === "prose-url-field" ? { github_url: `See ${url}` } : { tags: ["keep", "gh:o/r#7"] };
  await tracker(fields, async (root, id) => {
    const item = (await get(id, {}, { pmRoot: root })).item, before = bytes(root, id);
    assert.deepEqual(githubOwnershipClaims(item).owners, []);
    assert.equal(matchImportedIssue([item], issue, kind === "reference-tag" ? item : undefined).item, undefined);
    await importing(root, repo, issue);
    assert.deepEqual(bytes(root, id), before); assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
  });
});

for (const explicit of [false, true]) test(`Copied-provider markers retain main's precedence (explicit owner: ${explicit})`, async () => tracker({
  description: "GitHub issue https://github.com/o/r/issues/7. Local evidence", body: "[linear] linear_id=ENG-7 linear_url=https://linear.app/fixture/issue/ENG-7",
  ...(explicit ? { github_repo: "o/r", github_number: 7, github_url: "https://github.com/o/r/issues/7", github_link_only: false } : {}),
}, async (root, id) => {
  const item = (await get(id, {}, { pmRoot: root })).item;
  const match = matchImportedIssue([item], source("o/r", 7));
  assert.equal(match.item?.id, id); assert.equal(match.linkOnly, !explicit);
}));

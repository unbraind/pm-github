/** Scope and native number claims are exercised on genuine SDK tracker records. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { init, create, get, mutateItem, readSettings, getItemPath, getHistoryPath } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type PmItem, type GhIssue, planSync, buildExportPlan, deriveAtomicItemId, runImport, parseImportOptions, indexByProvenance } from "../index.ts";
import { buildProjectImportPlan, buildProjectPullPlan, type ProjectItem } from "../projects.ts";
import { matchImportedIssue } from "../import-fidelity.ts";
import { buildGithubOwnershipIndex, githubOwnershipClaims, githubImporterIdentity, warnGithubOwnershipScope } from "../import-ownership.ts";
import { selectRefreshTargets } from "../refresh.ts";
import { exploreGithubIdentities, planGithubIdentityRepair } from "../identity.ts";
import { captureStderr, withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

/** Own every tracker setup and cleanup; there are no substituted SDK calls. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-scoped-owners-")), root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Persist arbitrary legacy metadata via the native SDK and read it back before planning. */
async function item(root: string, fields: Record<string, unknown> = {}, id?: string): Promise<PmItem> {
  const created = (await create({ title: "Curated fixture", type: "Task", ...(id ? { id } : {}) }, { pmRoot: root })).item;
  await mutateItem({ pmRoot: root, id: created.id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
    Object.assign(document.metadata, fields); return { changedFields: Object.keys(fields) };
  } });
  return (await get(created.id, {}, { pmRoot: root })).item;
}
/** Observe both the native item and its audit record around a refused operation. */
function bytes(root: string, value: PmItem) { return [getItemPath(root, String(value.type), value.id!), getHistoryPath(root, value.id!)].map(file => readFileSync(file, "hex")); }
const url = "https://github.com/o/r/issues/7";
const issue = { number: 7, html_url: url, body: "", title: "Source", state: "open", labels: [], assignee: null, milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z" } satisfies GhIssue;
const board: ProjectItem[] = [{ id: "board-item", statusName: "Closed", content: { typename: "Issue", repo: "o/r", number: 7, title: "Source" } }];
const ref = { owner: "o", number: 1 };

for (const command of ["sync", "export"] as const) test(`${command} --ids allows a clean owner while warning about both unselected peers`, async () => tracker(async root => {
  const clean = await item(root, { github_url: url }), first = await item(root, { github_url: "https://github.com/o/r/issues/8" }), second = await item(root, { external_ref: "gh:o/r#8" });
  const before = [clean, first, second].map(value => bytes(root, value));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const result = await captureStderr(() => harness.runCommand({ command: `github ${command}`, options: { repo: "o/r", ids: clean.id, "dry-run": true }, pmRoot: root, global: { json: true } }));
  assert.ok(result.stderr.some(line => line.includes("out_of_scope_github_owner_conflict") && line.includes(first.id!) && line.includes(second.id!)));
  assert.deepEqual([clean, first, second].map(value => bytes(root, value)), before);
}));

for (const path of ["sync", "export", "board-import", "board-pull"] as const) test(`${path} still refuses a peer of the selected owner`, async () => tracker(async root => {
  const selected = await item(root, { github_url: url }), peer = await item(root, { external_ref: "gh:o/r#7" }), corpus = [selected, peer], before = corpus.map(value => bytes(root, value));
  const run = () => path === "sync" ? planSync([selected], "o/r", undefined, { corpus }) : path === "export" ? buildExportPlan([selected], "o/r", undefined, undefined, { corpus }) : path === "board-import" ? buildProjectImportPlan(board, ref, corpus) : buildProjectPullPlan([selected], ref, board, undefined, undefined, corpus);
  assert.throws(run, error => (error as { code: string }).code === "github_import_owner_conflict");
  assert.deepEqual(corpus.map(value => bytes(root, value)), before);
}));

for (const path of ["board-import", "board-pull", "import-match"] as const) test(`${path} allows clean targets and reports off-board ownership collisions`, async () => tracker(async root => {
  const selected = await item(root, { github_url: url }), first = await item(root, { github_url: "https://github.com/o/r/issues/8" }), second = await item(root, { external_ref: "gh:o/r#8" }), corpus = [selected, first, second];
  const outcome = await captureStderr(async () => {
    if (path === "board-import") assert.equal(buildProjectImportPlan(board, ref, corpus)[0]?.pmId, selected.id);
    else if (path === "board-pull") assert.equal(buildProjectPullPlan(corpus, ref, board).entries[0]?.pmId, selected.id);
    else { const index = buildGithubOwnershipIndex(corpus, ["o/r"]); warnGithubOwnershipScope(index, [selected]); assert.equal(matchImportedIssue(corpus, issue, undefined, false, index).item?.id, selected.id); }
  });
  assert.ok(outcome.stderr.some(line => line.includes(first.id!) && line.includes(second.id!)));
}));

for (const declared of ["8", "0", "-1", "9007199254740993"]) test(`native declaration rejects number ${declared} against URL 7 with a warning`, async () => tracker(async root => {
  const value = await item(root, { description: `GH issue #${declared}: ${url} · author fixture` });
  assert.deepEqual(githubOwnershipClaims(value).owners, []); assert.equal(matchImportedIssue([value], issue).item, undefined);
  const outcome = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([value]), [value]));
  assert.ok(outcome.stderr.some(line => line.includes("invalid_github_identity_number") && line.includes(value.id!)));
}));

for (const suffix of ["9007199254740993", "9007199254740991"]) test(`verified importer suffix ${suffix} must be a safe number`, async () => tracker(async root => {
  const prefix = (await readSettings(root)).id_prefix;
  const id = deriveAtomicItemId("o/r", 7, prefix, value => value).replace(/-7$/, `-${suffix}`);
  const value = await item(root, { author: "pm-github", tags: ["gh:o/r#7"] }, id);
  const safe = Number.isSafeInteger(Number(suffix));
  assert.equal(githubImporterIdentity(value, ["o/r"]), safe ? `o/r#${suffix}` : undefined);
  assert.deepEqual(githubOwnershipClaims(value, false, false, ["o/r"]).owners, safe ? [`o/r#${suffix}`] : []);
  const outcome = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([value], ["o/r"]), [value]));
  assert.equal(outcome.stderr.some(line => line.includes("invalid_github_identity_number")), !safe);
}));

test("matching marker-free declaration is a repair owner and resolves the import", async () => tracker(async root => {
  const owner = await item(root, { description: `GH issue #7: ${url} · author fixture` }), mention = await item(root, { tags: ["gh:o/r#7"] });
  assert.equal(matchImportedIssue([owner, mention], issue).item?.id, owner.id);
  const report = await exploreGithubIdentities(root, { identity: "gh:o/r#7" });
  assert.ok(report.edges.some(edge => edge.item === owner.id && edge.source === "declaration" && edge.strength === "claim"));
  assert.equal((await planGithubIdentityRepair(root, "gh:o/r#7", owner.id!, mention.id!)).owner, owner.id);
}));

for (const path of ["refresh", "search", "gated-import"] as const) test(`${path} scopes ownership to requested issue targets`, async () => tracker(async root => {
  const selected = await item(root, { github_url: url }), first = await item(root, { github_url: "https://github.com/o/r/issues/8" }), second = await item(root, { external_ref: "gh:o/r#8" }), corpus = [selected, first, second];
  const outcome = await captureStderr(async () => {
    if (path === "refresh") assert.equal(selectRefreshTargets(corpus, "o/r", [7])[0]?.id, selected.id);
    else if (path === "search") assert.equal(indexByProvenance(corpus, new Set(["o/r#7"])).get("o/r#7")?.id, selected.id);
    else await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((request, response) => {
      assert.equal(request.method, "GET"); jsonResponse(response, 200, request.url?.includes("/timeline") ? [] : [{ ...issue, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z" }]);
    }, () => runImport("o/r", root, parseImportOptions({ atomic: true, gate: true, "dry-run": true }))));
  });
  assert.ok(outcome.stderr.some(line => line.includes(first.id!) && line.includes(second.id!)));
}));

test("board import command ignores and warns about two off-board peers", async () => tracker(async root => {
  const selected = await item(root, { github_url: url }), first = await item(root, { github_url: "https://github.com/o/r/issues/8" }), second = await item(root, { external_ref: "gh:o/r#8" });
  const before = [first, second].map(value => bytes(root, value));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const outcome = await captureStderr(() => withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((_request, response, body) => {
    const query = (JSON.parse(body) as { query: string }).query;
    jsonResponse(response, 200, query.includes("projectV2(number:") ? { data: { organization: { projectV2: { id: "board", title: "Fixture", statusField: null } } } }
      : { data: { node: { items: { nodes: [{ id: "board-item", content: { __typename: "Issue", id: "issue-node", number: 7, title: "Source", body: "", state: "OPEN", url, repository: { nameWithOwner: "o/r" } } }], pageInfo: { hasNextPage: false } } } } });
  }, () => harness.runCommand({ command: "github project import", args: ["o/1"], options: { "dry-run": true }, pmRoot: root, global: { json: true } }))));
  assert.ok(outcome.stderr.some(line => line.includes(first.id!) && line.includes(second.id!)));
  assert.deepEqual([first, second].map(value => bytes(root, value)), before);
  assert.equal((await get(selected.id!, {}, { pmRoot: root })).item.github_url, url);
}));


test("board scope accepts independently decoded selected records", async () => tracker(async root => {
  const selected = await item(root, { github_url: url });
  assert.equal(buildProjectPullPlan([JSON.parse(JSON.stringify(selected))], ref, board, undefined, undefined, [selected]).entries[0]?.pmId, selected.id);
}));

test("unknown board content is outside an import's ownership scope", async () => tracker(async root => {
  const first = await item(root, { github_url: "https://github.com/o/r/issues/8", tags: ["gh-project:o/1#redacted"] }), second = await item(root, { external_ref: "gh:o/r#8" });
  const outcome = await captureStderr(async () => assert.deepEqual(buildProjectImportPlan([{ id: "redacted", content: { typename: "Unknown", title: "" } }], ref, [first, second]), []));
  assert.ok(outcome.stderr.some(line => line.includes(first.id!) && line.includes(second.id!)));
}));



for (const number of ["9007199254740993", "9007199254740991"]) test(`external_ref number ${number} must also be a positive safe integer`, async () => tracker(async root => {
  const value = await item(root, { external_ref: `gh:o/r#${number}` }), safe = Number.isSafeInteger(Number(number));
  assert.deepEqual(githubOwnershipClaims(value).owners, safe ? [`o/r#${number}`] : []);
  const outcome = await captureStderr(async () => warnGithubOwnershipScope(buildGithubOwnershipIndex([value]), [value]));
  assert.equal(outcome.stderr.some(line => line.includes("invalid_github_identity_number")), !safe);
}));

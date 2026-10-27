/** Real nested workspaces certify shared host resolution and configured lifecycle comparisons. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { create, init, isTerminalStatus, normalizeStatusInput, schemaAddStatus, schemaAddType, update, SETTINGS_DEFAULTS, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
import { acceptGithubWebhook, buildExportPlan, buildPullEntryArgs, completeIssueForm, fetchJSON, parseNextLink, planSync, reconcileGithubWebhooks, selectBlockerCandidates, type BlockerPmItem } from "../index.ts";
import { runCloseout } from "../closeout.ts";
import { normalizeImportValue, readImportTypeNames, selectImportContextIndex } from "../import-fidelity.ts";
import { buildProjectImportPlan, buildProjectPullPlan, buildProjectPushPlan, mapOptionNameToPmStatus, projectItemTag, resolveOptionForStatus, type ProjectItem } from "../projects.ts";
import { canonicalGithubStatus, githubStatusIsTerminal, githubStatusKind, readGithubWorkspace } from "../workspace.ts";
import { generateChangelog } from "../scripts/generate-changelog.ts";
import { jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";

/** Configure aliases through real SDK schema mutations, with no repository or raw settings access. */
async function fixture(run: (workspace: string, root: string) => Promise<void>) {
  const workspace = mkdtempSync(join(tmpdir(), "pm-workspace-resolution-"));
  const root = join(workspace, ".agents/pm");
  const client = { pmRoot: workspace, cwd: workspace, noExtensions: true };
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { ...client, pmRoot: root });
    await schemaAddType("Investigation", { alias: ["probe"], folder: "investigations" }, client);
    await schemaAddStatus("working", { alias: ["busy-now"], role: ["active"] }, client);
    await schemaAddStatus("verified", { alias: ["settled"], role: ["terminal", "terminal_done"] }, client);
    await schemaAddStatus("archived", { alias: ["shelved"], role: ["terminal"] }, client);
    await run(workspace, root);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

/** Snapshot only durable item/history content; SDK caches are deliberately outside the contract. */
function durable(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true }).map(String).filter(path => /\.(toon|jsonl)$/.test(path)).sort().map(path => [path, readFileSync(join(root, path), "utf8")]));
}

test("workspace path and alias property matches SDK writers across fidelity and provider planners", async () => fixture(async (workspace, root) => {
  const native = (await create({ title: "Native", type: "probe", status: "busy-now", tags: "gh:fixture/project#1" }, { pmRoot: workspace, noExtensions: true })).item;
  assert.equal(native.type, "Investigation");
  assert.equal(native.status, "working");
  const before = durable(root);
  for (const [alias, canonical] of Object.entries(resolveItemTypeRegistry(SETTINGS_DEFAULTS).alias_to_type)) assert.equal(normalizeImportValue("type", alias), canonical);
  for (const path of [workspace, root, relative(process.cwd(), workspace), relative(process.cwd(), root)]) {
    const resolved = await readGithubWorkspace(path);
    assert.equal(resolved.pmRoot, root);
    const names = await readImportTypeNames(path);
    for (const [alias, canonical] of Object.entries(resolved.types.alias_to_type)) for (const spelling of [alias, alias.toUpperCase(), ` ${alias} `]) {
      assert.equal(normalizeImportValue("type", spelling, names), canonical);
    }
    for (const [alias, canonical] of resolved.statuses.alias_to_id) for (const spelling of [alias, alias.toUpperCase(), ` ${alias} `]) {
      assert.equal(canonicalGithubStatus(spelling, resolved.statuses), normalizeStatusInput(spelling, resolved.statuses));
      assert.equal(normalizeImportValue("status", spelling, names, resolved.statuses), canonical);
      const history = [{ message: "Native context", patch: [] }, { message: "Preserve GitHub source lifecycle for issue #1", patch: [{ path: "/metadata/status", value: spelling }] }];
      assert.equal(selectImportContextIndex(history, canonical, resolved.statuses), 0, "Equivalent owned status aliases must retain the native context revision.");
      const terminal = isTerminalStatus(canonical, resolved.statuses);
      const item: BlockerPmItem = { id: native.id, title: "Fixture", status: spelling, description: "", tags: ["gh:fixture/project#1"],
        dependencies: [{ id: "github:fixture/project#8", kind: "blocked_by" }], comments: [] };
      assert.equal(planSync([item], "fixture/project", resolved.statuses)[0]!.to, terminal ? "closed" : "open");
      assert.equal(buildExportPlan([item], "fixture/project", undefined, resolved.statuses)[0]!.payload.state, terminal ? "closed" : "open");
      assert.equal(selectBlockerCandidates([item], resolved.statuses).length, terminal ? 0 : 1);
      const kind = githubStatusKind(spelling, resolved.statuses);
      if (terminal) assert.equal(kind, resolved.statuses.terminal_canceled_statuses.has(canonical) ? "canceled" : "closed");
    }
    for (const unknown of ["constructor", "__proto__", "unknown", ""]) {
      assert.equal(canonicalGithubStatus(unknown, resolved.statuses), unknown);
      assert.equal(normalizeImportValue("status", unknown, names, resolved.statuses), unknown);
    }
    assert.equal(githubStatusKind(undefined, resolved.statuses), "open");
    assert.equal(githubStatusIsTerminal(undefined, resolved.statuses), false);
    const ref = { owner: "fixture", number: 1 };
    const project: ProjectItem = { id: "linked", statusName: "Done", statusOptionId: "done", content: { typename: "DraftIssue", title: "Fixture" } };
    const local = { id: native.id, title: "Fixture", status: " SETTLED ", tags: [projectItemTag(ref, "linked")] };
    const map = new Map([["settled", "Done"]]);
    assert.equal(mapOptionNameToPmStatus("Done", map, resolved.statuses), "verified");
    assert.equal(resolveOptionForStatus("SETTLED", [{ id: "done", name: "Done" }], map, resolved.statuses)!.id, "done");
    assert.equal(buildProjectPullPlan([local], ref, [project], map, resolved.statuses).entries.length, 0);
    assert.equal(buildProjectPushPlan([local], ref, [project], { id: "field", name: "Status", options: [{ id: "done", name: "Done" }] }, { statusMap: map, statuses: resolved.statuses }).entries[0]!.action, "noop");
    assert.equal(buildProjectImportPlan([project], ref, [local], map, resolved.statuses)[0]!.mappedStatus, "verified");
    const args = buildPullEntryArgs({ itemId: "linked", pmId: native.id, title: "Fixture", fromStatus: "working", toStatus: "SETTLED" }, path, resolved.statuses);
    assert.equal(args[args.indexOf("--status") + 1], "verified");
  }
  assert.ok(durable(root) === before, "Registry and plan reads must preserve items and history.");
  await update(native.id, { status: "settled", closeReason: "Fixture verification", force: true }, { pmRoot: workspace, noExtensions: true });
  let released: string[] = [];
  assert.equal(await generateChangelog(workspace, [], (_command, _args, options) => {
    released = (JSON.parse(String(options.input)) as { items: Array<{ id: string }> }).items.map(item => item.id);
    return { pid: 0, output: ["", "", ""], stdout: "", stderr: "", status: 0, signal: null };
  }), 0);
  assert.ok(released.includes(native.id), "Changelog filtering uses the same configured completed role as SDK writers.");
}));

test("nested workspace settings resolve in issue forms, closeout and authenticated webhook storage", async () => fixture(async (workspace, root) => {
  const native = (await create({ title: "Native bound title", type: "probe", status: "busy-now", tags: "gh:fixture/project#1" }, { pmRoot: workspace, noExtensions: true })).item;
  const yaml = JSON.stringify({ name: "Fixture", description: "Fixture", body: [{ type: "input", id: "summary", attributes: { label: "Summary" }, validations: { required: true } }] });
  assert.equal((await completeIssueForm(workspace, { repo: "fixture/project", ref: "main", path: ".github/ISSUE_TEMPLATE/fixture.yml", yaml, item: native.id, bindings: { summary: "title" } })).report.ok, true);
  const before = durable(root);
  await withMockGithub((request, response) => {
    if (request.url === "/graphql") return jsonResponse(response, 200, { data: { repository: { i1: { number: 1, title: "Native bound title", body: "Public context", state: "OPEN", stateReason: "REOPENED",
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: null, url: "https://github.com/fixture/project/issues/1", author: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    if (request.url!.includes("/commits?")) return jsonResponse(response, 200, []);
    return jsonResponse(response, 200, { number: 1, body: `Closes https://github.com/fixture/project/blob/main/.agents/pm/investigations/${native.id}.toon`, merged: false, commits: 0,
      merged_at: null, merge_commit_sha: null, html_url: "https://github.com/fixture/project/pull/1", head: { sha: "a".repeat(40) }, base: { ref: "main", repo: { full_name: "fixture/project" } } });
  }, async server => {
    const report = await runCloseout(workspace, "fixture/project", { pr: "1" }, { base: server.baseUrl, get: url => fetchJSON(url, "fixture"), next: parseNextLink });
    assert.equal(report.plan.find(row => row.item === native.id)!.code, "not_merged");
    const payload = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "fixture/project" }, issue: { number: 1 } }));
    const secret = "fixture-key";
    const delivery = { repo: "fixture/project", delivery: "workspace-1", event: "issues", payload, secret, signature: "sha256=" + createHmac("sha256", secret).update(payload).digest("hex") };
    assert.equal((await acceptGithubWebhook(workspace, delivery)).duplicate, false);
    assert.equal((await acceptGithubWebhook(workspace, delivery)).duplicate, true);
    const reconciled = await withEnv({ GITHUB_TOKEN: "fixture" }, () => reconcileGithubWebhooks(workspace, "fixture/project"));
    assert.equal(reconciled.selected, 1);
    assert.equal(reconciled.retry, 0);
  });
  assert.ok(durable(root) === before, "Previews and intake receipts must not rewrite native items/history.");
}));

/** Behavior at optional-data boundaries, using real trackers and HTTP responses. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as sdk from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, * as github from "../index.ts";
import { formatGateReport } from "../gate.ts";
import { captureStderr, jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";
import { projectItemTag } from "../projects.ts";

const harness = createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });

function tracker(t: TestContext, git = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-coverage-edges-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (git) {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "config", "user.name", "Fixture"]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]).status, 0);
  }
  const result = spawnSync("pm", ["--path", git ? path.join(root, ".agents", "pm") : root, "init", "fixture"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr);
  return git ? path.join(root, ".agents", "pm") : root;
}
function issue(extra: Partial<github.GhIssue> = {}): github.GhIssue {
  return { number: 1, title: "Widget", body: null, state: "open", labels: [], assignee: null, milestone: null,
    created_at: "", updated_at: "", html_url: "https://example.test/acme/widgets/issues/1", user: null, ...extra };
}
function entry(extra: Partial<github.PreparedGithubImport> = {}): github.PreparedGithubImport {
  return { issueNumber: 1, title: "Widget", itemType: "Task", status: "open", description: "d", body: "b",
    tags: ["gh:acme/widgets#1"], comments: [], syncAnnotations: false, ...extra };
}

async function command(root: string, name: string, options: Record<string, unknown> = {}, args: string[] = []) {
  return (await harness).runCommand({ command: name, options, args, pmRoot: root, global: { json: false } });
}

test("optional provenance and dependency data produce complete deterministic plans", () => {
  const bare = { id: "pm-empty" };
  assert.equal(github.indexByProvenance([bare]).size, 0);
  assert.equal(github.buildProvenanceIndexFromMetadata([{ id: "", tags: [] }, bare as github.DepLinkSnapshotItem]).size, 0);
  assert.equal(github.verifyImportIdempotency([{ id: "" }, bare], [], "acme/widgets").matched_by_provenance, 0);
  assert.deepEqual(github.planSync([{ id: "" }, bare, { id: "pm-wrong", tags: ["nonsense", "gh:other/repo#1"] }], "acme/widgets"), []);
  const provenance = new Map([["acme/widgets#1", "pm-source"], ["acme/widgets#2", "pm-source"], ["acme/widgets#3", "pm-target"], ["acme/widgets#4", "pm-target"]]);
  assert.deepEqual(github.planDependencyLinks("acme/widgets", [issue(), issue({ body: "Blocked by #2, #3, #4" })], provenance).edges.map(e => e.targetId), ["pm-target"]);
  assert.equal(github.countDependencyRefCandidates("acme/widgets", [issue()]), 0);
  const plan = github.buildExportPlan([bare], "acme/widgets");
  assert.equal(plan[0]?.payload.title, "(untitled)");
  assert.deepEqual(plan[0]?.payload.labels, []);
  assert.equal(github.isMutatingGithubCommand("", {}), false);
  assert.match(github.buildCommentText({ id: 1, body: "", created_at: "", user: null }), /empty comment/);
  assert.match(github.composeBody(issue(), [{ id: 1, body: "", created_at: "", user: null }]), /@unknown/);
  assert.equal(github.parseImportOptions({ state: "closed" }).state, "closed");
  assert.equal(github.parseImportOptions({ state: "nonsense" }).state, "open");
  const normalized = (id: string) => id;
  for (const match of [undefined, { id: "legacy", status: "open" }]) for (const closedAt of [undefined, "2026-10-01T00:00:00Z"]) {
    const mutations = github.buildAtomicImportMutations("acme/widgets", entry({ status: "closed", closedAt, assignee: "fixture", milestone: "Sprint", match }), "pm-", normalized).mutations;
    assert.ok(mutations.some(m => m.op === "close"));
    assert.equal((mutations[0] as unknown as { options: { assignee: string; sprint: string } }).options.assignee, "fixture");
    assert.equal((mutations[0] as unknown as { options: { sprint: string } }).options.sprint, "Sprint");
  }
  assert.match(formatGateReport({ verdict: "fail", source: "git", scanned_files: 1, added_lines: 1, allowlisted: 0, allowlist_path: "",
    findings: [{ item_id: "", field: "", rule: "email-address", hash: "a".repeat(64) }] }).join("\n"), /unknown field/);
});

test("search corpus falls back to the real complete tracker", async t => {
  const root = tracker(t);
  const created = await sdk.create({ title: "Corpus item", type: "Task" }, { pmRoot: root });
  assert.equal(github.resolveSearchCorpus(undefined, root)[0]?.id, created.item.id);
});

test("empty upstream and gated non-atomic imports retain pass receipts", async t => {
  const root = tracker(t, true);
  for (const atomic of [false, true]) for (const dryRun of [false, true]) {
    const { result } = await captureStderr(() => github.runImport("acme/widgets", root, github.parseImportOptions({ gate: true, atomic, dryRun }), {
      resolveToken: () => undefined, fetchIssues: async () => [],
    }));
    if (!dryRun) assert.ok("gate" in result && result.gate && "verdict" in result.gate && result.gate.verdict === "pass");
  }
  await withMockGithub((_req, res) => jsonResponse(res, 200, [issue()]), async () => {
    const result = await github.runImport("acme/widgets", root, github.parseImportOptions({ gate: true }), { resolveToken: () => undefined });
    assert.ok("gate" in result && result.gate && "verdict" in result.gate && result.gate.verdict === "pass");
    const second = await github.runImport("acme/widgets", root, github.parseImportOptions({ gate: true }), { resolveToken: () => undefined });
    assert.ok("updated" in second && second.updated === 1);
  });
});

test("atomic and plain previews report dependency candidates and PR rendering", async t => {
  const root = tracker(t);
  for (const atomic of [true, false]) {
    const { result, stderr } = await captureStderr(() => github.runImport("acme/widgets", root, github.parseImportOptions({ atomic, dryRun: true, "link-deps": true, "include-prs": true, "comments-mode": "annotations" }), {
      resolveToken: () => undefined, fetchIssues: async () => [issue({ pull_request: {}, state: "closed", state_reason: "completed" })], fetchIssueComments: async () => [],
    }));
    assert.ok("wouldLinkDependencyCandidates" in result && result.wouldLinkDependencyCandidates === 0);
    assert.match(stderr.join("\n"), /link-deps/);
  }
  await assert.rejects(github.runImport("acme/widgets", root, github.parseImportOptions({}), {
    resolveToken: () => undefined, fetchIssues: async () => { throw "transport unavailable"; },
  }), /transport unavailable/);
});

test("sync scoped empty plans and export preview shapes use real local items", async t => {
  const root = tracker(t);
  const item = await sdk.create({ title: "Local", type: "Task", tags: "gh:acme/widgets#1,bug" }, { pmRoot: root });
  const unlinked = await sdk.create({ title: "Unlinked", type: "Task" }, { pmRoot: root });
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, async () => {
    const { result, stderr } = await captureStderr(() => command(root, "github sync", { repo: "acme/widgets", ids: unlinked.item.id }));
    assert.ok(result.result);
    assert.match(stderr.join("\n"), /from --ids/);
    for (const format of ["json", "md", "markdown"]) {
      const preview = await captureStderr(() => command(root, "github export", { format, repo: "acme/widgets", ids: item.item.id, "label-map": "bug=defect" }));
      assert.match(preview.stderr.join("\n"), /Scoped to 1/);
      assert.match(preview.stderr.join("\n"), /Label map applied/);
    }
    const preview = await captureStderr(() => command(root, "github export", { format: "markdown" }));
    assert.match(preview.stderr.join("\n"), /no --repo/);
    assert.match(preview.stderr.join("\n"), /create/);
  });
});

test("scoped sync and labelled export apply preserve receipts after partial remote failure", async t => {
  const root = tracker(t);
  const first = await sdk.create({ title: "Linked", type: "Task", status: "open", tags: "gh:acme/widgets#1" }, { pmRoot: root });
  const second = await sdk.create({ title: "New", type: "Task", tags: "bug" }, { pmRoot: root });
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, async () => {
    await withMockGithub((req, res) => {
      if (req.method === "GET") jsonResponse(res, 200, { state: "closed" });
      else if (req.method === "PATCH") jsonResponse(res, 200, { number: 1 });
      else jsonResponse(res, 422, { message: "refused" });
    }, async () => {
      const preview = await captureStderr(() => command(root, "github sync", { repo: "acme/widgets", ids: first.item.id, "dry-run": true }));
      assert.ok(preview.result.result);
      const synced = await captureStderr(() => command(root, "github sync", { repo: "acme/widgets", ids: first.item.id, apply: true }));
      assert.ok(synced.result.result);
      const exported = await captureStderr(() => command(root, "github export", { repo: "acme/widgets", ids: `${first.item.id},${second.item.id}`, apply: true, "label-map": "bug=defect" }));
      assert.match(exported.stderr.join("\n"), /1 item\(s\) failed/);
    });
  });
});

const meta = { id: "board", title: "Board", url: "https://example.test/board", statusField: { id: "status", name: "Status", options: [{ id: "todo", name: "Todo" }, { id: "done", name: "Done" }] } };
test("Projects HTTP optional content and cursor pages are normalized by the registered handler", async t => {
  const root = tracker(t);
  let pages = 0;
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, async () => {
    await withMockGithub((_req, res, body) => {
      const call = JSON.parse(body) as { query: string; variables: { cursor?: string } };
      if (call.query.includes("projectV2(number:")) jsonResponse(res, 200, { data: { user: { projectV2: { ...meta, title: null, url: null, statusField: { id: "status", name: "Status" } } } } });
      else if (call.query.includes("items(first:")) {
        pages++;
        if (!call.variables.cursor) jsonResponse(res, 200, { data: { node: { items: { pageInfo: { hasNextPage: true, endCursor: "next" }, nodes: [null,
          { content: { __typename: "Issue", number: 1, title: null, repository: { nameWithOwner: "acme/widgets" } } },
          { id: "pr", content: { __typename: "PullRequest", number: 2, title: null } },
          { id: "draft", content: { __typename: "DraftIssue" } },
        ] } } } });
        else jsonResponse(res, 200, { data: { node: { items: { pageInfo: { hasNextPage: false } } } } });
      } else jsonResponse(res, 200, { data: { node: { fields: { nodes: [{ __typename: "ProjectV2SingleSelectField", name: "Status", options: [{ name: "Todo" }] }] } } } });
    }, async () => {
      const fields = await captureStderr(() => command(root, "github project fields", {}, ["acme/5"]));
      assert.match(fields.stderr.join("\n"), /Status.*Todo/);
      const imported = await captureStderr(() => command(root, "github project import", { "dry-run": true }, ["acme/5"]));
      assert.ok(imported.result.result);
      assert.equal(pages, 2);
    });
    for (const payload of [{}, { data: null, errors: [] }]) await withMockGithub((_req, res) => jsonResponse(res, 200, payload), async () => {
      await assert.rejects(command(root, "github project list", {}, ["acme"]), /GraphQL error.*HTTP 200/);
    });
  });
});

test("Projects missing inventory connection returns an empty complete preview", async t => {
  const root = tracker(t);
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((_req, res, body) => {
    const query = (JSON.parse(body) as { query: string }).query;
    jsonResponse(res, 200, { data: query.includes("projectV2(number:") ? { user: { projectV2: meta } } : { node: null } });
  }, async () => {
    const result = await command(root, "github project import", { "dry-run": true }, ["acme/5"]);
    assert.ok(result.result);
  }));
});

test("Projects existing issue import applies mapped open status", async t => {
  const root = tracker(t);
  const item = await sdk.create({ title: "Existing", type: "Task", tags: projectItemTag({ owner: "acme", number: 5 }, "linked") }, { pmRoot: root });
  await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((_req, res, body) => {
    const query = (JSON.parse(body) as { query: string }).query;
    jsonResponse(res, 200, { data: query.includes("projectV2(number:") ? { user: { projectV2: meta } } : { node: { items: { nodes: [
      { id: "linked", fieldValueByName: { name: "Todo", optionId: "todo" }, content: { __typename: "DraftIssue", title: "Updated" } },
    ], pageInfo: {} } } } });
  }, async () => {
    await command(root, "github project import", {}, ["acme/5"]);
    const persisted = await sdk.get(item.item.id, {}, { pmRoot: root });
    assert.equal(persisted.item.title, "Updated");
  }));
});

test("atomic dependency linking records advisory and mutation failures without discarding import", async t => {
  const root = tracker(t);
  const { result, stderr } = await captureStderr(() => github.runImport("acme/widgets", root, github.parseImportOptions({ atomic: true, "link-deps": true }), {
    resolveToken: () => undefined,
    fetchIssues: async () => [issue({ number: 1, body: "Blocked by #2" }), issue({ number: 2, body: "Blocked by #1" })],
  }));
  assert.ok("linkedDependencies" in result);
  assert.match(stderr.join("\n"), /link-deps/);
  const items = github.readPmItems(root);
  assert.equal(items.length, 2);
  const retry = await captureStderr(() => github.runImport("acme/widgets", root, github.parseImportOptions({ atomic: true, "link-deps": true }), {
    resolveToken: () => undefined, fetchIssues: async () => [issue({ body: "Blocked by #2" })],
    applyDependencyLink: () => ({ ok: false, stderr: "fixture write refused" }),
  }));
  assert.ok("dependencyLinkFailures" in retry.result && Array.isArray(retry.result.dependencyLinkFailures) && retry.result.dependencyLinkFailures.length === 1);
  assert.match(retry.stderr.join("\n"), /link failed/);
});

test("export isolates a numbered update failure and search accepts omitted remote hits", async t => {
  const root = tracker(t);
  const { result } = await captureStderr(() => github.applyExportPlan([{
    action: "update", number: 7, payload: { title: "Linked", body: "", labels: [], state: "open" },
  }], "acme/widgets", undefined, async () => { throw new Error("remote write refused"); }));
  assert.equal(result.failures[0]?.number, 7);
  await withEnv({ GITHUB_TOKEN: "fixture-token" }, () => withMockGithub((_req, res) => jsonResponse(res, 200, {}), async () => {
    const hits = await (await harness).runSearchProvider({ provider: "github", operation: "query", context: { query: "widget", options: { "github-repo": "acme/widgets" }, documents: [], pm_root: root } as never });
    assert.deepEqual(hits, []);
  }));
});

test("public validate warns at low unauthenticated quota without consulting host credentials", async t => {
  const root = tracker(t);
  const tools = path.join(root, "tools");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "gh"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture; exit 0; fi\nexit 1\n', { mode: 0o755 });
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: tools + path.delimiter + process.env.PATH }, () => withMockGithub((_req, res) => {
    jsonResponse(res, 200, {}, { "x-ratelimit-remaining": "1", "x-ratelimit-limit": "60" });
  }, async () => {
    const { stderr } = await captureStderr(() => command(root, "github validate", { repo: "acme/widgets" }));
    assert.match(stderr.join("\n"), /raise it \(60→5000\/hr\)/);
  }));
});

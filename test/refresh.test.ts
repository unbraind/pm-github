/** Refresh acceptance uses actual initialized trackers and the real HTTP transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, cpSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { create, get, comments, listAllComplete, readHistorySnapshot, getHistoryPath, deleteItem, readSettings, normalizeItemId, commitImportedItem, getItemPath } from "@unbrained/pm-cli/sdk";
import extension, { buildAtomicImportMutations, deriveAtomicItemId, importGithubAtomic, parseImportOptions, prepareGithubImport } from "../index.ts";
import { fetchImportTimeline } from "../import-fidelity.ts";
import { runRefresh, selectRefreshTargets, refreshChanges } from "../refresh.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { withEnv, withMockGithub, jsonResponse, type MockGithubHandler } from "./helpers/mock-github-server.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";

const packageRoot = join(import.meta.dirname, "..");
const cli = join(packageRoot, "node_modules/.bin/pm");
/** Give every scenario a fresh real tracker and route all PM calls explicitly. */
async function tracker(fn: (directory: string, pmRoot: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pm-refresh-"));
  const pmRoot = join(directory, ".agents/pm");
  try {
    for (const [bin, args] of [["git", ["init", "-q", "-b", "main"]], [cli, ["--path", pmRoot, "init", "refresh-fixture"]]] as const) {
      const result = spawnSync(bin, args, { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    await withEnv({ PM_PATH: pmRoot, PM_AUTHOR: "fixture", GITHUB_TOKEN: "fixture",
      PATH: join(packageRoot, "node_modules/.bin") + delimiter + process.env.PATH }, () => fn(directory, pmRoot));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** One GraphQL issue with stable historical source dates. */
function node(number = 1, state = "OPEN", reason: string | null = null) {
  return { number, title: `Upstream ${number}`, body: "upstream body", state, stateReason: reason,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-03T00:00:00Z", closedAt: state === "CLOSED" ? "2026-02-02T00:00:00Z" : null,
    url: `https://github.com/fixture/repo/issues/${number}`, author: { login: "fixture" } as { login: string } | null,
    labels: { nodes: [{ name: "bug" }], pageInfo: { hasNextPage: false, endCursor: null as string | null } } };
}
/** Read every tracker file, including history and journals, for exact no-write proofs. */
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = join(entry.parentPath, entry.name);
    return [file, readFileSync(file, "hex")];
  }));
}
/** Replay issue batches, while the importer's closure timeline reader uses its normal endpoints. */
function transport(nodes: Record<string, ReturnType<typeof node> | null>, errors?: Array<{ type: string; message: string; path?: string[] }>): MockGithubHandler {
  return (request, response, body) => {
    if (request.url?.includes("/timeline")) { jsonResponse(response, 200, []); return; }
    const payload = JSON.parse(body) as { query: string };
    if (payload.query.includes("timelineItems")) {
      jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      return;
    }
    const selected = Object.fromEntries([...payload.query.matchAll(/(i\d+): issue\(number:(\d+)\)/g)].map(match => [match[1], nodes[match[1]!] ?? null]));
    jsonResponse(response, 200, { data: { repository: selected }, errors });
  };
}

for (const atomic of [false, true]) {
  test(`refresh only linked items with zero creates, real dates, labels, audit and reopen (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    const linked = (await create({ title: "Stale", type: "Task", tags: "gh:fixture/repo#1,old-label", body: "keep local body" }, { pmRoot })).item;
    const other = (await create({ title: "Other repo", tags: "gh:fixture/other#2" }, { pmRoot })).item;
    const unrelated = (await create({ title: "Unlinked", body: "See https://github.com/fixture/repo/issues/3" }, { pmRoot })).item;
    const otherBefore = (await get(other.id, {}, { pmRoot })).item;
    const unrelatedBefore = (await get(unrelated.id, {}, { pmRoot })).item;
    const upstreams = new Map([[1, node(1, "CLOSED", "COMPLETED")]]);
    const upstream = upstreams.get(1)!;
    await withMockGithub((...args) => transport({ i1: upstreams.get(1)!, i2: node(2), i3: node(3) })(...args), async server => {
      const before = snapshot(pmRoot);
      const preview = await runRefresh("FIXTURE/REPO", pmRoot, { atomic, "dry-run": true });
      assert.equal(preview.updated, 1);
      assert.deepEqual(preview.plan.map(row => row.id), [linked.id]);
      assert.ok(preview.plan[0]!.changes.some(change => change.field === "closed_at" && change.new === upstream.closedAt));
      assert.deepEqual(snapshot(pmRoot), before);
      const receipt = await runRefresh("fixture/repo", pmRoot, { atomic });
      assert.deepEqual(receipt.plan, preview.plan);
      assert.equal(receipt.created, 0);
      const actual = (await get(linked.id, {}, { pmRoot })).item;
      assert.equal(actual.status, "closed");
      assert.equal(actual.completed_at, upstream.closedAt);
      assert.equal(actual.closed_at, upstream.closedAt);
      assert.equal(actual.created_at, upstream.createdAt);
      assert.equal(actual.github_updated_at, upstream.updatedAt);
      assert.equal(actual.github_state, "closed");
      assert.match(actual.close_reason!, /Closed on GitHub as completed on 2026-02-02/);
      assert.equal(actual.title, "Upstream 1");
      assert.equal(actual.type, "Task");
      assert.equal(actual.body, "keep local body");
      assert.deepEqual(actual.tags, ["bug", "gh:fixture/repo#1", "github_author:fixture"]);
      assert.equal((await comments(linked.id, {}, { pmRoot })).comments.length, 1);
      assert.equal((await listAllComplete({}, { pmRoot })).items.length, 3);
      assert.deepEqual((await get(other.id, {}, { pmRoot })).item, otherBefore);
      assert.deepEqual((await get(unrelated.id, {}, { pmRoot })).item, unrelatedBefore);
      const history = await readHistorySnapshot(getHistoryPath(pmRoot, linked.id), linked.id);
      assert.equal(history.entries.filter(entry => entry.op === "create").length, 1);
      await listAllComplete({ includeBody: true }, { pmRoot, cwd: pmRoot, noExtensions: true });
      const stable = snapshot(pmRoot);
      assert.equal((await runRefresh("fixture/repo", pmRoot, { atomic })).unchanged, 1);
      assert.deepEqual(snapshot(pmRoot), stable);
      upstreams.set(1, node(1, "OPEN", "REOPENED"));
      await runRefresh("fixture/repo", pmRoot, { atomic });
      const open = (await get(linked.id, {}, { pmRoot })).item;
      assert.equal(open.status, "open");
      for (const field of ["closed_at", "completed_at", "close_reason"]) assert.equal(open[field], undefined);
      upstreams.set(1, node(1, "CLOSED", "NOT_PLANNED"));
      await runRefresh("fixture/repo", pmRoot, { atomic });
      assert.equal((await get(linked.id, {}, { pmRoot })).item.status, "canceled");
      assert.ok(server.requests.filter(request => request.url === "/graphql" && !request.body.includes("timelineItems")).every(request => request.body.includes("i1: issue") && !request.body.includes("i2:")));
    });
  }));
}

test("explicit fields select existing owners; mentions, wrong repos, malformed and ambiguous links are refused", () => {
  assert.deepEqual(selectRefreshTargets([
    { id: "url", github_url: "https://github.com/FIXTURE/REPO/issues/2" },
    { id: "fields", github_repo: "FIXTURE/REPO", github_number: 3 },
    { id: "pr", github_url: "https://github.com/fixture/repo/pull/4/" },
    { id: "wrong", github_url: "https://github.com/fixture/other/issues/8" },
    { id: "badurl", github_url: "mention" },
    { id: "wrong-fields", github_repo: "fixture/other", github_number: 8 },
    { id: "bad-fields", github_repo: "fixture/repo", github_number: "3" },
    { id: "text", github_number: 9, body: "https://github.com/fixture/repo/issues/9" }, {},
  ], "fixture/repo").map(target => [target.id, target.number]), [["url", 2], ["fields", 3], ["pr", 4]]);
  for (const items of [
    [{ id: "a", tags: ["gh:fixture/repo#1", "gh:fixture/repo#2"] }],
    [{ id: "a", tags: ["gh:fixture/repo#1"] }, { id: "b", github_url: "https://github.com/fixture/repo/issues/1" }],
    [{ id: "a", tags: ["gh:fixture/repo#0"] }],
    [{ id: "a", github_repo: "fixture/repo", github_number: Number.MAX_SAFE_INTEGER + 1 }],
  ]) assert.throws(() => selectRefreshTargets(items, "fixture/repo"));
});

test("missing, transferred and forbidden issues have typed reports and no writes", async () => tracker(async (_directory, pmRoot) => {
  for (let number = 1; number <= 6; number++) await create({ title: `Local ${number}`, tags: `gh:fixture/repo#${number}` }, { pmRoot });
  const upstream = { i1: null, i2: { ...node(2), url: "https://github.com/fixture/other/issues/2" }, i3: null,
    i4: node(4), i5: { ...node(5), title: " " }, i6: { ...node(6), number: 77 } };
  await withMockGithub(transport(upstream, [
    { type: "NOT_FOUND", message: "gone", path: ["repository", "i1"] },
    { type: "FORBIDDEN", message: "hidden", path: ["repository", "i3"] },
    { type: "OTHER", message: "failure", path: ["repository", "i4"] },
  ]), async () => {
    await listAllComplete({ includeBody: true }, { pmRoot, cwd: pmRoot, noExtensions: true });
    const before = snapshot(pmRoot);
    const receipt = await runRefresh("fixture/repo", pmRoot, { atomic: true });
    assert.equal(receipt.missing, 6);
    assert.deepEqual(receipt.plan.map(row => row.reason), ["not_found_or_inaccessible", "transferred", "inaccessible", "api_error", "invalid_issue", "invalid_issue"]);
    assert.deepEqual(snapshot(pmRoot), before);
  });
}));

test("100-item batches and limits only request selected linked numbers; since uses upstream timestamps", async () => tracker(async (_directory, pmRoot) => {
  const nodes: Record<string, ReturnType<typeof node>> = {};
  const settings = await readSettings(pmRoot);
  for (let number = 1; number <= 101; number++) {
    const id = `${settings.id_prefix}batch-${number}`;
    await commitImportedItem({ pmRoot, id, itemPath: getItemPath(pmRoot, "Task", id), settings,
      document: { metadata: { id, title: `Local ${number}`, description: "", type: "Task", status: "open", priority: 2,
        tags: [`gh:fixture/repo#${number}`], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }, body: "" },
      author: "fixture", message: "Seed linked batch fixture", conflictWarningPrefix: "fixture" });
    nodes[`i${number}`] = node(number);
  }
  await withMockGithub(transport(nodes), async server => {
    const before = snapshot(pmRoot);
    const receipt = await runRefresh("fixture/repo", pmRoot, { "dry-run": true });
    assert.equal(receipt.updated, 101);
    assert.deepEqual(server.requests.map(request => (request.body.match(/: issue\(number:/g) ?? []).length), [100, 1]);
    const filtered = await runRefresh("fixture/repo", pmRoot, { "dry-run": true, since: "2026-03-01", limit: "2" });
    assert.equal(filtered.selected, 2);
    assert.equal(filtered.filtered, 2);
    assert.equal(filtered.updated, 0);
    const included = await runRefresh("fixture/repo", pmRoot, { "dry-run": true, since: "2026-01-01", limit: "1" });
    assert.equal(included.updated, 1);
    assert.deepEqual(snapshot(pmRoot), before);
  });
}));

test("update-only import refuses absent matches and cannot upsert a missing deterministic target", async () => tracker(async (_directory, pmRoot) => {
  const prefix = (await readSettings(pmRoot)).id_prefix;
  const id = deriveAtomicItemId("fixture/repo", 1, prefix, normalizeItemId);
  const local = (await create({ id, title: "Linked", tags: "gh:fixture/repo#1" }, { pmRoot })).item;
  const entry = (await prepareGithubImport({ number: 1, title: "New", body: null, state: "open", labels: [], assignee: null, milestone: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z", html_url: "https://github.com/fixture/repo/issues/1" },
  "fixture/repo", parseImportOptions({}), "fixture", local, undefined, { items: [local], releases: [], timeline: fetchImportTimeline }))!;
  assert.ok(refreshChanges({ ...entry, match: { ...local, tags: undefined } }).some(change => change.field === "github_state"));
  assert.throws(() => buildAtomicImportMutations("fixture/repo", { ...entry, match: undefined }, prefix, normalizeItemId, true), /unlinked target/);
  const mutations = buildAtomicImportMutations("fixture/repo", entry, prefix, normalizeItemId, true).mutations;
  assert.deepEqual(mutations.map(mutation => mutation.op), ["update"]);
  await deleteItem(local.id, {}, { pmRoot });
  await assert.rejects(() => importGithubAtomic(pmRoot, "fixture/repo", [entry], { updateOnly: true }));
  assert.equal((await listAllComplete({}, { pmRoot })).items.length, 0);
}));

test("registered command executes against a real tracker and rejects usage before transport", async () => tracker(async (directory, pmRoot) => {
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const handler = harness.activation.commands.handlers.find(handler => handler.command === "github refresh")!;
  assert.ok(handler);
  harness.assertCommandContract({ name: "github refresh", flags: ["--dry-run", "--since", "--limit", "--atomic"] });
  for (const repo of [undefined, "invalid", "a/b/c", 'a/"b']) await assert.rejects(() => runRefresh(repo, pmRoot, {}), /Usage/);
  await assert.rejects(() => runRefresh("fixture/repo", pmRoot, { limit: "0" }), /positive integer/);
  assert.equal((await runRefresh("fixture/repo", pmRoot, {})).selected, 0);
  await harness.runCommand({ command: "github refresh", args: ["fixture/repo"], pmRoot, options: { "dry-run": true } });
  const installed = join(pmRoot, "extensions", "pm-github");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  for (const file of ["manifest.json", "package.json"]) copyFileSync(join(packageRoot, file), join(installed, file));
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const help = await boundedCli(cli, ["--path", pmRoot, "github", "refresh", "--help"], directory, process.env);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /ascending\s+order/);
  assert.doesNotMatch(help.stdout, /newest-updated/);
  const result = await boundedCli(cli, ["--path", pmRoot, "github", "refresh", "fixture/repo", "--dry-run", "--json"], directory, process.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { created: number }).created, 0);
}));

test("label pagination is complete and cursor or API failures abort before any item writes", async () => tracker(async (_directory, pmRoot) => {
  await create({ title: "Labels", tags: "gh:fixture/repo#1" }, { pmRoot });
  const issue = node();
  issue.author = null;
  issue.labels.pageInfo = { hasNextPage: true, endCursor: "page-1" };
  for (const mode of ["complete", "missing-cursor", "repeated-cursor", "error"]) {
    await withMockGithub((_request, response, body) => {
      const payload = JSON.parse(body) as { variables: { cursor?: string } };
      if (payload.variables.cursor) {
        jsonResponse(response, 200, { data: { repository: { issue: { labels: {
          nodes: [{ name: "second-page" }], pageInfo: { hasNextPage: mode === "repeated-cursor", endCursor: "page-1" },
        } } } }, ...(mode === "error" ? { errors: [{ message: "denied" }] } : {}) });
      } else jsonResponse(response, 200, { data: { repository: { i1: { ...issue,
        labels: { ...issue.labels, pageInfo: { hasNextPage: true, endCursor: mode === "missing-cursor" ? null : "page-1" } },
      } } } });
    }, async server => {
      const before = snapshot(pmRoot);
      if (mode === "complete") {
        const result = await runRefresh("fixture/repo", pmRoot, { "dry-run": true });
        assert.ok((result.plan[0]!.changes.find(change => change.field === "tags")!.new as string[]).includes("second-page"));
        assert.equal(server.requests.length, 2);
      } else await assert.rejects(() => runRefresh("fixture/repo", pmRoot, { "dry-run": true }), /cursor|every label/);
      assert.deepEqual(snapshot(pmRoot), before);
    });
  }
}));

test("sparse, repository-level and pathless GraphQL failures remain typed and cannot mutate items", async () => tracker(async (_directory, pmRoot) => {
  await create({ title: "Linked", tags: "gh:fixture/repo#1" }, { pmRoot });
  for (const [data, errors, reason] of [
    [{ repository: {} }, undefined, "incomplete_response"],
    [{ repository: null }, undefined, "not_found_or_inaccessible"],
    [{ repository: {} }, [{ type: "FORBIDDEN", message: "denied", path: ["repository"] }], "inaccessible"],
    [{ repository: { i1: node() } }, [{ type: "OTHER", message: "denied" }], "api_error"],
    [{ repository: { i1: { ...node(), state: "UNKNOWN" } } }, undefined, "invalid_issue"],
    [{ repository: { i1: node() } }, [{ type: "OTHER", message: "unrelated", path: ["other"] }], undefined],
  ] as const) {
    await withMockGithub((_request, response) => jsonResponse(response, 200, { data, errors }), async () => {
      const result = await runRefresh("fixture/repo", pmRoot, { "dry-run": true });
      assert.equal(result.plan[0]!.reason, reason);
      assert.equal(result.updated, reason === undefined ? 1 : 0);
    });
  }
}));

test("field-linked GitHub and cross-provider owners refresh without replacing local provider context", async () => tracker(async (_directory, pmRoot) => {
  const settings = await readSettings(pmRoot);
  const localItems: Array<{ id: string; created_at: string }> = [];
  for (const [number, linkOnly] of [[1, false], [2, true]] as const) {
    const local = (await create({ title: "Local owner", type: "Task", status: "in_progress", body: "provider context" }, { pmRoot })).item;
    await commitImportedItem({ pmRoot, id: local.id, itemPath: getItemPath(pmRoot, "Task", local.id), settings,
      document: { metadata: { ...local, github_url: `https://github.com/fixture/repo/issues/${number}`, github_link_only: linkOnly }, body: "provider context" },
      author: "fixture", message: "Seed explicit existing link", conflictWarningPrefix: "fixture" });
    localItems.push(local);
  }
  await withMockGithub(transport({ i1: node(), i2: node(2, "CLOSED", "COMPLETED") }), async () => {
    const preview = await runRefresh("fixture/repo", pmRoot, { "dry-run": true });
    assert.equal(preview.updated, 2);
    const providerPreview = preview.plan.find(row => row.number === 2)!;
    assert.ok(providerPreview.changes.every(change => !["title", "status", "created_at", "completed_at", "closed_at"].includes(change.field)));
    await runRefresh("fixture/repo", pmRoot, { atomic: true });
    const provider = (await get(localItems[1]!.id, {}, { pmRoot })).item;
    assert.equal(provider.title, "Local owner");
    assert.equal(provider.status, "in_progress");
    assert.equal(provider.created_at, localItems[1]!.created_at);
    assert.equal(provider.body, "provider context");
    assert.equal(provider.closed_at, undefined);
    assert.equal(provider.github_state, "closed");
    assert.equal((await comments(provider.id, {}, { pmRoot })).comments.length, 1);
    assert.equal((await listAllComplete({}, { pmRoot })).items.length, 2);
  });
}));

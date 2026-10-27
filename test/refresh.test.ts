/** Refresh acceptance uses actual initialized trackers and the real HTTP transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, cpSync, copyFileSync, symlinkSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { WorkspaceTransactionInterruptedError, create, update, get, comments, listAllComplete, readHistorySnapshot, getHistoryPath, deleteItem, readSettings, normalizeItemId, commitImportedItem, getItemPath } from "@unbrained/pm-cli/sdk";
import extension, {
  buildAtomicImportMutations, deriveAtomicItemId, importGithubAtomic, listUnfinishedGithubImports,
  parseImportOptions, prepareGithubImport, readGithubImportPlan, resumeGithubImport,
  validateGithubImportPlan, type GithubImportPlanRecord,
} from "../index.ts";
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
  test(`apply then re-apply preserves every byte and history line without cache priming (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    const linked = (await create({ title: "Stale", tags: "gh:fixture/repo#1,area,api" }, { pmRoot })).item;
    const upstream = node();
    upstream.labels.nodes.push({ name: "second-label" });
    upstream.labels.nodes.push(...["area,api", '["json"]', 'quote"tag', " É,ß "].map(name => ({ name })));
    const upstreams = new Map([[1, upstream]]);
    await withMockGithub((...args) => transport({ i1: upstreams.get(1)! })(...args), async () => {
      assert.equal((await runRefresh("fixture/repo", pmRoot, { atomic })).updated, 1);
      const written = (await get(linked.id, {}, { pmRoot })).item;
      assert.ok(written.tags!.includes("area,api"));
      assert.ok(written.tags!.includes('["json"]'));
      assert.ok(!written.tags!.includes("area") && !written.tags!.includes("api"));
      const before = snapshot(pmRoot);
      const historyLines = readFileSync(getHistoryPath(pmRoot, linked.id), "utf8").trimEnd().split("\n").length;
      const repeated = await runRefresh("fixture/repo", pmRoot, { atomic });
      assert.equal(repeated.updated, 0);
      assert.equal(repeated.unchanged, 1);
      assert.deepEqual(snapshot(pmRoot), before);
      assert.equal(readFileSync(getHistoryPath(pmRoot, linked.id), "utf8").trimEnd().split("\n").length, historyLines);
      // Identical source instants and labels can arrive in another representation.
      upstreams.set(1, { ...upstream, createdAt: "2026-01-01T01:00:00+01:00", updatedAt: "2026-02-03T00:00:00.000Z",
        title: "  Upstream 1  ", labels: { ...upstream.labels, nodes: [...upstream.labels.nodes].reverse() } });
      const normalized = await runRefresh("fixture/repo", pmRoot, { atomic });
      assert.equal(normalized.updated, 0);
      assert.equal(normalized.unchanged, 1);
      assert.deepEqual(normalized.plan[0]!.changes, []);
      assert.deepEqual(snapshot(pmRoot), before);
      assert.equal(readFileSync(getHistoryPath(pmRoot, linked.id), "utf8").trimEnd().split("\n").length, historyLines);
      upstreams.set(1, { ...upstreams.get(1)!, updatedAt: "2026-02-04T00:00:00Z" });
      const genuine = await runRefresh("fixture/repo", pmRoot, { atomic });
      assert.equal(genuine.updated, 1);
      assert.deepEqual(genuine.plan[0]!.changes.map(change => change.field), ["github_updated_at"]);
      const refreshed = (await get(linked.id, {}, { pmRoot })).item;
      assert.equal(refreshed.github_updated_at, "2026-02-04T00:00:00Z");
      assert.equal(refreshed.created_at, upstream.createdAt);
      assert.equal(refreshed.github_created_at, upstream.createdAt);
    });
  }));

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

test("GraphQL bot authors retain REST bot-tag spelling across repeated refreshes", async () => tracker(async (_directory, pmRoot) => {
  const linked = (await create({ title: "Stale", tags: "gh:fixture/repo#1,github_author:fixture-bot[bot]" }, { pmRoot })).item;
  const upstreams = new Map([[1, { ...node(), author: { login: "fixture-bot", __typename: "Bot" } }]]);
  await withMockGithub((...args) => transport({ i1: upstreams.get(1)! })(...args), async () => {
    const first = await runRefresh("fixture/repo", pmRoot, { atomic: true });
    const tags = first.plan[0]!.changes.find(change => change.field === "tags")!.new as string[];
    assert.ok(tags.includes("github_author:fixture-bot[bot]"));
    assert.ok(!tags.includes("github_author:fixture-bot"));
    const before = snapshot(pmRoot);
    for (const login of ["fixture-bot", "fixture-bot[bot]"]) {
      upstreams.set(1, { ...node(), author: { login, __typename: "Bot" } });
      assert.equal((await runRefresh("fixture/repo", pmRoot, { atomic: true })).updated, 0);
      assert.deepEqual(snapshot(pmRoot), before);
    }
    assert.ok((await get(linked.id, {}, { pmRoot })).item.tags!.includes("github_author:fixture-bot[bot]"));
  });
}));

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
  ], "fixture/repo").map(target => [target.id, target.number]), [["url", 2], ["fields", 3]]);
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
  const nodes: Record<string, ReturnType<typeof node>> = Object.create(null);
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
  const synchronized = { ...entry, match: { ...local, ...Object.fromEntries(refreshChanges(entry).map(change => [change.field, change.new])) } };
  for (const linkOnly of [false, true]) {
    const noOp = buildAtomicImportMutations("fixture/repo", { ...synchronized, linkOnly }, prefix, normalizeItemId, true).mutations[0]!;
    assert.equal(noOp.op, "update");
    if (noOp.op === "update") assert.deepEqual(Object.keys(noOp.options!), ["comment"]);
  }
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
  for (const mode of ["complete", "missing-cursor", "repeated-cursor", "error", "null-repository", "null-issue"]) {
    await withMockGithub((_request, response, body) => {
      const payload = JSON.parse(body) as { variables: { cursor?: string } };
      if (payload.variables.cursor) {
        // A repository or issue can disappear between requests (transfer or
        // deletion); both must surface as a typed CommandError, not a TypeError.
        const labels = { nodes: [{ name: "second-page" }], pageInfo: { hasNextPage: mode === "repeated-cursor", endCursor: "page-1" } };
        const repository = mode === "null-repository" ? null
          : mode === "null-issue" ? { issue: null }
            : { issue: { labels } };
        jsonResponse(response, 200, { data: { repository }, ...(mode === "error" ? { errors: [{ message: "denied" }] } : {}) });
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

test("refresh preserves an existing release when GitHub has no release evidence", async () => tracker(async (_directory, pmRoot) => {
  const settings = await readSettings(pmRoot);
  const id = `${settings.id_prefix}release-owner`;
  await commitImportedItem({ pmRoot, id, itemPath: getItemPath(pmRoot, "Task", id), settings,
    document: { metadata: { id, title: "Release owner", description: "", type: "Task", status: "open", priority: 2,
      tags: ["gh:fixture/repo#1"], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", release: "v2026.9.1" }, body: "" },
    author: "fixture", message: "Seed release fixture", conflictWarningPrefix: "fixture" });
  await withMockGithub(transport({ i1: node() }), async () => {
    const receipt = await runRefresh("fixture/repo", pmRoot, { atomic: true });
    assert.equal(receipt.updated, 1);
    assert.ok(!receipt.plan[0]!.changes.some(change => change.field === "release"),
      "an open issue never has GitHub release evidence, so the local release is not a change");
    assert.equal((await get(id, {}, { pmRoot })).item.release, "v2026.9.1");
    const repeated = await runRefresh("fixture/repo", pmRoot, { atomic: true });
    assert.equal(repeated.unchanged, 1);
    assert.equal((await get(id, {}, { pmRoot })).item.release, "v2026.9.1");
  });
}));

test("journal scan lists unfinished github-import transactions without changing tracker bytes", async () => tracker(async (_directory, pmRoot) => {
  const journalDir = join(pmRoot, "transactions", "sdk");
  const planDir = join(pmRoot, "transactions", "pm-github");
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const journal = (id: string, body: string) => writeFileSync(join(journalDir, `${id}.json`), body);
  journal("github-import-0000000000000001", JSON.stringify({ transactionId: "github-import-0000000000000001", status: "applying",
    stepIds: ["1-update-pm-a-0123456789ab", 7, "junk", "2-create-pm-b-ffffffffffff"] }));
  journal("github-import-0000000000000002", JSON.stringify({ transactionId: "github-import-0000000000000002", status: "compensating", stepIds: [] }));
  journal("github-import-0000000000000003", JSON.stringify({ transactionId: "github-import-0000000000000003", status: "committed" }));
  journal("github-import-0000000000000006", JSON.stringify({ transactionId: "github-import-0000000000000006", status: "applying" }));
  writeFileSync(join(journalDir, "unrelated.json"), "{}");
  writeFileSync(join(journalDir, "github-import-notes.txt"), "");
  writeFileSync(join(planDir, "github-import-0000000000000001.json"), "{}");
  writeFileSync(join(planDir, "github-import-0000000000000003.json"), "{}");
  writeFileSync(join(planDir, "github-import-0000000000000009.json"), "{}");
  writeFileSync(join(planDir, "unrelated.json"), "{}");
  const before = snapshot(pmRoot);
  assert.deepEqual(await listUnfinishedGithubImports(pmRoot), [
    { transactionId: "github-import-0000000000000001", status: "applying", itemIds: ["pm-a", "pm-b"] },
    { transactionId: "github-import-0000000000000002", status: "compensating", itemIds: [] },
    { transactionId: "github-import-0000000000000006", status: "applying", itemIds: [] },
  ]);
  assert.ok(existsSync(join(planDir, "github-import-0000000000000001.json")), "an unfinished journal keeps its replay plan");
  assert.ok(existsSync(join(planDir, "github-import-0000000000000003.json")), "scanning never deletes plans");
  assert.ok(existsSync(join(planDir, "github-import-0000000000000009.json")), "orphan plans remain untouched");
  assert.deepEqual(snapshot(pmRoot), before);
  for (const body of ["{ not json", "null", "7"]) {
    journal("github-import-0000000000000004", body);
    await assert.rejects(() => listUnfinishedGithubImports(pmRoot), /GitHub transaction github-import-0000000000000004.*unreadable/);
  }
  assert.ok(existsSync(join(planDir, "unrelated.json")));
  assert.equal(await readGithubImportPlan(pmRoot, "../outside"), null);
  assert.equal(await readGithubImportPlan(pmRoot, "github-import-0000000000000010"), null);
}));

test("an inaccessible journal directory cannot masquerade as an ordinary no-op", async () => tracker(async (_directory, pmRoot) => {
  mkdirSync(join(pmRoot, "transactions"), { recursive: true });
  writeFileSync(join(pmRoot, "transactions", "sdk"), "not a directory");
  const before = snapshot(pmRoot);
  await assert.rejects(() => runRefresh("fixture/repo", pmRoot, {}), /cannot inspect GitHub transaction journals/);
  assert.deepEqual(snapshot(pmRoot), before);
}));

test("an unfinished journal with unknown targets fails closed before filtering", async () => tracker(async (_directory, pmRoot) => {
  const journalDir = join(pmRoot, "transactions", "sdk");
  mkdirSync(journalDir, { recursive: true });
  const transactionId = "github-import-unknown-targets";
  writeFileSync(join(journalDir, `${transactionId}.json`), JSON.stringify({ transactionId, status: "applying" }));
  const before = snapshot(pmRoot);
  await assert.rejects(() => runRefresh("fixture/repo", pmRoot, {}), new RegExp(`transaction ${transactionId}.*original plan is missing`));
  assert.deepEqual(snapshot(pmRoot), before);
}));

test("resume refuses plan records without a usable transaction or linked target", async () => tracker(async (_directory, pmRoot) => {
  await assert.rejects(() => resumeGithubImport(pmRoot, {} as GithubImportPlanRecord), /persisted plan is invalid/);
  await assert.rejects(() => resumeGithubImport(pmRoot, { transactionId: "bad id!", repo: "fixture/repo", entries: [], mutations: [] }), /persisted plan is invalid/);
  const base = { transactionId: "github-import-0000000000000007", repo: "fixture/repo", mutations: [{ op: "update", id: "fixture" }] };
  await assert.rejects(() => resumeGithubImport(pmRoot, { ...base, entries: [{}] } as unknown as GithubImportPlanRecord), /unlinked target/);
  await assert.rejects(() => resumeGithubImport(pmRoot, { ...base, entries: [{ issueNumber: 1 }] } as unknown as GithubImportPlanRecord), /unlinked target/);
}));

for (const boundary of ["step_applied", "committing"]) {
  test(`an interrupted atomic refresh is resumed from its persisted plan before the unchanged filter (${boundary})`, async () => tracker(async (_directory, pmRoot) => {
    // A real child process dies after the first mutation or after finalization,
    // preserving the durable journal and original complete plan for recovery.
    const crash = spawnSync(process.execPath, [join(packageRoot, "test", "fixtures", "refresh-crash.ts"), pmRoot, boundary], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(crash.status, 9, crash.stderr);
    const journalDir = join(pmRoot, "transactions", "sdk");
    const planDir = join(pmRoot, "transactions", "pm-github");
    const journalNames = readdirSync(journalDir);
    assert.equal(journalNames.length, 1);
    const transactionId = journalNames[0]!.slice(0, -".json".length);
    assert.match(transactionId, /^github-import-[0-9a-f]{16}$/);
    assert.equal(JSON.parse(readFileSync(join(journalDir, journalNames[0]!), "utf8")).status, "applying");
    const planFile = join(planDir, `${transactionId}.json`);
    const plan = readFileSync(planFile, "utf8");
    const linked = (await listAllComplete({ includeBody: true }, { pmRoot, cwd: pmRoot, noExtensions: true })).items[0]!;
    assert.equal(linked.title, "New upstream title");
    assert.equal((await comments(linked.id, {}, { pmRoot })).comments.length, 1);
    // An unfinished journal for an unselected item must neither block nor resume.
    const unrelated = "github-import-ffffffffffffffff";
    writeFileSync(join(journalDir, `${unrelated}.json`), JSON.stringify({ transactionId: unrelated, status: "applying", stepIds: ["1-update-pm-unrelated-0123456789ab"] }));
    // The crashed process cannot release its writer lock; simulate lock TTL expiry.
    rmSync(join(pmRoot, "locks"), { recursive: true, force: true });
    await withMockGithub(transport({ i1: { ...node(1, "CLOSED", "COMPLETED"), title: "New upstream title" } }), async () => {
      await assert.rejects(() => runRefresh("fixture/repo", pmRoot, { atomic: true, "dry-run": true }),
        new RegExp(`GitHub transaction ${transactionId} is unfinished`));
      rmSync(planFile);
      await assert.rejects(() => runRefresh("fixture/repo", pmRoot, { atomic: true }),
        new RegExp(`unfinished GitHub transaction ${transactionId}.*original plan is missing`));
      writeFileSync(planFile, JSON.stringify({ ...JSON.parse(plan), transactionId: "github-import-wrong" }));
      await assert.rejects(() => runRefresh("fixture/repo", pmRoot, { atomic: true }), /original plan is missing or mismatched/);
      writeFileSync(planFile, plan);
      const receipt = await runRefresh("fixture/repo", pmRoot, { atomic: true, limit: "1" });
      assert.equal(JSON.parse(readFileSync(join(journalDir, `${transactionId}.json`), "utf8")).status, "committed");
      assert.equal(receipt.resumed, 1);
      assert.equal(receipt.updated, 0);
      assert.equal(receipt.unchanged, 1);
      assert.deepEqual(receipt.plan[0]!.changes, []);
      assert.ok(!existsSync(planFile), "the replayed plan record is removed");
      assert.equal((await comments(linked.id, {}, { pmRoot })).comments.length, 1, "resume does not duplicate the audit comment");
      const completed = (await get(linked.id, {}, { pmRoot })).item;
      assert.equal(completed.title, "New upstream title");
      assert.equal(completed.status, "closed");
      assert.equal(completed.closed_at, "2026-02-02T00:00:00Z");
      const before = snapshot(pmRoot);
      const again = await runRefresh("fixture/repo", pmRoot, { atomic: true });
      assert.equal(again.resumed, 0);
      assert.equal(again.unchanged, 1);
      assert.deepEqual(snapshot(pmRoot), before);
      assert.ok(existsSync(join(journalDir, `${unrelated}.json`)), "an unrelated journal is left to its own recovery");
      assert.ok(!existsSync(join(planDir, `${unrelated}.json`)), "no plan is invented for the unrelated journal");
    });
  }));
}

/** Leave a real SDK journal applying and return its complete original plan. */
function interruptedPlan(pmRoot: string, number = 1): GithubImportPlanRecord {
  const crash = spawnSync(process.execPath, [join(packageRoot, "test/fixtures/refresh-crash.ts"), pmRoot, "committing", String(number)], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(crash.status, 9, crash.stderr);
  rmSync(join(pmRoot, "locks"), { recursive: true, force: true });
  const plans = readdirSync(join(pmRoot, "transactions/pm-github")).map(file =>
    JSON.parse(readFileSync(join(pmRoot, "transactions/pm-github", file), "utf8")) as GithubImportPlanRecord);
  return plans.find(plan => plan.entries[0]!.issueNumber === number)!;
}

test("every recovery plan is validated before any journal writes", async () => tracker(async (_directory, pmRoot) => {
  interruptedPlan(pmRoot);
  interruptedPlan(pmRoot, 2);
  const pending = await listUnfinishedGithubImports(pmRoot);
  const last = pending[1]!;
  const file = join(pmRoot, "transactions/pm-github", `${last.transactionId}.json`);
  const original = readFileSync(file, "utf8");
  const record = JSON.parse(original) as GithubImportPlanRecord;
  for (const invalid of [null, {}, { ...record, repo: "invalid" }, { ...record, repo: null }, { ...record, entries: [] },
    { ...record, entries: [{}] }, { ...record, mutations: [] }, { ...record, mutations: [null] },
    { ...record, mutations: record.mutations.map(mutation => ({ ...mutation, options: { title: "Mismatched saved payload" } })) },
    { ...record, mutations: [{ op: "update", id: "unlinked" }] }, { ...record, mutations: [{ op: "create", id: record.entries[0]!.match!.id }] }]) {
    if (invalid === null) rmSync(file); else writeFileSync(file, JSON.stringify(invalid));
    const before = snapshot(pmRoot);
    await assert.rejects(() => runRefresh("fixture/repo", pmRoot, {}), error => {
      assert.match(String(error), new RegExp(last.transactionId));
      return true;
    });
    assert.deepEqual(snapshot(pmRoot), before, "the first valid journal must still be applying");
    writeFileSync(file, original);
  }
  assert.throws(() => validateGithubImportPlan({ ...record, mutations: "invalid" } as unknown as GithubImportPlanRecord), /persisted plan is invalid/);
  assert.throws(() => validateGithubImportPlan({ ...record, entries: "invalid" } as unknown as GithubImportPlanRecord), /persisted plan is invalid/);
}));

test("persisted fidelity in every recovery plan is validated before any journal writes", async () => tracker(async (_directory, pmRoot) => {
  interruptedPlan(pmRoot);
  interruptedPlan(pmRoot, 2);
  const pending = await listUnfinishedGithubImports(pmRoot);
  const last = pending[1]!;
  const file = join(pmRoot, "transactions/pm-github", `${last.transactionId}.json`);
  const record = JSON.parse(readFileSync(file, "utf8")) as GithubImportPlanRecord;
  const entry = record.entries[0]!;
  const fidelity = entry.fidelity!;
  const corruptions: unknown[] = [
    { ...fidelity, github_closed_at: "invalid-date" },
    null, [], "invalid",
    { ...fidelity, tags: 7 },
    { ...fidelity, github_url: 7 },
    { ...fidelity, github_url: "https://github.com/fixture/other/issues/2" },
    { ...fidelity, github_number: 999 }, { ...fidelity, github_state: "unknown" },
    ...["github_created_at", "github_updated_at", "github_closed_at", "github_close_reason", "github_release", "github_state_reason"]
      .map(field => ({ ...fidelity, [field]: 7 })),
    { ...fidelity, github_created_at: "invalid-date" },
    { ...fidelity, github_updated_at: "invalid-date" },
    { ...fidelity, github_updated_at: "2025-01-01T00:00:00Z" },
    { ...fidelity, github_closed_at: "2025-01-01T00:00:00Z" },
    { ...fidelity, github_closed_at: "2027-01-01T00:00:00Z" },
    { ...fidelity, github_closed_at: "", github_created_at: "2026-02-02T12:00:00Z" },
  ];
  for (const invalid of [...corruptions.map(fidelity => ({ ...entry, fidelity })), { ...entry, linkOnly: "false" }]) {
    writeFileSync(file, JSON.stringify({ ...record, entries: [invalid] }));
    const before = snapshot(pmRoot);
    await assert.rejects(() => runRefresh("fixture/repo", pmRoot, {}), new RegExp(last.transactionId));
    assert.deepEqual(snapshot(pmRoot), before, "invalid finalization input must leave BOTH journals and every tracker byte untouched");
  }
}));

for (const atomic of [false, true]) {
  test(`fresh refresh validates every finalization projection before the first write (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    await create({ title: "Stale first", tags: "gh:fixture/repo#1" }, { pmRoot });
    const local = (await create({ title: "Closed second", tags: "gh:fixture/repo#2", type: "Task" }, { pmRoot })).item;
    await commitImportedItem({ pmRoot, id: local.id, itemPath: getItemPath(pmRoot, "Task", local.id), settings: await readSettings(pmRoot),
      document: { metadata: { ...local, status: "closed", created_at: "2025-01-01T00:00:00Z",
        closed_at: "2025-02-01T00:00:00Z", completed_at: "2025-02-01T00:00:00Z" }, body: "" },
      author: "fixture", message: "Seed historical closure", conflictWarningPrefix: "fixture" });
    const second = { ...node(2, "CLOSED", "COMPLETED"), closedAt: null } as unknown as ReturnType<typeof node>;
    await withMockGithub(transport({ i1: node(), i2: second }), async () => {
      const before = snapshot(pmRoot);
      await assert.rejects(() => runRefresh("fixture/repo", pmRoot, { atomic }), /native closure date/);
      assert.deepEqual(snapshot(pmRoot), before, "the first valid refresh must not write before the later native date conflict is found");
    });
  }));
}

test("persisted fidelity accepts empty and nullable source values and legacy entries", async () => tracker(async (_directory, pmRoot) => {
  const record = interruptedPlan(pmRoot);
  const entry = record.entries[0]!;
  const expected = new Map([[entry.issueNumber, entry.match!.id!]]);
  for (const value of ["", null]) {
    const fidelity = { ...entry.fidelity!, github_closed_at: value, github_state_reason: value,
      github_close_reason: value, github_release: value };
    for (const state of ["open", "closed"]) {
      const plan = { ...record, entries: [{ ...entry, fidelity: { ...fidelity, github_state: state } }] } as unknown as GithubImportPlanRecord;
      assert.deepEqual(validateGithubImportPlan(plan), expected);
    }
  }
  assert.deepEqual(validateGithubImportPlan({ ...record, entries: [{ ...entry, fidelity: undefined, linkOnly: undefined }] }), expected);
  assert.deepEqual(validateGithubImportPlan({ ...record, repo: "Fixture/Repo", entries: [{ ...entry,
    fidelity: { ...entry.fidelity!, github_url: `https://github.com/Fixture/Repo/issues/${entry.issueNumber}` } }] }), expected);
  const open = { ...entry, fidelity: { ...entry.fidelity!, github_state: "open", github_closed_at: "" } };
  assert.deepEqual(validateGithubImportPlan({ ...record, entries: [open] }, []), expected);
  assert.deepEqual(validateGithubImportPlan({ ...record, entries: [{ ...entry, linkOnly: true }] }), expected);
  const nullable = { ...record, entries: [{ ...entry, fidelity: { ...entry.fidelity!,
    github_state_reason: null, github_close_reason: null, github_release: null } }] } as unknown as GithubImportPlanRecord;
  // Replay real SDK state too: nullable non-date source values need no coercion.
  await resumeGithubImport(pmRoot, nullable);
  const item = (await get(entry.match!.id!, {}, { pmRoot })).item;
  assert.equal(item.github_state_reason, null);
  assert.equal(item.github_close_reason, null);
  assert.equal(item.github_release, null);
  assert.equal((await listUnfinishedGithubImports(pmRoot)).length, 0);
}));

test("recovery refuses a different repository even when the selected item overlaps", async () => tracker(async (_directory, pmRoot) => {
  const record = interruptedPlan(pmRoot);
  const id = record.entries[0]!.match!.id!;
  await update(id, { addTags: ["gh:fixture/other#1"] }, { pmRoot });
  const before = snapshot(pmRoot);
  await assert.rejects(() => runRefresh("fixture/other", pmRoot, {}), new RegExp(`${record.transactionId}.*fixture/repo.*fixture/other`));
  assert.deepEqual(snapshot(pmRoot), before);
}));

test("missing recovery plan names the configured journal and atomic import retry", async () => tracker(async (_directory, pmRoot) => {
  const record = interruptedPlan(pmRoot);
  rmSync(join(pmRoot, "transactions/pm-github", `${record.transactionId}.json`));
  const before = snapshot(pmRoot);
  await assert.rejects(() => runRefresh("fixture/repo", pmRoot, {}), error => {
    assert.match(String(error), /re-run that import to resume it/);
    assert.ok(String(error).includes("pm github import --atomic"));
    assert.ok(String(error).includes(join(pmRoot, "transactions", "sdk", `${record.transactionId}.json`)));
    return true;
  });
  assert.deepEqual(snapshot(pmRoot), before);
}));

test("request failure after recovery preserves committed recovery writes as documented", async () => tracker(async (_directory, pmRoot) => {
  const record = interruptedPlan(pmRoot);
  await withMockGithub((_request, response) => jsonResponse(response, 401, { message: "unauthorized" }), async () => {
    await assert.rejects(() => runRefresh("fixture/repo", pmRoot, {}), /401|unauthorized|authentication/i);
  });
  assert.equal((await listUnfinishedGithubImports(pmRoot)).length, 0);
  assert.equal(JSON.parse(readFileSync(join(pmRoot, "transactions/sdk", `${record.transactionId}.json`), "utf8")).status, "committed");
  assert.match(readFileSync(join(packageRoot, "README.md"), "utf8"), /Recovery of unfinished\s+transactions happens first and may already have committed earlier writes/);
}));

test("canceled update mutation carries the required reason only with a status change", async () => tracker(async (_directory, pmRoot) => {
  const linked = (await create({ title: "Stale", tags: "gh:fixture/repo#1" }, { pmRoot })).item;
  const entry = (await prepareGithubImport({ number: 1, title: "Stale", body: null, state: "closed", state_reason: "not_planned", closed_at: "2026-02-02T00:00:00Z", labels: [], assignee: null, milestone: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z", html_url: "https://github.com/fixture/repo/issues/1" },
  "fixture/repo", parseImportOptions({}), "fixture", linked, undefined, { items: [linked], releases: [], timeline: async () => [] }))!;
  const prefix = (await readSettings(pmRoot)).id_prefix;
  const mutation = buildAtomicImportMutations("fixture/repo", entry, prefix, normalizeItemId, true).mutations[0]!;
  assert.equal(mutation.op, "update");
  if (mutation.op === "update") {
    assert.equal(mutation.options!.status, "canceled");
    assert.equal(mutation.options!.closeReason, entry.fidelity!.github_close_reason);
  }
  await importGithubAtomic(pmRoot, "fixture/repo", [entry], { updateOnly: true });
  assert.equal((await get(linked.id, {}, { pmRoot })).item.close_reason, entry.fidelity!.github_close_reason);
}));

for (const recover of [false, true]) {
  test(`terminal failures remove replay plans after real SDK compensation (${recover})`, async () => tracker(async (_directory, pmRoot) => {
    const record = interruptedPlan(pmRoot);
    if (!recover) {
      // Finish the interrupted attempt first, then change only upstream title.
      await resumeGithubImport(pmRoot, record);
      record.entries = record.entries.map(entry => ({ ...entry, title: "Changed again", match: { ...entry.match!, title: "New upstream title" } }));
    }
    const unrelated = interruptedPlan(pmRoot, 2);
    const fail = { onTransition: (context: { transition: string }) => {
      if (context.transition === "committing") throw new Error("terminal fixture failure");
    } };
    await assert.rejects(() => recover ? resumeGithubImport(pmRoot, record, fail)
      : importGithubAtomic(pmRoot, record.repo, record.entries, { ...fail, updateOnly: true }), /terminal fixture failure/);
    assert.deepEqual((await listUnfinishedGithubImports(pmRoot)).map(journal => journal.transactionId), [unrelated.transactionId]);
    assert.deepEqual(readdirSync(join(pmRoot, "transactions/pm-github")), [`${unrelated.transactionId}.json`]);
  }));
}

for (const failure of ["interrupted", "inspection", "cleanup", "finalize"]) {
  test(`failure cleanup preserves resumability and the original error (${failure})`, async () => tracker(async (_directory, pmRoot) => {
    const record = interruptedPlan(pmRoot);
    const planFile = join(pmRoot, "transactions/pm-github", `${record.transactionId}.json`);
    const sdkDir = join(pmRoot, "transactions/sdk");
    await assert.rejects(() => resumeGithubImport(pmRoot, record, { onTransition: context => {
      if (context.transition === "committing" && ["interrupted", "inspection"].includes(failure)) {
        if (failure === "inspection") {
          renameSync(sdkDir, `${sdkDir}-held`);
          writeFileSync(sdkDir, "unavailable");
        }
        throw new WorkspaceTransactionInterruptedError("preserve original interruption");
      }
      if (context.transition === "committed") {
        if (failure === "cleanup") {
          rmSync(planFile);
          mkdirSync(planFile);
          writeFileSync(join(planFile, "held"), "unavailable");
          throw new Error("preserve original committed error");
        }
        if (failure === "finalize") {
          const entry = record.entries[0]!;
          rmSync(getItemPath(pmRoot, String(entry.match!.type), entry.match!.id!));
        }
      }
    } }), failure === "finalize" ? /committed journal.*could not be finalized/ : /preserve original/);
    if (failure === "inspection") {
      rmSync(sdkDir);
      renameSync(`${sdkDir}-held`, sdkDir);
    }
    if (["interrupted", "inspection"].includes(failure)) {
      assert.ok(existsSync(planFile), "a potentially resumable transaction keeps its plan");
      assert.equal((await listUnfinishedGithubImports(pmRoot)).length, 1);
      await resumeGithubImport(pmRoot, record);
      assert.ok(!existsSync(planFile));
    } else if (failure === "finalize") {
      assert.ok(!existsSync(planFile), "a terminal journal cannot keep a sensitive orphan plan");
    } else assert.ok(existsSync(join(planFile, "held")), "cleanup failure must not mask the transaction error");
  }));
}

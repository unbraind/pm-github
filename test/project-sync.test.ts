import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { schemaAddStatus, getHistoryPath, create as sdkCreate, update as sdkUpdate, init as sdkInit, get as sdkGet, readSettings, mutateItem } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { projectItemTag } from "../projects.ts";
import { captureStderr, jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";
import type { MockGithubHandler } from "./helpers/mock-github-server.ts";
import { nodeScenario } from "./helpers/node-scenario.ts";

const harness = createExtensionTestHarness(extension, {
  capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"],
});
const REF = { owner: "acme", number: 5 };
const OPTIONS = [
  { id: "todo", name: "Todo" },
  { id: "doing", name: "In Progress" },
  { id: "done", name: "Done" },
  { id: "cancel", name: "Canceled" },
];
interface LocalItem {
  id: string;
  title: string;
  status: string;
  tags?: string[];
  body?: string;
  close_reason?: string;
}
interface BoardNode {
  id?: string;
  fieldValueByName?: { name: string; optionId: string };
  content?: Record<string, unknown> | null;
}
interface GraphqlCall {
  query: string;
  variables: Record<string, unknown>;
}

/** Run the installed PM CLI against a disposable workspace, checking setup. */
function pm(root: string, args: string[]): string {
  const result = spawnSync(process.platform === "win32" ? "pm.cmd" : "pm", ["--path", root, ...args], {
    encoding: "utf8", shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Allocate a real tracker and remove it even after a failed assertion. */
function tracker(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-project-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  pm(root, ["init", "fixture"]);
  return root;
}

/** Read authoritative item state through the installed CLI. */
function items(root: string): LocalItem[] {
  const result = JSON.parse(pm(root, ["list", "--all", "--json", "--output-include", "full"])) as { items: LocalItem[] };
  return result.items;
}

/** Create a local item and return its generated identity. */
function create(root: string, title: string, tags: string[] = [], status = "open", extra: string[] = []): string {
  pm(root, ["create", "task", title, "--status", status, "--tags", JSON.stringify(tags), ...extra]);
  const item = items(root).find(item => item.title === title);
  assert.ok(item);
  return item.id;
}

/** Serve board discovery and inventory, handing actual mutations to the caller. */
function board(nodes: BoardNode[], mutate?: MockGithubHandler, statusField = true): MockGithubHandler {
  return (req, res, body, base) => {
    const call = JSON.parse(body) as GraphqlCall;
    if (call.query.includes("projectV2(number:")) {
      jsonResponse(res, 200, { data: { organization: { projectV2: {
        id: "board", title: "Fixture board", statusField: statusField ? { id: "status", name: "Status", options: OPTIONS } : null,
      } } } });
    } else if (call.query.includes("items(first:")) {
      jsonResponse(res, 200, { data: { node: { items: { nodes, pageInfo: { hasNextPage: false } } } } });
    } else if (mutate) {
      mutate(req, res, body, base);
    } else {
      jsonResponse(res, 400, { errors: [{ message: "Unexpected mutation during preview" }] });
    }
  };
}

/** A linked draft with an explicit board status. */
function draft(id: string, name = "Done", optionId = "done"): BoardNode {
  return { id, fieldValueByName: { name, optionId }, content: { __typename: "DraftIssue", title: id } };
}

/** Invoke the registered Projects command under a synthetic credential. */
async function sync(root: string, options: Record<string, unknown> = {}) {
  const ext = await harness;
  return withEnv({ GITHUB_TOKEN: "fixture" + "-token", GH_TOKEN: undefined }, () => ext.runCommand({
    command: "github project sync", args: ["acme/5"], options, pmRoot: root, global: { json: true },
  }));
}

test("project sync previews both directions without mutation, including unmapped statuses", async t => {
  const root = tracker(t);
  create(root, "Linked", [projectItemTag(REF, "linked")]);
  create(root, "Draft", [], "in_progress");
  create(root, "Issue", ["gh:acme/widgets#7"]);
  create(root, "Unmapped", [projectItemTag(REF, "unknown")], "blocked");
  const before = items(root);
  await withMockGithub(board([draft("linked"), draft("unknown", "Custom", "custom")]), async server => {
    const { stderr, result } = await captureStderr(() => sync(root));
    assert.deepEqual(result.result, { dryRun: true, project: "acme/5", push: { actionable: 3, statusSkipped: 1 }, pull: { actionable: 1, statusSkipped: 1 } });
    assert.match(stderr.join("\n"), /add draft @ In Progress/);
    assert.match(stderr.join("\n"), /add issue acme\/widgets#7 @ Todo/);
    assert.match(stderr.join("\n"), /maps to no board option/);
    assert.match(stderr.join("\n"), /maps to no pm status/);
    assert.equal(server.requests.length, 2);
  });
  assert.deepEqual(items(root), before);
});

test("project sync scopes previews, honors dry-run over apply, and rejects empty or unknown ids", async t => {
  const root = tracker(t);
  const id = create(root, "Scoped");
  create(root, "Other");
  await assert.rejects(sync(root, { ids: "" }), /requires at least one/);
  await withMockGithub(board([]), async server => {
    await assert.rejects(sync(root, { ids: "fixture-missing" }), /unknown pm item/);
    const result = await sync(root, { ids: id, apply: true, "dry-run": true, push: true });
    assert.deepEqual(result.result, { dryRun: true, project: "acme/5", push: { actionable: 1, statusSkipped: 0 }, pull: undefined });
    assert.equal(server.requests.length, 4);
  });
});

test("project sync applies draft and issue additions, status writes, and preserves local tags", async t => {
  const root = tracker(t);
  const retained = ["keep", "area,api", '["json"]'];
  const draftId = create(root, "Draft", retained, "in_progress", ["--body", "Local body"]);
  const issueId = create(root, "Issue", ["gh:acme/widgets#7", ...retained]);
  const linkedId = create(root, "Linked", [projectItemTag(REF, "linked"), ...retained]);
  const calls: GraphqlCall[] = [];
  await withMockGithub(board([draft("linked")], (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    calls.push(call);
    const data = call.query.includes("addProjectV2DraftIssue") ? { addProjectV2DraftIssue: { projectItem: { id: "new-draft" } } }
      : call.query.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { id: "issue-node" } } }
      : call.query.includes("addProjectV2ItemById") ? { addProjectV2ItemById: { item: { id: "new-issue" } } }
      : { updateProjectV2ItemFieldValue: { projectV2Item: { id: call.variables.i } } };
    jsonResponse(res, 200, { data });
  }), async () => {
    const result = await sync(root, { apply: true });
    assert.deepEqual(result.result, { project: "acme/5", pushed: 3, pushFailed: 0, pulled: 0, pullFailed: 0, prefer: "pm" });
  });
  assert.equal(calls.filter(c => c.query.includes("updateProjectV2ItemFieldValue")).length, 3);
  assert.deepEqual(calls.find(c => c.query.includes("addProjectV2DraftIssue"))?.variables, { p: "board", t: "Draft", b: "Local body" });
  assert.deepEqual(calls.find(c => c.query.includes("issueOrPullRequest"))?.variables, { o: "acme", n: "widgets", num: 7 });
  assert.deepEqual(calls.find(c => c.query.includes("addProjectV2ItemById"))?.variables, { p: "board", c: "issue-node" });
  const after = items(root);
  assert.deepEqual(new Set(after.find(i => i.id === draftId)?.tags), new Set([...retained, projectItemTag(REF, "new-draft")]));
  assert.ok(after.find(i => i.id === issueId)?.tags?.includes(projectItemTag(REF, "new-issue")));
  for (const item of after) for (const tag of retained) assert.ok(item.tags!.includes(tag));
  assert.deepEqual(new Set(after.find(i => i.id === linkedId)?.tags), new Set([projectItemTag(REF, "linked"), ...retained]));
});

test("project import applies configured terminal aliases with SDK lifecycle fidelity and stable pull previews", async t => {
  const root = tracker(t);
  await schemaAddStatus("verified", { alias: ["settled"], role: ["terminal", "terminal_done"] }, { pmRoot: root, noExtensions: true });
  const id = create(root, "Linked", [projectItemTag(REF, "linked")]);
  const nodes = [draft("linked"), draft("created")];
  await withMockGithub(board(nodes), async () => {
    const ext = await harness;
    await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, () => ext.runCommand({ command: "github project import", args: ["acme/5"],
      options: { "status-map": ["settled=Done"] }, pmRoot: root, global: { json: true } }));
    const written = items(root);
    assert.equal(written.length, 2);
    assert.ok(written.some(item => item.id === id));
    const client = { pmRoot: root, noExtensions: true };
    const createdOracle = (await sdkCreate({ title: "SDK create oracle", type: "Task", status: "settled", closeReason: "SDK verification" }, client)).item;
    const activeOracle = (await sdkCreate({ title: "SDK update oracle", type: "Task" }, client)).item;
    const updatedOracle = (await sdkUpdate(activeOracle.id, { status: "settled", closeReason: "SDK verification" }, client)).item;
    for (const item of written) {
      assert.equal(item.status, "verified");
      const oracle = item.id === id ? updatedOracle : createdOracle;
      assert.equal(typeof item.close_reason, typeof oracle.close_reason, "Configured terminal metadata must match the real SDK write contract.");
      if (oracle.close_reason !== undefined) assert.match(item.close_reason!, /GitHub project/);
    }
    const histories = written.map(item => fs.readFileSync(getHistoryPath(root, item.id), "utf8"));
    for (const history of histories) assert.match(history, /GitHub project/);
    const preview = await sync(root, { pull: true, "status-map": ["SETTLED=Done"] });
    assert.deepEqual(preview.result, { dryRun: true, project: "acme/5", push: undefined, pull: { actionable: 0, statusSkipped: 0 } });
    for (const [index, item] of written.entries()) assert.equal(fs.readFileSync(getHistoryPath(root, item.id), "utf8"), histories[index]);
  });
});

test("project import preserves literal tags when replacing an existing tag set", async t => {
  const root = tracker(t);
  const retained = [projectItemTag(REF, "linked"), "area,api", '["json"]'];
  const id = create(root, "Linked", retained);
  await withMockGithub(board([draft("linked", "Todo", "todo")]), async () => {
    const ext = await harness;
    await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, () => ext.runCommand({ command: "github project import", args: ["acme/5"], options: {}, pmRoot: root, global: { json: true } }));
  });
  assert.deepEqual(new Set(items(root).find(item => item.id === id)!.tags), new Set(retained));
});

for (const prefer of ["pm", "github"]) {
  test(`project sync resolves simultaneous status conflicts in favor of ${prefer}`, async t => {
    const root = tracker(t);
    create(root, "Linked", [projectItemTag(REF, "linked"), "area,api", '["json"]']);
    let mutations = 0;
    await withMockGithub(board([draft("linked")], (_req, res) => {
      mutations++;
      jsonResponse(res, 200, { data: {} });
    }), async () => {
      const result = await sync(root, { push: true, pull: true, apply: true, prefer });
      assert.deepEqual(result.result, { project: "acme/5", pushed: prefer === "pm" ? 1 : 0, pushFailed: 0, pulled: prefer === "github" ? 1 : 0, pullFailed: 0, prefer });
    });
    assert.equal(mutations, prefer === "pm" ? 1 : 0);
    const local = items(root)[0];
    assert.ok(local.tags!.includes("area,api") && local.tags!.includes('["json"]'));
    assert.equal(local.status, prefer === "pm" ? "open" : "closed");
    if (prefer === "github") assert.equal(local.close_reason, "GitHub project status → closed");
  });
}

test("project pull preserves canceled lifecycle metadata and reports a failed terminal close", async t => {
  const root = tracker(t);
  create(root, "Cancel", [projectItemTag(REF, "cancel")]);
  const closedId = create(root, "Terminal", [projectItemTag(REF, "terminal")]);
  pm(root, ["update", closedId, "--status", "canceled", "--close-reason", "Fixture cancellation"]);
  await withMockGithub(board([draft("cancel", "Canceled", "cancel"), draft("terminal")]), async () => {
    const { stderr, result } = await captureStderr(() => sync(root, { pull: true, apply: true }));
    assert.deepEqual(result.result, { project: "acme/5", pushed: 0, pushFailed: 0, pulled: 1, pullFailed: 1, prefer: "pm" });
    assert.match(stderr.join("\n"), /1 failed/);
  });
  const local = items(root).find(i => i.title === "Cancel");
  assert.equal(local?.status, "canceled");
  assert.equal(local?.close_reason, "GitHub project status → canceled");
});

test("project push continues after remote failures and fails when the entire batch fails", async t => {
  const root = tracker(t);
  const missing = create(root, "Missing issue", ["gh:acme/widgets#99"]);
  create(root, "Rejected draft");
  create(root, "No id draft");
  const ok = create(root, "Good draft");
  await withMockGithub(board([], (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    if (call.query.includes("issueOrPullRequest")) jsonResponse(res, 200, { data: { repository: null } });
    else if (call.variables.t === "Rejected draft") jsonResponse(res, 200, { errors: [{ message: "Rejected by board" }] });
    else if (call.variables.t === "No id draft") jsonResponse(res, 200, { data: { addProjectV2DraftIssue: null } });
    else jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "good" } } } });
  }), async () => {
    const { result, stderr } = await captureStderr(() => sync(root, { push: true, apply: true }));
    assert.deepEqual(result.result, { project: "acme/5", pushed: 1, pushFailed: 3, pulled: 0, pullFailed: 0, prefer: "pm" });
    assert.match(stderr.join("\n"), /could not resolve node id/);
    assert.match(stderr.join("\n"), /returned no item id/);
    await assert.rejects(sync(root, { push: true, apply: true, ids: missing }), /Sync wrote nothing; 1 operation/);
  });
  assert.ok(items(root).find(i => i.id === ok)?.tags?.includes(projectItemTag(REF, "good")));
  assert.deepEqual(items(root).find(i => i.id === missing)?.tags, ["gh:acme/widgets#99"]);
});

test("project push attaches an issue without a Status field and rejects a missing attachment id", async t => {
  const root = tracker(t);
  const id = create(root, "Issue", ["gh:acme/widgets#7"]);
  let omitId = true;
  await withMockGithub(board([], (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    const data = call.query.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { id: "issue" } } }
      : { addProjectV2ItemById: omitId ? {} : { item: { id: "attached" } } };
    jsonResponse(res, 200, { data });
  }, false), async server => {
    await assert.rejects(sync(root, { apply: true, push: true }), /Sync wrote nothing/);
    omitId = false;
    const result = await sync(root, { apply: true, push: true });
    assert.equal((result.result as { pushed: number }).pushed, 1);
    assert.ok(server.requests.every(r => !r.body.includes("updateProjectV2ItemFieldValue")));
  });
  assert.ok(items(root).find(i => i.id === id)?.tags?.includes(projectItemTag(REF, "attached")));
});

test("empty project sync previews report nothing to push or pull", async t => {
  const root = tracker(t);
  await withMockGithub(board([]), async () => {
    const { stderr, result } = await captureStderr(() => sync(root, { "no-add-missing": true }));
    assert.deepEqual(result.result, { dryRun: true, project: "acme/5", push: { actionable: 0, statusSkipped: 0 }, pull: { actionable: 0, statusSkipped: 0 } });
    assert.match(stderr.join("\n"), /nothing to push/);
    assert.match(stderr.join("\n"), /nothing to pull/);
  });
});

test("project sync reports a lost local item after a successful remote attachment", async t => {
  const root = tracker(t);
  const id = create(root, "Concurrent deletion");
  await withMockGithub(board([], (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    if (call.query.includes("addProjectV2DraftIssue")) {
      pm(root, ["delete", id, "--message", "Fixture concurrent deletion"]);
      jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "remote-created" } } } });
    } else jsonResponse(res, 200, { data: {} });
  }), async () => {
    const { stderr, result } = await captureStderr(() => sync(root, { apply: true }));
    assert.deepEqual(result.result, { project: "acme/5", pushed: 1, pushFailed: 0, pulled: 0, pullFailed: 0, prefer: "pm" });
    assert.match(stderr.join("\n"), /linked but tag write failed/);
  });
  assert.deepEqual(items(root), []);
});

test("project sync validates the token and reference before contacting GitHub", async t => {
  const root = tracker(t);
  const ext = await harness;
  await assert.rejects(ext.runCommand({ command: "github project sync", args: ["invalid"], pmRoot: root }), /Usage:/);
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { createExtensionTestHarness } from ${JSON.stringify(new URL("../node_modules/@unbrained/pm-cli/dist/sdk/testing.js", import.meta.url).href)};
    import extension from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    const ext = await createExtensionTestHarness(extension, { capabilities: ['commands', 'importers', 'schema', 'hooks', 'preflight', 'search'] });
    await assert.rejects(ext.runCommand({ command: 'github project sync', args: ['acme/5'], pmRoot: ${JSON.stringify(root)} }), /needs a GitHub token/);
  `, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "" });
});

test("project sync previews additions without Status and a linked item without an option", async t => {
  const root = tracker(t);
  create(root, "Draft");
  create(root, "Issue", ["gh:acme/widgets#7"]);
  create(root, "Linked", [projectItemTag(REF, "linked")]);
  await withMockGithub(board([{ id: "linked", content: { __typename: "DraftIssue" } }], undefined, false), async () => {
    const { stderr, result } = await captureStderr(() => sync(root, { push: true }));
    assert.equal((result.result as { push: { actionable: number } }).push.actionable, 2);
    assert.match(stderr.join("\n"), /add draft\n/);
    assert.match(stderr.join("\n"), /add issue acme\/widgets#7\n/);
  });
});

test("project sync reports a missing mutation id and malformed linked issue coordinates", async t => {
  const root = tracker(t);
  create(root, "Draft with missing remote id");
  create(root, "Malformed issue", ["gh:broken#7"]);
  await withMockGithub(board([], (_req, res) => jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: {} } } })), async () => {
    const { stderr } = await captureStderr(() => assert.rejects(sync(root, { push: true, apply: true }), /failed/));
    assert.match(stderr.join("\n"), /returned no item id/);
    assert.match(stderr.join("\n"), /could not resolve node id for broken#7/);
  });
});

test("project pull-only preview treats an absent board status as no information", async t => {
  const root = tracker(t);
  create(root, "Linked", [projectItemTag(REF, "linked")]);
  await withMockGithub(board([{ id: "linked", content: { __typename: "DraftIssue" } }]), async () => {
    const { result, stderr } = await captureStderr(() => sync(root, { pull: true }));
    assert.equal((result.result as { push?: unknown }).push, undefined);
    assert.match(stderr.join("\n"), /nothing to pull/);
  });
});

test("project push preview names a previously unset Status option", async t => {
  const root = tracker(t);
  create(root, "Linked", [projectItemTag(REF, "linked")]);
  await withMockGithub(board([{ id: "linked", content: { __typename: "DraftIssue" } }]), async () => {
    const { stderr } = await captureStderr(() => sync(root, { push: true }));
    assert.match(stderr.join("\n"), /\(none\) → Todo/);
  });
});


test("project push refuses a missing identity from the real attachment response", async t => {
  const root = tracker(t);
  create(root, "Linked issue", ["gh:acme/widgets#7"]);
  await withMockGithub(board([{ fieldValueByName: { name: "Done", optionId: "done" }, content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" } } }], (_req, res, body) => {
    const query = (JSON.parse(body) as GraphqlCall).query;
    jsonResponse(res, 200, { data: query.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { id: "issue" } } } : { addProjectV2ItemById: { item: {} } } });
  }), async () => {
    const { stderr } = await captureStderr(() => assert.rejects(sync(root, { push: true, apply: true }), /failed/));
    assert.match(stderr.join("\n"), /returned no item id/);
  });
});


test("project writers preserve 500 native comma atoms through import and sync without git", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-project-native-tags-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.symlinkSync(path.join(import.meta.dirname, "../node_modules/.bin/pm"), path.join(bin, "pm"));
  const pmRoot = path.join(root, "tracker");
  await sdkInit("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot, cwd: root, noExtensions: true });
  const settings = await readSettings(pmRoot);
  const scope = { parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] };
  const imported = (await sdkCreate({ title: "Existing issue", type: "Task", ...scope }, { pmRoot })).item;
  const pushed = (await sdkCreate({ title: "Native draft", type: "Task", ...scope }, { pmRoot })).item;
  let seed = 0x3c0ffee;
  const native = Array.from({ length: 500 }, (_, index) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const words = ["One", "TWO", "Bug Fix", "scope:One", "constructor", "İ"];
    return ` ${words[(seed >>> 0) % words.length]}, Tag ${index} `;
  });
  for (const target of [imported, pushed]) await mutateItem({ pmRoot, settings, id: target.id, author: "fixture", op: "update", mutate: document => {
    document.metadata.tags = [...native, ...(target.id === imported.id ? ["gh:acme/widgets#7"] : [])];
    return { changedFields: ["tags"] };
  } });
  const beforeImport = (await sdkGet(imported.id, {}, { pmRoot })).item;
  const beforePush = (await sdkGet(pushed.id, {}, { pmRoot })).item;
  await withEnv({ PATH: bin, GIT_CEILING_DIRECTORIES: path.dirname(root), PM_AUTHOR: "fixture", GITHUB_TOKEN: "fixture" + "-token", GH_TOKEN: undefined }, async () => {
    const node: BoardNode = { id: "native-import", fieldValueByName: { name: "Todo", optionId: "todo" }, content: {
      __typename: "Issue", title: "Existing issue", number: 7, state: "OPEN", body: "",
      repository: { name: "widgets", owner: { login: "acme" }, nameWithOwner: "acme/widgets" },
    } };
    const expected = new Map([[imported.id, beforeImport.tags!], [pushed.id, beforePush.tags!]]);
    const boundaries = new Map([[imported.id, 0], [pushed.id, 0]]);
    /** Inject a peer's native mutation at every provider-response boundary, including after local planning. */
    function interleaved(id: string, handler: MockGithubHandler): MockGithubHandler {
      return async (...args) => {
        const step = boundaries.get(id)! + 1;
        boundaries.set(id, step);
        await mutateItem({ pmRoot, settings, id, author: "peer", op: "update", mutate: document => {
          document.metadata.tags = [...document.metadata.tags, `peer, step ${step}`];
          return { changedFields: ["tags"] };
        } });
        expected.set(id, (await sdkGet(id, {}, { pmRoot })).item.tags!);
        await handler(...args);
      };
    }
    await withMockGithub(interleaved(imported.id, board([node])), async () => {
      await (await harness).runCommand({ command: "github project import", args: ["acme/5"], options: {}, pmRoot, global: { json: true } });
    });
    const afterImport = (await sdkGet(imported.id, {}, { pmRoot })).item;
    assert.deepEqual(new Set(afterImport.tags), new Set([...expected.get(imported.id)!, projectItemTag(REF, "native-import")]));
    await withMockGithub(interleaved(pushed.id, board([], (_req, res) => jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "native-push" } } } }))), async () => {
      const result = await sync(pmRoot, { apply: true, push: true, ids: pushed.id });
      assert.equal((result.result as { pushed: number }).pushed, 1);
    });
    const afterPush = (await sdkGet(pushed.id, {}, { pmRoot })).item;
    assert.deepEqual(new Set(afterPush.tags), new Set([...expected.get(pushed.id)!, projectItemTag(REF, "native-push")]));
    assert.equal(boundaries.get(imported.id), 2);
    assert.equal(boundaries.get(pushed.id), 4);
  });
});

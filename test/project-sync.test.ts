import assert from "node:assert/strict";
import { withGithubOwnershipWork, type GithubOwnershipWork } from "../import-ownership.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { schemaAddStatus, getHistoryPath, getItemPath, create as sdkCreate, update as sdkUpdate, init as sdkInit, get as sdkGet, readSettings, mutateItem, resolvePmRoot, runWithActiveExtensions, setActiveExtensionHooks } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { decode as decodeToon } from "@toon-format/toon";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { withPackedFixture } from "./helpers/packed-fixture.ts";
import extension, { applyPushEntry, readPmItems } from "../index.ts";
import { buildProjectPushPlan, parseProjectItemTag, projectItemTag } from "../projects.ts";
import { captureStderr, jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";
import type { MockGithubHandler } from "./helpers/mock-github-server.ts";
import { nodeScenario } from "./helpers/node-scenario.ts";
import { appendedHistory } from "./helpers/history-assertions.ts";

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

/** Establish ownership explicitly; ordinary fixture creation only stores its reference tags. */
async function own(root: string, id: string, githubUrl: string): Promise<void> {
  await mutateItem({ pmRoot: root, id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
    document.metadata.github_url = githubUrl;
    return { changedFields: ["github_url"] };
  } });
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

/** Locate the draft journal for this fixture item without relying on directory order. */
function projectDraftJournal(root: string, id: string): string {
  const key = createHash("sha256").update(JSON.stringify([REF.owner, REF.number, id])).digest("hex");
  return path.join(resolvePmRoot(root, root), "runtime", "github-project-push", `${key}.json`);
}

/** Invoke the registered Projects command under a synthetic credential. */
async function sync(root: string, options: Record<string, unknown> = {}) {
  const ext = await harness;
  return withEnv({ GITHUB_TOKEN: "fixture" + "-token", GH_TOKEN: undefined }, () => ext.runCommand({
    command: "github project sync", args: ["acme/5"], options, pmRoot: root, global: { json: true },
  }));
}

/** Keep the aggregate command contract independently asserted alongside step receipts. */
function aggregate(result: unknown) {
  assert.ok(result && typeof result === "object");
  const { pushReceipts: _receipts, pushPartial: _partial, ...summary } = result as Record<string, unknown>;
  return summary;
}

test("project sync previews both directions without mutation, including unmapped statuses", async t => {
  const root = tracker(t);
  create(root, "Linked", [projectItemTag(REF, "linked")]);
  create(root, "Draft", [], "in_progress");
  const owned = create(root, "Issue", ["gh:acme/widgets#7"]);
  await own(root, owned, "https://github.com/acme/widgets/issues/7");
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

for (const explicitOwner of [false, true]) test(`project sync keeps a valid reference-only item as a draft (explicit owner: ${explicitOwner})`, async t => {
  const root = tracker(t);
  const id = create(root, "Mentioned issue", ["gh:acme/widgets#7"]);
  if (explicitOwner) await own(root, id, "https://github.com/acme/widgets/issues/7");
  const stored = (await sdkGet(id, {}, { pmRoot: root })).item;
  assert.equal(stored.github_url, explicitOwner ? "https://github.com/acme/widgets/issues/7" : undefined);
  const before = items(root);
  await withMockGithub(board([]), async server => {
    const { stderr } = await captureStderr(() => sync(root, { push: true }));
    const plan = stderr.join("\n");
    assert.match(plan, explicitOwner ? /add issue acme\/widgets#7/ : /add draft/);
    assert.doesNotMatch(plan, explicitOwner ? /add draft/ : /add issue/);
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
  await own(root, issueId, "https://github.com/acme/widgets/issues/7");
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
    assert.deepEqual(aggregate(result.result), { project: "acme/5", pushed: 3, pushFailed: 0, pulled: 0, pullFailed: 0, prefer: "pm" });
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

test("two stale Projects push plans attach one card and write one tracker tag", async t => {
  const root = tracker(t);
  const id = create(root, "One draft");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  const plans = [0, 1].map(() => buildProjectPushPlan([local], REF, [], undefined).entries[0]!);
  const nodes: BoardNode[] = [];
  const provider = board(nodes, (_req, res) => {
    const card = `draft-${nodes.length + 1}`;
    nodes.push(draft(card));
    jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: card } } } });
  });
  await withMockGithub((request, response, raw, base) => {
    const call = JSON.parse(raw) as GraphqlCall;
    if (call.query.includes("items(first:") && call.variables.cursor === null) {
      jsonResponse(response, 200, { data: { node: { items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "page-two" } } } } });
    } else {
      provider(request, response, raw, base);
    }
  }, async server => {
    const outcomes = await Promise.all(plans.map(plan => applyPushEntry(plan, meta, REF, root, "fixture")));
    assert.equal(nodes.length, 1, "Both plans began with an empty board, but only one may create a draft");
    assert.deepEqual(outcomes.map(result => result.attachment.outcome).sort(), ["attached", "reused"]);
    assert.deepEqual(outcomes.map(result => result.trackerTag.outcome).sort(), ["present", "written"]);
    assert.equal(server.requests.filter(request => request.body.includes('"cursor":"page-two"')).length, 2);
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags, [projectItemTag(REF, "draft-1")]);
});

test("a rejected Projects status reports the attached card and retry reuses it", async t => {
  const root = tracker(t);
  const id = create(root, "Retry status");
  const nodes: BoardNode[] = [];
  let statusReply: "reject" | "wrong-card" | "accept" = "reject";
  await withMockGithub(board(nodes, (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    if (call.query.includes("addProjectV2DraftIssue")) {
      nodes.push(draft("attached"));
      jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "attached" } } } });
    } else if (statusReply === "reject") {
      jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: null }, errors: [{ type: "FORBIDDEN", message: "Status refused" }] });
    } else if (statusReply === "wrong-card") {
      jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "different-card" } } } });
    } else {
      assert.equal(call.variables.i, "attached");
      jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "attached" } } } });
    }
  }), async server => {
    const first = await captureStderr(() => sync(root, { push: true, apply: true }));
    assert.match(first.stderr.join("\n"), /Status refused/);
    assert.deepEqual(first.result.result, { project: "acme/5", pushed: 1, pushFailed: 0, pushPartial: 1, pulled: 0, pullFailed: 0, prefer: "pm",
      pushReceipts: [{ pmId: id, cardId: "attached", outcome: "partial", attachment: { outcome: "attached" },
        status: { outcome: "failed", error: "Status refused" }, trackerTag: { outcome: "written" } }],
    });
    assert.deepEqual(items(root).find(item => item.id === id)?.tags, [projectItemTag(REF, "attached")]);
    statusReply = "wrong-card";
    const wrongCard = await captureStderr(() => assert.rejects(sync(root, { push: true, apply: true }), /could not confirm any writes/));
    assert.match(wrongCard.stderr.join("\n"), /no matching card ID for the Status write/);
    statusReply = "accept";
    const retry = await sync(root, { push: true, apply: true });
    assert.deepEqual((retry.result as { pushReceipts: unknown[] }).pushReceipts, [{
      pmId: id, cardId: "attached", outcome: "applied", attachment: { outcome: "reused" },
      status: { outcome: "updated" }, trackerTag: { outcome: "present" },
    }]);
    assert.equal(server.requests.filter(request => request.body.includes("addProjectV2DraftIssue")).length, 1);
    assert.equal(server.requests.filter(request => request.body.includes("updateProjectV2ItemFieldValue")).length, 3);
  });
  assert.equal(nodes.length, 1);
});

test("a stale attachment refuses an existing tag absent from the live board", async t => {
  const root = tracker(t);
  const id = create(root, "Previously linked");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  const plan = buildProjectPushPlan([local], REF, [], undefined).entries[0]!;
  const tag = projectItemTag(REF, "not-visible");
  await sdkUpdate(id, { addTags: [tag] }, { pmRoot: root });
  await withMockGithub(board([]), async server => {
    const result = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.equal(result.outcome, "failed");
    assert.match(result.error!, /card missing from the live board/);
    const preview = await captureStderr(() => sync(root, { push: true }));
    assert.match(preview.stderr.join("\n"), /blocked.*card missing from the live board/);
    const { push } = preview.result.result as { push: { actionable: number; blocked: { pmId: string; cardId: string }[] } };
    assert.equal(push.actionable, 0);
    assert.equal(push.blocked[0]?.pmId, id);
    assert.equal(push.blocked[0]?.cardId, "not-visible");
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 0);
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags, [tag]);
});

test("push refuses a live card claimed by an unselected tracker peer", async t => {
  const root = tracker(t);
  const tag = projectItemTag(REF, "existing");
  const id = create(root, "Scoped item", [tag]);
  const peerId = create(root, "Unselected peer");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const, statusField: { id: "status", name: "Status", options: OPTIONS } };
  const plan = buildProjectPushPlan([local], REF, [{ id: "existing", content: { typename: "DraftIssue", title: "Existing" } }], meta.statusField).entries[0]!;
  assert.equal(plan.action, "set-status");
  await sdkUpdate(peerId, { addTags: [tag] }, { pmRoot: root });
  await withMockGithub(board([draft("existing")]), async server => {
    const result = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.equal(result.outcome, "failed");
    assert.match(result.error!, /Multiple tracker items claim/);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 0);
  });
});

test("seeded Projects preview and dry-run apply agree on the same write and block verdicts", async t => {
  const root = tracker(t);
  const nodes: BoardNode[] = [];
  const blocked: string[] = [];
  let expectedActions = 0;
  let seed = 487;
  for (let i = 0; i < 20; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const kind = (seed >>> 24) % 4;
    const card = `seeded-${i}`;
    const status = kind === 1 ? "in_progress" : "open";
    const tags = kind === 0 ? [] : [projectItemTag(REF, card)];
    const item = (await sdkCreate({ type: "Task", title: `Seeded ${i}`, status, tags: JSON.stringify(tags) }, { pmRoot: root, noExtensions: true })).item;
    if (kind === 3) blocked.push(item.id);
    else if (kind !== 2) expectedActions++;
    if (kind === 1 || kind === 2) nodes.push(draft(card, "Todo", "todo"));
  }
  assert.ok(expectedActions && blocked.length);
  await withMockGithub(board(nodes), async server => {
    const preview = await captureStderr(() => sync(root, { push: true }));
    const apply = await captureStderr(() => sync(root, { push: true, apply: true, "dry-run": true }));
    assert.deepEqual(apply.result.result, preview.result.result);
    const { push } = preview.result.result as { push: { actionable: number; blocked: { pmId: string }[] } };
    assert.equal(push.actionable, expectedActions);
    assert.deepEqual(push.blocked.map(row => row.pmId).sort(), blocked.sort());
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("an issue attached while resolving its node is reused and tagged without rewriting its Status", async t => {
  const root = tracker(t);
  const id = create(root, "Existing issue");
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  const nodes: BoardNode[] = [];
  await withMockGithub(board(nodes, (_req, res, body) => {
    assert.match(body, /issueOrPullRequest/);
    nodes.push({ id: "existing-issue", fieldValueByName: { name: "Todo", optionId: "todo" },
      content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "Acme/Widgets" } } });
    jsonResponse(res, 200, { data: { repository: { issueOrPullRequest: { id: "issue-node" } } } });
  }), async server => {
    const receipt = (await sync(root, { push: true, apply: true })).result as { pushReceipts: unknown[] };
    assert.deepEqual(receipt.pushReceipts, [{ pmId: id, cardId: "existing-issue", outcome: "applied",
      attachment: { outcome: "reused" }, status: { outcome: "unchanged" }, trackerTag: { outcome: "written" } }]);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 0);
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags, [projectItemTag(REF, "existing-issue")]);
});

test("the draft recovery record preserves a confirmed card across a tracker tag refusal", async t => {
  const root = tracker(t);
  const id = create(root, "Recover tag");
  const peer = create(root, "Competing claimant");
  const tag = projectItemTag(REF, "confirmed");
  const nodes: BoardNode[] = [];
  await withMockGithub(board(nodes, async (_req, res, body) => {
    if (body.includes("addProjectV2DraftIssue")) {
      nodes.push(draft("confirmed"));
      await sdkUpdate(peer, { addTags: [tag] }, { pmRoot: root });
      jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "confirmed" } } } });
    } else {
      jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "confirmed" } } } });
    }
  }), async server => {
    const args = { push: true, apply: true, ids: id };
    const first = (await sync(root, args)).result as { pushPartial: number; pushReceipts: [{ cardId: string; trackerTag: { outcome: string; error: string } }] };
    assert.equal(first.pushPartial, 1);
    assert.equal(first.pushReceipts[0].cardId, "confirmed");
    assert.equal(first.pushReceipts[0].trackerTag.outcome, "failed");
    assert.match(first.pushReceipts[0].trackerTag.error, /Another tracker item claims/);
    await sdkUpdate(peer, { removeTags: [tag] }, { pmRoot: root });
    const retry = (await sync(root, args)).result as { pushReceipts: unknown[] };
    assert.deepEqual(retry.pushReceipts, [{ pmId: id, cardId: "confirmed", outcome: "applied",
      attachment: { outcome: "reused" }, status: { outcome: "updated" }, trackerTag: { outcome: "written" } }]);
    assert.equal(server.requests.filter(request => request.body.includes("addProjectV2DraftIssue")).length, 1);
    assert.equal(server.requests.filter(request => request.body.includes("updateProjectV2ItemFieldValue")).length, 1);
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags, [tag]);
});

test("Status refuses a competing issue owner that appears during the tracker tag write", async t => {
  const root = tracker(t);
  const id = create(root, "Existing issue card");
  const peer = create(root, "Late issue claimant");
  const url = "https://github.com/acme/widgets/issues/7";
  await own(root, id, url);
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const,
    statusField: { id: "status", name: "Status", options: OPTIONS },
  };
  const cardId = "existing-issue";
  const plan = buildProjectPushPlan([local], REF, [{ id: cardId, statusOptionId: "done",
    content: { typename: "Issue", title: "Existing issue card", repo: "acme/widgets", number: 7 },
  }], meta.statusField).entries[0]!;
  const nodes = [{ id: cardId, fieldValueByName: { name: "Done", optionId: "done" },
    content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" } },
  }];
  let competing = false;
  const pmRoot = resolvePmRoot(root, root);
  await withMockGithub(board(nodes, (_req, res) => jsonResponse(res, 200, { data: {
    updateProjectV2ItemFieldValue: { projectV2Item: { id: cardId } },
  } })), async server => {
    const result = await runWithActiveExtensions({ path: pmRoot, noExtensions: true }, async () => {
      setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onIndex: [], beforeMutation: [],
        onWrite: [{ layer: "project", name: "fixture-late-authority", run: async context => {
          if (competing || !context.path.endsWith(`${id}.toon`)) return;
          competing = true;
          await runWithActiveExtensions({ path: pmRoot, noExtensions: true }, () => own(pmRoot, peer, url));
        } }],
      });
      return applyPushEntry(plan, meta, REF, pmRoot, "fixture");
    });
    assert.equal(competing, true);
    assert.equal(server.requests.filter(request => request.body.includes("updateProjectV2ItemFieldValue")).length, 0);
    assert.equal(result.cardId, cardId);
    assert.equal(result.outcome, "partial");
    assert.equal(result.trackerTag.outcome, "written");
    assert.equal(result.status.outcome, "failed");
    assert.match(result.status.error!, /claimed by/);
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags, [projectItemTag(REF, cardId)]);
});

test("a no-add push stays read-only for an unlinked item", async t => {
  const root = tracker(t);
  const id = create(root, "Leave off board");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  const options = { addMissing: false };
  const plan = buildProjectPushPlan([local], REF, [], undefined, options).entries[0]!;
  const oldPlan = buildProjectPushPlan([local], REF, [], undefined).entries[0]!;
  assert.equal(plan.action, "noop");
  assert.equal(oldPlan.action, "add-draft");
  await withMockGithub(board([]), async server => {
    for (const entry of [plan, oldPlan]) {
      const result = await applyPushEntry(entry, meta, REF, root, "fixture", options);
      assert.equal(result.outcome, "unchanged");
      assert.equal(result.attachment.outcome, "not_attempted");
    }
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("recovery refuses a different board and a confirmed card hidden from inventory", async t => {
  const root = tracker(t);
  const id = create(root, "Pending recovery target");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const plan = buildProjectPushPlan([local], REF, [], undefined).entries[0]!;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  const location = path.join(resolvePmRoot(root, root), "runtime", "github-project-push");
  const key = createHash("sha256").update(JSON.stringify([REF.owner, REF.number, id])).digest("hex");
  const file = path.join(location, `${key}.json`);
  fs.mkdirSync(file, { recursive: true });
  await withMockGithub(board([]), async server => {
    const unreadable = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.match(unreadable.error!, /EISDIR/);
    fs.rmdirSync(file);
    fs.writeFileSync(file, JSON.stringify({ boardId: "different-board", cardId: "hidden" }));
    const changed = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.match(changed.error!, /board changed/);
    assert.equal(server.requests.length, 0);
    fs.writeFileSync(file, JSON.stringify({ boardId: meta.id, cardId: "hidden" }));
    const hidden = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.match(hidden.error!, /card missing from the live board/);
    const conflictingTag = projectItemTag(REF, "different-card");
    await sdkUpdate(id, { addTags: [conflictingTag] }, { pmRoot: root });
    const conflict = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.match(conflict.error!, /project card link changed during push/);
    await sdkUpdate(id, { removeTags: [conflictingTag] }, { pmRoot: root });
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags ?? [], []);
});

test("a local tag and a live issue card must agree before Projects push can proceed", async t => {
  const root = tracker(t);
  const id = create(root, "Ambiguous local link", [projectItemTag(REF, "obsolete")]);
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  const project = { id: "actual", content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" } } };
  await withMockGithub(board([project]), async server => {
    await assert.rejects(sync(root, { push: true, apply: true, ids: id }), /conflicting links to this board/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
  await sdkUpdate(id, { addTags: [projectItemTag(REF, "second-obsolete")] }, { pmRoot: root });
  await withMockGithub(board([]), async server => {
    await assert.rejects(sync(root, { push: true, ids: id }), /conflicting links to this board/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("a stale draft entry cannot add or update after the tracker acquires a different GitHub owner", async t => {
  const root = tracker(t);
  const id = create(root, "Fresh issue owner");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const plan = buildProjectPushPlan([local], REF, [], undefined).entries[0]!;
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  await withMockGithub(board([]), async server => {
    const outcome = await applyPushEntry(plan, meta, REF, root, "fixture");
    assert.match(outcome.error!, /current owner changed to acme\/widgets#7/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("a tag-only recovery remains a confirmed write when journal cleanup fails", async t => {
  const root = tracker(t);
  const id = create(root, "Cleanup failure");
  const pmRoot = resolvePmRoot(root, root);
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  const local = (await sdkGet(id, {}, { pmRoot })).item;
  const plan = buildProjectPushPlan([local], REF, [], undefined).entries[0]!;
  const location = path.join(pmRoot, "runtime", "github-project-push");
  const key = createHash("sha256").update(JSON.stringify([REF.owner, REF.number, id])).digest("hex");
  const file = path.join(location, `${key}.json`);
  await withMockGithub(board([], (_req, res) => jsonResponse(res, 200, { data: {
    addProjectV2DraftIssue: { projectItem: { id: "cleanup-card" } },
  } }), false), async () => {
    const result = await runWithActiveExtensions({ path: pmRoot, noExtensions: true }, async () => {
      setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onIndex: [], beforeMutation: [],
        onWrite: [{ layer: "project", name: "fixture-cleanup-failure", run: async context => {
          if (!context.path.endsWith(`${id}.toon`)) return;
          fs.renameSync(file, file + ".retained");
          fs.mkdirSync(file);
        } }],
      });
      return applyPushEntry(plan, meta, REF, pmRoot, "fixture");
    });
    assert.equal(result.outcome, "partial");
    assert.equal(result.attachment.outcome, "attached");
    assert.equal(result.trackerTag.outcome, "written");
    assert.match(result.trackerTag.error!, /draft recovery cleanup failed/);
  });
  assert.deepEqual(items(root).find(item => item.id === id)?.tags, [projectItemTag(REF, "cleanup-card")]);
});

test("ambiguous draft delivery is neither repeated by transport nor replayed from a new plan", async t => {
  const root = tracker(t);
  const id = create(root, "Ambiguous delivery");
  const nodes: BoardNode[] = [];
  await withMockGithub(board(nodes, (_req, res, body) => {
    if (body.includes("addProjectV2DraftIssue")) {
      nodes.push(draft("already-created"));
      jsonResponse(res, 502, {});
    } else {
      jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "already-created" } } } });
    }
  }), async server => {
    const options = { push: true, apply: true, ids: id };
    const first = await captureStderr(() => assert.rejects(sync(root, options), /could not confirm any writes/));
    assert.match(first.stderr.join("\n"), /HTTP 502/);
    assert.equal(server.requests.filter(request => request.body.includes("addProjectV2DraftIssue")).length, 1);
    const retry = await captureStderr(() => assert.rejects(sync(root, options), /could not confirm any writes/));
    assert.match(retry.stderr.join("\n"), /no confirmed card ID/);
    nodes.push({ id: "issue-card", fieldValueByName: { name: "Done", optionId: "done" },
      content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" } } });
    await own(root, id, "https://github.com/acme/widgets/issues/7");
    const differentCard = await captureStderr(() => assert.rejects(sync(root, options), /could not confirm any writes/));
    assert.match(differentCard.stderr.join("\n"), /no confirmed card ID/);
    await mutateItem({ pmRoot: root, id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
      delete document.metadata.github_url;
      return { changedFields: ["github_url"] };
    } });
    await sdkUpdate(id, { addTags: [projectItemTag(REF, "already-created")] }, { pmRoot: root });
    fs.writeFileSync(projectDraftJournal(root, id), JSON.stringify({ boardId: "board", cardId: "already-created" }));
    const recovered = (await sync(root, options)).result as { pushReceipts: unknown[] };
    assert.deepEqual(recovered.pushReceipts, [{ pmId: id, cardId: "already-created", outcome: "applied",
      attachment: { outcome: "reused" }, status: { outcome: "updated" }, trackerTag: { outcome: "present" } }]);
    assert.equal(server.requests.filter(request => request.body.includes("addProjectV2DraftIssue")).length, 1);
  });
});

test("incomplete live board pages cannot authorize a Projects attachment", async t => {
  const root = tracker(t);
  const id = create(root, "Requires a complete board");
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  const local = (await sdkGet(id, {}, { pmRoot: root })).item;
  const meta = { id: "board", title: "Fixture board", url: "", ownerType: "organization" as const };
  const plan = buildProjectPushPlan([local], REF, [], undefined).entries[0]!;
  /** Construct one provider page, including deliberately incomplete fields. */
  const inventory = (nodes: unknown[], pageInfo: unknown) => ({ data: { node: { items: { nodes, pageInfo } } } });
  for (const response of [
    { data: { node: null } },
    inventory([], undefined),
    inventory([null], { hasNextPage: false }),
    inventory([{}], { hasNextPage: false }),
    inventory([{ id: 123, content: { __typename: "DraftIssue" } }], { hasNextPage: false }),
    inventory([{ id: "issue", content: { __typename: "Issue", number: 7 } }], { hasNextPage: false }),
    inventory([{ id: "pull", content: { __typename: "PullRequest", number: "7", repository: { nameWithOwner: "Acme/Widgets" } } }], { hasNextPage: false }),
    inventory([{ id: "pull", content: { __typename: "PullRequest", number: 0, repository: { nameWithOwner: "Acme/Widgets" } } }], { hasNextPage: false }),
    inventory([{ id: "issue", content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets/other" } } }], { hasNextPage: false }),
    inventory([], { hasNextPage: true }),
    inventory([], { hasNextPage: true, endCursor: "repeated" }),
    { ...inventory([], { hasNextPage: false }), errors: [{ message: "partial visibility" }] },
  ]) {
    await withMockGithub((_req, res) => jsonResponse(res, 200, response), async server => {
      const result = await applyPushEntry(plan, meta, REF, root, "fixture");
      assert.match(result.error!, /incomplete Projects board inventory/);
      assert.ok(server.requests.every(request => !request.body.includes("mutation")));
    });
  }
});

test("an opaque card cannot prove that a tracker-owned issue is absent", async t => {
  const root = tracker(t);
  const id = create(root, "Known issue");
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  await withMockGithub(board([{ id: "private-card", content: null }], (_req, res) => {
    jsonResponse(res, 200, { data: { repository: { issueOrPullRequest: { id: "issue-node" } } } });
  }), async server => {
    const result = await captureStderr(() => assert.rejects(sync(root, { push: true, apply: true, ids: id }), /Sync wrote nothing/));
    assert.match(result.stderr.join("\n"), /incomplete Projects board inventory for issue attachment/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("malformed mutation IDs cannot confirm drafts, issue attachment, or Status delivery", async t => {
  const root = tracker(t);
  const statusCard = "status-card";
  for (const [operation, value] of [["draft", 123], ["draft", "  "], ["issue", { id: "mis-shaped" }], ["status", "other-card"]] as const) {
    const item = (await sdkCreate({ type: "Task", title: `Malformed ${operation} ${String(value)}`,
      tags: operation === "status" ? projectItemTag(REF, statusCard) : undefined }, { pmRoot: root })).item;
    if (operation === "issue") await own(root, item.id, "https://github.com/acme/widgets/issues/7");
    const cards = operation === "status" ? [draft(statusCard)] : [];
    await withMockGithub(board(cards, (_req, res, body) => {
      if (body.includes("issueOrPullRequest")) {
        jsonResponse(res, 200, { data: { repository: { issueOrPullRequest: { id: "issue-node" } } } });
      } else if (operation === "draft") {
        jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: value } } } });
      } else if (operation === "issue") {
        jsonResponse(res, 200, { data: { addProjectV2ItemById: { item: { id: value } } } });
      } else {
        jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: value } } } });
      }
    }), async server => {
      const options = { push: true, apply: true, ids: item.id };
      await assert.rejects(sync(root, options), (error: unknown) => {
        const receipt = readFailedProjectsPush(error);
        assert.equal(receipt.pushed, 0);
        assert.equal(receipt.pushReceipts[0]![operation === "status" ? "status" : "attachment"].outcome, "unknown");
        assert.equal(receipt.pushReceipts[0]!.cardId, operation === "status" ? statusCard : undefined);
        return true;
      });
      if (operation === "draft") await assert.rejects(sync(root, options), (error: unknown) => {
        assert.match(readFailedProjectsPush(error).pushReceipts[0]!.attachment.error!, /earlier draft attachment has no confirmed/);
        return true;
      });
      assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 1);
    });
    assert.deepEqual((await sdkGet(item.id, {}, { pmRoot: root })).item.tags ?? [], operation === "status" ? [projectItemTag(REF, statusCard)] : []);
  }
});

/** Read the CLI's structured refusal and require honest unknown-delivery wording. */
function readFailedProjectsPush(error: unknown) {
  assert.ok(error instanceof Error);
  assert.match(error.message, /Sync could not confirm any writes/);
  assert.ok("context" in error);
  return error.context as { pushed: number; pushReceipts: { cardId?: string; attachment: { outcome: string; error?: string };
    status: { outcome: string; error?: string }; trackerTag: { outcome: string; error?: string } }[] };
}

test("an issue attachment acknowledgement does not count as creation when its tag is refused", async t => {
  const root = tracker(t);
  const owner = create(root, "Owner");
  const peer = create(root, "Late card claimant");
  await own(root, owner, "https://github.com/acme/widgets/issues/7");
  const nodes: BoardNode[] = [];
  const cardId = "concurrent-issue-card";
  const tag = projectItemTag(REF, cardId);
  await withMockGithub(board(nodes, async (_req, res, body) => {
    if (body.includes("issueOrPullRequest")) {
      jsonResponse(res, 200, { data: { repository: { issueOrPullRequest: { id: "issue-node" } } } });
    } else {
      nodes.push({ id: cardId, fieldValueByName: { name: "Todo", optionId: "todo" },
        content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "Acme/Widgets" } } });
      await sdkUpdate(peer, { addTags: [tag] }, { pmRoot: root });
      jsonResponse(res, 200, { data: { addProjectV2ItemById: { item: { id: cardId } } } });
    }
  }), async server => {
    const args = { push: true, apply: true, ids: owner };
    await assert.rejects(sync(root, args), (error: unknown) => {
      const { pushed, pushReceipts: [row] } = readFailedProjectsPush(error);
      assert.equal(pushed, 0);
      assert.equal(row!.cardId, cardId);
      assert.equal(row!.attachment.outcome, "confirmed");
      assert.equal(row!.trackerTag.outcome, "failed");
      assert.equal(row!.status.outcome, "not_attempted");
      return true;
    });
    await sdkUpdate(peer, { removeTags: [tag] }, { pmRoot: root });
    const preview = await captureStderr(() => sync(root, { ...args, apply: false }));
    assert.match(preview.stderr.join("\n"), /link tracker to card concurrent-issue-card/);
    const retry = (await sync(root, args)).result as { pushed: number; pushReceipts: unknown[] };
    assert.equal(retry.pushed, 1);
    assert.deepEqual(retry.pushReceipts, [{ pmId: owner, cardId, outcome: "applied",
      attachment: { outcome: "reused" }, trackerTag: { outcome: "written" }, status: { outcome: "unchanged" } }]);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 1);
  });
});

test("an issue acknowledgement plus a tag already written by a peer counts zero writes", async t => {
  const root = tracker(t);
  const id = create(root, "Late native tag");
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  const cardId = "already-linked";
  const tag = projectItemTag(REF, cardId);
  await withMockGithub(board([], async (_req, res, body) => {
    if (body.includes("issueOrPullRequest")) {
      jsonResponse(res, 200, { data: { repository: { issueOrPullRequest: { id: "issue-node" } } } });
    } else {
      await sdkUpdate(id, { addTags: [tag] }, { pmRoot: root });
      jsonResponse(res, 200, { data: { addProjectV2ItemById: { item: { id: cardId } } } });
    }
  }, false), async () => {
    const result = (await sync(root, { push: true, apply: true, ids: id })).result as { pushed: number; pushReceipts: unknown[] };
    assert.equal(result.pushed, 0);
    assert.deepEqual(result.pushReceipts, [{ pmId: id, cardId, outcome: "unchanged",
      attachment: { outcome: "confirmed" }, trackerTag: { outcome: "present" }, status: { outcome: "skipped" } }]);
  });
  assert.deepEqual((await sdkGet(id, {}, { pmRoot: root })).item.tags, [tag]);
});

test("a tagged no-op recovers a pending draft and an ordinary no-op stays read-only", async t => {
  const root = tracker(t);
  const id = create(root, "Lost draft response");
  const first = "lost-response";
  const nodes: BoardNode[] = [];
  await withMockGithub(board(nodes, (_req, res, body) => {
    assert.match(body, /addProjectV2DraftIssue/);
    if (!nodes.length && !fs.existsSync(path.join(root, "fixture-reconciled"))) {
      nodes.push(draft(first));
      jsonResponse(res, 502, {});
    } else {
      jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "replacement" } } } });
    }
  }, false), async server => {
    const args = { push: true, ids: id };
    await assert.rejects(sync(root, { ...args, apply: true }), /could not confirm any writes/);
    await sdkUpdate(id, { addTags: [projectItemTag(REF, first)] }, { pmRoot: root });
    const beforePreview = server.requests.length;
    const preview = await sync(root, { ...args, "no-add-missing": true });
    assert.deepEqual((preview.result as { push: unknown }).push, { actionable: 1, statusSkipped: 0 });
    assert.equal(server.requests.length - beforePreview, 2);
    const journal = projectDraftJournal(root, id);
    const pending = fs.readFileSync(journal);
    const other = "unrelated-draft";
    nodes.push(draft(other, "Todo", "todo"));
    await sdkUpdate(id, { removeTags: [projectItemTag(REF, first)], addTags: [projectItemTag(REF, other)] }, { pmRoot: root });
    await assert.rejects(sync(root, { ...args, apply: true, "no-add-missing": true }), (error: unknown) => {
      assert.equal(readFailedProjectsPush(error).pushReceipts[0]!.attachment.outcome, "unknown");
      return true;
    });
    assert.deepEqual(fs.readFileSync(journal), pending);
    const confirmed = JSON.stringify({ boardId: "board", cardId: first });
    fs.writeFileSync(journal, confirmed);
    await assert.rejects(sync(root, { ...args, apply: true }), /Sync wrote nothing/);
    assert.equal(fs.readFileSync(journal, "utf8"), confirmed);
    fs.writeFileSync(journal, pending);
    await sdkUpdate(id, { removeTags: [projectItemTag(REF, other)] }, { pmRoot: root });
    await assert.rejects(sync(root, { ...args, apply: true }), /could not confirm any writes/);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 1);
    fs.writeFileSync(journal, confirmed);
    await sdkUpdate(id, { addTags: [projectItemTag(REF, first)] }, { pmRoot: root });
    const reconciled = (await sync(root, { ...args, apply: true, "no-add-missing": true })).result as { pushed: number; pushReceipts: unknown[] };
    assert.equal(reconciled.pushed, 0);
    assert.deepEqual(reconciled.pushReceipts, [{ pmId: id, cardId: first, outcome: "unchanged",
      attachment: { outcome: "reused" }, trackerTag: { outcome: "present" }, status: { outcome: "skipped" } }]);
    const beforeNoop = server.requests.length;
    const noop = (await sync(root, { ...args, apply: true })).result as { pushReceipts?: unknown[] };
    assert.equal(noop.pushReceipts, undefined);
    assert.equal(server.requests.length - beforeNoop, 2);
    fs.writeFileSync(path.join(root, "fixture-reconciled"), "");
    nodes.splice(0);
    await sdkUpdate(id, { removeTags: [projectItemTag(REF, first)] }, { pmRoot: root });
    const replacement = (await sync(root, { ...args, apply: true })).result as { pushed: number };
    assert.equal(replacement.pushed, 1);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 2);
  });
});

for (const latePeer of [false, true]) test(`Status waves bind the full corpus once per batch (late claimant: ${latePeer})`, async t => {
  const root = tracker(t);
  const nodes = Array.from({ length: 35 }, (_, i) => draft(`wave-${i}`));
  const ids: string[] = [];
  for (const node of nodes) {
    const item = (await sdkCreate({ type: "Task", title: node.id!, tags: projectItemTag(REF, node.id!) }, { pmRoot: root })).item;
    ids.push(item.id);
  }
  const peer = (await sdkCreate({ type: "Task", title: "Other tracker claimant" }, { pmRoot: root })).item;
  const laterItem = readPmItems(root).filter(item => ids.includes(item.id!))[20]!;
  const disputedCard = parseProjectItemTag(laterItem.tags![0]!)!.itemId;
  let introduced = false;
  const writes: string[] = [];
  const work: GithubOwnershipWork = {};
  await withMockGithub(board(nodes, async (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    assert.match(call.query, /updateProjectV2ItemFieldValue/);
    writes.push(String(call.variables.i));
    if (latePeer && !introduced) {
      introduced = true;
      await sdkUpdate(peer.id, { addTags: [projectItemTag(REF, disputedCard)] }, { pmRoot: root });
    }
    jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: call.variables.i } } } });
  }), async server => {
    const result = await withGithubOwnershipWork(work, () => sync(root, { push: true, apply: true, ids: ids.join(",") }));
    assert.deepEqual(aggregate(result.result), { project: "acme/5", prefer: "pm", pushed: latePeer ? 34 : 35,
      pushFailed: latePeer ? 1 : 0, pulled: 0, pullFailed: 0 });
    assert.equal(server.requests.filter(request => request.body.includes("items(first:")).length, 4);
    assert.deepEqual(new Set(writes), new Set(nodes.map(node => node.id).filter(id => !latePeer || id !== disputedCard)));
    if (!latePeer) assert.equal(work.claimParses, 36 * 4);
  });
});

test("Status waves on initially untagged issue cards reuse the board inventory through tag repair", async t => {
  const root = tracker(t);
  const issueCount = 19;
  const cards: BoardNode[] = [];
  for (let number = 1; number <= issueCount; number++) {
    const item = (await sdkCreate({ type: "Task", title: `Issue ${number}` }, { pmRoot: root })).item;
    await own(root, item.id, `https://github.com/acme/widgets/issues/${number}`);
    cards.push({ ...draft(`issue-${number}`), content: { __typename: "Issue", number, repository: { nameWithOwner: "acme/widgets" } } });
  }
  const mutated = new Set<string>();
  const work: GithubOwnershipWork = {};
  await withMockGithub(board(cards, (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    assert.match(call.query, /updateProjectV2ItemFieldValue/);
    const cardId = String(call.variables.i);
    assert.equal(mutated.has(cardId), false);
    mutated.add(cardId);
    jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: cardId } } } });
  }), async server => {
    const { result } = await withGithubOwnershipWork(work, () => sync(root, { push: true, apply: true }));
    assert.deepEqual(aggregate(result), { project: "acme/5", prefer: "pm", pushed: issueCount, pushFailed: 0, pulled: 0, pullFailed: 0 });
    assert.equal(server.requests.filter(request => request.body.includes("items(first:")).length, 5);
    assert.deepEqual(mutated, new Set(cards.map(card => card.id)));
    // Five complete Status snapshots plus one native peer check and two target documents per tag mutation.
    assert.equal(work.claimParses, 5 * issueCount + issueCount * (issueCount + 2));
  });
  for (const item of items(root)) {
    assert.equal(item.tags?.length, 1);
    assert.equal(parseProjectItemTag(item.tags[0]!)?.itemId, item.title.toLowerCase().replace(" ", "-"));
  }
});

test("a repaired Status wave retains tag writes when its single post-tag refresh fails", async t => {
  const root = tracker(t);
  const id = create(root, "Repair then refresh");
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  const cards = [{ ...draft("repaired"), content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" } } }];
  const provider = board(cards);
  let reads = 0;
  await withMockGithub((req, res, body, base) => {
    if (body.includes("items(first:") && ++reads === 3) jsonResponse(res, 200, { data: { node: null } });
    else provider(req, res, body, base);
  }, async server => {
    const { result } = await sync(root, { push: true, apply: true, ids: id });
    assert.deepEqual((result as { pushReceipts: unknown[] }).pushReceipts, [{ pmId: id, cardId: "repaired", outcome: "partial",
      attachment: { outcome: "reused" }, trackerTag: { outcome: "written" },
      status: { outcome: "failed", error: "GitHub returned an incomplete Projects board inventory." } }]);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("an unreadable journal directory refuses the push before mutation", async t => {
  const root = tracker(t);
  const id = create(root, "Linked", [projectItemTag(REF, "status")]);
  const runtime = path.join(resolvePmRoot(root, root), "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "github-project-push"), "");
  await withMockGithub(board([draft("status")]), async server => {
    await assert.rejects(sync(root, { push: true, apply: true, ids: id }), /Could not read Projects draft recovery directory/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("a Status wave refuses a deleted target and serializes overdue tag writes", async t => {
  const root = tracker(t);
  const deleted = create(root, "Deleted after planning", [projectItemTag(REF, "deleted")]);
  const retagged = create(root, "Tag removed after planning", [projectItemTag(REF, "retagged")]);
  await own(root, retagged, "https://github.com/acme/widgets/issues/7");
  const cards = [draft("deleted"), { ...draft("retagged"),
    content: { __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" } },
  }];
  let inventories = 0;
  const provider = board(cards, (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    assert.equal(call.variables.i, "retagged");
    jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "retagged" } } } });
  });
  await withMockGithub(async (request, response, body, base) => {
    if (body.includes("items(first:") && ++inventories === 2) {
      pm(root, ["delete", deleted, "--message", "Fixture delete"]);
      await sdkUpdate(retagged, { removeTags: [projectItemTag(REF, "retagged")] }, { pmRoot: root });
    }
    provider(request, response, body, base);
  }, async server => {
    const result = (await sync(root, { push: true, apply: true })).result as { pushed: number; pushFailed: number; pushReceipts: Record<string, unknown>[] };
    assert.equal(result.pushed, 1);
    assert.equal(result.pushFailed, 1);
    assert.equal(result.pushReceipts.find(row => row.pmId === deleted)?.outcome, "failed");
    assert.deepEqual(result.pushReceipts.find(row => row.pmId === retagged)?.trackerTag, { outcome: "written" });
    assert.equal(inventories, 3);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 1);
  });
});

test("an incomplete refresh refuses the whole Status wave before dispatch", async t => {
  const root = tracker(t);
  const id = create(root, "Linked", [projectItemTag(REF, "status")]);
  let inventories = 0;
  const good = board([draft("status")]);
  await withMockGithub((request, response, body, base) => {
    if (body.includes("items(first:") && ++inventories === 2) {
      jsonResponse(response, 200, { data: { node: null } });
    } else {
      good(request, response, body, base);
    }
  }, async server => {
    const result = await captureStderr(() => assert.rejects(sync(root, { push: true, apply: true, ids: id }), /Sync wrote nothing/));
    assert.match(result.stderr.join("\n"), /incomplete Projects board inventory/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
});

test("a legacy malformed draft journal requires verified identity while pull owns Status", async t => {
  const root = tracker(t);
  const cardId = "reconciled-draft";
  const id = create(root, "Explicit link", [projectItemTag(REF, cardId)]);
  const pmRoot = resolvePmRoot(root, root);
  const location = path.join(pmRoot, "runtime", "github-project-push");
  fs.mkdirSync(location, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify([REF.owner, REF.number, id])).digest("hex");
  const journal = path.join(location, `${key}.json`);
  fs.writeFileSync(journal, JSON.stringify({ boardId: "board", cardId: 123 }));
  await withMockGithub(board([draft(cardId)]), async server => {
    const previous = fs.readFileSync(journal);
    const disputed = (await sync(root, { push: true, pull: true, apply: true, prefer: "github", ids: id })).result as {
      pushed: number; pullFailed: number; pushFailed: number; pulled: number; pushReceipts: { attachment: { outcome: string } }[];
    };
    assert.equal(disputed.pushed, 0);
    assert.equal(disputed.pulled, 1);
    assert.equal(disputed.pushFailed, 1);
    assert.equal(disputed.pushReceipts[0]?.attachment.outcome, "unknown");
    assert.deepEqual(fs.readFileSync(journal), previous);
    await sdkUpdate(id, { status: "open" }, { pmRoot });
    fs.writeFileSync(journal, JSON.stringify({ boardId: "board", cardId }));
    const result = (await sync(root, { push: true, pull: true, apply: true, prefer: "github", ids: id })).result as {
      pushed: number; pulled: number; pushReceipts: unknown[];
    };
    assert.equal(result.pushed, 0);
    assert.equal(result.pulled, 1);
    assert.deepEqual(result.pushReceipts, [{ pmId: id, cardId, outcome: "unchanged",
      attachment: { outcome: "reused" }, trackerTag: { outcome: "present" }, status: { outcome: "skipped" } }]);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
  assert.equal(fs.existsSync(journal), false);
  assert.equal((await sdkGet(id, {}, { pmRoot })).item.status, "closed");
});

test("an accepted Status with a lost response remains unconfirmed without replaying", async t => {
  const root = tracker(t);
  const id = create(root, "Status timeout", [projectItemTag(REF, "status")]);
  const nodes = [draft("status")];
  await withMockGithub(board(nodes, (_req, res, body) => {
    assert.match(body, /updateProjectV2ItemFieldValue/);
    nodes[0] = draft("status", "Todo", "todo");
    jsonResponse(res, 502, {});
  }), async server => {
    const args = { push: true, apply: true, ids: id };
    await assert.rejects(sync(root, args), (error: unknown) => {
      const { pushed, pushReceipts: [row] } = readFailedProjectsPush(error);
      assert.equal(pushed, 0);
      assert.equal(row!.status.outcome, "unknown");
      assert.match(row!.status.error!, /HTTP 502/);
      return true;
    });
    const repeated = (await sync(root, args)).result as { pushed: number };
    assert.equal(repeated.pushed, 0);
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 1);
  });
});

test("a throttled draft retries and definitive HTTP rejection permits a corrected push", async t => {
  const root = tracker(t);
  const id = create(root, "Rejected input");
  let attempts = 0;
  await withMockGithub(board([], (_req, res, body) => {
    assert.match(body, /addProjectV2DraftIssue/);
    attempts++;
    if (attempts === 1) jsonResponse(res, 429, {}, { "Retry-After": "0" });
    else if (attempts === 2) jsonResponse(res, 422, {});
    else jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "corrected" } } } });
  }, false), async () => {
    const args = { push: true, apply: true, ids: id };
    const refused = await captureStderr(() => assert.rejects(sync(root, args), /Sync wrote nothing/));
    assert.match(refused.stderr.join("\n"), /HTTP 429; retrying/);
    assert.match(refused.stderr.join("\n"), /HTTP 422/);
    assert.equal(attempts, 2);
    const receipt = (await sync(root, args)).result as { pushReceipts: unknown[] };
    assert.deepEqual(receipt.pushReceipts, [{ pmId: id, cardId: "corrected", outcome: "applied",
      attachment: { outcome: "attached" }, status: { outcome: "skipped" }, trackerTag: { outcome: "written" } }]);
    assert.equal(attempts, 3);
  });
});

test("a definitive draft refusal survives failed journal cleanup and can be retried", async t => {
  const root = tracker(t);
  const id = create(root, "Refused then corrected");
  const file = projectDraftJournal(root, id);
  let attempts = 0;
  await withMockGithub(board([], (_req, res, body) => {
    assert.match(body, /addProjectV2DraftIssue/);
    if (++attempts === 1) {
      fs.renameSync(file, file + ".retained");
      fs.mkdirSync(file);
      jsonResponse(res, 200, { errors: [{ type: "FORBIDDEN", message: "Fixture definitive refusal" }] });
    } else {
      jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "after-refusal" } } } });
    }
  }, false), async () => {
    const options = { push: true, apply: true, ids: id };
    await assert.rejects(sync(root, options), (error: unknown) => {
      assert.ok(error instanceof Error && "context" in error);
      const { pushReceipts: [row] } = error.context as { pushReceipts: Array<{ outcome: string; attachment: unknown; cleanupError?: string }> };
      assert.equal(row!.outcome, "failed");
      assert.deepEqual(row!.attachment, { outcome: "failed", error: "GitHub GraphQL error: Fixture definitive refusal." });
      assert.match(row!.cleanupError!, /could not record the confirmed draft refusal.*draft recovery cleanup failed/);
      return true;
    });
    assert.equal(attempts, 1);
    fs.rmdirSync(file);
    // Model the persisted refusal after fixing an obstructed runtime directory.
    fs.writeFileSync(file, JSON.stringify({ boardId: "board", refused: true }));
    const { result } = await sync(root, options);
    assert.deepEqual((result as { pushReceipts: unknown[] }).pushReceipts, [{ pmId: id, cardId: "after-refusal", outcome: "applied",
      attachment: { outcome: "attached" }, status: { outcome: "skipped" }, trackerTag: { outcome: "written" } }]);
    assert.equal(attempts, 2);
    assert.equal(fs.existsSync(file), false);
  });
});

test("a persisted draft refusal remains definitive until journal unlink succeeds", async t => {
  const root = tracker(t);
  const id = create(root, "Refusal with a durable marker");
  const journal = projectDraftJournal(root, id);
  let attempts = 0;
  let blocked = true;
  const remove = fs.promises.rm;
  fs.promises.rm = async (file, options) => {
    if (file === journal && blocked) throw new Error("Fixture journal unlink failure");
    await remove(file, options);
  };
  /** Restore the actual filesystem function after this single journal fault test. */
  const restoreRemove = () => { fs.promises.rm = remove; };
  try {
    await withMockGithub(board([], (_req, res) => {
      if (++attempts === 1) jsonResponse(res, 200, { errors: [{ type: "FORBIDDEN", message: "Fixture denied" }] });
      else jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "accepted-after-unlink" } } } });
    }, false), async () => {
      const options = { push: true, apply: true, ids: id };
      for (const expected of ["Fixture denied", "GitHub refused the earlier draft"]) {
        await assert.rejects(sync(root, options), (error: unknown) => {
          assert.ok(error instanceof Error && "context" in error);
          assert.match(error.message, /Sync wrote nothing/);
          const { pushReceipts: [row] } = error.context as {
            pushReceipts: Array<{ attachment: { outcome: string; error: string }; cleanupError: string }>;
          };
          assert.equal(row!.attachment.outcome, "failed");
          assert.ok(row!.attachment.error.includes(expected));
          assert.match(row!.cleanupError, /Fixture journal unlink failure/);
          return true;
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(journal, "utf8")), { boardId: "board", refused: true });
        assert.equal(attempts, 1);
      }
      blocked = false;
      const { result } = await sync(root, options);
      assert.equal((result as { pushed: number }).pushed, 1);
      assert.equal(attempts, 2);
      assert.equal(fs.existsSync(journal), false);
    });
  } finally {
    restoreRemove();
  }
});

test("blank provider diagnostics keep typed attachment and Status failures visible", async t => {
  const root = tracker(t);
  const draftId = create(root, "Attachment with blank detail");
  const statusId = create(root, "Status with blank detail", [projectItemTag(REF, "linked")]);
  await withMockGithub(board([draft("linked")], (_req, res, body) => {
    const mutation = body.includes("addProjectV2DraftIssue") ? "addProjectV2DraftIssue" : "updateProjectV2ItemFieldValue";
    const errors = [{ type: "FORBIDDEN", message: "" }];
    if (mutation === "updateProjectV2ItemFieldValue") errors.push({ type: "FORBIDDEN", message: " " });
    jsonResponse(res, 200, { data: { [mutation]: null }, errors });
  }), async server => {
    await assert.rejects(sync(root, { push: true, apply: true }), (error: unknown) => {
      assert.ok(error instanceof Error && "context" in error);
      assert.match(error.message, /Sync wrote nothing; 2 operation/);
      const { pushFailed, pushReceipts } = error.context as { pushFailed: number; pushReceipts: Array<{
        pmId: string; outcome: string; attachment: unknown; status: unknown;
      }> };
      assert.equal(pushFailed, 2);
      for (const row of pushReceipts) assert.equal(row.outcome, "failed");
      assert.deepEqual(pushReceipts.find(row => row.pmId === draftId)?.attachment,
        { outcome: "failed", error: "GitHub did not confirm the Projects attachment." });
      assert.deepEqual(pushReceipts.find(row => row.pmId === statusId)?.status,
        { outcome: "failed", error: "GitHub did not confirm the Projects Status update." });
      return true;
    });
    assert.equal(server.requests.filter(request => request.body.includes("mutation")).length, 2);
  });
});

let projectsConsumerTarball: Buffer | undefined;

for (const launcher of ["npx", "bunx"] as const) {
  const availability = launcher === "bunx" ? spawnSync(launcher, ["--version"]) : undefined;
  const launcherMissing = (availability?.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  test(`packed npm and Bun consumers expose the same Projects partial receipt in JSON and TOON (${launcher})`, {
    timeout: 180_000,
    skip: process.platform === "win32" ? "packed launcher fixture uses Unix npm and tar executables" :
      launcherMissing && "Bun is unavailable on PATH",
  }, async () => {
    if (availability) assert.equal(availability.status, 0, availability.error?.message ?? "bunx --version must succeed");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-project-consumer-"));
    const repository = path.resolve(import.meta.dirname, "..");
    await withPackedFixture(base, async ({ root, env }) => {
      /** Run local pack and extraction without contacting a registry or reading user credentials. */
      function setup(command: string, args: string[], cwd = repository) {
        const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      }
      if (!projectsConsumerTarball) {
        // Build in an isolated package directory so stale checkout output and parallel packs cannot affect this artifact.
        const packageRoot = path.join(base, "package");
        const dist = path.join(packageRoot, "dist");
        fs.mkdirSync(dist, { recursive: true });
        fs.writeFileSync(path.join(dist, "index.js"), 'throw new Error("Stale Projects consumer build");');
        setup("npm", ["run", "build", "--", "--outDir", dist]);
        const metadata = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")) as { files: string[] };
        for (const file of new Set(["package.json", ...metadata.files])) {
          if (file.replace(/\/$/, "") === "dist") continue;
          fs.mkdirSync(path.dirname(path.join(packageRoot, file)), { recursive: true });
          fs.copyFileSync(path.join(repository, file), path.join(packageRoot, file));
        }
        const [{ filename }] = JSON.parse(setup("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", base], packageRoot)) as [{ filename: string }];
        projectsConsumerTarball = fs.readFileSync(path.join(base, filename));
      }
      const archive = path.join(base, "projects-consumer.tgz");
      fs.writeFileSync(archive, projectsConsumerTarball);
      const pmRoot = path.join(root, ".agents", "pm");
      await sdkInit("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: root, pmRoot, noExtensions: true });
      assert.equal(fs.existsSync(path.join(root, ".git")), false);
      const installed = path.join(pmRoot, "extensions", "pm-github");
      fs.mkdirSync(installed, { recursive: true });
      setup("tar", ["-xf", archive, "--strip-components=1", "-C", installed]);
      fs.symlinkSync(path.join(repository, "node_modules"), path.join(installed, "node_modules"), "dir");
      env.PATH = path.join(repository, "node_modules", ".bin") + path.delimiter + env.PATH;
      const launcherArgs = launcher === "bunx" ? ["--bun", "--no-install", "pm"] : ["--no-install", "pm"];
      for (const format of ["json", "toon"]) {
        const item = (await sdkCreate({ type: "Task", title: `Consumer ${launcher} ${format}` }, { pmRoot, noExtensions: true })).item;
        const cardId = `card-${launcher}-${format}`;
        await withMockGithub(board([], (_req, res, body) => {
          if (body.includes("addProjectV2DraftIssue")) {
            jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: cardId } } } });
          } else {
            jsonResponse(res, 200, { errors: [{ type: "FORBIDDEN", message: "Fixture Status refusal" }] });
          }
        }), async server => {
          const args = [...launcherArgs, "--path", pmRoot, "github", "project", "sync", "acme/5", "--push", "--apply", "--ids", item.id];
          if (format === "json") args.push("--json");
          const result = await boundedCli(launcher, args, repository, { ...env, PM_GITHUB_API_BASE: server.baseUrl }, 60_000);
          assert.equal(result.code, 0, result.stderr + result.stdout);
          const decoded = format === "json" ? JSON.parse(result.stdout) as unknown : decodeToon(result.stdout);
          const { pushed, pushPartial, pushReceipts } = decoded as { pushed: number; pushPartial: number; pushReceipts: unknown[] };
          assert.equal(pushed, 1);
          assert.equal(pushPartial, 1);
          const row = { pmId: item.id, cardId, outcome: "partial", attachment: { outcome: "attached" },
            status: { outcome: "failed", error: "GitHub GraphQL error: Fixture Status refusal." }, trackerTag: { outcome: "written" } };
          assert.deepEqual(pushReceipts, [row]);
          assert.match(result.stderr, /1 partial/);
        });
        assert.deepEqual((await sdkGet(item.id, {}, { pmRoot })).item.tags, [projectItemTag(REF, cardId)]);
      }
    });
  });
}

test("project import applies configured terminal aliases with SDK lifecycle fidelity and stable pull previews", async t => {
  const root = tracker(t);
  await schemaAddStatus("verified", { alias: ["settled"], role: ["terminal", "terminal_done"] }, { pmRoot: root, noExtensions: true });
  const id = create(root, "Linked", [projectItemTag(REF, "linked")]);
  const nodes = [draft("linked"), draft("created")];
  await withMockGithub(board(nodes), async () => {
    const ext = await harness;
    const request = { command: "github project import", args: ["acme/5"], pmRoot: root, global: { json: true } };
    await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, async () => {
      await assert.rejects(ext.runCommand({ ...request, options: { "status-map": ["settled=Done"] } }), { code: "extension_flag_value_invalid" });
      await ext.runCommand({ ...request, options: { "status-map": "settled=Done" } });
    });
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
    const documents = written.map(item => fs.readFileSync(getItemPath(root, "Task", item.id), "utf8"));
    for (const history of histories) assert.match(history, /GitHub project/);
    const preview = await sync(root, { pull: true, "status-map": "SETTLED=Done" });
    assert.deepEqual(preview.result, { dryRun: true, project: "acme/5", push: undefined, pull: { actionable: 0, statusSkipped: 0 } });
    await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, async () => {
      const options = { "status-map": "settled=Done" };
      const planned = await ext.runCommand({ ...request, options: { ...options, "dry-run": true } });
      assert.deepEqual(planned.result, { dryRun: true, project: "acme/5", wouldImport: 0, wouldUpdate: 0, planned: 2 });
      const repeated = await ext.runCommand({ ...request, options });
      assert.deepEqual(repeated.result, { imported: 0, updated: 0, skipped: 0, project: "acme/5", planned: 2 });
    });
    for (const [index, item] of written.entries()) {
      assert.equal(fs.readFileSync(getHistoryPath(root, item.id), "utf8"), histories[index]);
      assert.equal(fs.readFileSync(getItemPath(root, "Task", item.id), "utf8"), documents[index]);
    }
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

test("project import skips an identical closed item and can update its body without closing again", async t => {
  const root = tracker(t);
  const ext = await harness;
  const request = { command: "github project import", args: ["acme/5"], pmRoot: root, global: { json: true } };
  const card = draft("closed-card", "Done", "done");
  await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, async () => {
    await withMockGithub(board([draft("closed-card", "Todo", "todo")]), async () => {
      await ext.runCommand({ ...request, options: {} });
    });
    await withMockGithub(board([card]), async () => {
      const closure = await ext.runCommand({ ...request, options: {} });
      assert.deepEqual(closure.result, { imported: 0, updated: 1, skipped: 0, project: "acme/5", planned: 1 });
      const [item] = items(root);
      assert.equal(item?.status, "closed");
      const file = getItemPath(root, "Task", item.id);
      const history = getHistoryPath(root, item.id);
      const before = [fs.readFileSync(file, "utf8"), fs.readFileSync(history, "utf8")];
      const preview = await ext.runCommand({ ...request, options: { "dry-run": true } });
      assert.deepEqual(preview.result, { dryRun: true, project: "acme/5", wouldImport: 0, wouldUpdate: 0, planned: 1 });
      const repeat = await ext.runCommand({ ...request, options: {} });
      assert.deepEqual(repeat.result, { imported: 0, updated: 0, skipped: 0, project: "acme/5", planned: 1 });
      assert.deepEqual([fs.readFileSync(file, "utf8"), fs.readFileSync(history, "utf8")], before);
      const edited = { ...card, content: { ...card.content, body: "New board note." } };
      await withMockGithub(board([edited]), async () => {
        const apply = await ext.runCommand({ ...request, options: {} });
        assert.deepEqual(apply.result, { imported: 0, updated: 1, skipped: 0, project: "acme/5", planned: 1 });
      });
      assert.match(fs.readFileSync(file, "utf8"), /New board note\./);
      const appended = appendedHistory(before[1]!, fs.readFileSync(history, "utf8"));
      assert.deepEqual(appended.map(event => event.op), ["update"]);
    });
  });
});

test("project import records a status-only change and repairs a canceled reason only once", async t => {
  const root = tracker(t);
  const ext = await harness;
  const request = { command: "github project import", args: ["acme/5"], options: {}, pmRoot: root, global: { json: true } };
  const client = { pmRoot: root, noExtensions: true };
  const cardId = "lifecycle-card";
  await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, async () => {
    await withMockGithub(board([draft(cardId, "Todo", "todo")]), () => ext.runCommand(request));
    const [item] = items(root);
    assert.ok(item);
    const history = getHistoryPath(root, item.id);
    const beforeStatus = fs.readFileSync(history, "utf8");
    await withMockGithub(board([draft(cardId, "In Progress", "doing")]), async () => {
      const result = await ext.runCommand(request);
      assert.equal((result.result as { updated: number }).updated, 1);
    });
    assert.equal((await sdkGet(item.id, {}, client)).item.status, "in_progress");
    assert.deepEqual(appendedHistory(beforeStatus, fs.readFileSync(history, "utf8")).map(event => event.op), ["update"]);

    await sdkUpdate(item.id, { status: "canceled", closeReason: "Local reason" }, client);
    const beforeReason = fs.readFileSync(history, "utf8");
    await withMockGithub(board([draft(cardId, "Canceled", "cancel")]), async () => {
      const result = await ext.runCommand(request);
      assert.equal((result.result as { updated: number }).updated, 1);
      assert.equal((await sdkGet(item.id, {}, client)).item.close_reason, "GitHub project acme/5 item closed");
      const afterReason = fs.readFileSync(history, "utf8");
      assert.deepEqual(appendedHistory(beforeReason, afterReason).map(event => event.op), ["update"]);
      const file = getItemPath(root, "Task", item.id);
      const document = fs.readFileSync(file, "utf8");
      const repeat = await ext.runCommand(request);
      assert.equal((repeat.result as { updated: number }).updated, 0);
      assert.equal(fs.readFileSync(file, "utf8"), document);
      assert.equal(fs.readFileSync(history, "utf8"), afterReason);
    });
  });
});

test("ambiguous Projects links refuse preview and apply without altering item or history bytes", async t => {
  const root = tracker(t);
  const first = draft("First", "In Progress", "doing");
  const second = draft("Second", "Todo", "todo");
  const id = create(root, "Linked", [projectItemTag(REF, "First"), projectItemTag(REF, "Second")]);
  const files = [getItemPath(root, "Task", id), getHistoryPath(root, id)];
  const before = files.map(file => fs.readFileSync(file, "utf8"));
  const ext = await harness;
  const request = { command: "github project import", args: ["acme/5"], pmRoot: root, global: { json: true } };
  const conflict = { code: "github_project_link_conflict" };
  await withEnv({ GITHUB_TOKEN: "fixture", GH_TOKEN: undefined }, async () => {
    for (const cards of [[first, second], [second, first]]) {
      await withMockGithub(board([draft("Unlinked"), ...cards]), async server => {
        await assert.rejects(ext.runCommand({ ...request, options: {} }), conflict);
        await assert.rejects(ext.runCommand({ ...request, options: { "dry-run": true } }), conflict);
        for (const options of [{ pull: true }, { pull: true, apply: true }]) {
          await assert.rejects(sync(root, options), conflict);
        }
        assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before);
        assert.deepEqual(items(root).map(item => item.id), [id]);
        assert.equal(server.requests.filter(req => req.body.includes("mutation")).length, 0);
      });
    }
    await withMockGithub(board([first]), async () => {
      const result = await ext.runCommand({ ...request, options: {} });
      assert.equal((result.result as { updated: number }).updated, 1);
      const applied = files.map(file => fs.readFileSync(file, "utf8"));
      const repeat = await ext.runCommand({ ...request, options: {} });
      assert.equal((repeat.result as { updated: number }).updated, 0);
      assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), applied);
    });
  });
});

for (const prefer of ["pm", "github"]) {
  test(`project sync resolves simultaneous status conflicts in favor of ${prefer}`, async t => {
    const root = tracker(t);
    create(root, "Linked", [projectItemTag(REF, "linked"), "area,api", '["json"]']);
    let mutations = 0;
    await withMockGithub(board([draft("linked")], (_req, res) => {
      mutations++;
      jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "linked" } } } });
    }), async () => {
      const result = await sync(root, { push: true, pull: true, apply: true, prefer });
      assert.deepEqual(aggregate(result.result), { project: "acme/5", pushed: prefer === "pm" ? 1 : 0, pushFailed: 0, pulled: prefer === "github" ? 1 : 0, pullFailed: 0, prefer });
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
    assert.deepEqual(aggregate(result.result), { project: "acme/5", pushed: 0, pushFailed: 0, pulled: 1, pullFailed: 1, prefer: "pm" });
    assert.match(stderr.join("\n"), /1 failed/);
    const refused = await captureStderr(() =>
      assert.rejects(sync(root, { pull: true, apply: true, ids: closedId }), /Sync wrote nothing; 1 operation/));
    assert.ok(refused.stderr.some(line => line.includes(`pull ${closedId}`)));
  });
  const local = items(root).find(i => i.title === "Cancel");
  assert.equal(local?.status, "canceled");
  assert.equal(local?.close_reason, "GitHub project status → canceled");
});

test("project push continues after remote failures and fails when the entire batch fails", async t => {
  const root = tracker(t);
  const missing = create(root, "Missing issue", ["gh:acme/widgets#99"]);
  await own(root, missing, "https://github.com/acme/widgets/issues/99");
  create(root, "Rejected draft");
  create(root, "No id draft");
  const ok = create(root, "Good draft");
  await withMockGithub(board([], (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    if (call.query.includes("issueOrPullRequest")) jsonResponse(res, 200, { data: { repository: null } });
    else if (call.variables.t === "Rejected draft") jsonResponse(res, 200, { errors: [{ message: "Rejected by board" }] });
    else if (call.variables.t === "No id draft") jsonResponse(res, 200, { data: { addProjectV2DraftIssue: null } });
    else if (call.query.includes("addProjectV2DraftIssue")) jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: { id: "good" } } } });
    else jsonResponse(res, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "good" } } } });
  }), async () => {
    const { result, stderr } = await captureStderr(() => sync(root, { push: true, apply: true }));
    assert.deepEqual(aggregate(result.result), { project: "acme/5", pushed: 1, pushFailed: 3, pulled: 0, pullFailed: 0, prefer: "pm" });
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
  await own(root, id, "https://github.com/acme/widgets/issues/7");
  let omitId = true;
  await withMockGithub(board([], (_req, res, body) => {
    const call = JSON.parse(body) as GraphqlCall;
    const data = call.query.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { id: "issue" } } }
      : { addProjectV2ItemById: omitId ? {} : { item: { id: "attached" } } };
    jsonResponse(res, 200, { data });
  }, false), async server => {
    await assert.rejects(sync(root, { apply: true, push: true }), /could not confirm any writes/);
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
    assert.deepEqual(aggregate(result.result), { project: "acme/5", pushed: 1, pushFailed: 0, pulled: 0, pullFailed: 0, prefer: "pm" });
    assert.match(stderr.join("\n"), /linked but tag write failed/);
    const { pushReceipts, pushPartial } = result.result as { pushReceipts: { outcome: string; cardId: string; trackerTag: { outcome: string } }[]; pushPartial: number };
    assert.equal(pushPartial, 1);
    assert.equal(pushReceipts[0]?.cardId, "remote-created");
    assert.equal(pushReceipts[0]?.outcome, "partial");
    assert.equal(pushReceipts[0]?.trackerTag.outcome, "failed");
  });
  assert.deepEqual(items(root), []);
});

test("project sync validates the token and reference before contacting GitHub", async t => {
  const root = tracker(t);
  const ext = await harness;
  await assert.rejects(ext.runCommand({ command: "github project sync", args: ["invalid"], pmRoot: root }), /Usage:/);
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { createExtensionTestHarness } from ${JSON.stringify(import.meta.resolve("@unbrained/pm-cli/sdk/testing"))};
    import extension from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    const ext = await createExtensionTestHarness(extension, { capabilities: ['commands', 'importers', 'schema', 'hooks', 'preflight', 'search'] });
    await assert.rejects(ext.runCommand({ command: 'github project sync', args: ['acme/5'], pmRoot: ${JSON.stringify(root)} }), /needs a GitHub token/);
  `, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "" });
});

test("project sync previews additions without Status and a linked item without an option", async t => {
  const root = tracker(t);
  create(root, "Draft");
  const owned = create(root, "Issue", ["gh:acme/widgets#7"]);
  await own(root, owned, "https://github.com/acme/widgets/issues/7");
  create(root, "Linked", [projectItemTag(REF, "linked")]);
  await withMockGithub(board([{ id: "linked", content: { __typename: "DraftIssue" } }], undefined, false), async () => {
    const { stderr, result } = await captureStderr(() => sync(root, { push: true }));
    assert.equal((result.result as { push: { actionable: number } }).push.actionable, 2);
    assert.match(stderr.join("\n"), /add draft\n/);
    assert.match(stderr.join("\n"), /add issue acme\/widgets#7\n/);
  });
});

test("project sync reports missing mutation IDs without treating a malformed reference as ownership", async t => {
  const root = tracker(t);
  create(root, "Draft with missing remote id");
  create(root, "Malformed issue", ["gh:broken#7"]);
  await withMockGithub(board([], (_req, res) => jsonResponse(res, 200, { data: { addProjectV2DraftIssue: { projectItem: {} } } })), async () => {
    const { stderr } = await captureStderr(() => assert.rejects(sync(root, { push: true, apply: true }), /failed/));
    assert.match(stderr.join("\n"), /returned no item id/);
    assert.doesNotMatch(stderr.join("\n"), /could not resolve node id for broken#7/);
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
  const owned = create(root, "Linked issue", ["gh:acme/widgets#7"]);
  await own(root, owned, "https://github.com/acme/widgets/issues/7");
  const apply = () => sync(root, { push: true, apply: true });
  const incomplete = { fieldValueByName: { name: "Done", optionId: "done" }, content: {
    __typename: "Issue", number: 7, repository: { nameWithOwner: "acme/widgets" },
  } };
  await withMockGithub(board([incomplete]), async server => {
    await assert.rejects(apply(), /incomplete Projects board inventory/);
    assert.ok(server.requests.every(request => !request.body.includes("mutation")));
  });
  await withMockGithub(board([], (_req, res, body) => {
    const query = (JSON.parse(body) as GraphqlCall).query;
    jsonResponse(res, 200, { data: query.includes("issueOrPullRequest") ? { repository: { issueOrPullRequest: { id: "issue" } } } : { addProjectV2ItemById: { item: {} } } });
  }), async server => {
    const { stderr } = await captureStderr(() => assert.rejects(apply(), /failed/));
    assert.match(stderr.join("\n"), /returned no item id/);
    assert.equal(server.requests.filter(request => request.body.includes("addProjectV2ItemById")).length, 1);
    assert.ok(server.requests.every(request => !request.body.includes("updateProjectV2ItemFieldValue")));
  });
  assert.deepEqual(items(root).find(item => item.id === owned)?.tags, ["gh:acme/widgets#7"]);
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
  const scope = { clearDeps: true, unset: ["parent", "sprint", "release", "goal", "objective"] };
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
    if (target.id === imported.id) document.metadata.github_url = "https://github.com/acme/widgets/issues/7";
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
    await withMockGithub(interleaved(pushed.id, board([], (_req, res, body) => jsonResponse(res, 200, { data: body.includes("addProjectV2DraftIssue")
      ? { addProjectV2DraftIssue: { projectItem: { id: "native-push" } } }
      : { updateProjectV2ItemFieldValue: { projectV2Item: { id: "native-push" } } } }))), async () => {
      const result = await sync(pmRoot, { apply: true, push: true, ids: pushed.id });
      assert.equal((result.result as { pushed: number }).pushed, 1);
    });
    const afterPush = (await sdkGet(pushed.id, {}, { pmRoot })).item;
    assert.deepEqual(new Set(afterPush.tags), new Set([...expected.get(pushed.id)!, projectItemTag(REF, "native-push")]));
    assert.equal(boundaries.get(imported.id), 2);
    assert.equal(boundaries.get(pushed.id), 5);
  });
});

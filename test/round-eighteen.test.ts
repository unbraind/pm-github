/** Ownership races and defensive boundaries use native non-git SDK trackers. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { init, create, get, listAllComplete, mutateItem, readSettings, getItemPath, getHistoryPath, comments, runWithActiveExtensions, setActiveExtensionHooks, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import extension, { applyPushEntry, syncGithubCommentsToAnnotations, prepareGithubImport, parseImportOptions, importGithubAtomic, listRetainedGithubImportPlans, verifyImportIdempotency, runImport, type PmItem, type GhComment, type GhIssue } from "../index.ts";
import { assertCloseoutGithubOwner } from "../closeout.ts";
import { selectRefreshTargets, runRefresh } from "../refresh.ts";
import { parseLegacyGithubDescription, legacyGithubIdentityConflict, legacyGithubDescriptionIdentity, matchImportedIssue } from "../import-fidelity.ts";
import { buildGithubOwnershipIndex, withGithubImportOwners, githubOwnershipClaims } from "../import-ownership.ts";
import { buildProjectPushPlan, projectItemTag, type ProjectItem, type ProjectMeta } from "../projects.ts";
import { withEnv, withMockGithub, jsonResponse, captureStderr } from "./helpers/mock-github-server.ts";

const repo = "o/r", issueUrl = "https://github.com/o/r/issues/7", ref = { owner: "o", number: 1 };
const meta: ProjectMeta = { id: "BOARD_NODE", title: "Fixture board", url: "https://github.com/orgs/o/projects/1", ownerType: "organization",
  statusField: { id: "STATUS_FIELD", name: "Status", options: [{ id: "TODO_OPTION", name: "Todo" }, { id: "DOING_OPTION", name: "In Progress" }] } };
/** Isolate native data and prevent ancestor tracker discovery. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-round-eighteen-")), root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Independent ordinary SDK writers deliberately do not acquire the package ownership lease. */
async function change(root: string, id: string, fields: Record<string, unknown>, unset: readonly string[] = []) {
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => mutateItem({ pmRoot: root, id, settings: await readSettings(root), author: "fixture-peer", op: "update", mutate: document => {
    for (const key of unset) delete document.metadata[key];
    for (const [key, value] of Object.entries(fields)) { if (key === "body") document.body = String(value); else document.metadata[key] = value; } return { changedFields: [...Object.keys(fields), ...unset] };
  } }));
}
/** Create and reread full provider metadata through the pinned SDK. */
async function native(root: string, fields: Record<string, unknown> = {}): Promise<PmItem> {
  const item = (await create({ title: "Curated delivery", type: "Chore", body: "Local context", tags: "retained", status: "open" }, { pmRoot: root })).item;
  await change(root, item.id, fields);
  return (await listAllComplete({ includeBody: true }, { pmRoot: root, noExtensions: true })).items.find(row => row.id === item.id)!;
}
/** Refusals preserve authoritative item and history bytes after the peer's own change. */
function bytes(root: string, item: PmItem) { return [getItemPath(root, String(item.type), item.id!), getHistoryPath(root, item.id!)].map(file => readFileSync(file, "hex")); }

for (const clear of [false, true]) test(`board add-issue requires a current positive owner after node resolution (${clear})`, async () => tracker(async root => {
  const item = await native(root, { github_url: issueUrl });
  const plan = buildProjectPushPlan([item], ref, [], meta.statusField).entries[0]!;
  assert.equal(plan.action, "add-issue");
  let peerBytes = bytes(root, item);
  await withMockGithub(async (_request, response, body) => {
    const query = (JSON.parse(body) as { query: string }).query;
    if (query.includes("issueOrPullRequest")) {
      if (clear) { await change(root, item.id!, {}, ["github_url"]); peerBytes = bytes(root, item); }
      jsonResponse(response, 200, { data: { repository: { issueOrPullRequest: { id: "ISSUE_NODE" } } } });
    } else if (query.includes("addProjectV2ItemById")) jsonResponse(response, 200, { data: { addProjectV2ItemById: { item: { id: "ATTACHED_NODE" } } } });
    else jsonResponse(response, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ATTACHED_NODE" } } } });
  }, async server => {
    const result = await applyPushEntry(plan, meta, ref, new Map([[item.id!, item]]), root, "fixture", []);
    if (clear) {
      assert.equal(result.changed, false); assert.match(result.error!, /current owner.*curated\/unowned/);
      assert.equal(server.requests.length, 1, "Only the read query may reach GitHub; no attachment or status mutation");
      assert.deepEqual(bytes(root, item), peerBytes);
      assert.equal((await get(item.id!, {}, { pmRoot: root })).item.tags!.some(tag => tag.startsWith("gh-project:")), false);
    } else {
      assert.equal(result.changed, true, result.error ?? "Unexpected board refusal"); assert.equal(server.requests.length, 3);
      assert.equal((await get(item.id!, {}, { pmRoot: root })).item.github_url, issueUrl);
      assert.ok((await get(item.id!, {}, { pmRoot: root })).item.tags!.includes(projectItemTag(ref, "ATTACHED_NODE")));
    }
  });
}));

for (const removeTag of [false, true]) test(`a zero-owner board status needs its current board tag (${removeTag})`, async () => tracker(async root => {
  const tag = projectItemTag(ref, "EXISTING_NODE"), item = await native(root, { tags: ["retained", tag] });
  const board: ProjectItem[] = [{ id: "EXISTING_NODE", statusName: "In Progress", content: { typename: "Issue", title: "Existing issue", repo, number: 7 } }];
  const plan = buildProjectPushPlan([item], ref, board, meta.statusField).entries[0]!; assert.equal(plan.action, "set-status");
  if (removeTag) await change(root, item.id!, { tags: ["retained"] });
  const before = bytes(root, item);
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "EXISTING_NODE" } } } }), async server => {
    const result = await applyPushEntry(plan, meta, ref, new Map([[item.id!, item]]), root, "fixture", board);
    assert.equal(result.changed, !removeTag, result.error ?? "Unexpected board result");
    assert.equal(server.requests.length, removeTag ? 0 : 1);
    if (removeTag) assert.match(result.error!, /missing current board tag/);
    assert.deepEqual(bytes(root, item), before);
  });
}));

test("zero-owner draft creation remains authorized without an issue link or existing board tag", async () => tracker(async root => {
  const item = await native(root), plan = buildProjectPushPlan([item], ref, [], meta.statusField).entries[0]!;
  assert.equal(plan.action, "add-draft");
  await withMockGithub((_request, response, body) => {
    const query = (JSON.parse(body) as { query: string }).query;
    jsonResponse(response, 200, { data: query.includes("addProjectV2DraftIssue") ? { addProjectV2DraftIssue: { projectItem: { id: "DRAFT_NODE" } } }
      : { updateProjectV2ItemFieldValue: { projectV2Item: { id: "DRAFT_NODE" } } } });
  }, async server => {
    const result = await applyPushEntry(plan, meta, ref, new Map([[item.id!, item]]), root, "fixture", []);
    assert.equal(result.changed, true, result.error ?? "Unexpected board refusal"); assert.equal(server.requests.length, 2);
    const after = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items[0]!;
    for (const field of ["title", "type", "created_at", "body"] as const) assert.equal(after[field], item[field]);
    assert.ok(after.tags!.includes(projectItemTag(ref, "DRAFT_NODE")));
  });
}));

for (const competing of [false, true]) test(`each separately locked comment rereads ordinary SDK peer claims (${competing})`, async () => tracker(async root => {
  const owner = await native(root, { github_url: issueUrl }), peer = await native(root);
  const incoming: GhComment[] = [1, 2].map(id => ({ id, body: `Public comment ${id}`, created_at: "2025-02-01T00:00:00Z", user: { login: "fixture" } }));
  let changed = false;
  const outcome = await captureStderr(() => runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], beforeMutation: [], onRead: [], onIndex: [], onWrite: [{ layer: "project", name: "ordinary-peer-between-comments", run: async context => {
      if (changed || !competing || !context.path.endsWith(`${owner.id}.toon`)) return;
      changed = true; await change(root, peer.id!, { external_ref: "gh:o/r#7" });
    } }] });
    return syncGithubCommentsToAnnotations(owner.id!, incoming, root, 7, { id: owner.id!, repo, number: 7 });
  }));
  const stored = (await comments(owner.id!, {}, { pmRoot: root })).comments;
  assert.equal(outcome.result.added, competing ? 1 : 2); assert.equal(outcome.result.failed, competing ? 1 : 0);
  assert.equal(stored.length, competing ? 1 : 2); assert.match(stored[0]!.text!, /Public comment 1/);
  if (competing) { assert.equal(changed, true); assert.ok(outcome.stderr.some(line => /multiple existing owners|current owner/.test(line))); }
  else assert.match(stored[1]!.text!, /Public comment 2/);
}));


/** Provider rows remain synthetic inputs; preparation and every local write use the real SDK. */
function source(): GhIssue { return { number: 7, title: "Remote source", body: "Public source", state: "open", labels: [], user: null, assignee: null,
  milestone: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: issueUrl }; }

for (const number of ["0", "-1", "9007199254740993", "8", "7"]) test(`declared-number guard validates native declaration before ownership (${number})`, async () => tracker(async root => {
  const item = await native(root, { description: `GH issue #${number}: ${issueUrl}` }), before = bytes(root, item);
  const parsed = parseLegacyGithubDescription(item)!;
  assert.equal(parsed.invalidNumber, number !== "7"); assert.equal(legacyGithubDescriptionIdentity(item)?.key, number === "7" ? "o/r#7" : undefined);
  assert.deepEqual(githubOwnershipClaims(item).owners, number === "7" ? ["o/r#7"] : []);
  assert.deepEqual(bytes(root, item), before);
}));

for (const variant of ["unowned", "same", "foreign", "contradictory"] as const) test(`closeout ownership guards run on native claims (${variant})`, async () => tracker(async root => {
  const fields = variant === "unowned" ? {} : { github_url: variant === "foreign" ? "https://github.com/other/project/issues/8" : issueUrl,
    ...(variant === "contradictory" ? { external_ref: "gh:o/r#8" } : {}) };
  const item = await native(root, fields), before = bytes(root, item);
  if (variant === "contradictory") { const state = githubOwnershipClaims(item); assert.equal(state.evidence, true); assert.equal(state.owners.length, 2); }
  const run = () => assertCloseoutGithubOwner(item as Parameters<typeof assertCloseoutGithubOwner>[0], repo, buildGithubOwnershipIndex([item], [repo]));
  if (variant === "unowned" || variant === "same") assert.doesNotThrow(run);
  else assert.throws(run, error => {
    assert.equal((error as { code: string }).code, "github_import_owner_conflict");
    assert.equal((error as { expected: string }).expected, "o/r (delivery repository)");
    assert.ok(String(error).includes(variant === "foreign" ? "other/project#8" : "o/r#8")); return true;
  });
  assert.deepEqual(bytes(root, item), before);
}));

for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`refresh safe-number guard refuses a crafted native number (${invalid})`, async () => tracker(async root => {
  const item = await native(root, { github_repo: repo, github_number: invalid }), before = bytes(root, item);
  assert.throws(() => selectRefreshTargets([item], repo), /Refresh found an invalid issue number/);
  assert.deepEqual(bytes(root, item), before);
}));

test("refresh conflicting-number guard rejects native contradictory URL and number claims", async () => tracker(async root => {
  const item = await native(root, { github_repo: repo, github_number: 8, github_url: issueUrl }), before = bytes(root, item);
  assert.throws(() => selectRefreshTargets([item], repo), error => {
    assert.equal((error as { code: string }).code, "github_import_owner_conflict");
    assert.match((error as { expected: string }).expected, /Refresh found conflicting GitHub identities/); return true;
  });
  assert.deepEqual(bytes(root, item), before);
  const consistent = await native(root, { github_repo: repo, github_number: 7, github_url: issueUrl });
  assert.equal(selectRefreshTargets([consistent], repo)[0]!.id, consistent.id);
}));

test("duplicate identity tracking refuses two native owners and tolerates repeated rows of one owner", async () => tracker(async root => {
  const first = await native(root, { github_url: issueUrl }), entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, first, undefined, { items: [first], releases: [], timeline: async () => [] }))!;
  assert.equal(verifyImportIdempotency([first, first], [entry], repo).provenance_indexed, 1);
  const peer = await native(root, { external_ref: "gh:o/r#7" }), before = [first, peer].map(item => bytes(root, item));
  assert.throws(() => verifyImportIdempotency([first, peer], [entry], repo), error => {
    assert.equal((error as { code: string }).code, "github_import_owner_conflict"); assert.match(String(error), /claimed by/); assert.ok((error as { owners: string[] }).owners.every(owner => owner.includes("claimed by"))); return true;
  });
  assert.deepEqual([first, peer].map(item => bytes(root, item)), before);
}));

test("an out-of-plan claim is filtered before the shared contradiction refusal", async () => tracker(async root => {
  const initial = await native(root, { github_url: issueUrl }), entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, initial, undefined, { items: [initial], releases: [], timeline: async () => [] }))!;
  await change(root, initial.id!, { external_ref: "gh:o/r#8" });
  const current = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items[0]!, before = bytes(root, current);
  assert.throws(() => verifyImportIdempotency([current], [entry], repo), { code: "github_import_owner_conflict" });
  assert.deepEqual(bytes(root, current), before);
}));

test("atomic ownership rethrow preserves a native peer-relink refusal before an SDK journal starts", async () => tracker(async root => {
  const item = await native(root, { github_url: issueUrl }), entry = (await prepareGithubImport(source(), repo, parseImportOptions({}), undefined, item, undefined, { items: [item], releases: [], timeline: async () => [] }))!;
  let starts = 0, peerBytes: string[] | undefined;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onPlanStaged: async () => {
    await change(root, item.id!, { github_url: "https://github.com/other/project/issues/8" }); peerBytes = bytes(root, item);
  }, onTransition: () => { starts++; } }), error => {
    assert.equal((error as { code: string }).code, "github_import_owner_conflict"); assert.match(String(error), /other\/project#8/); return true;
  });
  assert.equal(starts, 0); assert.deepEqual(bytes(root, item), peerBytes);
  assert.deepEqual(await listRetainedGithubImportPlans(root), [], "A pre-journal ownership refusal must remove its staged plan");
}));

for (const corrupt of ["missing-id"] as const) test(`certified native corpus refuses ${corrupt} before constructing a writable owner index`, async () => tracker(async root => {
  const owner = await native(root, { github_url: issueUrl }), peer = await native(root);
  const { id: _id, ...withoutId } = peer;
  writeFileSync(getItemPath(root, String(peer.type), peer.id!), serializeItemDocument({ metadata: withoutId as Parameters<typeof serializeItemDocument>[0]["metadata"], body: "Local context" }));
  const before = [owner, peer].map(item => bytes(root, item)); let started = false;
  await assert.rejects(() => withGithubImportOwners(root, [{ id: owner.id!, repo, number: 7 }], async () => { started = true; }), error => /incomplete|duplicate|invalid|id/i.test(String(error)));
  assert.equal(started, false); assert.deepEqual([owner, peer].map(item => bytes(root, item)), before);
}));

test("a native proposal removing its id is refused before any peer snapshot can authorize the write", async () => tracker(async root => {
  const item = await native(root), before = bytes(root, item), settings = await readSettings(root);
  await assert.rejects(() => withGithubImportOwners(root, [{ id: item.id!, repo, number: 7, initialLink: () => true }], () => mutateItem({ pmRoot: root, id: item.id!, settings, author: "fixture", op: "update", mutate: document => {
    delete (document.metadata as Record<string, unknown>).id; return { changedFields: ["id"] };
  } })), /changed or removed the target id/);
  assert.deepEqual(bytes(root, item), before);
  await native(root, { github_url: issueUrl });
  const corpus = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items, index = buildGithubOwnershipIndex(corpus, [repo]);
  for (const [id, row] of index.byId) {
    assert.ok(index.states.has(row));
    for (const key of index.states.get(row)!.claims) assert.ok(index.claimants.get(key)!.has(id));
  }
}));

test("legacy reference-conflict consumers are unreachable for the strongest mention-only native records", async () => tracker(async root => {
  const reference = await native(root, { github_number: 7, tags: ["gh:o/r#7", "gh:other/project#7", "gh:o/r#8"] });
  const second = await native(root, { tags: ["gh:o/r#7", "gh:other/project#7"] });
  for (const item of [reference, second]) { assert.equal(legacyGithubIdentityConflict(item), undefined); assert.deepEqual(githubOwnershipClaims(item).owners, []); }
  const before = [reference, second].map(item => bytes(root, item));
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url!.includes("/issues?") ? [source()] : []), async () => {
    const result = await runImport(repo, root, parseImportOptions({ atomic: true, "dry-run": true }));
    assert.equal("wouldImport" in result && result.wouldImport, 1); assert.equal("identity_conflicts" in result, false);
    assert.equal("identity_conflicts" in await runRefresh(repo, root, { "dry-run": true }), false);
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
    const sync = await harness.runCommand({ command: "github sync", pmRoot: root, options: { repo, "dry-run": true } });
    assert.equal("identity_conflicts" in sync, false);
  });
  assert.deepEqual([reference, second].map(item => bytes(root, item)), before);
}));

for (const author of ["fixture", "pm-github"]) test(`citation adoption counts the native curated/mirroring branch (${author})`, async () => tracker(async root => {
  const item = await native(root, { author, body: `Issue: ${issueUrl}` });
  await withMockGithub((request, response) => jsonResponse(response, 200, request.url!.includes("/issues?") ? [source()] : []), async () => {
    const result = await runImport(repo, root, parseImportOptions({ adoptCited: true }));
    assert.equal("adopted" in result && result.adopted, 1);
    assert.equal("updated" in result && result.updated, 0);
    const after = (await listAllComplete({ includeBody: true }, { pmRoot: root })).items;
    assert.equal(after.length, 1); assert.equal(after[0]!.id, item.id);
    assert.equal(after[0]!.title, author === "pm-github" ? source().title : item.title);
  });
}));

for (const malformed of [false, true]) test(`Unicode-shifted native citation boundaries preserve the malformed-URL guard (${malformed})`, async () => tracker(async root => {
  const item = await native(root, { body: `Issue: ${issueUrl}\n\n${"İ".repeat(11)}${malformed ? "github.com/ issues/7" : " harmless context"}` }), before = bytes(root, item);
  const match = matchImportedIssue([item], source(), undefined, true);
  assert.equal(match.item?.id, malformed ? undefined : item.id);
  if (malformed) assert.deepEqual(match.citation_candidates, [{ id: item.id!, reason: "multiple_issues" }]);
  else assert.equal(match.via, "citation");
  assert.deepEqual(bytes(root, item), before);
}));

test("board status retains a current matching issue owner", async () => tracker(async root => {
  const tag = projectItemTag(ref, "EXISTING_NODE"), item = await native(root, { github_url: issueUrl, tags: ["retained", tag] });
  const board: ProjectItem[] = [{ id: "EXISTING_NODE", statusName: "In Progress", content: { typename: "Issue", title: "Existing issue", repo, number: 7 } }];
  const plan = buildProjectPushPlan([item], ref, board, meta.statusField).entries[0]!, before = bytes(root, item);
  assert.equal(plan.action, "set-status");
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "EXISTING_NODE" } } } }), async server => {
    const result = await applyPushEntry(plan, meta, ref, new Map([[item.id!, item]]), root, "fixture", board);
    assert.equal(result.changed, true, result.error ?? "Unexpected matching-owner refusal"); assert.equal(server.requests.length, 1);
    assert.deepEqual(bytes(root, item), before);
  });
}));

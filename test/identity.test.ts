/** Identity exploration uses real SDK storage in non-git directories, including durable audit. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, symlinkSync, chmodSync, cpSync, copyFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  init, create, update, get, commitImportedItem, getItemPath, readSettings,
  readHistorySnapshot, getHistoryPath, WorkspaceTransactionInterruptedError, type ItemMetadata,
} from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { exploreGithubIdentities, planGithubIdentityRepair, applyGithubIdentityRepair } from "../index.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

const key = "gh:fixture/repo#1";
const url = "https://github.com/fixture/repo/issues/1";
/** Capture all bytes, including history and journals, for zero-write assertions. */
function snapshot(root: string) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = join(entry.parentPath, entry.name);
    return [file, createHash("sha256").update(readFileSync(file)).digest("hex")];
  }));
}
/** Initialize real storage with no enclosing git repository and then remove git from PATH. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pm-identities-"));
  const root = join(directory, "tracker");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  try {
    await withEnv({ GIT_CEILING_DIRECTORIES: tmpdir(), PM_AUTHOR: "fixture", PM_PATH: root, PATH: bin }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root, noExtensions: true });
      await run(root);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Seed provider metadata through the host import primitive with genuine append-only history. */
async function item(root: string, fields: Record<string, unknown>, body = "") {
  const created = (await create({ title: "Identity fixture", type: "Task" }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: created.id, itemPath: getItemPath(root, "Task", created.id),
    document: { metadata: { ...created, ...fields }, body }, settings: await readSettings(root),
    author: "fixture", message: "Seed provider identity", conflictWarningPrefix: "fixture" });
  return created.id;
}
/** Verify typed expected refusals without depending on diagnostic prose. */
function code(expected: string) { return (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; }; }

test("copied prose, structured multi-provider owners, exact refs and bounded graph remain distinct without git", async () => tracker(async root => {
  const owner = await item(root, { github_url: url, tags: [key], github_link_only: false });
  const copied = await item(root, { tags: ["linear:example"], linear_id: null, jira_key: "", ado_id: "   " }, `Example [linear] linear_id=sample ${url} ${url}`);
  const provider = await item(root, { github_url: url.replace("/1", "/2"), linear_id: "stable-id", github_link_only: true, tags: ["gh:fixture/repo#2"] });
  const mixed = await item(root, { github_url: url.replace("/1", "/3"), jira_key: "ENG-3" });
  await item(root, { external_ref: key, tags: ["normal-label"] });
  await item(root, { external_ref: "jira:ENG-4", jira_key: 123 });
  await item(root, { external_ref: "jira:ENG-4" });
  await item(root, { description: `GitHub issue: ${url.replace("/1", "/5")}` });
  await item(root, { description: "See https://github.com/fixture/repo/pull/6" });
  await item(root, { description: "GitHub issue https://example.invalid/issue/1" });
  const conflict = await item(root, { github_url: "https://github.com/fixture/repo/issues/8", tags: ["gh:fixture/repo#9"], source_owner: "fixture-provider" });
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())) chmodSync(join(entry.parentPath, entry.name), 0o444);
  const before = snapshot(root);
  const report = await exploreGithubIdentities(root);
  assert.equal(report.scanned, 11);
  assert.equal(report.collisions, 4);
  assert.equal(report.mentions, 2);
  assert.equal(report.nodes.find(node => node.id === conflict)?.native_owner, "fixture-provider");
  assert.equal(report.nodes.find(node => node.id === copied)?.ownership, "local");
  assert.equal((await exploreGithubIdentities(root, { identity: "gh:fixture/repo#2" })).nodes.find(node => node.id === provider)?.ownership, "provider");
  assert.equal((await exploreGithubIdentities(root, { identity: "gh:fixture/repo#3" })).nodes.find(node => node.id === mixed)?.ownership, "mixed");
  assert.equal(report.nodes.find(node => node.id === owner)?.ownership, "github");
  const first = await exploreGithubIdentities(root, { limit: 1 });
  assert.equal(first.total, 5);
  assert.equal(first.next, 1);
  assert.equal((await exploreGithubIdentities(root, { limit: 1, offset: 4 })).next, null);
  assert.deepEqual((await exploreGithubIdentities(root, { identity: "absent" })).edges, []);
  assert.deepEqual(snapshot(root), before);
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.1 }, { offset: -1 }, { offset: NaN }]) await assert.rejects(exploreGithubIdentities(root, options), code("invalid_options"));
  const empty = join(root, "missing");
  await assert.rejects(exploreGithubIdentities(empty), code("incomplete_read"));
}));

for (const fields of [{ tags: [key, "keep"], external_ref: "jira:ENG-2" }, { tags: [key], external_ref: undefined }]) {
  test(`approved detach is audited, scoped and byte-idempotent (${Object.keys(fields).join("+")})`, async () => tracker(async root => {
    const owner = await item(root, { github_url: "https://github.com/FIXTURE/REPO/pull/1?view=all", github_link_only: false });
    const detach = await item(root, { ...fields, linear_id: "real-provider-id", release: "2026.1.1" }, "keep provider content");
    const before = snapshot(root);
    const proposed = await planGithubIdentityRepair(root, key, owner, detach);
    assert.ok(proposed.changes.length);
    assert.deepEqual(snapshot(root), before);
    await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture", approval: "bad" }), code("invalid_options"));
    await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: " " }), code("invalid_options"));
    await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture", approval: "0".repeat(64) }), code("stale_approval"));
    const result = await applyGithubIdentityRepair(root, { ...proposed, author: "fixture" });
    assert.equal(result.changed, true);
    const updated = (await get(detach, {}, { pmRoot: root })).item;
    assert.equal(updated.linear_id, "real-provider-id");
    assert.equal(updated.release, "2026.1.1");
    assert.equal(updated.body, "keep provider content");
    assert.ok(!updated.tags?.includes(key));
    assert.equal(updated.external_ref, fields.external_ref);
    const history = await readHistorySnapshot(getHistoryPath(root, detach), detach);
    assert.ok(history.entries.some(entry => entry.author === "fixture" && entry.message?.includes(result.transaction)));
    const after = snapshot(root);
    assert.equal((await applyGithubIdentityRepair(root, { ...proposed, author: "fixture" })).changed, false);
    assert.deepEqual(snapshot(root), after);
    assert.equal((await exploreGithubIdentities(root)).collisions, 0);
  }));
}

test("refuse contradictory owners, source metadata, opaque providers and changed approvals before writes", async () => tracker(async root => {
  const owner = await item(root, { github_url: url });
  const detach = await item(root, { tags: [key] });
  const proposed = await planGithubIdentityRepair(root, key, owner, detach);
  await update(detach, { title: "Edited since preview" }, { pmRoot: root });
  await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture" }), code("stale_approval"));
  for (const [ref, rightful, target] of [[key, owner, owner], ["jira:ENG-1", owner, detach], [key, "missing", detach], [key, owner, "missing"]]) {
    await assert.rejects(planGithubIdentityRepair(root, ref!, rightful!, target!), code("ambiguous_identity"));
  }
  const a = await item(root, { github_url: "https://github.com/fixture/repo/issues/2", jira_key: "ENG-1" });
  const b = await item(root, { tags: ["gh:fixture/repo#2"] });
  await assert.rejects(planGithubIdentityRepair(root, "gh:fixture/repo#2", a, b), code("ambiguous_identity"));
  const external = await item(root, { external_ref: key });
  await assert.rejects(planGithubIdentityRepair(root, key, owner, external), code("ambiguous_identity"));
  const before = snapshot(root);
  await item(root, { github_url: url });
  const multiple = snapshot(root);
  await assert.rejects(planGithubIdentityRepair(root, key, owner, detach), code("ambiguous_identity"));
  assert.deepEqual(snapshot(root), multiple);
  assert.notDeepEqual(before, multiple);
}));

for (const fields of [{ github_url: url }, { github_link_only: false }, { github_number: 1 }, { source_owner: "fixture-provider" }, { tags: [key, "gh:fixture/repo#2"] }]) {
  test(`source-owned duplicates require manual review (${Object.keys(fields).join()})`, async () => tracker(async root => {
    const owner = await item(root, { description: `GitHub issue ${url}` });
    const detach = await item(root, { tags: [key], ...fields });
    const before = snapshot(root);
    await assert.rejects(planGithubIdentityRepair(root, key, owner, detach), code("ambiguous_identity"));
    assert.deepEqual(snapshot(root), before);
  }));
}

test("registered command uses compact host TOON/JSON, read-only graph, repair preview and explicit apply", async () => tracker(async root => {
  const owner = await item(root, { github_url: url });
  const detach = await item(root, { tags: [key] });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks", "preflight", "search", "importers"] });
  const run = async (options: Record<string, unknown>) => (await harness.runCommand({ command: "github identity", pmRoot: root, args: [], options })).result;
  const report = await run({ limit: "1", offset: "0", identity: key }) as { collisions: number };
  assert.equal(report.collisions, 1);
  const proposed = await run({ identity: key, owner, detach }) as { approval: string };
  assert.match(proposed.approval, /^[a-f0-9]{64}$/);
  await assert.rejects(run({ owner }), code("invalid_options"));
  await assert.rejects(run({ detach }), code("invalid_options"));
  await assert.rejects(run({ approve: "digest" }), code("invalid_options"));
  await assert.rejects(run({ identity: key, owner: true, detach }), code("invalid_options"));
  await assert.rejects(run({ identity: key, owner, detach: true }), code("invalid_options"));
  await assert.rejects(run({ identity: key, owner, detach, approve: true }), code("invalid_options"));
  const applied = await withEnv({ PM_AUTHOR: undefined }, () => run({ identity: key, owner, detach, approve: proposed.approval })) as { changed: boolean };
  assert.equal(applied.changed, true);
  const packageRoot = join(import.meta.dirname, "..");
  const installed = join(root, "extensions/pm-github");
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  for (const file of ["manifest.json", "package.json"]) copyFileSync(join(packageRoot, file), join(installed, file));
  symlinkSync(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  for (const format of ["toon", "json"]) {
    const result = spawnSync(process.execPath, [join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, ...(format === "json" ? ["--json"] : []), "github", "identity"], { encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /collisions/);
  }
}));

test("external reference mutation gaps refuse with a remedy and no source writes", async () => tracker(async root => {
  const owner = await item(root, { github_url: url });
  const detach = await item(root, { tags: [key], external_ref: url });
  await assert.rejects(applyGithubIdentityRepair(root, { identity: key, owner, detach: "missing", approval: "a".repeat(64), author: "fixture" }), code("ambiguous_identity"));
  const before = snapshot(root);
  await assert.rejects(planGithubIdentityRepair(root, key, owner, detach), code("unsupported_repair"));
  assert.deepEqual(snapshot(root), before);
}));

test("recover an interrupted audited detach and refuse an edit made before locked validation", async () => tracker(async root => {
  const owner = await item(root, { github_url: url });
  const detach = await item(root, { tags: [key, "retain"] });
  const proposed = await planGithubIdentityRepair(root, key, owner, detach);
  await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture", onTransition: context => {
    if (context.transition === "step_applied") throw new WorkspaceTransactionInterruptedError();
  } }), WorkspaceTransactionInterruptedError);
  const recovered = await applyGithubIdentityRepair(root, { ...proposed, author: "fixture" });
  assert.equal(recovered.changed, false);
  const stable = snapshot(root);
  await applyGithubIdentityRepair(root, { ...proposed, author: "fixture" });
  assert.deepEqual(snapshot(root), stable);
  const current = (await get(detach, {}, { pmRoot: root })).item as ItemMetadata & { body: string };
  await commitImportedItem({ pmRoot: root, id: detach, itemPath: getItemPath(root, "Task", detach),
    document: { metadata: { ...current, external_ref: key }, body: current.body! }, settings: await readSettings(root),
    author: "fixture", message: "Reintroduce source reference", conflictWarningPrefix: "fixture" });
  await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture" }), code("stale_approval"));
  await commitImportedItem({ pmRoot: root, id: detach, itemPath: getItemPath(root, "Task", detach),
    document: { metadata: current, body: current.body! }, settings: await readSettings(root),
    author: "fixture", message: "Restore synthetic baseline", conflictWarningPrefix: "fixture" });
  await update(detach, { addTags: [key] }, { pmRoot: root });
  await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture" }), code("stale_approval"));
  const next = await planGithubIdentityRepair(root, key, owner, detach);
  await assert.rejects(applyGithubIdentityRepair(root, { ...next, author: "fixture", onTransition: async context => {
    if (context.transition === "prepared") await update(owner, { title: "Concurrent edit" }, { pmRoot: root });
  } }), code("stale_approval"));
  assert.ok((await get(detach, {}, { pmRoot: root })).item.tags?.includes(key));
}));

test("malformed and mismatched native audit hints cannot authorize a repair", async () => tracker(async root => {
  const owner = await item(root, { github_url: url });
  const detach = await item(root, { tags: [key] });
  const proposed = await planGithubIdentityRepair(root, key, owner, detach);
  const malformed = ["{", JSON.stringify({ ...proposed, revision: null }), JSON.stringify({ ...proposed, revision: "invalid" }),
    JSON.stringify({ ...proposed, changes: [] }), JSON.stringify({ ...proposed, changes: [{ field: "title", after: [] }] }),
    JSON.stringify({ ...proposed, changes: [{ field: "tags", after: [42] }] })];
  for (const value of malformed) {
    await update(detach, { comment: [`GitHub identity repair ${Buffer.from(value).toString("base64url")}`],
      message: `bulk-item-transaction github-identity-${proposed.approval} fixture apply` }, { pmRoot: root });
    await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture" }), code("stale_approval"));
  }
}));

test("an audit receipt cannot be replayed for another identity, owner, target or digest", async () => tracker(async root => {
  const owner = await item(root, { github_url: url });
  const detach = await item(root, { tags: [key] });
  const proposed = await planGithubIdentityRepair(root, key, owner, detach);
  for (const patch of [{ identity: "gh:fixture/repo#2" }, { owner: "another-owner" }, { detach: "another-item" }, { approval: "f".repeat(64) }]) {
    const encoded = Buffer.from(JSON.stringify({ ...proposed, ...patch })).toString("base64url");
    await update(detach, { comment: [`GitHub identity repair ${encoded}`],
      message: `bulk-item-transaction github-identity-${proposed.approval} fixture apply` }, { pmRoot: root });
    await assert.rejects(applyGithubIdentityRepair(root, { ...proposed, author: "fixture" }), code("stale_approval"));
  }
}));

test("read-only isolation refuses symbolic tracker roots and entries without following them", async () => tracker(async root => {
  await item(root, { tags: [key] });
  const linkedRoot = join(root, "../linked-tracker");
  symlinkSync(root, linkedRoot, "dir");
  await assert.rejects(exploreGithubIdentities(linkedRoot), code("incomplete_read"));
  symlinkSync(join(root, "settings.json"), join(root, "linked-entry"));
  const before = snapshot(root);
  await assert.rejects(exploreGithubIdentities(root), code("incomplete_read"));
  assert.deepEqual(snapshot(root), before);
  unlinkSync(join(root, "linked-entry"));
}));

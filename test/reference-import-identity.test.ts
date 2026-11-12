/** Reference tags never transfer curated content ownership; all storage is real SDK storage. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { init, create, get, getItemPath, getHistoryPath, listAllComplete, commitImportedItem, readSettings } from "@unbrained/pm-cli/sdk";
import { runImport, parseImportOptions, type GhIssue } from "../index.ts";
import { selectRefreshTargets } from "../refresh.ts";
import { exploreGithubIdentities } from "../identity.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const tag = "gh:o/r#7";
const issue: GhIssue = { number: 7, title: "Source issue", body: "Source body", state: "open", labels: [{ name: "source-label" }],
  assignee: null, milestone: null, user: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z", html_url: "https://github.com/o/r/issues/7" };

/** Initialize isolated SDK storage, including the supported non-git case. */
async function tracker(git: boolean, run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "reference-identity-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Mock transport only; planner, transactions, metadata, history and the gate use their actual implementations. */
async function sync(root: string, source = issue, atomic = true, gate = true) {
  return (await captureStderr(() => runImport(repo, root, parseImportOptions({ state: "all", atomic, gate }), {
    resolveToken: () => undefined, fetchIssues: async () => [source], fetchIssueTimeline: async () => [],
  }))).result as Record<string, unknown>;
}
/** Capture current native bytes and history to prove zero-change compatibility. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "utf8"), readFileSync(getHistoryPath(root, id), "utf8")];
}

for (const atomic of [true, false]) {
  test(`one reference-only Chore keeps all curated fields (${atomic})`, async () => tracker(true, async root => {
    const local = (await create({ title: "Curated local Chore", type: "Chore", description: "Local description", body: "Local body", tags: `${tag},curated` }, { pmRoot: root })).item;
    const before = await bytes(root, local.id);
    const result = await sync(root, issue, atomic);
    assert.deepEqual(await bytes(root, local.id), before);
    assert.equal(result.imported, 1);
    assert.ok(existsSync(getItemPath(root, "Chore", local.id)));
    assert.equal((await get(local.id, {}, { pmRoot: root })).item.created_at, local.created_at);
  }));
  test(`two shared references import exactly once and do not collide (${atomic})`, async () => tracker(true, async root => {
    for (const title of ["Local A", "Local B"]) await create({ title, type: "Task", tags: tag }, { pmRoot: root });
    const result = await sync(root, issue, atomic);
    assert.equal(result.imported, 1);
    const items = (await listAllComplete({}, { pmRoot: root, noExtensions: true })).items;
    assert.equal(items.length, 3);
    assert.equal(items.filter(item => item.github_number === 7).length, 1);
    assert.equal((await sync(root, issue, atomic)).imported, 0);
    assert.equal((await exploreGithubIdentities(root)).collisions, 0);
  }));
  test(`importer-created mirror still refreshes title beside reference items (${atomic})`, async () => tracker(true, async root => {
    await sync(root, issue, atomic);
    const imported = (await listAllComplete({}, { pmRoot: root })).items[0]!;
    await create({ title: "Related delivery", type: "Chore", tags: tag }, { pmRoot: root });
    const result = await sync(root, { ...issue, title: "New source title" }, atomic);
    assert.equal(result.updated, 1);
    assert.equal((await get(imported.id, {}, { pmRoot: root })).item.title, "New source title");
  }));
}

test("released legacy snapshot resyncs with zero changes beside shared references", async () => tracker(true, async root => {
  // These are the exact native fields emitted by the released importer, not a plan made by the new code.
  const local = (await create({ title: issue.title, type: "Issue", status: "open", tags: `${tag},source-label`,
    description: `GH issue #7: ${issue.html_url} · created ${issue.created_at} · updated ${issue.updated_at}`, body: issue.body! }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: local.id, itemPath: getItemPath(root, "Issue", local.id), settings: await readSettings(root),
    document: { metadata: { ...local, github_number: 7, github_url: issue.html_url, github_link_only: false,
      github_state: "open", github_state_reason: "unspecified", github_created_at: issue.created_at, github_updated_at: issue.updated_at,
      github_closed_at: "", github_close_reason: "", github_release: "", created_at: issue.created_at }, body: issue.body! },
    author: "fixture", message: "Released importer snapshot", conflictWarningPrefix: "fixture" });
  await create({ title: "Reference to old import", type: "Chore", tags: tag }, { pmRoot: root });
  const before = await bytes(root, local.id);
  const result = await sync(root);
  assert.equal(result.unchanged, true);
  assert.equal(result.imported, 0);
  assert.equal(result.updated, 0);
  assert.deepEqual(await bytes(root, local.id), before);
}));

for (const git of [true, false]) test(`explicit local link merges lifecycle while preserving curated content (git=${git})`, async () => tracker(git, async root => {
  const local = (await create({ title: "Curated title", type: "Chore", description: "Keep description", body: "Keep body", tags: "keep" }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: local.id, itemPath: getItemPath(root, "Chore", local.id), settings: await readSettings(root),
    document: { metadata: { ...local, github_url: issue.html_url }, body: "Keep body" }, author: "fixture", message: "Explicit link", conflictWarningPrefix: "fixture" });
  const source = { ...issue, state: "closed" as const, state_reason: "completed" as const, closed_at: "2027-01-01T00:00:00Z", updated_at: "2027-01-01T00:00:00Z" };
  const result = await sync(root, source, true, git);
  const actual = (await get(local.id, {}, { pmRoot: root })).item;
  for (const field of ["title", "description", "type", "created_at"] as const) assert.equal(actual[field], local[field]);
  assert.equal(actual.body, "Keep body");
  assert.deepEqual(actual.tags, [tag, "keep"].sort());
  assert.equal(actual.status, "closed");
  assert.equal(actual.closed_at, source.closed_at);
  assert.equal(actual.completed_at, source.closed_at);
  assert.equal(((result.plan as Array<{ identity: { title_conflict?: boolean } }> | undefined)?.[0]?.identity.title_conflict) ?? !git, true);
  assert.equal((await sync(root, source, true, git)).unchanged, true);
  assert.equal(selectRefreshTargets([{ ...actual, tags: [tag, "gh:o/r#99"] }], repo)[0]?.number, 7);
  assert.equal(selectRefreshTargets([actual], repo)[0]?.number, 7);
}));

for (const fields of [
  { github_repo: "O/R", github_number: 7 },
  { github_repo: repo, github_number: 7 },
  { github_link_only: true, github_url: issue.html_url },
  { github_link_only: true, description: `GH issue #7: ${issue.html_url}` },
  { github_link_only: true, description: "GH issue #7: https://github.com/O/R/issues/7" },
]) test(`legacy explicit provenance resolves its original item: ${Object.keys(fields).join(",")}`, async () => tracker(true, async root => {
  const local = (await create({ title: "Legacy curated owner", type: "Chore", tags: tag }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: local.id, itemPath: getItemPath(root, "Chore", local.id), settings: await readSettings(root),
    document: { metadata: { ...local, ...fields }, body: "Retain legacy context" }, author: "fixture", message: "Legacy link snapshot", conflictWarningPrefix: "fixture" });
  const result = await sync(root);
  assert.equal(result.imported, 0);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  const actual = (await get(local.id, {}, { pmRoot: root })).item;
  assert.equal(actual.title, local.title);
  assert.equal(actual.type, "Chore");
  assert.equal(actual.created_at, local.created_at);
  assert.equal((await sync(root)).unchanged, true);
}));

test("references on an already linked owner permit another import without rebinding", async () => tracker(true, async root => {
  const local = (await create({ title: "Owner", type: "Chore", tags: `${tag},gh:o/r#99` }, { pmRoot: root })).item;
  await commitImportedItem({ pmRoot: root, id: local.id, itemPath: getItemPath(root, "Chore", local.id), settings: await readSettings(root),
    document: { metadata: { ...local, github_url: issue.html_url, github_number: 7, github_link_only: false }, body: "Local" }, author: "fixture", message: "Linked owner with references", conflictWarningPrefix: "fixture" });
  const source = { ...issue, number: 99, html_url: "https://github.com/o/r/issues/99" };
  const before = await get(local.id, {}, { pmRoot: root });
  const history = readFileSync(getHistoryPath(root, local.id), "utf8");
  await sync(root, source);
  assert.equal((await get(local.id, {}, { pmRoot: root })).item_hash, before.item_hash);
  assert.equal(readFileSync(getHistoryPath(root, local.id), "utf8"), history);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 2);
}));

test("dependency references resolve importer identities beside related local references", async () => tracker(true, async root => {
  await create({ title: "Related local work", type: "Chore", tags: tag }, { pmRoot: root });
  const dependent = { ...issue, number: 8, html_url: "https://github.com/o/r/issues/8", body: "Blocked by #7" };
  await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true, gate: true, "link-deps": true }), {
    resolveToken: () => undefined, fetchIssues: async () => [issue, dependent], fetchIssueTimeline: async () => [],
  }));
  const items = (await listAllComplete({}, { pmRoot: root })).items;
  const target = items.find(item => item.github_number === 7)!;
  const source = items.find(item => item.github_number === 8)!;
  assert.equal(source.dependencies?.[0]?.id, target.id);
  assert.equal(items.find(item => item.type === "Chore")!.dependencies?.length ?? 0, 0);
}));

test("seeded curated-link previews agree with the actual SDK lifecycle projection", async () => {
  let seed = 230;
  for (let sample = 0; sample < 8; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const closed = (seed & 4) !== 0;
    const active = (seed & 16) !== 0;
    await tracker(true, async root => {
      const local = (await create({ title: `Curated ${seed}`, type: active ? "Chore" : "Task", status: active ? "in_progress" : "open", tags: `native-${seed}` }, { pmRoot: root })).item;
      await commitImportedItem({ pmRoot: root, id: local.id, itemPath: getItemPath(root, local.type!, local.id), settings: await readSettings(root),
        document: { metadata: { ...local, github_url: issue.html_url }, body: "Native body" }, author: "fixture", message: "Seed curated projection", conflictWarningPrefix: "fixture" });
      const source = { ...issue, title: `Source ${seed}`, state: closed ? "closed" as const : "open" as const,
        state_reason: closed ? "completed" as const : null, closed_at: closed ? "2027-01-01T00:00:00Z" : null, updated_at: "2027-01-01T00:00:00Z" };
      const preview = (await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true, gate: true, "dry-run": true }), {
        resolveToken: () => undefined, fetchIssues: async () => [source], fetchIssueTimeline: async () => [],
      }))).result as { plan: Array<{ status: string; created_at: string; closed_at?: string }> };
      const projected = preview.plan[0]!;
      await sync(root, source);
      const actual = (await get(local.id, {}, { pmRoot: root })).item;
      assert.equal(actual.status, projected.status);
      assert.equal(actual.created_at, projected.created_at);
      assert.equal(actual.closed_at, projected.closed_at);
      assert.equal(actual.title, local.title);
      assert.equal(actual.type, local.type);
      assert.equal(actual.body, "Native body");
      assert.equal((await sync(root, source)).unchanged, true);
    });
  }
});

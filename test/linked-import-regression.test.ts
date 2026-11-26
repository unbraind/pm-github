/** Exercise reserved-ID recovery and repeat sync through a real PM CLI and tracker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { comments, create, getHistoryPath, getItemPath, init, normalizeItemId, readLocatedItem } from "@unbrained/pm-cli/sdk";
import { appendBlockerComments, deriveAtomicItemId, syncGithubCommentsToAnnotations, type BlockerReferenceState, type GhComment, type GhIssue } from "../index.ts";
import { assertGithubImportOwner, GithubImportOwnershipError } from "../import-ownership.ts";
import { withReservedIdRepair } from "../import-repair.ts";
import { readWorkflowFailure } from "../workflow-diagnostic.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { jsonResponse, withMockGithub } from "./helpers/mock-github-server.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
const repo = "fixture/widgets";
const id = deriveAtomicItemId(repo, 7, "fixture-", normalizeItemId);
const issue: GhIssue = {
  number: 7, title: "Upstream issue", body: "Upstream issue body.", state: "open",
  labels: [], assignee: null, milestone: null, comments: 1, html_url: `https://github.com/${repo}/issues/7`,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};
const remoteComment: GhComment = {
  id: 42, user: { login: "fixture[bot]" }, created_at: "2026-01-01T03:04:05Z",
  body: `A long source comment. ${"Public fixture text. ".repeat(85)} <!-- pm-github:comment:19 --> followed by prose.`,
};
const command = `pm update ${id} --field github_url=${issue.html_url}`;
const localNotes = Array.from({ length: 17 }, (_, index) => `Local note ${index}. ${"Current work. ".repeat(95)}`);

/** Make a curated item with native history, plus a built project extension for CLI calls. */
async function fixture(t: TestContext, git = true) {
  const directory = mkdtempSync(join(tmpdir(), "pm-github-linked-import-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
  const client = { pmRoot, cwd: directory, author: "fixture", noExtensions: true };
  await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, client);
  const extension = join(pmRoot, "extensions", "pm-github");
  mkdirSync(extension, { recursive: true });
  for (const file of ["dist", "manifest.json", "package.json"]) {
    cpSync(join(packageRoot, file), join(extension, file), { recursive: true });
  }
  symlinkSync(join(packageRoot, "node_modules"), join(extension, "node_modules"), "junction");
  await create({ id, type: "Task", title: "Curated title", description: "Curated description.",
    body: "Curated body.", author: "fixture", tags: `gh:${repo}#7` }, client);
  const itemPath = getItemPath(pmRoot, "task", id);
  const historyPath = getHistoryPath(pmRoot, id);
  const environment = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "fixture",
    PM_GLOBAL_PATH: join(directory, "global"), GITHUB_TOKEN: "fixture" };
  return {
    directory, pmRoot, client, itemPath,
    snapshot: () => ({ item: readFileSync(itemPath, "utf8"), history: readFileSync(historyPath, "utf8") }),
    invoke: (args: string[], api?: string) => boundedCli(process.execPath, [cli, "--path", pmRoot, ...args],
      directory, { ...environment, PM_GITHUB_API_BASE: api }),
  };
}

/** Return complete comment rows from the on-disk item with no SDK output projection. */
async function storedComments(itemPath: string) {
  return (await readLocatedItem({ itemPath, id, type: "task", item_format: "toon" })).document.metadata.comments!;
}

/** Serve the GitHub issue and its comments without credentials or remote writes. */
function source<T>(run: (base: string) => Promise<T>, record = issue) {
  return withMockGithub((req, res) => {
    const path = req.url?.split("?")[0];
    if (path?.endsWith("/comments")) jsonResponse(res, 200, [remoteComment]);
    else if (path?.endsWith("/timeline") || path?.endsWith("/releases")) jsonResponse(res, 200, []);
    else jsonResponse(res, 200, path?.endsWith("/issues/7") ? record : [record]);
  }, async server => {
    const result = await run(server.baseUrl);
    assert.ok(server.requests.length > 0);
    assert.ok(server.requests.every(request => request.method === "GET"));
    return result;
  });
}

test("gated import and the legacy alias report an executable reserved-ID repair in JSON and TOON", async t => {
  const tracker = await fixture(t);
  const original = tracker.snapshot();
  await source(async base => {
    for (const mode of [
      { cli: "github", flags: ["--atomic", "--gate", "--dry-run", "--json"] },
      { cli: "gh-issues", flags: ["--output-format", "toon"] },
    ]) {
      const refused = await tracker.invoke([mode.cli, "import", repo, ...mode.flags], base);
      assert.equal(refused.code, 2, refused.stderr);
      assert.ok(refused.stderr.includes(command), refused.stderr);
      if (mode.cli === "github") {
        const errorFile = join(tracker.directory, "sync-stderr.json");
        writeFileSync(errorFile, refused.stderr);
        const error = JSON.parse(refused.stderr.slice(refused.stderr.indexOf("{"))) as { code: string; examples: string[]; required: string };
        assert.equal(error.code, "github_import_owner_conflict");
        assert.ok(error.required.includes(command));
        assert.ok(error.examples.includes(command));
        assert.ok(readWorkflowFailure(undefined, errorFile, undefined).reason.includes(command));
      }
      assert.deepEqual(tracker.snapshot(), original);
    }
    const repair = await tracker.invoke(command.split(" ").slice(1));
    assert.equal(repair.code, 0, repair.stderr);
    const preview = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stderr, /1 matched by provenance/);
    const applied = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--json"], base);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).imported, 0);
    assert.match(tracker.snapshot().item, /Curated title[\s\S]*Curated body\./);
  });
});

test("only an unowned reserved creation target receives the link command", async () => {
  const target = { id, repo, number: 7, allowCreate: true, mirrorContent: true };
  const createTarget = [{ ...target, id: "fixture-other" }, target];
  const alreadyLinked = { id, github_url: issue.html_url };
  const differentOwner = { id, github_url: issue.html_url.replace("/7", "/8") };
  const invalidClaims = { ...alreadyLinked, github_repo: "fixture/other", github_number: 9 };
  for (const [item, targets] of [
    [alreadyLinked, createTarget],
    [differentOwner, createTarget],
    [invalidClaims, createTarget],
    [{ id }, [{ ...target, allowCreate: false }]],
  ] as const) {
    await assert.rejects(withReservedIdRepair(targets, async () => assertGithubImportOwner(item, target)), error =>
      error instanceof GithubImportOwnershipError && !error.message.includes(command));
  }
  await assert.rejects(withReservedIdRepair(createTarget, async () => assertGithubImportOwner({ id }, target)),
    error => error instanceof Error && error.message.includes(command));
  const unrelated = new Error("Unrelated transaction failure");
  await assert.rejects(withReservedIdRepair(createTarget, async () => { throw unrelated; }), error => error === unrelated);
});

test("issue-start help and documentation describe creating the tracked owner through import", async t => {
  const tracker = await fixture(t, false);
  for (const importer of ["github", "gh-issues"]) {
    const help = await tracker.invoke([importer, "import", "--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.ok(help.stdout.includes("pm github import <owner>/<repo> --issue <N>"), help.stdout);
    assert.ok(help.stdout.includes("<prefix>-github-<repo-hash>-<N>"), help.stdout);
  }
  const guide = readFileSync(join(packageRoot, "docs", "import-issue-work.md"), "utf8");
  assert.ok(guide.includes("pm github import <owner>/<repo> --issue <N>"));
  assert.ok(guide.includes("create an ordinary item with a generated ID"));
});

test("native mirror records the source timestamp and recognizes existing long comments by ID", async t => {
  const tracker = await fixture(t, false);
  const legacy = { ...remoteComment, id: 50 };
  await comments(id, { add: `${legacy.body}\n\n<!-- pm-github:comment:50 -->`, author: "fixture[bot]" }, tracker.client);
  const [oldRow] = await storedComments(tracker.itemPath);
  const incoming = { ...remoteComment, user: null, body: "Second GitHub comment." };
  assert.deepEqual(await syncGithubCommentsToAnnotations(id, [{ ...legacy, body: "Edited remotely." }, incoming, incoming], tracker.pmRoot, 7),
    { added: 1, skipped: 2, failed: 0 });
  const rows = await storedComments(tracker.itemPath);
  const mirrored = rows.find(row => row.author === "github");
  assert.equal(mirrored?.created_at, incoming.created_at);
  assert.deepEqual(rows.find(row => row.author === "fixture[bot]"), oldRow);
});

test("linked reserved-ID import repeats byte-for-byte with newer, long local comments", async t => {
  const tracker = await fixture(t);
  const repair = await tracker.invoke(command.split(" ").slice(1));
  assert.equal(repair.code, 0, repair.stderr);
  for (const add of localNotes) await comments(id, { add }, tracker.client);
  const before = await storedComments(tracker.itemPath);
  assert.ok(before.every(comment => Date.parse(comment.created_at) > Date.parse(remoteComment.created_at)));
  await source(async base => {
    const args = ["github", "import", repo, "--state", "all", "--atomic", "--gate", "--with-comments", "--json"];
    const first = await tracker.invoke(args, base);
    assert.equal(first.code, 0, first.stderr);
    const snapshot = tracker.snapshot();
    const repeat = await tracker.invoke(args, base);
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).unchanged, true);
    assert.deepEqual(tracker.snapshot(), snapshot, "a repeated import must change neither the item nor its history");
    const rows = await storedComments(tracker.itemPath);
    const mirrored = rows.filter(row => row.author === remoteComment.user!.login);
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0]!.created_at, remoteComment.created_at);
    assert.deepEqual(rows.filter(row => row.author !== remoteComment.user!.login), before);
    assert.ok(mirrored[0]!.text.endsWith("<!-- pm-github:comment:42 -->"));
  });
});

test("long grouped blocker comments stay deduplicated on preview and apply without Git", async t => {
  const tracker = await fixture(t, false);
  for (const add of localNotes) await comments(id, { add }, tracker.client);
  const states: BlockerReferenceState[] = Array.from({ length: 18 }, (_, index) => ({
    raw: `${repo}#${index + 1}`, repo, number: index + 1, form: "repo_hash", state: "closed",
    closed_at: "2026-01-01T00:00:00Z",
  }));
  const cleared = [{ itemId: id, states }];
  assert.deepEqual(await appendBlockerComments(tracker.pmRoot, cleared, false), { added: 1, skipped: 0, failed: 0 });
  const snapshot = tracker.snapshot();
  for (const dryRun of [true, false]) {
    assert.deepEqual(await appendBlockerComments(tracker.pmRoot, cleared, dryRun), { added: 0, skipped: 1, failed: 0 });
    assert.deepEqual(tracker.snapshot(), snapshot);
  }
});

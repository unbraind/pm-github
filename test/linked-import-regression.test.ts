/** Exercise reserved-ID recovery and repeat sync through a real PM CLI and tracker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { comments, create, getHistoryPath, getItemPath, init, normalizeItemId, readLocatedItem, renderPmCommand } from "@unbrained/pm-cli/sdk";
import { appendBlockerComments, buildCommentText, deriveAtomicItemId, syncGithubCommentsToAnnotations, type BlockerReferenceState, type GhComment, type GhIssue } from "../index.ts";
import { appendGithubComment } from "../comment-mirror.ts";
import { assertGithubImportOwner, GithubImportOwnershipError } from "../import-ownership.ts";
import { withGithubInvocationScope } from "../workspace.ts";
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
/** The repair command a refusal must offer, scoped to the exact tracker the failed import used. */
const repairArgs = (root: string) => ["--pm-path", root, "update", id, "--field", `github_url=${issue.html_url}`] as const;
/** The same command as the refusal renders it, for substring assertions on JSON and TOON output. */
const repairCommand = (root: string) => renderPmCommand([...repairArgs(root)]);
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

/**
 * A second ordinary tracker holding an item with the SAME id under a different
 * title. Executing a copied repair command from this directory must never
 * touch it: without the failing invocation's tracker selector the copy would
 * resolve this tracker instead and link the decoy item.
 */
async function decoyTracker(t: TestContext, itemId: string) {
  const directory = mkdtempSync(join(tmpdir(), "pm-github-repair-decoy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  const client = { pmRoot, cwd: directory, author: "fixture", noExtensions: true };
  await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, client);
  await create({ id: itemId, type: "Task", title: "Decoy title", description: "Decoy description.",
    body: "Decoy body.", author: "fixture" }, client);
  const environment: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(directory, "global") };
  delete environment.PM_PATH;
  return {
    directory, pmRoot,
    snapshot: () => ({
      item: readFileSync(getItemPath(pmRoot, "task", itemId), "utf8"),
      history: readFileSync(getHistoryPath(pmRoot, itemId), "utf8"),
    }),
    environment,
  };
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

test("gated import and the legacy alias report an executable, tracker-scoped reserved-ID repair in JSON and TOON", async t => {
  const tracker = await fixture(t);
  const decoy = await decoyTracker(t, id);
  const command = repairCommand(tracker.pmRoot);
  const original = tracker.snapshot();
  const decoyOriginal = decoy.snapshot();
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
        const reason = readWorkflowFailure(undefined, errorFile, undefined).reason;
        assert.match(reason, new RegExp(`pm --pm-path .*update ${id} --field github_url=${issue.html_url.replaceAll("/", "\\/")}`), reason);
      }
      assert.deepEqual(tracker.snapshot(), original);
      assert.deepEqual(decoy.snapshot(), decoyOriginal);
    }
    // Copy the offered command verbatim into a different workspace directory and
    // run it there: the selector it carries must keep it on the failed import's
    // tracker, never on the same-ID item the decoy directory holds.
    const copied = await boundedCli(process.execPath, [cli, ...repairArgs(tracker.pmRoot)], decoy.directory, decoy.environment);
    assert.equal(copied.code, 0, copied.stderr);
    assert.deepEqual(decoy.snapshot(), decoyOriginal, "a copied repair must never touch another tracker's same-ID item");
    const preview = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stderr, /1 matched by provenance/);
    const applied = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--json"], base);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).imported, 0);
    assert.match(tracker.snapshot().item, /Curated title[\s\S]*Curated body\./);
  });
});

test("a reserved item with contradictory provenance keeps the plain refusal and no link offer", async t => {
  const tracker = await fixture(t);
  const wrongNumber = await tracker.invoke(["update", id, "--field", "github_number=8"]);
  assert.equal(wrongNumber.code, 0, wrongNumber.stderr);
  const original = tracker.snapshot();
  await source(async base => {
    const refused = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(refused.code, 2, refused.stderr);
    assert.ok(refused.stderr.includes("github_import_owner_conflict"), refused.stderr);
    assert.ok(!refused.stderr.includes("--field github_url="), "a link that would create contradictory ownership must not be offered");
    assert.ok(!refused.stderr.includes("pm update"), refused.stderr);
    assert.deepEqual(tracker.snapshot(), original);
    // The unrepairable refusal is stable: a retry names the same conflict and
    // still writes nothing.
    const retry = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(retry.code, 2, retry.stderr);
    assert.deepEqual(tracker.snapshot(), original);
  });
});

test("only an unowned reserved creation target with consistent provenance receives the scoped link command", async () => {
  const command = repairCommand("tracker-b");
  const target = { id, repo, number: 7, allowCreate: true, mirrorContent: true };
  const createTarget = [{ ...target, id: "fixture-other" }, target];
  const alreadyLinked = { id, github_url: issue.html_url };
  const differentOwner = { id, github_url: issue.html_url.replace("/7", "/8") };
  const invalidClaims = { ...alreadyLinked, github_repo: "fixture/other", github_number: 9 };
  for (const [item, targets] of [
    [alreadyLinked, createTarget],
    [differentOwner, createTarget],
    [invalidClaims, createTarget],
    // Incomplete provenance that would contradict the offered link keeps the
    // plain refusal: a wrong github_number or github_repo must never be told to
    // link, because the next import would then see two owners and block.
    [{ id, github_number: 8 }, createTarget],
    [{ id, github_repo: "fixture/other" }, createTarget],
    [{ id, github_number: 8, github_repo: "fixture/widgets" }, createTarget],
    [{ id }, [{ ...target, allowCreate: false }]],
  ] as const) {
    await assert.rejects(withGithubInvocationScope("tracker-b", () => withReservedIdRepair(targets, async () => assertGithubImportOwner(item, target))), error =>
      error instanceof GithubImportOwnershipError && !error.message.includes(command));
  }
  for (const item of [{ id }, { id, github_number: 7 }, { id, github_repo: "fixture/widgets" }]) {
    await assert.rejects(withGithubInvocationScope("tracker-b", () => withReservedIdRepair(createTarget, async () => assertGithubImportOwner(item, target))),
      error => error instanceof Error && error.message.includes(command));
  }
  // An implicit selection stays implicit: the copy replays the caller's shell.
  await assert.rejects(withGithubInvocationScope(undefined, () => withReservedIdRepair(createTarget, async () => assertGithubImportOwner({ id }, target))),
    error => error instanceof Error && error.message.includes(`pm update ${id} --field github_url=${issue.html_url}`));
  const unrelated = new Error("Unrelated transaction failure");
  await assert.rejects(withGithubInvocationScope("tracker-b", () => withReservedIdRepair(createTarget, async () => { throw unrelated; })), error => error === unrelated);
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

test("invalid source comment timestamps are refused, never stored, and stay retryable", async t => {
  const tracker = await fixture(t, false);
  const malformed = [
    { ...remoteComment, id: 61, created_at: "", body: "Missing timestamp." },
    { ...remoteComment, id: 62, created_at: "not-a-timestamp", body: "Garbage timestamp." },
    { ...remoteComment, id: 63, created_at: "2026-02-31T25:61:61Z", body: "Out-of-range timestamp." },
  ] satisfies GhComment[];
  const batch = [remoteComment, ...malformed];
  assert.deepEqual(await syncGithubCommentsToAnnotations(id, batch, tracker.pmRoot, 7), { added: 1, skipped: 0, failed: 3 });
  const rows = await storedComments(tracker.itemPath);
  assert.equal(rows.length, 1, "only the comment with a valid timestamp may be stored");
  assert.equal(rows[0]!.created_at, remoteComment.created_at);
  // A refused comment is never marked synced by its ID: the next sync retries
  // it, fails it again, and leaves the tracker byte-identical.
  const settled = tracker.snapshot();
  assert.deepEqual(await syncGithubCommentsToAnnotations(id, batch, tracker.pmRoot, 7), { added: 0, skipped: 1, failed: 3 });
  assert.deepEqual(tracker.snapshot(), settled, "a refused comment must never change the tracker");
  assert.equal((await storedComments(tracker.itemPath)).length, 1);
});

test("linked reserved-ID import repeats byte-for-byte with newer, long local comments", async t => {
  const tracker = await fixture(t);
  const repair = await tracker.invoke([...repairArgs(tracker.pmRoot)]);
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

test("the comment mirror's release guidance replays the failing invocation's tracker selector", async t => {
  const tracker = await fixture(t, false);
  // Strict ownership enforcement turns a held item into a refused write; the
  // default preset would only warn and the comment would land.
  const strict = await tracker.invoke(["config", "project", "set", "governance.ownership_enforcement", "strict"]);
  assert.equal(strict.code, 0, strict.stderr);
  const held = await tracker.invoke(["claim", id]);
  assert.equal(held.code, 0, held.stderr);
  // The write is refused by the item's current owner; the guidance it renders
  // must release THIS tracker's item, not whatever tracker the copy runs in.
  await assert.rejects(withGithubInvocationScope("tracker-b", () => appendGithubComment(id, tracker.pmRoot, remoteComment, buildCommentText(remoteComment))), error => {
    const examples = (error as { context?: { examples?: string[] } }).context?.examples ?? [];
    return error instanceof Error && examples.includes(`pm --pm-path tracker-b release ${id}`);
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

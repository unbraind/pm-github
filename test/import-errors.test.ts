import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  EXIT_CODE, acquireImportLock, importCommentSyncLockPath, parseImportOptions,
  readPmItems, resolveCommitItemMutations, runImport, syncGithubCommentsToAnnotations,
  type CommandError, type GhIssue,
} from "../index.ts";
import { captureStderr, jsonResponse, withMockGithub } from "./helpers/mock-github-server.ts";

/** Create a real local PM tracker with cleanup attached before setup. */
function tracker(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-import-errors-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  pm(root, ["init", "fixture"]);
  return root;
}

/** Execute the installed PM CLI; setup errors cannot masquerade as failures. */
function pm(root: string, args: string[]): string {
  const result = spawnSync("pm", ["--path", root, ...args], { encoding: "utf8", env: { ...process.env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Synthetic GitHub issue with optional lifecycle and content overrides. */
function issue(overrides: Partial<GhIssue> = {}): GhIssue {
  return { number: 1, title: "Remote fixture", body: "Original body", state: "open", labels: [], assignee: null, milestone: null,
    html_url: "https://github.com/acme/widgets/issues/1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", ...overrides };
}

test("import preserves semantic fetch errors and gives unauthenticated quota guidance", async t => {
  const root = tracker(t);
  for (const status of [403, 404]) {
    await withMockGithub((_req, res) => jsonResponse(res, status, { message: "Fixture denied" }), async () => {
      await assert.rejects(runImport("acme/widgets", root, parseImportOptions({}), { resolveToken: () => undefined }), error => {
        assert.equal((error as CommandError).exitCode, status === 404 ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE);
        assert.match((error as Error).message, new RegExp(`HTTP ${status}`));
        if (status === 403) assert.match((error as Error).message, /raise the rate limit/);
        return true;
      });
    });
  }
  assert.deepEqual(readPmItems(root), []);
});

test("atomic previews distinguish empty upstream data from entirely skipped issue titles", async t => {
  const root = tracker(t);
  let data: GhIssue[] = [];
  await withMockGithub((_req, res) => jsonResponse(res, 200, data), async () => {
    assert.deepEqual(await runImport("acme/widgets", root, parseImportOptions({ atomic: true, "dry-run": true }), { resolveToken: () => undefined }),
      { dryRun: true, wouldImport: 0, wouldUpdate: 0, wouldSkip: 0, atomic: true });
    data = [issue({ title: "  " })];
    assert.deepEqual(await runImport("acme/widgets", root, parseImportOptions({ atomic: true, "dry-run": true }), { resolveToken: () => undefined }),
      { dryRun: true, wouldImport: 0, wouldUpdate: 0, wouldSkip: 1, atomic: true });
    await assert.rejects(runImport("acme/widgets", root, parseImportOptions({ atomic: true }), { resolveToken: () => undefined }), /Imported 0 issue\(s\); 1 failed/);
  });
  assert.deepEqual(readPmItems(root), []);
});

test("ungated import tolerates unavailable comments and still writes the issue", async t => {
  const root = tracker(t);
  await withMockGithub((req, res) => {
    if (req.url?.includes("/comments")) jsonResponse(res, 422, { message: "Comments unavailable" });
    else jsonResponse(res, 200, [issue({ comments: 1 })]);
  }, async () => {
    const { stderr, result } = await captureStderr(() => runImport("acme/widgets", root, parseImportOptions({ "comments-mode": "both" }), { resolveToken: () => undefined }));
    assert.deepEqual(result, { imported: 1, updated: 0, skipped: 0 });
    assert.match(stderr.join("\n"), /failed to fetch comments/);
  });
  assert.equal(readPmItems(root)[0].body, "Original body");
});

test("import reports real mutation failures after a linked local item disappears", async t => {
  const root = tracker(t);
  const created = JSON.parse(pm(root, ["create", "task", "Linked", "--tags", "gh:acme/widgets#1", "--json"])) as { id: string };
  const snapshot = readPmItems(root);
  pm(root, ["delete", created.id, "--message", "Fixture concurrent deletion"]);
  await withMockGithub((_req, res) => jsonResponse(res, 200, [issue()]), async () => {
    const { stderr } = await captureStderr(async () => {
      await assert.rejects(runImport("acme/widgets", root, parseImportOptions({}), { resolveToken: () => undefined, readItems: () => snapshot }), /Imported 0 issue\(s\); 1 failed/);
    });
    assert.match(stderr.join("\n"), /update failed/);
  });
  assert.deepEqual(readPmItems(root), []);
});

test("import rejects an unknown item type and allows a corrected retry", async t => {
  const root = tracker(t);
  await withMockGithub((_req, res) => jsonResponse(res, 200, [issue()]), async () => {
    const { stderr } = await captureStderr(async () => {
      await assert.rejects(runImport("acme/widgets", root, parseImportOptions({ type: "UnsupportedFixtureType" }), { resolveToken: () => undefined }), /Imported 0 issue\(s\); 1 failed/);
    });
    assert.match(stderr.join("\n"), /create failed/);
    const result = await runImport("acme/widgets", root, parseImportOptions({}), { resolveToken: () => undefined });
    assert.ok("imported" in result);
    assert.equal(result.imported, 1);
  });
});

test("import records failed close reconciliation for an already canceled item", async t => {
  const root = tracker(t);
  pm(root, ["create", "task", "Canceled", "--status", "canceled", "--tags", "gh:acme/widgets#1"]);
  await withMockGithub((_req, res) => jsonResponse(res, 200, [issue({ state: "closed" })]), async () => {
    const { stderr } = await captureStderr(async () => {
      await assert.rejects(runImport("acme/widgets", root, parseImportOptions({}), { resolveToken: () => undefined }), /Imported 0 issue\(s\); 1 failed/);
    });
    assert.match(stderr.join("\n"), /close reconciliation failed/);
  });
  assert.equal(readPmItems(root)[0].status, "canceled");
});

test("comment sync degrades on an unavailable lock directory and handles a missing item", async t => {
  const root = tracker(t);
  fs.rmSync(path.join(root, "locks"), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, "locks"), "Fixture blocks the lock directory");
  const { stderr, result } = await captureStderr(() => syncGithubCommentsToAnnotations("fixture-missing", [{ id: 1, user: null, body: "A comment", created_at: "2026-01-01T00:00:00Z" }], root, 1));
  assert.deepEqual(result, { added: 0, skipped: 0 });
  assert.match(stderr.join("\n"), /lock unavailable/);
  assert.match(stderr.join("\n"), /could not read existing comments/);
});

test("comment lock contention handles malformed payloads without breaking a fresh lock", async t => {
  const root = tracker(t);
  const file = importCommentSyncLockPath(root, "fixture-item");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const content of ["null", "[]", "7"]) {
    fs.writeFileSync(file, content);
    const result = await acquireImportLock(root, "fixture-item", { waitMs: 0 });
    assert.equal(result.status, "contended");
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});

test("atomic SDK resolution accepts an available export and caches the real SDK helper", async () => {
  const commit = await resolveCommitItemMutations();
  assert.equal(await resolveCommitItemMutations(), commit);
  assert.equal(await resolveCommitItemMutations(async () => ({ commitItemMutations: commit })), commit);
});

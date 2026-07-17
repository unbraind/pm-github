// Unit + workspace integration tests for `--comments-mode` (native comment sync).
//
// The default (`body`) mode must remain byte-identical to the pre-2026.7.14
// behavior, so the zero-regression tests pin the exact `composeBody` output
// and the default `parseImportOptions` shape. The annotations-mode tests
// exercise the real SDK `comments()` primitive against a throwaway pm
// workspace (offline) and prove re-sync dedupes on the GitHub comment id.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommandError,
  buildCommentText,
  composeBody,
  extractSyncedCommentIds,
  parseCreatedItemId,
  parseImportOptions,
  syncGithubCommentsToAnnotations,
} from "../dist/index.js";

// Minimal factories -----------------------------------------------------------

function ghComment(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1001,
    user: { login: "alice" },
    created_at: "2026-01-01T00:00:00Z",
    body: "looks good to me",
    ...overrides,
  };
}

function ghIssue(overrides: Record<string, unknown> = {}): any {
  return {
    number: 1,
    title: "t",
    body: "issue body text",
    state: "open",
    labels: [],
    assignee: null,
    milestone: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/o/r/issues/1",
    comments: 0,
    ...overrides,
  };
}

// parseImportOptions — comments-mode parsing ---------------------------------

test("parseImportOptions defaults commentsMode to body (zero-regression default)", () => {
  assert.strictEqual(parseImportOptions({}).commentsMode, "body");
  assert.strictEqual(parseImportOptions({ withComments: true }).commentsMode, "body");
});

test("parseImportOptions honors --comments-mode body|annotations|both (and camelCase alias)", () => {
  assert.strictEqual(parseImportOptions({ "comments-mode": "annotations" }).commentsMode, "annotations");
  assert.strictEqual(parseImportOptions({ "comments-mode": "both" }).commentsMode, "both");
  assert.strictEqual(parseImportOptions({ "comments-mode": "body" }).commentsMode, "body");
  assert.strictEqual(parseImportOptions({ commentsMode: "both" }).commentsMode, "both");
});

test("parseImportOptions rejects an unknown --comments-mode value", () => {
  // An invalid value must throw a CommandError (USAGE), not silently fall back
  // to body, so the user is told they mistyped rather than getting body output.
  assert.throws(
    () => parseImportOptions({ "comments-mode": "nonsense" }),
    (err: unknown) => err instanceof CommandError && /comments-mode/.test((err as Error).message),
  );
});

test("--with-comments + --comments-mode annotations reconciles to both (neither flag silently dropped)", () => {
  // The legacy flag asks for body embedding; the mode asks for native comments.
  // The intuitive combined intent is BOTH, so neither flag is ignored.
  assert.strictEqual(
    parseImportOptions({ "with-comments": true, "comments-mode": "annotations" }).commentsMode,
    "both",
  );
  assert.strictEqual(
    parseImportOptions({ "include-comments": true, "comments-mode": "annotations" }).commentsMode,
    "both",
  );
  // body/both combined with --with-comments are already consistent — unchanged.
  assert.strictEqual(
    parseImportOptions({ "with-comments": true, "comments-mode": "body" }).commentsMode,
    "body",
  );
  assert.strictEqual(
    parseImportOptions({ "with-comments": true, "comments-mode": "both" }).commentsMode,
    "both",
  );
  // Without --with-comments, annotations stays annotations.
  assert.strictEqual(parseImportOptions({ "comments-mode": "annotations" }).commentsMode, "annotations");
});

// Zero-regression: composeBody is unchanged ----------------------------------
// The default path must produce the exact same body the pre-2026.7.14 code did.
// composeBody is the only function that shapes the body for comments; pinning
// its output here proves the default mode (body + no --with-comments, and the
// --with-comments body embedding) is byte-identical to before.

test("composeBody with no comments returns the issue body unchanged (default mode byte-identical)", () => {
  assert.strictEqual(composeBody(ghIssue(), []), "issue body text");
  assert.strictEqual(composeBody(ghIssue({ body: null }), []), "");
});

test("composeBody with comments produces the exact historical blockquote section", () => {
  const issue = ghIssue({ body: "issue body text" });
  const comments = [
    ghComment({ id: 1, user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", body: "first" }),
    ghComment({ id: 2, user: { login: "bob" }, created_at: "2026-01-02T00:00:00Z", body: "line1\nline2" }),
  ];
  // This is the verbatim pre-2026.7.14 output: body, separator, heading with the
  // count, then one blockquote per comment. Pinning it catches any drift.
  const expected = [
    "issue body text",
    "",
    "---",
    "",
    "### GitHub comments (2)",
    "",
    "> **@alice** (2026-01-01T00:00:00Z)",
    ">",
    "> first",
    "",
    "> **@bob** (2026-01-02T00:00:00Z)",
    ">",
    "> line1",
    "> line2",
  ].join("\n");
  assert.strictEqual(composeBody(issue, comments), expected);
});

// buildCommentText / extractSyncedCommentIds / parseCreatedItemId (pure) ------

test("buildCommentText embeds the GitHub comment id marker and the body", () => {
  const text = buildCommentText(ghComment({ id: 4242, body: "nice" }));
  assert.ok(/<!-- pm-github:comment:4242 -->$/.test(text), "marker should trail the body");
  assert.ok(text.includes("nice"));
});

test("buildCommentText falls back to a placeholder for empty bodies", () => {
  const text = buildCommentText(ghComment({ id: 1, body: "   " }));
  assert.ok(text.includes("(empty comment)"));
  assert.ok(/<!-- pm-github:comment:1 -->$/.test(text));
});

test("extractSyncedCommentIds collects ids from markers and ignores plain comments", () => {
  const stored = [
    { text: "hand-written note" },
    { text: "synced\n\n<!-- pm-github:comment:7 -->" },
    { text: buildCommentText(ghComment({ id: 99, body: "x" })) },
  ];
  const ids = extractSyncedCommentIds(stored);
  assert.deepEqual([...ids].sort((a, b) => a - b), [7, 99]);
  assert.strictEqual(extractSyncedCommentIds([]).size, 0);
  assert.strictEqual(extractSyncedCommentIds([{ text: undefined } as any]).size, 0);
});

test("parseCreatedItemId reads the id from `pm create --json` stdout", () => {
  assert.strictEqual(parseCreatedItemId(JSON.stringify({ item: { id: "pm-ab12" } })), "pm-ab12");
  assert.strictEqual(parseCreatedItemId("not json"), undefined);
  assert.strictEqual(parseCreatedItemId(JSON.stringify({ item: {} })), undefined);
  assert.strictEqual(parseCreatedItemId(JSON.stringify({})), undefined);
});

// Workspace integration: real SDK comments() primitive + dedupe -------------

// Resolve the platform-appropriate pm shim (win32 needs pm.cmd via shell).
const PM_BIN = fileURLToPath(
  new URL(`../node_modules/.bin/pm${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url),
);

function makeCommentsTestWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-github-comments-test-"));
  const env = { ...process.env, PM_AUTHOR: "tester" };
  const opts = { stdio: "ignore" as const, env, shell: process.platform === "win32" };
  try {
    try {
      execFileSync(PM_BIN, ["init", "-y", "--force", "--workspace", root, "--author", "tester"], opts);
    } catch {
      execFileSync(PM_BIN, ["init", "-y", "--force", root, "--author", "tester"], opts);
    }
    execFileSync(PM_BIN, ["--pm-path", root, "create", "task", "Synced item", "--description", "d"], opts);
    return root;
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function firstItemId(root: string): string {
  const out = execFileSync(PM_BIN, ["--pm-path", root, "--json", "list", "--full"], { encoding: "utf-8" });
  const parsed = JSON.parse(out);
  const arr = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.results ?? []);
  if (!arr.length) throw new Error("no items in test workspace");
  return arr[0].id as string;
}

test("syncGithubCommentsToAnnotations populates the native comments collection via the SDK", async () => {
  const root = makeCommentsTestWorkspace();
  try {
    const id = firstItemId(root);
    const comments = [
      ghComment({ id: 5001, user: { login: "alice" }, body: "first sync comment" }),
      ghComment({ id: 5002, user: { login: "bob" }, body: "second sync comment" }),
    ];
    const { added, skipped } = await syncGithubCommentsToAnnotations(id, comments, root, 1);
    assert.strictEqual(added, 2);
    assert.strictEqual(skipped, 0);

    // Read back through the public SDK surface and assert structure.
    const { comments: pmComments } = await import("@unbrained/pm-cli/sdk").then((m) => m.comments(id, {}, { pmRoot: root }));
    assert.strictEqual(pmComments.length, 2, "two comments should be stored");
    assert.strictEqual(pmComments[0].author, "alice");
    assert.strictEqual(pmComments[1].author, "bob");
    // Each stored comment carries its GitHub comment id marker for dedupe.
    assert.ok(/<!-- pm-github:comment:5001 -->/.test(pmComments[0].text));
    assert.ok(/<!-- pm-github:comment:5002 -->/.test(pmComments[1].text));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-running sync does not duplicate comments (dedupe by GitHub comment id)", async () => {
  const root = makeCommentsTestWorkspace();
  try {
    const id = firstItemId(root);
    const firstBatch = [
      ghComment({ id: 6001, user: { login: "alice" }, body: "first" }),
      ghComment({ id: 6002, user: { login: "bob" }, body: "second" }),
    ];
    const r1 = await syncGithubCommentsToAnnotations(id, firstBatch, root, 1);
    assert.strictEqual(r1.added, 2);

    // Re-sync the same comments plus one new one: only the new one is added.
    const secondBatch = [
      ghComment({ id: 6001, user: { login: "alice" }, body: "first" }),
      ghComment({ id: 6002, user: { login: "bob" }, body: "second" }),
      ghComment({ id: 6003, user: { login: "carol" }, body: "third" }),
    ];
    const r2 = await syncGithubCommentsToAnnotations(id, secondBatch, root, 1);
    assert.strictEqual(r2.added, 1, "only the new comment should be added on re-sync");
    assert.strictEqual(r2.skipped, 2, "the two already-synced comments should be skipped");

    const { comments: pmComments } = await import("@unbrained/pm-cli/sdk").then((m) => m.comments(id, {}, { pmRoot: root }));
    assert.strictEqual(pmComments.length, 3, "exactly three comments after re-sync — no duplicates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncGithubCommentsToAnnotations with no comments is a no-op", async () => {
  const root = makeCommentsTestWorkspace();
  try {
    const id = firstItemId(root);
    const { added, skipped } = await syncGithubCommentsToAnnotations(id, [], root, 1);
    assert.strictEqual(added, 0);
    assert.strictEqual(skipped, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
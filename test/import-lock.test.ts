// Tests for the cross-process comment-sync lock (pm-github-503u).
//
// Unit tests cover the lock helper in isolation: acquire/release roundtrip
// (incl. token-checked release), contention (wait → contended → acquire after
// release), and stale-lock breaking (dead owner PID, recycled own PID, the
// mtime-TTL fallback for unparseable payloads — and, critically, that a LIVE
// owner is never age-broken). The integration test spawns two REAL concurrent child processes
// syncing the same GitHub comments into the same item of a throwaway
// workspace — the exact `pm github import` race from pm-github-503u — and
// asserts no duplicate comment markers result.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMPORT_LOCK_TTL_MS_DEFAULT,
  acquireImportLock,
  importCommentSyncLockPath,
  resolvePmDataDir,
  syncGithubCommentsToAnnotations,
} from "../dist/index.js";

// Minimal factories + workspace helpers --------------------------------------

function ghComment(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1001,
    user: { login: "alice" },
    created_at: "2026-01-01T00:00:00Z",
    body: "looks good to me",
    ...overrides,
  };
}

// Resolve the platform-appropriate pm shim (win32 needs pm.cmd via shell).
const PM_BIN = fileURLToPath(
  new URL(`../node_modules/.bin/pm${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url),
);

const CHILD_SCRIPT = fileURLToPath(
  new URL("../test/helpers/comment-sync-child.mjs", import.meta.url),
);

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-github-lock-test-"));
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

// Run fn with console.error captured; returns the messages it logged.
async function captureStderr(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return messages;
}

// Plant a lock file as if another process created it.
function plantLock(root: string, itemId: string, payload: unknown): string {
  const lockPath = importCommentSyncLockPath(root, itemId);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`);
  return lockPath;
}

// resolvePmDataDir / importCommentSyncLockPath --------------------------------

test("resolvePmDataDir prefers a nested .agents/pm and falls back to pmRoot itself", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-datadir-test-"));
  try {
    assert.strictEqual(resolvePmDataDir(root), root, "no .agents/pm → pmRoot is the data dir");
    mkdirSync(join(root, ".agents", "pm"), { recursive: true });
    assert.strictEqual(resolvePmDataDir(root), join(root, ".agents", "pm"));
    // A pmRoot that already IS the data dir keeps working.
    assert.strictEqual(resolvePmDataDir(join(root, ".agents", "pm")), join(root, ".agents", "pm"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importCommentSyncLockPath lands in locks/ with a pm-github prefix and sanitizes the item id", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-lockpath-test-"));
  try {
    mkdirSync(join(root, ".agents", "pm"), { recursive: true });
    const p = importCommentSyncLockPath(root, "pm-ab12");
    assert.strictEqual(p, join(root, ".agents", "pm", "locks", "pm-github.comment-sync.pm-ab12.lock"));
    // Filename-unsafe characters are replaced, so the lock always stays inside
    // the locks dir even for adversarial item ids.
    const nasty = importCommentSyncLockPath(root, "../evil/x");
    assert.strictEqual(
      nasty,
      join(root, ".agents", "pm", "locks", "pm-github.comment-sync..._evil_x.lock"),
      "path separators cannot escape the locks dir",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// acquire / release ------------------------------------------------------------

test("acquireImportLock creates a CLI-convention payload and release removes it", async () => {
  const root = makeWorkspace();
  try {
    const acq = await acquireImportLock(root, "pm-lock1");
    assert.strictEqual(acq.status, "acquired");
    if (acq.status !== "acquired") return;
    assert.ok(existsSync(acq.lock.path), "lock file exists while held");
    assert.ok(acq.lock.path.startsWith(join(root, ".agents", "pm", "locks")), "lock is in the workspace locks dir");
    const payload = JSON.parse(readFileSync(acq.lock.path, "utf-8"));
    assert.strictEqual(payload.pid, process.pid);
    assert.strictEqual(payload.owner, "pm-github");
    assert.strictEqual(payload.ttl_seconds, Math.ceil(IMPORT_LOCK_TTL_MS_DEFAULT / 1000));
    assert.ok(Number.isFinite(Date.parse(payload.created_at)), "created_at is an ISO timestamp");
    assert.ok(typeof payload.token === "string" && payload.token.length > 0, "payload carries an ownership token");
    acq.lock.release();
    assert.ok(!existsSync(acq.lock.path), "release removes the lock file");
    acq.lock.release(); // idempotent — must not throw
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live held lock contends: second acquire times out, then succeeds after release", async () => {
  const root = makeWorkspace();
  try {
    const first = await acquireImportLock(root, "pm-lock2");
    assert.strictEqual(first.status, "acquired");

    // While held (fresh, own PID alive): not stale → waits out the budget.
    const started = Date.now();
    const second = await acquireImportLock(root, "pm-lock2", { waitMs: 250 });
    assert.strictEqual(second.status, "contended");
    assert.ok(Date.now() - started >= 200, "actually waited for the budget");

    if (first.status === "acquired") first.lock.release();
    const third = await acquireImportLock(root, "pm-lock2", { waitMs: 1000 });
    assert.strictEqual(third.status, "acquired");
    if (third.status === "acquired") third.lock.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter acquires the lock once the holder releases mid-wait", async () => {
  const root = makeWorkspace();
  try {
    const first = await acquireImportLock(root, "pm-lock3");
    assert.strictEqual(first.status, "acquired");
    const timer = setTimeout(() => {
      if (first.status === "acquired") first.lock.release();
    }, 200);
    const second = await acquireImportLock(root, "pm-lock3", { waitMs: 5000 });
    clearTimeout(timer);
    assert.strictEqual(second.status, "acquired", "waiter gets the lock after release, not a contention timeout");
    if (second.status === "acquired") second.lock.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Stale-lock breaking ----------------------------------------------------------

test("a lock recorded under our own PID is broken (recycled pid), even when fresh", async () => {
  const root = makeWorkspace();
  try {
    const lockPath = plantLock(root, "pm-stale1", {
      id: "pm-github.comment-sync.pm-stale1",
      pid: process.pid, // we demonstrably don't hold it → the pid was recycled
      owner: "pm-github",
      created_at: new Date().toISOString(), // fresh — age is irrelevant here
      ttl_seconds: 300,
    });
    const messages = await captureStderr(async () => {
      const acq = await acquireImportLock(root, "pm-stale1", { waitMs: 1000 });
      assert.strictEqual(acq.status, "acquired", "recycled-pid lock is broken and re-acquired");
      if (acq.status === "acquired") {
        const payload = JSON.parse(readFileSync(acq.lock.path, "utf-8"));
        assert.strictEqual(payload.pid, process.pid, "the broken lock is replaced with our payload");
        acq.lock.release();
      }
    });
    assert.ok(
      messages.some((m) => m.includes("breaking stale comment-sync lock") && m.includes("recycled")),
      `expected a recycled-pid stale-break warning, got: ${messages.join(" | ")}`,
    );
    assert.ok(!existsSync(lockPath), "lock released at the end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an over-TTL lock with a LIVE foreign owner is NOT broken — the waiter contends", async () => {
  const root = makeWorkspace();
  // A real live foreign process: a child that sleeps well past the test.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    assert.ok(holder.pid && holder.pid > 0, "need a live child pid for this test");
    plantLock(root, "pm-live1", {
      id: "pm-github.comment-sync.pm-live1",
      pid: holder.pid,
      owner: "pm-github",
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(), // way past TTL
      ttl_seconds: 300,
    });
    const acq = await acquireImportLock(root, "pm-live1", { waitMs: 300 });
    assert.strictEqual(
      acq.status,
      "contended",
      "a slow-but-alive holder keeps its lock: age alone must never break a live owner's lock",
    );
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("release() is token-checked: a broken-then-replaced lock is never unlinked by the old holder", async () => {
  const root = makeWorkspace();
  try {
    const first = await acquireImportLock(root, "pm-token1");
    assert.strictEqual(first.status, "acquired");
    if (first.status !== "acquired") return;
    // Simulate a stale-break + successor acquisition: replace the file content
    // with a different owner/token while `first` still believes it holds it.
    const successor = {
      id: "pm-github.comment-sync.pm-token1",
      pid: process.pid,
      owner: "pm-github",
      token: "successor-token",
      created_at: new Date().toISOString(),
      ttl_seconds: 300,
    };
    writeFileSync(first.lock.path, `${JSON.stringify(successor)}\n`);
    first.lock.release();
    assert.ok(existsSync(first.lock.path), "release must not unlink a successor's lock");
    const after = JSON.parse(readFileSync(first.lock.path, "utf-8"));
    assert.strictEqual(after.token, "successor-token", "successor payload is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh lock whose owner PID is dead is broken with a stderr warning", async () => {
  const root = makeWorkspace();
  try {
    // A process that has already exited gives us a (practically) dead PID.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(dead.pid && dead.pid > 0, "need a real child pid for this test");
    plantLock(root, "pm-stale2", {
      id: "pm-github.comment-sync.pm-stale2",
      pid: dead.pid,
      owner: "pm-github",
      created_at: new Date().toISOString(), // fresh — only the dead PID makes it stale
      ttl_seconds: 300,
    });
    const messages = await captureStderr(async () => {
      const acq = await acquireImportLock(root, "pm-stale2", { waitMs: 500 });
      assert.strictEqual(acq.status, "acquired", "dead-owner lock is broken without waiting out the TTL");
      if (acq.status === "acquired") acq.lock.release();
    });
    assert.ok(
      messages.some((m) => m.includes("breaking stale comment-sync lock") && m.includes("dead")),
      `expected a dead-owner warning, got: ${messages.join(" | ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unparseable lock payload falls back to file mtime: fresh contends, old breaks", async () => {
  const root = makeWorkspace();
  try {
    // Fresh garbage payload — could be a live writer mid-write, so it must NOT
    // be broken; the waiter contends instead.
    const lockPath = plantLock(root, "pm-stale3", "not json at all");
    const fresh = await acquireImportLock(root, "pm-stale3", { waitMs: 200 });
    assert.strictEqual(fresh.status, "contended", "young unparseable lock is treated as held, not broken");

    // Backdate the mtime beyond the TTL — now it is stale and gets broken.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, old, old);
    const messages = await captureStderr(async () => {
      const acq = await acquireImportLock(root, "pm-stale3", { waitMs: 1000 });
      assert.strictEqual(acq.status, "acquired");
      if (acq.status === "acquired") acq.lock.release();
    });
    assert.ok(messages.some((m) => m.includes("breaking stale comment-sync lock")), "stale garbage lock is broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Concurrency: in-process and cross-process ------------------------------------

test("two in-process concurrent syncs of the same comments never duplicate", async () => {
  const root = makeWorkspace();
  try {
    const id = firstItemId(root);
    const comments = Array.from({ length: 8 }, (_, i) =>
      ghComment({ id: 7000 + i, user: { login: "racer" }, body: `in-process race ${i}` }),
    );
    const [r1, r2] = await Promise.all([
      syncGithubCommentsToAnnotations(id, comments, root, 1),
      syncGithubCommentsToAnnotations(id, comments, root, 1),
    ]);
    assert.strictEqual(r1.added + r2.added, comments.length, "each comment added exactly once across both syncs");
    const { comments: stored } = await import("@unbrained/pm-cli/sdk").then((m) =>
      m.comments(id, {}, { pmRoot: root }),
    );
    assert.strictEqual(stored.length, comments.length, "no duplicate comments stored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The pm-github-503u acceptance test: two concurrent OS processes (the real
// `pm github import` race shape) sync identical fake GitHub comments into the
// same item of the same workspace. The lockfile must serialize them so every
// GitHub comment id lands exactly once.
test(
  "two concurrent processes importing the same comments never duplicate (pm-github-503u)",
  { timeout: 180_000 },
  async () => {
    const root = makeWorkspace();
    try {
      const id = firstItemId(root);
      const comments = Array.from({ length: 20 }, (_, i) =>
        ghComment({ id: 9000 + i, user: { login: "racer" }, body: `cross-process race ${i}` }),
      );
      const env = { ...process.env, FAKE_COMMENTS: JSON.stringify(comments) };
      const runChild = () =>
        new Promise<{ added: number; skipped: number }>((resolve, reject) => {
          execFile(
            process.execPath,
            [CHILD_SCRIPT, id, root],
            { env },
            (err, stdout, stderr) => {
              if (err) return reject(new Error(`child failed: ${err.message}\n${stderr}`));
              assert.ok(
                !stderr.includes("another import holds the comment-sync lock"),
                `neither child may be starved off the lock: ${stderr}`,
              );
              try {
                resolve(JSON.parse(stdout.trim()));
              } catch (parseErr) {
                reject(new Error(`unparseable child output: ${stdout} (${parseErr})`));
              }
            },
          );
        });

      const [r1, r2] = await Promise.all([runChild(), runChild()]);
      assert.strictEqual(
        r1.added + r2.added,
        comments.length,
        `each comment added exactly once across both processes (got ${r1.added}+${r2.added})`,
      );
      assert.strictEqual(r1.skipped + r2.skipped, comments.length, "the loser of the race skips every duplicate");

      const { comments: stored } = await import("@unbrained/pm-cli/sdk").then((m) =>
        m.comments(id, {}, { pmRoot: root }),
      );
      assert.strictEqual(stored.length, comments.length, "exactly one stored comment per GitHub comment");
      const markerIds = stored.map((c: { text?: string }) => {
        const m = /<!--\s*pm-github:comment:(\d+)\s*-->/.exec(c.text ?? "");
        assert.ok(m, `stored comment carries a marker: ${c.text}`);
        return Number(m![1]);
      });
      assert.strictEqual(new Set(markerIds).size, comments.length, "no marker id appears twice");
      assert.deepEqual(
        [...markerIds].sort((a, b) => a - b),
        comments.map((c) => c.id).sort((a, b) => a - b),
      );

      // The loser's re-run must be a clean no-op (idempotency preserved).
      const r3 = await new Promise<{ added: number; skipped: number }>((resolve, reject) => {
        execFile(process.execPath, [CHILD_SCRIPT, id, root], { env }, (err, stdout) =>
          err ? reject(err) : resolve(JSON.parse(stdout.trim())),
        );
      });
      assert.deepEqual(r3, { added: 0, skipped: comments.length });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

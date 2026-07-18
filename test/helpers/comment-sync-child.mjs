// Child-process entry for the cross-process concurrent comment-sync test.
//
// Spawning real OS processes (rather than two in-process calls) exercises the
// lockfile serialization the way two concurrent `pm github import` runs hit
// it: separate processes, same workspace, same item, same GitHub comments.
//
// Usage: node test/helpers/comment-sync-child.mjs <itemId> <pmRoot>
// Input:  FAKE_COMMENTS env var — JSON array of GhComment-shaped objects.
//         BARRIER_FILE env var (optional) — path both children poll for before
//         starting, so the parent can line them up and the test exercises real
//         concurrent entry into the sync instead of an accidental sequence.
// Output: one JSON line on stdout with the { added, skipped } result.

import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { syncGithubCommentsToAnnotations } from "../../dist/index.js";

const [itemId, pmRoot] = process.argv.slice(2);
if (!itemId || !pmRoot) {
  console.error("usage: comment-sync-child.mjs <itemId> <pmRoot>");
  process.exit(2);
}

const barrier = process.env.BARRIER_FILE;
if (barrier) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) {
      console.error("barrier file never appeared");
      process.exit(2);
    }
    await delay(5);
  }
}

const comments = JSON.parse(process.env.FAKE_COMMENTS || "[]");
const result = await syncGithubCommentsToAnnotations(itemId, comments, pmRoot, 1);
process.stdout.write(`${JSON.stringify(result)}\n`);

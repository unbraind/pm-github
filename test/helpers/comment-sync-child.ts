// Child-process entry for the cross-process concurrent comment-sync test.
//
// Spawning real OS processes exercises the lockfile serialization the way two
// concurrent `pm github import` runs do: separate processes, same workspace,
// same item, and the same GitHub comments.

import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { syncGithubCommentsToAnnotations } from "../../dist/index.js";
import type { GhComment } from "../../dist/index.js";

const [itemId, pmRoot] = process.argv.slice(2);
if (!itemId || !pmRoot) {
  console.error("usage: comment-sync-child.js <itemId> <pmRoot>");
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

const comments = JSON.parse(process.env.FAKE_COMMENTS || "[]") as GhComment[];
const result = await syncGithubCommentsToAnnotations(itemId, comments, pmRoot, 1);
process.stdout.write(`${JSON.stringify(result)}\n`);

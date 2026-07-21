// Child-process entry for the cross-process concurrent comment-sync test.
//
// Spawning real OS processes exercises the lockfile serialization the way two
// concurrent `pm github import` runs do: separate processes, same workspace,
// same item, and the same GitHub comments.

import { syncGithubCommentsToAnnotations } from "../../dist/index.js";
import type { GhComment } from "../../dist/index.js";
import { waitForBarrier } from "./barrier.js";

const [itemId, pmRoot] = process.argv.slice(2);
if (!itemId || !pmRoot) {
  console.error("usage: comment-sync-child.js <itemId> <pmRoot>");
  process.exit(2);
}

const barrier = process.env.BARRIER_FILE;
if (barrier) {
  await waitForBarrier(barrier);
}

const comments = JSON.parse(process.env.FAKE_COMMENTS || "[]") as GhComment[];
const result = await syncGithubCommentsToAnnotations(itemId, comments, pmRoot, 1);
process.stdout.write(`${JSON.stringify(result)}\n`);

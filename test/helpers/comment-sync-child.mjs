// Child-process entry for the cross-process concurrent comment-sync test.
//
// Spawning real OS processes (rather than two in-process calls) exercises the
// lockfile serialization the way two concurrent `pm github import` runs hit
// it: separate processes, same workspace, same item, same GitHub comments.
//
// Usage: node test/helpers/comment-sync-child.mjs <itemId> <pmRoot>
// Input:  FAKE_COMMENTS env var — JSON array of GhComment-shaped objects.
// Output: one JSON line on stdout with the { added, skipped } result.

import { syncGithubCommentsToAnnotations } from "../../dist/index.js";

const [itemId, pmRoot] = process.argv.slice(2);
if (!itemId || !pmRoot) {
  console.error("usage: comment-sync-child.mjs <itemId> <pmRoot>");
  process.exit(2);
}

const comments = JSON.parse(process.env.FAKE_COMMENTS || "[]");
const result = await syncGithubCommentsToAnnotations(itemId, comments, pmRoot, 1);
process.stdout.write(`${JSON.stringify(result)}\n`);

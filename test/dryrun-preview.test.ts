import assert from "node:assert/strict";
import test from "node:test";

import { parseImportOptions, runImport } from "../dist/index.js";
import type { GhIssue } from "../dist/index.js";

// A --dry-run preview exists to tell an agent what a real run will do. The
// non-atomic path used to skip building the provenance index entirely, so every
// already-linked issue was previewed as a fresh import: "would import N, skip 0"
// where the real run performs updates. That reads as "this will duplicate my
// whole tracker" and is exactly what --dry-run is supposed to rule out.

const issue = (number: number, title: string): GhIssue => ({
  number,
  title,
  body: "",
  state: "open",
  labels: [],
  assignee: null,
  milestone: null,
  user: { login: "octocat" },
  created_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-21T00:00:00Z",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
});

async function previewImport(atomic: boolean) {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));
  try {
    const result = await runImport(
      "acme/widgets",
      "/unused-dry-run-workspace",
      parseImportOptions({ dryRun: true, ...(atomic ? { atomic: true } : {}) }),
      {
        resolveToken: () => undefined,
        fetchIssues: async () => [issue(1, "Brand new"), issue(2, "Already linked")],
        // #2 is already in the workspace, carrying the provenance tag the import writes.
        readItems: () => [{ id: "existing-id", tags: ["gh:acme/widgets#2"] }],
      },
    );
    return { result, messages };
  } finally {
    console.error = originalError;
  }
}

test("non-atomic --dry-run previews updates for already-linked issues instead of counting them as imports", async () => {
  const { result, messages } = await previewImport(false);

  assert.deepStrictEqual(result, {
    dryRun: true,
    wouldImport: 1,
    wouldUpdate: 1,
    wouldSkip: 0,
  });
  assert.ok(
    messages.some((message) => /Would import 1, update 1, skip 0/.test(message)),
    `summary line missing; saw: ${messages.join(" | ")}`
  );
  assert.ok(
    messages.some((message) => /#2 update Already linked/.test(message)),
    "per-issue line should label the already-linked issue as an update"
  );
  assert.ok(
    messages.some((message) => /#1 import Brand new/.test(message)),
    "per-issue line should label the unlinked issue as an import"
  );
});

test("atomic and non-atomic --dry-run agree on the import/update split", async () => {
  const plain = (await previewImport(false)).result as Record<string, unknown>;
  const atomic = (await previewImport(true)).result as Record<string, unknown>;

  assert.strictEqual(plain.wouldImport, atomic.wouldImport);
  assert.strictEqual(plain.wouldUpdate, atomic.wouldUpdate);
  assert.strictEqual(plain.wouldSkip, atomic.wouldSkip);
  // The atomic variant additionally flags itself; that is the only difference.
  assert.strictEqual(atomic.atomic, true);
  assert.strictEqual(plain.atomic, undefined);
});

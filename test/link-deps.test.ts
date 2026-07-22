import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProvenanceIndexFromMetadata,
  countDependencyRefCandidates,
  linkImportedDependencies,
  parseDependencyReferences,
  planDependencyLinks,
  runImport,
} from "../dist/index.js";
import type {
  DepLinkSnapshotItem,
  GhIssue,
  ImportOptions,
  ResolvedDepEdge,
} from "../dist/index.js";

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = {
  encoding: "utf-8" as const,
  shell: process.platform === "win32",
};

function issue(number: number, body: string | null, overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number,
    title: `Issue ${number}`,
    body,
    state: "open",
    labels: [],
    assignee: null,
    milestone: null,
    created_at: "2026-07-22T00:00:00Z",
    updated_at: "2026-07-22T00:00:00Z",
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    ...overrides,
  };
}

function importOpts(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    state: "all",
    includePrs: false,
    skipDrafts: false,
    withComments: false,
    commentsMode: "body",
    itemType: "Issue",
    dryRun: false,
    atomic: false,
    linkDeps: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseDependencyReferences — pure
// ---------------------------------------------------------------------------

test("parses 'Blocked by #N' as a blocked_by ref against the source repo", () => {
  const refs = parseDependencyReferences("Blocked by #12", "acme/widgets");
  assert.deepStrictEqual(refs, [
    { repo: "acme/widgets", number: 12, kind: "blocked_by", phrase: "blocked by" },
  ]);
});

test("maps 'Depends on' to blocked_by and 'Blocks' to blocks", () => {
  assert.strictEqual(parseDependencyReferences("Depends on #3", "a/b")[0].kind, "blocked_by");
  assert.strictEqual(parseDependencyReferences("Blocks #4", "a/b")[0].kind, "blocks");
});

test("is case-insensitive and tolerates hyphen/colon glue", () => {
  const refs = parseDependencyReferences("BLOCKED-BY: #7", "a/b");
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].number, 7);
  assert.strictEqual(refs[0].kind, "blocked_by");
});

test("collects multiple refs in one clause ('#1, #2 and #3')", () => {
  const refs = parseDependencyReferences("Blocked by #1, #2 and #3", "a/b");
  assert.deepStrictEqual(refs.map((r) => r.number), [1, 2, 3]);
});

test("resolves explicit owner/repo#N cross-repo refs (lowercased)", () => {
  const refs = parseDependencyReferences("Depends on Other/Repo#42", "a/b");
  assert.deepStrictEqual(refs, [
    { repo: "other/repo", number: 42, kind: "blocked_by", phrase: "depends on" },
  ]);
});

test("de-duplicates repeated refs within one body", () => {
  const refs = parseDependencyReferences("Blocked by #5. Also blocked by #5.", "a/b");
  assert.strictEqual(refs.length, 1);
});

test("ignores refs inside fenced and inline code spans", () => {
  const body = "See `Blocked by #99` and\n```\nBlocked by #100\n```\nBlocked by #1";
  const refs = parseDependencyReferences(body, "a/b");
  assert.deepStrictEqual(refs.map((r) => r.number), [1]);
});

test("does not match 'blocks' inside a larger word (roadblocks)", () => {
  assert.deepStrictEqual(parseDependencyReferences("roadblocks #1", "a/b"), []);
});

test("prefers 'blocked by' over 'blocks' at the same position", () => {
  const refs = parseDependencyReferences("Blocked by #2", "a/b");
  assert.strictEqual(refs[0].kind, "blocked_by");
});

test("returns [] for empty/undefined body and bodies with no phrase", () => {
  assert.deepStrictEqual(parseDependencyReferences("", "a/b"), []);
  assert.deepStrictEqual(parseDependencyReferences("mentions #5 without a phrase", "a/b"), []);
});

// ---------------------------------------------------------------------------
// buildProvenanceIndexFromMetadata — pure
// ---------------------------------------------------------------------------

test("indexes items by their gh provenance tag", () => {
  const items: DepLinkSnapshotItem[] = [
    { id: "pm-1", tags: ["bug", "gh:acme/widgets#1"] },
    { id: "pm-2", tags: ["gh:acme/widgets#2"] },
    { id: "pm-3", tags: ["no-provenance"] },
  ];
  const index = buildProvenanceIndexFromMetadata(items);
  assert.strictEqual(index.get("acme/widgets#1"), "pm-1");
  assert.strictEqual(index.get("acme/widgets#2"), "pm-2");
  assert.strictEqual(index.size, 2);
});

test("first writer wins on a duplicated provenance tag", () => {
  const items: DepLinkSnapshotItem[] = [
    { id: "pm-1", tags: ["gh:acme/widgets#1"] },
    { id: "pm-dup", tags: ["gh:acme/widgets#1"] },
  ];
  assert.strictEqual(buildProvenanceIndexFromMetadata(items).get("acme/widgets#1"), "pm-1");
});

// ---------------------------------------------------------------------------
// planDependencyLinks — pure
// ---------------------------------------------------------------------------

const PROVENANCE = new Map<string, string>([
  ["acme/widgets#1", "pm-1"],
  ["acme/widgets#2", "pm-2"],
  ["acme/widgets#3", "pm-3"],
]);

test("resolves a body reference into a concrete edge", () => {
  const { edges, unresolved } = planDependencyLinks(
    "acme/widgets",
    [issue(2, "Blocked by #1")],
    PROVENANCE,
  );
  assert.strictEqual(unresolved, 0);
  assert.deepStrictEqual(edges, [
    { sourceId: "pm-2", targetId: "pm-1", kind: "blocked_by", sourceIssue: 2, phrase: "blocked by" },
  ]);
});

test("counts references to issues absent from the workspace as unresolved", () => {
  const { edges, unresolved } = planDependencyLinks(
    "acme/widgets",
    [issue(2, "Blocked by #999")],
    PROVENANCE,
  );
  assert.strictEqual(edges.length, 0);
  assert.strictEqual(unresolved, 1);
});

test("skips self-references (issue referencing its own number)", () => {
  const { edges, unresolved } = planDependencyLinks(
    "acme/widgets",
    [issue(1, "Blocked by #1")],
    PROVENANCE,
  );
  assert.deepStrictEqual(edges, []);
  assert.strictEqual(unresolved, 0);
});

test("skips issues whose source item is not in the workspace (no unresolved inflation)", () => {
  const { edges, unresolved } = planDependencyLinks(
    "acme/widgets",
    [issue(77, "Blocked by #1")], // #77 has no provenance entry
    PROVENANCE,
  );
  assert.deepStrictEqual(edges, []);
  assert.strictEqual(unresolved, 0);
});

test("de-duplicates identical edges across issues", () => {
  const { edges } = planDependencyLinks(
    "acme/widgets",
    [issue(2, "Blocked by #1 and again blocked by #1")],
    PROVENANCE,
  );
  assert.strictEqual(edges.length, 1);
});

// ---------------------------------------------------------------------------
// linkImportedDependencies — hermetic (all hooks injected)
// ---------------------------------------------------------------------------

function snapshot(deps: Record<string, Array<{ id: string; kind: string }>> = {}): DepLinkSnapshotItem[] {
  return [
    { id: "pm-1", tags: ["gh:acme/widgets#1"], dependencies: deps["pm-1"] },
    { id: "pm-2", tags: ["gh:acme/widgets#2"], dependencies: deps["pm-2"] },
  ];
}

test("applies edges, records changed sources, and surfaces injected cycle warnings", async () => {
  const applied: ResolvedDepEdge[] = [];
  const result = await linkImportedDependencies(
    "acme/widgets",
    [issue(2, "Blocked by #1")],
    "/pm",
    {
      listItemMetadata: async () => snapshot(),
      applyDependencyLink: (edge) => {
        applied.push(edge);
        return { ok: true, stderr: "" };
      },
      collectOrderingCycleWarnings: (_b, _a, changed) =>
        changed === "pm-2" ? ["ordering_cycle_created:pm-2 -> pm-1 -> pm-2"] : [],
    },
  );
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(result.linked, 1);
  assert.strictEqual(result.unresolved, 0);
  assert.deepStrictEqual(result.orderingCycleWarnings, ["ordering_cycle_created:pm-2 -> pm-1 -> pm-2"]);
  assert.deepStrictEqual(result.failures, []);
});

test("captures apply failures without throwing and still snapshots for warnings", async () => {
  let afterCalls = 0;
  const result = await linkImportedDependencies(
    "acme/widgets",
    [issue(2, "Blocked by #1")],
    "/pm",
    {
      listItemMetadata: async () => {
        afterCalls++;
        return snapshot();
      },
      applyDependencyLink: () => ({ ok: false, stderr: "boom" }),
      collectOrderingCycleWarnings: () => [],
    },
  );
  assert.strictEqual(result.linked, 0);
  assert.strictEqual(result.failures.length, 1);
  assert.match(result.failures[0], /boom/);
  // A failed edge does not join changedSources, so no "after" snapshot is taken.
  assert.strictEqual(afterCalls, 1);
});

test("no candidate edges → no apply, no after-snapshot, empty result", async () => {
  let applyCalls = 0;
  let listCalls = 0;
  const result = await linkImportedDependencies(
    "acme/widgets",
    [issue(1, "no dependency phrases here")],
    "/pm",
    {
      listItemMetadata: async () => {
        listCalls++;
        return snapshot();
      },
      applyDependencyLink: () => {
        applyCalls++;
        return { ok: true, stderr: "" };
      },
      collectOrderingCycleWarnings: () => ["should-not-appear"],
    },
  );
  assert.strictEqual(applyCalls, 0);
  assert.strictEqual(listCalls, 1); // only the "before" snapshot
  assert.deepStrictEqual(result, { linked: 0, unresolved: 0, orderingCycleWarnings: [], failures: [] });
});

test("de-duplicates cycle warnings emitted for multiple changed sources", async () => {
  const result = await linkImportedDependencies(
    "acme/widgets",
    [issue(1, "Blocks #2"), issue(2, "Blocked by #1")],
    "/pm",
    {
      listItemMetadata: async () => snapshot(),
      applyDependencyLink: () => ({ ok: true, stderr: "" }),
      collectOrderingCycleWarnings: () => ["same-cycle-warning"],
    },
  );
  assert.strictEqual(result.linked, 2);
  assert.deepStrictEqual(result.orderingCycleWarnings, ["same-cycle-warning"]);
});

test("countDependencyRefCandidates totals parsed refs across issues", () => {
  const n = countDependencyRefCandidates("acme/widgets", [
    issue(1, "Blocked by #2, #3"),
    issue(4, "no refs"),
    issue(5, "Depends on #1"),
  ]);
  assert.strictEqual(n, 3);
});

// ---------------------------------------------------------------------------
// runImport --link-deps — real end-to-end against a live pm tracker + SDK
// ---------------------------------------------------------------------------

function freshTracker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-linkdeps-"));
  const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
  assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
  return root;
}

function showItem(root: string, id: string): { dependencies?: Array<{ id: string; kind: string }> } {
  const r = spawnSync(PM_BIN, ["--path", root, "show", id, "--json"], PM_SPAWN_OPTS);
  assert.strictEqual(r.status, 0, `pm show failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  return parsed.item ?? parsed;
}

function idForProvenance(root: string, tag: string): string {
  const r = spawnSync(PM_BIN, ["--path", root, "list", "--json", "--limit", "100"], PM_SPAWN_OPTS);
  assert.strictEqual(r.status, 0, `pm list failed: ${r.stderr}`);
  const items = (JSON.parse(r.stdout).items ?? []) as Array<{ id: string; tags?: string[] }>;
  for (const it of items) {
    const full = showItemTags(root, it.id);
    if (full.includes(tag)) return it.id;
  }
  throw new Error(`no item carries provenance ${tag}`);
}

function showItemTags(root: string, id: string): string[] {
  const r = spawnSync(PM_BIN, ["--path", root, "show", id, "--json"], PM_SPAWN_OPTS);
  const parsed = JSON.parse(r.stdout);
  return (parsed.item ?? parsed).tags ?? [];
}

test("runImport --link-deps writes a blocked_by edge between imported items (idempotent)", async () => {
  const root = freshTracker();
  try {
    const issues = [issue(1, "Root work."), issue(2, "Blocked by #1")];
    const deps = { resolveToken: () => "x", fetchIssues: async () => issues };

    const first = (await runImport("acme/widgets", root, importOpts(), deps)) as Record<string, unknown>;
    assert.strictEqual(first.imported, 2);
    assert.strictEqual(first.linkedDependencies, 1);
    assert.strictEqual(first.unresolvedDependencyRefs, 0);

    const id1 = idForProvenance(root, "gh:acme/widgets#1");
    const id2 = idForProvenance(root, "gh:acme/widgets#2");
    const item2 = showItem(root, id2);
    assert.deepStrictEqual(
      (item2.dependencies ?? []).map((d) => ({ id: d.id, kind: d.kind })),
      [{ id: id1, kind: "blocked_by" }],
    );

    // Re-import must not duplicate the edge.
    const second = (await runImport("acme/widgets", root, importOpts(), deps)) as Record<string, unknown>;
    assert.strictEqual(second.linkedDependencies, 1);
    const item2Again = showItem(root, id2);
    assert.strictEqual((item2Again.dependencies ?? []).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runImport --link-deps skips self-references and counts unresolved refs", async () => {
  const root = freshTracker();
  try {
    const issues = [issue(1, "Blocked by #1. Also blocked by #404.")];
    const deps = { resolveToken: () => "x", fetchIssues: async () => issues };
    const result = (await runImport("acme/widgets", root, importOpts(), deps)) as Record<string, unknown>;
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.linkedDependencies, 0); // self skipped
    assert.strictEqual(result.unresolvedDependencyRefs, 1); // #404 absent

    const id1 = idForProvenance(root, "gh:acme/widgets#1");
    assert.strictEqual((showItem(root, id1).dependencies ?? []).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runImport without --link-deps leaves items free of dependency edges", async () => {
  const root = freshTracker();
  try {
    const issues = [issue(1, "Root."), issue(2, "Blocked by #1")];
    const deps = { resolveToken: () => "x", fetchIssues: async () => issues };
    const result = (await runImport("acme/widgets", root, importOpts({ linkDeps: false }), deps)) as Record<string, unknown>;
    assert.strictEqual(result.imported, 2);
    assert.strictEqual(result.linkedDependencies, undefined);
    const id2 = idForProvenance(root, "gh:acme/widgets#2");
    assert.strictEqual((showItem(root, id2).dependencies ?? []).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

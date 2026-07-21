import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CommandError,
  EXIT_CODE,
  buildAtomicImportMutations,
  deriveAtomicItemId,
  deriveAtomicTransactionId,
  importGithubAtomic,
  parseImportOptions,
  resolveCommitItemMutations,
  runImport,
} from "../dist/index.js";
import type { GhIssue, PreparedGithubImport } from "../dist/index.js";

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = {
  encoding: "utf-8" as const,
  shell: process.platform === "win32",
};

function entry(
  issueNumber: number,
  title: string,
  overrides: Partial<PreparedGithubImport> = {},
): PreparedGithubImport {
  return {
    issueNumber,
    title,
    itemType: "Issue",
    status: "open",
    description: `GH issue #${issueNumber}: https://github.com/acme/widgets/issues/${issueNumber}`,
    body: `Body ${issueNumber}`,
    tags: ["bug", `gh:acme/widgets#${issueNumber}`],
    comments: [],
    syncAnnotations: false,
    ...overrides,
  };
}

function freshTracker(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-atomic-"));
  try {
    const init = spawnSync(PM_BIN, ["--path", root, "init", "test"], PM_SPAWN_OPTS);
    assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
    assert.strictEqual(itemCount(root), 0, "fresh tracker must be empty");
    return root;
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function listItems(root: string): Array<{ id: string; title: string; status: string }> {
  const result = spawnSync(
    PM_BIN,
    ["--path", root, "list-all", "--json", "--full", "--limit", "100"],
    PM_SPAWN_OPTS,
  );
  assert.strictEqual(result.status, 0, `pm list-all failed: ${result.error?.message ?? result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { items?: Array<{ id: string; title: string; status: string }> };
  return parsed.items ?? [];
}

function itemCount(root: string): number {
  return listItems(root).length;
}

function validateOk(root: string): boolean {
  return spawnSync(PM_BIN, ["--path", root, "validate"], PM_SPAWN_OPTS).status === 0;
}

test("parseImportOptions enables atomic mode without changing the default", () => {
  assert.strictEqual(parseImportOptions({}).atomic, false);
  assert.strictEqual(parseImportOptions({ atomic: true }).atomic, true);
  assert.strictEqual(parseImportOptions({ atomic: "1" }).atomic, true);
});

test("atomic dry-run previews creates and updates without invoking the SDK", async () => {
  const issue = (number: number, title: string): GhIssue => ({
    number,
    title,
    body: `Body ${number}`,
    state: "open",
    labels: [{ name: "bug" }],
    user: { login: "alice" },
    assignee: null,
    milestone: null,
    created_at: "2026-07-21T00:00:00Z",
    updated_at: "2026-07-21T00:00:00Z",
    html_url: `https://github.com/acme/widgets/issues/${number}`,
  });
  let sdkCalls = 0;
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));
  try {
    const result = await runImport(
      "acme/widgets",
      "/unused-dry-run-workspace",
      parseImportOptions({ atomic: true, dryRun: true }),
      {
        resolveToken: () => undefined,
        fetchIssues: async () => [issue(1, "New"), issue(2, "Existing"), issue(3, "   ")],
        readItems: () => [{ id: "existing-id", tags: ["gh:acme/widgets#2"] }],
        commitAtomic: async () => {
          sdkCalls++;
          throw new Error("atomic dry-run must not call the SDK commit path");
        },
      },
    );

    assert.deepStrictEqual(result, {
      dryRun: true,
      wouldImport: 1,
      wouldUpdate: 1,
      wouldSkip: 1,
      atomic: true,
    });
    assert.strictEqual(sdkCalls, 0);
    assert.ok(messages.some((message) => /Atomic plan would import 1, update 1, skip 1/.test(message)));
  } finally {
    console.error = originalError;
  }
});

test("transaction identity is content-sensitive and independent of fetch order", () => {
  const first = entry(1, "First");
  const second = entry(2, "Second");
  const id = deriveAtomicTransactionId("Acme/Widgets", [first, second]);
  assert.match(id, /^github-import-[0-9a-f]{16}$/);
  assert.strictEqual(
    deriveAtomicTransactionId("acme/widgets", [second, first]),
    id,
    "same rendered issues in another order resume the same transaction",
  );
  assert.notStrictEqual(
    deriveAtomicTransactionId("acme/widgets", [first, entry(2, "Changed")]),
    id,
    "changed desired state starts a fresh transaction",
  );
});

test("create ids are stable external-key ids and mutation planning handles transitions", () => {
  const normalize = (input: string, prefix: string) => `${prefix}${input}`;
  const id = deriveAtomicItemId("Acme/Widgets", 42, "test-", normalize);
  assert.strictEqual(id, deriveAtomicItemId("acme/widgets", 42, "test-", normalize));
  assert.notStrictEqual(id, deriveAtomicItemId("acme/widgets", 43, "test-", normalize));

  const created = buildAtomicImportMutations("acme/widgets", entry(42, "New"), "test-", normalize);
  assert.strictEqual(created.itemId, id);
  assert.deepStrictEqual(created.mutations.map((mutation) => mutation.op), ["create", "update"]);

  const recoveredCreate = buildAtomicImportMutations(
    "acme/widgets",
    entry(42, "New", { match: { id, status: "open" } }),
    "test-",
    normalize,
  );
  assert.deepStrictEqual(
    recoveredCreate.mutations,
    created.mutations,
    "a partially-created deterministic item reproduces the original journal plan",
  );

  const closed = buildAtomicImportMutations(
    "acme/widgets",
    entry(42, "Closed", { status: "closed", match: { id: "legacy-import-id", status: "open" } }),
    "test-",
    normalize,
  );
  assert.deepStrictEqual(closed.mutations.map((mutation) => mutation.op), ["update", "close"]);

  const reopened = buildAtomicImportMutations(
    "acme/widgets",
    entry(42, "Reopened", { match: { id: "legacy-import-id", status: "closed" } }),
    "test-",
    normalize,
  );
  assert.strictEqual(reopened.mutations.length, 1);
  assert.strictEqual(reopened.mutations[0]?.op, "update");
  assert.strictEqual((reopened.mutations[0] as { options: Record<string, unknown> }).options.status, "open");
});

test("atomic import commits and resumes reordered input without duplicates", async () => {
  const root = freshTracker();
  try {
    const entries = [entry(1, "First"), entry(2, "Second")];
    const first = await importGithubAtomic(root, "acme/widgets", entries);
    assert.strictEqual(first.imported, 2);
    assert.strictEqual(first.updated, 0);
    assert.strictEqual(first.recovered, false);
    assert.strictEqual(itemCount(root), 2);

    const resumedEntries = [...entries].reverse().map((candidate) => ({
      ...candidate,
      match: {
        id: first.itemIds.get(candidate.issueNumber),
        status: "open",
      },
    }));
    const resumed = await importGithubAtomic(root, "acme/widgets", resumedEntries);
    assert.strictEqual(resumed.transactionId, first.transactionId);
    assert.strictEqual(resumed.recovered, true);
    assert.strictEqual(resumed.imported, 0, "a recovered journal is not misreported as new work");
    assert.strictEqual(resumed.updated, 0, "a recovered journal is not misreported as updates");
    assert.strictEqual(resumed.recoveredItems, 2);
    assert.strictEqual(itemCount(root), 2, "resumed import does not duplicate items");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic update and close commit together", async () => {
  const root = freshTracker();
  try {
    const initial = entry(7, "Initial");
    const created = await importGithubAtomic(root, "acme/widgets", [initial]);
    const itemId = created.itemIds.get(7);
    assert.ok(itemId);

    const changed = entry(7, "Completed upstream", {
      status: "closed",
      body: "Final body",
      match: { id: itemId, status: "open" },
    });
    const result = await importGithubAtomic(root, "acme/widgets", [changed]);
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.updated, 1);
    const item = listItems(root).find((candidate) => candidate.id === itemId);
    assert.strictEqual(item?.title, "Completed upstream");
    assert.strictEqual(item?.status, "closed");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed atomic batch compensates every applied create", async () => {
  const root = freshTracker();
  try {
    const sdk = await import("@unbrained/pm-cli/sdk");
    const wrappingCommit = async (options: Parameters<typeof sdk.commitItemMutations>[0]) => {
      const settings = await sdk.readSettings(options.pmRoot);
      const brokenId = sdk.normalizeItemId("github-broken", settings.id_prefix);
      return sdk.commitItemMutations({
        ...options,
        mutations: [
          ...options.mutations,
          {
            op: "create" as const,
            id: brokenId,
            options: { title: "Broken", type: "NoSuchType_XYZ", status: "open" },
          },
        ],
      });
    };

    await assert.rejects(
      () => importGithubAtomic(
        root,
        "acme/widgets",
        [entry(20, "Rollback one"), entry(21, "Rollback two")],
        { commitItemMutations: wrappingCommit },
      ),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
        assert.match((err as Error).message, /no partial committed state/);
        return true;
      },
    );
    assert.strictEqual(itemCount(root), 0, "rollback deletes every transaction-owned create");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed mixed batch restores pre-existing updates and closes", async () => {
  const root = freshTracker();
  try {
    const sdk = await import("@unbrained/pm-cli/sdk");
    const initialEntries = [entry(30, "Original update target"), entry(31, "Original close target")];
    const initial = await importGithubAtomic(root, "acme/widgets", initialEntries);
    const updateId = initial.itemIds.get(30);
    const closeId = initial.itemIds.get(31);
    assert.ok(updateId);
    assert.ok(closeId);

    const wrappingCommit = async (options: Parameters<typeof sdk.commitItemMutations>[0]) => {
      const settings = await sdk.readSettings(options.pmRoot);
      const brokenId = sdk.normalizeItemId("github-broken-mixed", settings.id_prefix);
      return sdk.commitItemMutations({
        ...options,
        mutations: [
          ...options.mutations,
          {
            op: "create" as const,
            id: brokenId,
            options: { title: "Broken", type: "NoSuchType_XYZ", status: "open" },
          },
        ],
      });
    };

    await assert.rejects(
      () => importGithubAtomic(
        root,
        "acme/widgets",
        [
          entry(30, "Mutated title", { body: "Mutated body", match: { id: updateId, status: "open" } }),
          entry(31, "Should be restored", { status: "closed", match: { id: closeId, status: "open" } }),
        ],
        { commitItemMutations: wrappingCommit },
      ),
      /no partial committed state/,
    );

    const items = listItems(root);
    const updateTarget = items.find((candidate) => candidate.id === updateId);
    const closeTarget = items.find((candidate) => candidate.id === closeId);
    assert.strictEqual(updateTarget?.title, "Original update target", "update compensation restores title");
    assert.strictEqual(updateTarget?.status, "open", "update compensation restores status");
    assert.strictEqual(closeTarget?.title, "Original close target", "close target content is restored");
    assert.strictEqual(closeTarget?.status, "open", "close compensation reopens the item");
    assert.strictEqual(itemCount(root), 2, "mixed rollback neither deletes nor duplicates existing items");
    assert.ok(validateOk(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SDK resolution reports an actionable version error", async () => {
  await assert.rejects(
    () => resolveCommitItemMutations(async () => ({})),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /does not export commitItemMutations/);
      assert.match((err as Error).message, />=2026\.7\.20/);
      return true;
    },
  );
});

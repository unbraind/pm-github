/**
 * Remaining reachable command, import, and planner paths.
 *
 * These cases use real temporary git repositories, the installed pm CLI, and
 * the local HTTP stand-in. Injected dependencies are the production seams
 * (fetch, commit, pm subprocess via PATH), not substitutes for the unit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  applyClientFilters,
  applyExportPlan,
  buildIssuesUrl,
  collectProjectsV2Pages,
  importGithubAtomic,
  importCommentSyncLockPath,
  linkImportedDependencies,
  listOwnerProjectsV2Nodes,
  parseImportOptions,
  runImport,
  syncGithubCommentsToAnnotations,
  type GhIssue,
  type ImportOptions,
} from "../index.ts";
import { nodeScenario } from "./helpers/node-scenario.ts";
import { withReadOnlyDirectory } from "./helpers/read-only-directory.ts";

// Root ignores directory write permissions, so read-only-directory fixtures
// cannot produce their write failures there; skip them visibly in that case.
const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const nonRootOnly = { skip: runsAsRoot && "permission-based fixture: root ignores directory write permissions" };
import { projectItemTag } from "../projects.ts";
import { captureStderr, jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";

const harnessPromise: Promise<ExtensionTestHarness> = createExtensionTestHarness(extension, {
  capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"],
});

const REAL_PM = fileURLToPath(new URL("../node_modules/.bin/pm", import.meta.url));

function issue(overrides: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 7,
    title: "Widget",
    body: "clean body",
    state: "open",
    labels: [{ name: "bug" }, { name: "" }],
    assignee: null,
    milestone: null,
    created_at: "",
    updated_at: "",
    html_url: "https://example.test/acme/widgets/issues/7",
    user: null,
    ...overrides,
  };
}

function opts(extra: Record<string, unknown> = {}): ImportOptions {
  return parseImportOptions(extra);
}

function gitTracker(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "config", "user.email", "fixture@example.com"]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "config", "user.name", "Fixture"]).status, 0);
  const tracker = path.join(root, ".agents", "pm");
  fs.mkdirSync(tracker, { recursive: true });
  const init = spawnSync(REAL_PM, ["--path", tracker, "init", "test"], { encoding: "utf8", cwd: root });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

async function withFakePm(body: string, fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-fake-pm-"));
  fs.writeFileSync(path.join(dir, "pm"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousReal = process.env.REAL_PM;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
  process.env.REAL_PM = REAL_PM;
  try {
    await fn();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousReal === undefined) delete process.env.REAL_PM;
    else process.env.REAL_PM = previousReal;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("client filters and issue URL query keep optional import constraints", () => {
  const open = issue({ number: 1, milestone: { title: "Now" } });
  const other = issue({ number: 2, milestone: { title: "Later" }, pull_request: {}, draft: true });
  const filtered = applyClientFilters([open, other], opts({ milestone: "Now", "include-prs": true, "skip-drafts": true }));
  assert.deepEqual(filtered.map((item) => item.number), [1]);
  const url = buildIssuesUrl("Acme/Widgets", opts({ labels: "bug", since: "2026-01-01T00:00:00Z", assignee: "octo", all: true }));
  assert.match(url, /labels=bug/);
  assert.match(url, /since=/);
  assert.match(url, /assignee=octo/);
  assert.match(url, /state=all/);
});

test("atomic import falls back when settings are unreadable and reports interruption", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-atomic-settings-"));
  try {
    const entry = {
      issueNumber: 7,
      title: "Widget",
      itemType: "Task",
      status: "open",
      description: "d",
      body: "b",
      tags: ["gh:acme/widgets#7"],
      comments: [],
      syncAnnotations: false,
    };
    const committed = await importGithubAtomic(root, "acme/widgets", [entry], {
      readSettings: async () => { throw new Error("settings unreadable"); },
      normalizeItemId: (value) => value,
      commitItemMutations: async () => ({ status: "committed", recovered: false, transactionId: "tx", results: {} }),
    });
    assert.equal(committed.recovered, false);
    const interrupted = new Error("stopped");
    interrupted.name = "WorkspaceTransactionInterruptedError";
    await assert.rejects(
      importGithubAtomic(root, "acme/widgets", [entry], {
        readSettings: async () => ({}),
        normalizeItemId: (value) => value,
        commitItemMutations: async () => { throw interrupted; },
      }),
      /interrupted/,
    );
    await assert.rejects(
      importGithubAtomic(root, "acme/widgets", [entry], {
        readSettings: async () => ({}),
        normalizeItemId: (value) => value,
        commitItemMutations: async () => { throw "plain failure"; },
      }),
      /plain failure/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGitHubToken does not throw when gh cannot be spawned", () => {
  nodeScenario(`
    import assert from 'node:assert/strict';
    import { resolveGitHubToken } from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    assert.equal(resolveGitHubToken(), undefined);
  `, { GITHUB_TOKEN: undefined, GH_TOKEN: undefined, PATH: "" });
});

test("project page collection stops on a missing connection, null nodes, and a cursorless next page", async () => {
  const pages = await collectProjectsV2Pages(async (cursor) => {
    if (cursor === undefined) return { nodes: [null, { number: 1, title: "A", url: "u", closed: false }], pageInfo: { hasNextPage: true, endCursor: "c1" } };
    if (cursor === "c1") return { pageInfo: { hasNextPage: true } };
    return null;
  });
  assert.equal(pages.length, 1);
  const org = await listOwnerProjectsV2Nodes("acme", async () => ({
    user: null,
    organization: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [{ number: 3, title: "Org", url: "o", closed: true }] } },
  }));
  assert.equal(org[0]?.number, 3);
});

test("export apply records a non-Error failure and an update missing its number", async () => {
  const { stderr, result } = await captureStderr(() => applyExportPlan([
    { action: "update", id: "pm-1", payload: { title: "T", body: "", labels: [], state: "open" } },
    { action: "create", payload: { title: "C", body: "", labels: [], state: "open" } },
  ], "acme/widgets", "tok", async () => { throw "exporter down"; }));
  assert.equal(result.failed, 2);
  assert.match(stderr.join("\n"), /exporter down/);
  assert.match(stderr.join("\n"), /missing its GitHub issue number/);
});

test("dependency linking reports a non-Error snapshot failure and a detector failure", async () => {
  const skipped = await linkImportedDependencies("acme/widgets", [issue({ body: "Blocked by #2" })], "unused", {
    listItemMetadata: async () => { throw "metadata down"; },
  });
  assert.match(skipped.failures[0] ?? "", /metadata down/);
  const advised = await linkImportedDependencies("acme/widgets", [issue({ number: 1, body: "Blocked by #2" })], "unused", {
    listItemMetadata: async () => [
      { id: "pm-1", tags: ["gh:acme/widgets#1"], status: "open" },
      { id: "pm-2", tags: ["gh:acme/widgets#2"], status: "open" },
    ],
    applyDependencyLink: () => ({ ok: true, stderr: "" }),
    collectOrderingCycleWarnings: () => { throw "detector down"; },
  });
  assert.deepEqual(advised.failures, ["ordering-cycle advisory skipped: detector down"]);
  assert.deepEqual(advised.orderingCycleWarnings, []);
  assert.equal(advised.linked, 1);
});

test("ungated import skips a blank title, reports comment-fetch failure, and previews link-deps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-import-preview-"));
  try {
    const { stderr, result } = await captureStderr(() => runImport("acme/widgets", root, opts({ "link-deps": true, dryRun: true, "with-comments": true }), {
      resolveToken: () => "tok",
      readItems: () => [],
      fetchIssues: async () => [issue({ title: "   ", number: 1 }), issue({ number: 2, body: "Blocked by #9" })],
      fetchIssueComments: async () => { throw "comments down"; },
    }));
    assert.ok("dryRun" in result);
    assert.equal(result.dryRun, true);
    assert.match(stderr.join("\n"), /failed to fetch comments/);
    assert.match(stderr.join("\n"), /comments down/);
    assert.match(stderr.join("\n"), /link-deps/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gated atomic import reports a recovered journal and fails closed after a post-write leak", async () => {
  const root = gitTracker("pm-github-gate-write-");
  try {
    const recovered = await captureStderr(() => runImport("acme/widgets", path.join(root, ".agents", "pm"), opts({ atomic: true }), {
      resolveToken: () => "tok",
      readItems: () => [],
      fetchIssues: async () => [issue()],
      commitAtomic: async () => ({
        transactionId: "tx-recovered",
        recovered: true,
        imported: 0,
        updated: 0,
        recoveredItems: 1,
        itemIds: new Map([[7, "pm-recovered"]]),
      }),
    }));
    assert.match(recovered.stderr.join("\n"), /recovered transaction tx-recovered/);

    await assert.rejects(captureStderr(() => runImport("acme/widgets", path.join(root, ".agents", "pm"), opts({ atomic: true, gate: true }), {
      resolveToken: () => "tok",
      fetchIssues: async () => [issue({ body: "clean" })],
      commitAtomic: async (tracker, repo, entries) => {
        const receipt = await importGithubAtomic(tracker, repo, entries);
        fs.writeFileSync(path.join(root, ".agents", "pm", "issues", "leak.txt"), `body: "token ${"ghp_" + "b".repeat(36)}"\n`);
        return receipt;
      },
    })), /FAIL/);
    fs.rmSync(path.join(root, ".agents", "pm", "issues", "leak.txt"));

    await assert.rejects(captureStderr(() => runImport("acme/widgets", path.join(root, ".agents", "pm"), opts({ atomic: true, gate: true }), {
      resolveToken: () => "tok",
      fetchIssues: async () => [issue({ body: "still clean" })],
      commitAtomic: async (tracker, repo, entries) => {
        const receipt = await importGithubAtomic(tracker, repo, entries);
        fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
        return receipt;
      },
    })), /could not read the proposed tracker change|not inside a Git work tree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gated non-atomic import fails closed when a planned write fails", async () => {
  // The close reconciliation is refused: the item keeps its provenance tag, so
  // only the write count can show that the tracker no longer matches the plan.
  const root = gitTracker("pm-github-gated-write-fail-");
  try {
    await withFakePm(`
      for arg in "$@"; do
        if [ "$arg" = "close" ]; then echo close-refused >&2; exit 1; fi
      done
      exit 0
    `, async () => {
      await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts({ gate: true }), {
        resolveToken: () => "tok",
        readItems: () => [
          { id: "pm-existing", title: "old", status: "open", tags: ["gh:acme/widgets#8"] },
          { id: "pm-clean", title: "old", status: "open", tags: ["gh:acme/widgets#9"] },
        ],
        // #9 updates cleanly, so the import is not an all-failed run; only the
        // write count can show that #8's close never happened.
        fetchIssues: async () => [
          issue({ number: 8, state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" }),
          issue({ number: 9 }),
        ],
      }), /planned write\(s\) failed/));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A gated --comments-mode annotations|both import must be all-or-nothing for
// native comments too: a contended comment-sync lock, a refused per-comment
// add, and an unparsable created id all leave planned comments unwritten while
// every other check stays green, so the plan-divergence refusal is the only
// thing that can fail the run closed. The ungated twins pin the unchanged
// warn-and-continue behaviour.

test("a gated import fails closed when the comment-sync lock is contended", async () => {
  const root = gitTracker("pm-github-gated-lock-");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    assert.ok(holder.pid && holder.pid > 0);
    const lockPath = importCommentSyncLockPath(root, "pm-existing");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, token: "held", created_at: new Date().toISOString() }) + "\n");
    await withFakePm(`exit 0`, async () => {
      const gated = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts({ gate: true, "comments-mode": "annotations" }), {
        resolveToken: () => "tok",
        readItems: () => [{ id: "pm-existing", title: "old", status: "open", tags: ["gh:acme/widgets#7"] }],
        fetchIssues: async () => [issue({ comments: 1 })],
        fetchIssueComments: async () => [{ id: 3, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "held note" }],
      }), /planned write\(s\) failed/));
      assert.match(gated.stderr.join("\n"), /another import holds the comment-sync lock/);
    });
  } finally {
    holder.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gated import fails closed when a per-comment add fails mid-sync", nonRootOnly, async () => {
  const root = gitTracker("pm-github-gated-add-fail-");
  const tracker = path.join(root, ".agents", "pm");
  const created = spawnSync(REAL_PM, ["--path", tracker, "create", "task", "Commented", "--tags", "gh:acme/widgets#7", "--description", "d"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const listed = spawnSync(REAL_PM, ["--pm-path", root, "--json", "list", "--full"], { encoding: "utf8" });
  const itemId = (JSON.parse(listed.stdout) as { items?: Array<{ id: string }> }).items?.[0]?.id;
  assert.ok(itemId);
  const syncedComment = { id: 21, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "already synced" };
  const failingComment = { id: 22, user: { login: "octo" }, created_at: "2026-01-02T00:00:00Z", body: "cannot land" };
  // Land the first comment while the tasks directory is still writable so the
  // gated run below proves the loop continues past it: one skip, one failure.
  await syncGithubCommentsToAnnotations(itemId, [syncedComment], tracker, 7);
  const tasksDir = path.join(tracker, "tasks");
  try {
    await withReadOnlyDirectory(tasksDir, async () => {
      await withFakePm(`exit 0`, async () => {
        const gated = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts({ gate: true, "comments-mode": "annotations" }), {
          resolveToken: () => "tok",
          readItems: () => [{ id: itemId, title: "old", status: "open", tags: ["gh:acme/widgets#7"] }],
          fetchIssues: async () => [issue({ comments: 2 })],
          fetchIssueComments: async () => [syncedComment, failingComment],
        }), /planned write\(s\) failed/));
        assert.match(gated.stderr.join("\n"), /comment 22 sync failed/);
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gated import fails closed when a created id cannot be parsed with annotations sync on", async () => {
  const root = gitTracker("pm-github-gated-unparsed-");
  try {
    await withFakePm(`
      json=0
      for arg in "$@"; do
        if [ "$arg" = "--json" ]; then json=1; fi
      done
      if [ "$json" = "1" ]; then printf '%s\\n' 'not-json'; exit 0; fi
      exit 0
    `, async () => {
      const gated = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts({ gate: true, "comments-mode": "annotations" }), {
        resolveToken: () => "tok",
        readItems: () => [],
        fetchIssues: async () => [issue({ comments: 1 })],
        fetchIssueComments: async () => [{ id: 31, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "note" }],
      }), /planned write\(s\) failed/));
      assert.match(gated.stderr.join("\n"), /could not parse created item id — comments not synced/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gated atomic import fails closed when committed items lack their planned comments", async () => {
  const root = gitTracker("pm-github-gated-atomic-comments-");
  const tracker = path.join(root, ".agents", "pm");
  try {
    await assert.rejects(captureStderr(() => runImport("acme/widgets", tracker, opts({ atomic: true, gate: true, "comments-mode": "annotations" }), {
      resolveToken: () => "tok",
      readItems: () => [{ id: "pm-fresh", title: "t", status: "open", tags: ["gh:acme/widgets#7"] }],
      fetchIssues: async () => [issue({ comments: 1 })],
      fetchIssueComments: async () => [{ id: 41, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "note" }],
      // The commit "succeeds" but routes no created id, so the planned comment
      // is unreachable — only the comment-failure count can fail the run closed.
      commitAtomic: async () => ({ transactionId: "tx-comments", recovered: false, imported: 1, updated: 0, itemIds: new Map() }),
    })), /planned write\(s\) failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the same comment-sync failures without --gate still import with a warning", nonRootOnly, async () => {
  const root = gitTracker("pm-github-ungated-comments-");
  const tracker = path.join(root, ".agents", "pm");
  const created = spawnSync(REAL_PM, ["--path", tracker, "create", "task", "Commented", "--tags", "gh:acme/widgets#7", "--description", "d"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const listed = spawnSync(REAL_PM, ["--pm-path", root, "--json", "list", "--full"], { encoding: "utf8" });
  const itemId = (JSON.parse(listed.stdout) as { items?: Array<{ id: string }> }).items?.[0]?.id;
  assert.ok(itemId);
  const failingComment = { id: 52, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "cannot land" };
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    assert.ok(holder.pid && holder.pid > 0);
    const lockPath = importCommentSyncLockPath(root, itemId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, token: "held", created_at: new Date().toISOString() }) + "\n");
    await withFakePm(`exit 0`, async () => {
      const contended = await captureStderr(() => runImport("acme/widgets", root, opts({ "comments-mode": "annotations" }), {
        resolveToken: () => "tok",
        readItems: () => [{ id: itemId, title: "old", status: "open", tags: ["gh:acme/widgets#7"] }],
        fetchIssues: async () => [issue({ comments: 1 })],
        fetchIssueComments: async () => [failingComment],
      }));
      assert.ok("updated" in contended.result && contended.result.updated === 1);
      assert.match(contended.stderr.join("\n"), /another import holds the comment-sync lock/);
    });
    fs.rmSync(lockPath, { force: true });
    const tasksDir = path.join(tracker, "tasks");
    await withReadOnlyDirectory(tasksDir, async () => {
      await withFakePm(`exit 0`, async () => {
        const refused = await captureStderr(() => runImport("acme/widgets", root, opts({ "comments-mode": "annotations" }), {
          resolveToken: () => "tok",
          readItems: () => [{ id: itemId, title: "old", status: "open", tags: ["gh:acme/widgets#7"] }],
          fetchIssues: async () => [issue({ comments: 1 })],
          fetchIssueComments: async () => [failingComment],
        }));
        assert.ok("updated" in refused.result && refused.result.updated === 1);
        assert.match(refused.stderr.join("\n"), /comment 52 sync failed/);
      });
    });
  } finally {
    holder.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-atomic import reports update, close, reopen, and unparsed-id failures", async () => {
  const root = gitTracker("pm-github-import-fail-");
  const listed = spawnSync(REAL_PM, ["--pm-path", root, "--json", "list", "--full"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  try {
    await withFakePm(`
      for arg in "$@"; do
        if [ "$arg" = "update" ]; then echo update-refused >&2; exit 1; fi
      done
      exit 0
    `, async () => {
      const { stderr } = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts(), {
        resolveToken: () => "tok",
        readItems: () => [{ id: "pm-existing", title: "old", status: "open", tags: ["gh:acme/widgets#7"] }],
        fetchIssues: async () => [issue({ assignee: { login: "octo" }, milestone: { title: "Now" } })],
      }), /Imported 0 issue/));

      assert.match(stderr.join("\n"), /update failed/);
    });

    await withFakePm(`
      for arg in "$@"; do
        if [ "$arg" = "close" ]; then echo close-refused >&2; exit 1; fi
      done
      exit 0
    `, async () => {
      const closed = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts(), {
        resolveToken: () => "tok",
        readItems: () => [{ id: "pm-existing", title: "old", status: "open", tags: ["gh:acme/widgets#8"] }],
        fetchIssues: async () => [issue({ number: 8, state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" })],
      }), /Imported 0 issue/));
      assert.match(closed.stderr.join("\n"), /close reconciliation failed|close after import failed/);
    });

    await withFakePm(`
      for arg in "$@"; do
        if [ "$arg" = "open" ]; then echo reopen-refused >&2; exit 1; fi
      done
      exit 0
    `, async () => {
      const reopened = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts(), {
        resolveToken: () => "tok",
        readItems: () => [{ id: "pm-existing", title: "old", status: "closed", tags: ["gh:acme/widgets#9"] }],
        fetchIssues: async () => [issue({ number: 9, state: "open" })],
      }), /Imported 0 issue/));
      assert.match(reopened.stderr.join("\n"), /reopen reconciliation failed/);
    });

    await withFakePm(`
      json=0
      for arg in "$@"; do
        if [ "$arg" = "--json" ]; then json=1; fi
      done
      if [ "$json" = "1" ]; then printf '%s\\n' 'not-json'; exit 0; fi
      exit 0
    `, async () => {
      const parsed = await captureStderr(() => assert.rejects(runImport("acme/widgets", root, opts({ "comments-mode": "annotations" }), {
        resolveToken: () => "tok",
        readItems: () => [],
        fetchIssues: async () => [issue({ number: 10, state: "closed", comments: 1 })],
        fetchIssueComments: async () => [{ id: 1, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "note" }],
      }), /Imported 0 issue/));
      assert.match(parsed.stderr.join("\n"), /could not parse created item id/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("comment sync skips a contended lock and reports a per-comment write failure", nonRootOnly, async () => {
  const root = gitTracker("pm-github-comments-");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    assert.ok(holder.pid && holder.pid > 0);
    const created = spawnSync(REAL_PM, ["--path", root, "create", "task", "Commented", "--description", "d"], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const listed = spawnSync(REAL_PM, ["--pm-path", root, "--json", "list", "--full"], { encoding: "utf8" });
    const items = JSON.parse(listed.stdout) as { items?: Array<{ id: string }> };
    const itemId = items.items?.[0]?.id;
    assert.ok(itemId);
    const lockPath = importCommentSyncLockPath(root, itemId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, token: "held", created_at: new Date().toISOString() }) + "\n");
    const contended = await captureStderr(() => syncGithubCommentsToAnnotations(itemId, [
      { id: 4, user: { login: "octo" }, created_at: "2026-01-01T00:00:00Z", body: "held" },
    ], path.join(root, ".agents", "pm"), 7));
    assert.match(contended.stderr.join("\n"), /another import holds the comment-sync lock/);
    fs.rmSync(lockPath, { force: true });

    const itemFile = fs.readdirSync(path.join(root, ".agents", "pm", "tasks"))[0];
    assert.ok(itemFile);
    const tasksDir = path.join(root, ".agents", "pm", "tasks");
    await withReadOnlyDirectory(tasksDir, async () => {
      const failed = await captureStderr(() => syncGithubCommentsToAnnotations(itemId, [
        { id: 5, body: "", user: null, created_at: "" },
      ], path.join(root, ".agents", "pm"), 7));
      assert.equal(failed.result.added, 0);
      assert.match(failed.stderr.join("\n"), /sync failed/);
    });
  } finally {
    holder.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registered commands print text diagnostics and reject empty project and export selectors", async () => {
  const ext = await harnessPromise;
  await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined, PM_GITHUB_SYNC: undefined }, async () => {
    await assert.rejects(
      ext.runCommand({ command: "github project list", args: [], options: {}, global: { json: true } }),
      /Usage: pm github project list/,
    );
    await assert.rejects(
      ext.runCommand({ command: "github export", options: { ids: "" }, global: { json: true }, pmRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-export-empty-")) }),
      /--ids requires at least one/,
    );

    const listed = await captureStderr(() => withMockGithub((_req, res) => {
      jsonResponse(res, 200, { data: {
        user: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [
          { number: 5, title: null, url: null, closed: true, shortDescription: null },
          { number: 6, title: "Open", url: "", closed: false },
        ] } },
        organization: null,
      } });
    }, () => ext.runCommand({ command: "github project list", args: ["acme"], global: { json: false } })));
    assert.match(listed.stderr.join("\n"), /Projects for acme/);
    assert.match(listed.stderr.join("\n"), /\[closed\]/);

    const fields = await captureStderr(() => withMockGithub((_req, res) => {
      jsonResponse(res, 200, { data: {
        user: { projectV2: { id: "PVT", title: "Board", url: "https://example.test/board", statusField: null } },
        organization: null,
        node: { fields: { nodes: [
          { __typename: "ProjectV2FieldCommon", name: "Notes", dataType: "TEXT" },
          null,
        ] } },
      } });
    }, () => ext.runCommand({ command: "github project fields", args: ["acme/5"], global: { json: false } })));
    assert.match(fields.stderr.join("\n"), /Status field: \(none/);

    const validated = await captureStderr(() => withMockGithub((_req, res) => {
      jsonResponse(res, 404, { message: "missing" });
    }, async () => {
      await assert.rejects(
        ext.runCommand({ command: "github validate", args: ["acme/missing"], global: { json: false } }),
        /check failed/,
      );
    }));
    assert.match(validated.stderr.join("\n"), /check failed/);

  });
});

test("project import dry-run counts an update and apply fails closed when every create fails", async () => {
  const ext = await harnessPromise;
  const root = gitTracker("pm-github-project-import-");
  try {
    const tag = projectItemTag({ owner: "acme", number: 5 }, "PVTI_known");
    const created = spawnSync(REAL_PM, ["--path", root, "create", "task", "Linked board item", "--tags", tag], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      const preview = await captureStderr(() => withMockGithub((_req, res) => {
        jsonResponse(res, 200, { data: {
          user: { projectV2: { id: "PVT", title: "Board", url: "https://example.test/board", statusField: { id: "F", name: "Status", options: [{ id: "o", name: "Todo" }] } } },
          organization: null,
          node: { items: { pageInfo: { hasNextPage: false }, nodes: [
            { id: "PVTI_known", content: { __typename: "DraftIssue", title: "Linked", body: "b" } },
            { id: "PVTI_pr", content: { __typename: "PullRequest", title: "PR", number: 4, url: "https://example.test/pr/4", state: "OPEN", repository: { nameWithOwner: "acme/widgets" } } },
            { id: "PVTI_redacted", content: null },
          ] } },
        } });
      }, () => ext.runCommand({
        command: "github project import",
        args: ["acme/5"],
        options: { "dry-run": true },
        pmRoot: root,
        global: { json: false },
      })));
      assert.match(preview.stderr.join("\n"), /dry-run/);

      await withMockGithub((_req, res) => {
        jsonResponse(res, 200, { data: {
          user: { projectV2: { id: "PVT", title: "Board", url: "https://example.test/board", statusField: null } },
          organization: null,
          node: { items: { pageInfo: { hasNextPage: false }, nodes: [
            { id: "PVTI_new", content: { __typename: "DraftIssue", title: "New", body: "b" } },
          ] } },
        } });
      }, async () => {
        await withFakePm(`for arg in "$@"; do if [ "$arg" = "create" ]; then echo create-refused >&2; exit 1; fi; done
exec "$REAL_PM" "$@"`, async () => {
          await assert.rejects(ext.runCommand({
            command: "github project import",
            args: ["acme/5"],
            pmRoot: root,
            global: { json: true },
          }), /Imported 0 project item/);
        });
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync reports a non-retryable PATCH failure and the after-command hook names the upstream repo", async () => {
  const ext = await harnessPromise;
  const root = gitTracker("pm-github-sync-hook-");
  try {
    const created = spawnSync(REAL_PM, ["--path", root, "create", "task", "Linked", "--status", "closed", "--tags", "gh:acme/widgets#5"], { encoding: "utf8" });
    if (created.status !== 0) {
      const open = spawnSync(REAL_PM, ["--path", root, "create", "task", "Linked", "--tags", "gh:acme/widgets#5"], { encoding: "utf8" });
      assert.equal(open.status, 0, open.stderr);
      const listed = spawnSync(REAL_PM, ["--pm-path", root, "--json", "list", "--full"], { encoding: "utf8" });
      const id = (JSON.parse(listed.stdout) as { items?: Array<{ id: string }> }).items?.[0]?.id;
      assert.ok(id);
      assert.equal(spawnSync(REAL_PM, ["--path", root, "close", id, "--reason", "fixture closed"], { encoding: "utf8" }).status, 0);
    }
    await withEnv({ GITHUB_TOKEN: "tok", GH_TOKEN: undefined }, async () => {
      const patched = await captureStderr(() => withMockGithub((req, res) => {
        if (req.method === "PATCH") jsonResponse(res, 422, { message: "no" });
        else jsonResponse(res, 200, { state: "open", title: "Linked", number: 5 });
      }, () => ext.runCommand({
        command: "github sync",
        options: { repo: "acme/widgets" },
        pmRoot: root,
        global: { json: false },
      })));
      assert.match(patched.stderr.join("\n"), /PATCH failed/);
    });

    await withFakePm(`
      case "$FAKE_PM_MODE" in
        fail) exit 1 ;;
        badjson) printf '%s\n' 'not-json'; exit 0 ;;
        missingtags) printf '%s\n' '{}'; exit 0 ;;
        notag) printf '%s\n' '{"tags":["local"]}'; exit 0 ;;
        *) printf '%s\n' '{"tags":["gh:acme/widgets#5"]}'; exit 0 ;;
      esac
    `, async () => {
      await withEnv({ PM_GITHUB_SYNC: "1" }, async () => {
        const nudged = await captureStderr(() => ext.runHook({
          kind: "after_command",
          context: { command: "close", args: ["pm-linked"], pm_root: root, ok: true },
        }));
        assert.match(nudged.stderr.join("\n"), /pm github sync --repo acme\/widgets/);
        process.env.FAKE_PM_MODE = "fail";
        const silent = await captureStderr(() => ext.runHook({
          kind: "after_command",
          context: { command: "close", args: ["pm-linked"], pm_root: root, ok: true },
        }));
        assert.equal(silent.stderr.join("\n"), "");
        process.env.FAKE_PM_MODE = "badjson";
        await ext.runHook({ kind: "after_command", context: { command: "update", args: ["pm-linked"], pm_root: root, ok: true } });
        process.env.FAKE_PM_MODE = "notag";
        await ext.runHook({ kind: "after_command", context: { command: "close", args: ["pm-linked"], pm_root: root, ok: true } });
        process.env.FAKE_PM_MODE = "missingtags";
        const missingTags = await captureStderr(() => ext.runHook({ kind: "after_command", context: { command: "close", args: ["pm-linked"], pm_root: root, ok: true } }));
        assert.equal(missingTags.stderr.join("\n"), "");
        delete process.env.FAKE_PM_MODE;
        await ext.runHook({ kind: "after_command", context: { command: "list", args: ["pm-linked"], pm_root: root, ok: true } });
        await ext.runHook({ kind: "after_command", context: { command: "close", args: [], pm_root: root, ok: true } });
        await ext.runHook({ kind: "after_command", context: { command: "close", args: ["pm-linked"], pm_root: "", ok: true } });
        await ext.runHook({ kind: "after_command", context: { command: "close", args: ["pm-linked"], pm_root: root, ok: false } });
      });
      delete process.env.PM_GITHUB_SYNC;
      await ext.runHook({ kind: "after_command", context: { command: "close", args: ["pm-linked"], pm_root: root, ok: true } });
    });
  } finally {
    delete process.env.FAKE_PM_MODE;
    delete process.env.PM_GITHUB_SYNC;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plain imports preserve assigned metadata and synchronize existing annotations", async () => {
  const root = gitTracker("pm-github-metadata-");
  const tracker = path.join(root, ".agents/pm");
  try {
    const common = { resolveToken: () => undefined, fetchIssues: async () => [issue({ assignee: { login: "fixture" }, milestone: { title: "Sprint" }, comments: 1 })],
      fetchIssueComments: async () => [{ id: 11, body: "public note", user: null, created_at: "" }] };
    const first = await captureStderr(() => runImport("acme/widgets", tracker, opts({ "comments-mode": "annotations" }), common));
    assert.ok("imported" in first.result && first.result.imported === 1);
    const second = await captureStderr(() => runImport("acme/widgets", tracker, opts({ "comments-mode": "annotations" }), common));
    assert.ok("updated" in second.result && second.result.updated === 1);
    const items = JSON.parse(spawnSync(REAL_PM, ["--path", tracker, "list", "--json", "--full"], { encoding: "utf8" }).stdout) as { items: Array<{ assignee: string; sprint: string; comments: Array<{ text: string }> }> };
    assert.equal(items.items[0]?.assignee, "fixture");
    assert.equal(items.items[0]?.sprint, "Sprint");
    assert.equal(items.items[0]?.comments.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("plain create close failures and unreadable annotation identities report incomplete imports", async () => {
  const root = gitTracker("pm-github-create-boundary-");
  const tracker = path.join(root, ".agents/pm");
  try {
    await withFakePm(`for arg in "$@"; do if [ "$arg" = "close" ]; then echo close-refused >&2; exit 1; fi; done\nexec "$REAL_PM" "$@"`, async () => {
      const { stderr } = await captureStderr(() => assert.rejects(runImport("acme/widgets", tracker, opts(), {
        resolveToken: () => undefined, fetchIssues: async () => [issue({ state: "closed", closed_at: null })],
      }), /Imported 0 issue/));
      assert.match(stderr.join("\n"), /close after import failed/);
    });
    await withFakePm(`for arg in "$@"; do if [ "$arg" = "create" ]; then printf 'not-json'; exit 0; fi; done\nexec "$REAL_PM" "$@"`, async () => {
      const { stderr, result } = await captureStderr(() => runImport("acme/widgets", tracker, opts({ "comments-mode": "annotations" }), {
        resolveToken: () => undefined, fetchIssues: async () => [issue({ number: 2 })], fetchIssueComments: async () => [],
      }));
      assert.ok("imported" in result && result.imported === 1);
      assert.match(stderr.join("\n"), /comments not synced/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("gated comment failures stop before mutation and recovered receipts permit omitted item count", async () => {
  const root = gitTracker("pm-github-gated-comments-");
  const tracker = path.join(root, ".agents/pm");
  try {
    await assert.rejects(runImport("acme/widgets", tracker, opts({ gate: true, atomic: true, "with-comments": true }), {
      resolveToken: () => undefined, fetchIssues: async () => [issue()], fetchIssueComments: async () => { throw new Error("comments unavailable"); },
    }), /comments for issue #7 could not be read/);
    assert.deepEqual(fs.readdirSync(path.join(tracker, "issues")).filter(name => name.endsWith(".toon")), []);
    const recovered = await captureStderr(() => runImport("acme/widgets", tracker, opts({ atomic: true }), {
      resolveToken: () => undefined, fetchIssues: async () => [issue()],
      commitAtomic: async (root, repo, entries) => {
        await importGithubAtomic(root, repo, entries);
        const receipt = await importGithubAtomic(root, repo, entries);
        const { recoveredItems: _count, ...legacy } = receipt;
        return legacy;
      },
    }));
    assert.match(recovered.stderr.join("\n"), /covering 1 item/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Projects import fails closed at each local mutation boundary", async () => {
  const root = gitTracker("pm-project-import-boundaries-");
  try {
    const created = spawnSync(REAL_PM, ["--path", root, "create", "task", "Linked", "--tags", projectItemTag({ owner: "acme", number: 5 }, "linked")], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    for (const fixture of [
      { id: "linked", fail: "update", invalidId: false, diagnostic: /update failed/ },
      { id: "linked", fail: "close", invalidId: false, diagnostic: /close failed/ },
      { id: "new", fail: "create", invalidId: true, diagnostic: /could not read created item id/ },
      { id: "new", fail: "close", invalidId: false, diagnostic: /close failed/ },
    ]) {
      await withEnv({ GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined }, () => withMockGithub((_req, res, body) => {
        const query = (JSON.parse(body) as { query: string }).query;
        jsonResponse(res, 200, { data: query.includes("projectV2(number:") ? { user: { projectV2: {
          id: "board", title: "Board", statusField: { id: "status", name: "Status", options: [{ id: "done", name: "Done" }] },
        } } } : { node: { items: { nodes: [{ id: fixture.id, fieldValueByName: { name: "Done", optionId: "done" }, content: { __typename: "DraftIssue", title: "Closed candidate" } }], pageInfo: {} } } } });
      }, () => withFakePm(`for arg in "$@"; do
if [ "$arg" = "${fixture.fail}" ]; then
${fixture.invalidId ? "printf 'invalid-json'; exit 0" : "echo mutation-refused >&2; exit 1"}
fi
done
exec "$REAL_PM" "$@"`, async () => {
        const { stderr } = await captureStderr(() => assert.rejects((harnessPromise.then(ext => ext.runCommand({ command: "github project import", args: ["acme/5"], pmRoot: root }))), /Imported 0 project item/));
        assert.match(stderr.join("\n"), fixture.diagnostic);
      })));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Gated import pipeline: plan completeness + provenance idempotency verified
// BEFORE any mutation, the fail-closed tracker privacy gate AFTER it, and the
// full workflow sequence replayed on a REAL Git repository with a bare remote —
// the adversarial cases prove a malicious issue body, comment, email, or host
// path fails the gated import step so nothing is ever committed or pushed to
// the remote. The positive case proves the whole sequence: plan → gated import
// → caller changelog → final gate → strict health → commit/push → CI dispatch
// → a second gated run that is a no-op for item
// identity via the provenance tag.
//
// Malicious fixtures are syntactically valid but FAKE and assembled from parts
// at run time, so no tracked blob holds a complete credential or host path.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  CommandError,
  parseImportOptions,
  runImport,
  verifyImportPlanCompleteness,
  verifyImportIdempotency,
  verifyImportedProvenance,
  type GhComment,
  type GhIssue,
  type ImportGateReceipt,
  type PmItem,
  type PreparedGithubImport,
} from "../index.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { jsonResponse, withMockGithub, type MockGithubHandler } from "./helpers/mock-github-server.ts";

const MANIFEST_CAPABILITIES = ["commands", "importers", "schema", "hooks", "preflight", "search"] as const;
const harnessPromise: Promise<ExtensionTestHarness> =
  createExtensionTestHarness(extension, { capabilities: [...MANIFEST_CAPABILITIES] });

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
// Real scratch trackers must not inherit unrelated globally installed extensions.
const fixtureGlobalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-gate-global-"));
test.after(() => fs.rmSync(fixtureGlobalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32",
  env: { ...process.env, PM_GLOBAL_PATH: fixtureGlobalRoot, PM_TELEMETRY_INLINE_FLUSH: "1" } };
const SYNC_BRANCH = "automation/pm-github-sync";

// --- Fake-but-well-formed malicious fixtures, assembled from parts.
const GH_TOKEN = "ghp_" + "A".repeat(36);
const PERSONAL_EMAIL = "alice.person@example.org";
const HOME_PATH = "/" + "home" + "/alice/report.txt";
const HIGH_ENTROPY_SECRET = "Zj9kP2mQ7xW4" + "nB8vC5tR1sD";

/**
 * Build one GitHub issue REST payload for the mock server.
 *
 * @param number - The issue number.
 * @param title - The issue title.
 * @param body - The issue body (may carry a malicious fixture).
 * @returns A REST-shaped issue object.
 */
function issue(number: number, title: string, body: string | null): GhIssue {
  return {
    number,
    title,
    body,
    state: "open",
    labels: [],
    assignee: null,
    milestone: null,
    user: { login: "octocat" },
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    comments: body === null ? 0 : 1,
  };
}

/**
 * Build one plan entry for the pure verification functions.
 *
 * Only the fields the verifiers read (issue number, tags, match) vary; the rest
 * are the same inert defaults every prepared entry carries.
 *
 * @param issueNumber - The issue the entry plans.
 * @param tags - The provenance/label tags the entry would write.
 * @param match - The existing item it would update, when linked.
 * @returns A prepared plan entry.
 */
function planEntry(issueNumber: number, tags: string[], match?: PmItem): PreparedGithubImport {
  return {
    issueNumber,
    title: `Title ${issueNumber}`,
    itemType: "Issue",
    status: "open",
    description: "d",
    body: "b",
    tags,
    comments: [],
    syncAnnotations: false,
    match,
  };
}

test("recovered journals cannot substitute for a complete persisted provenance corpus", () => {
  const prepared = [planEntry(1, ["gh:acme/widgets#1"])];
  assert.throws(() => verifyImportedProvenance([], prepared, "acme/widgets"), CommandError);
  assert.equal(verifyImportedProvenance([{ id: "item-a", tags: ["gh:acme/widgets#1"] }], prepared, "acme/widgets"), 1);
  assert.throws(() => verifyImportedProvenance([
    { id: "item-a", tags: ["gh:acme/widgets#1"] }, { id: "item-b", tags: ["gh:acme/widgets#1"] },
  ], prepared, "acme/widgets"), CommandError);
});

test("gated comment imports scan persisted values without importing REST user metadata", async () => {
  const { root, base } = initSyncRepo();
  try {
    const comment = { id: 101, body: "Public comment", created_at: "2026-10-02T00:00:00Z",
      user: { login: "octocat", events_url: "https://api.github.com/users/octocat/events{/privacy}" } };
    await withMockGithub(githubHandler([issue(1, "Public issue", "Public body")], new Map([[1, [comment]]])), async () => {
      const result = await runGatedImport(root, { atomic: true, gate: true, "with-comments": true, "comments-mode": "both" });
      assert.equal(result.imported, 1);
      assert.equal((result.gate as ImportGateReceipt).verdict, "pass");
      const tracker = path.join(root, ".agents/pm");
      const item = fs.readdirSync(path.join(tracker, "issues")).find(file => file.endsWith(".toon"));
      assert.ok(item);
      const text = fs.readFileSync(path.join(tracker, "issues", item), "utf8");
      assert.ok(text.includes("Public comment"));
      assert.ok(!text.includes("events_url"));
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a real completed SDK journal with reset item files cannot authorize a push", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    await withMockGithub(githubHandler([issue(1, "Synthetic issue", "Public body")]), async () => {
      await runGatedImport(root, { atomic: true, gate: true });
      assert.equal(git(["add", ".agents/pm"]).status, 0);
      assert.equal(git(["reset", "--hard", "HEAD"]).status, 0);
      await assert.rejects(runGatedImport(root, { atomic: true, gate: true }), /committed journal.*nothing may be pushed/);
      assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/**
 * Build the mock GitHub handler serving one issues page plus per-issue comments.
 *
 * Comments are served for every issue so the `--with-comments` paths can embed
 * adversarial comment fixtures exactly as the real REST API would deliver them.
 *
 * @param issues - The issues the "repository" holds.
 * @param commentsByNumber - Comment fixtures keyed by issue number.
 * @returns The request handler.
 */
function githubHandler(
  issues: readonly GhIssue[],
  commentsByNumber: ReadonlyMap<number, readonly GhComment[]> = new Map(),
): MockGithubHandler {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/graphql") {
      jsonResponse(res, 200, { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
      return;
    }
    if (/\/issues\/\d+\/timeline$/.test(url.pathname)) {
      jsonResponse(res, 200, []);
      return;
    }
    const commentsMatch = /\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentsMatch) {
      jsonResponse(res, 200, commentsByNumber.get(Number(commentsMatch[1])) ?? []);
      return;
    }
    jsonResponse(res, 200, issues);
  };
}

/**
 * Create a REAL Git worktree with a pm tracker and a bare remote.
 *
 * The worktree is committed and pushed to the bare remote exactly like a fleet
 * checkout, so the adversarial cases can assert the remote's ref list never
 * gains the sync branch when the gate fails, and the positive case can push a
 * real commit to it.
 *
 * @returns The worktree root, the bare remote path, and a git helper bound to the worktree.
 */
function initSyncRepo(): { root: string; bare: string; base: string; git: (args: readonly string[]) => { stdout: string; status: number | null } } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-import-gate-"));
  const bare = path.join(base, "remote.git");
  const root = path.join(base, "work");
  fs.mkdirSync(root, { recursive: true });
  const git = (args: readonly string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });

  assert.strictEqual(spawnSync("git", ["init", "--bare", "-b", "main", bare]).status, 0, "git init --bare failed");
  assert.strictEqual(git(["init", "-b", "main"]).status, 0, "git init failed");
  // Inside a Git work tree the tracker lives at the repository-local path,
  // exactly like a fleet checkout.
  const init = spawnSync(PM_BIN, ["--path", path.join(root, ".agents", "pm"), "init", "test"], PM_SPAWN_OPTS);
  assert.strictEqual(init.status, 0, `pm init failed: ${init.error?.message ?? init.stderr}`);
  assert.strictEqual(git(["config", "user.name", "Sync Fixture"]).status, 0);
  assert.strictEqual(git(["config", "user.email", "fixture@example.invalid"]).status, 0);
  assert.strictEqual(git(["add", ".agents/pm"]).status, 0);
  // The init also writes the repo-root .gitattributes/.gitignore pair; they
  // join the baseline so the gated dry-run can assert a pristine tree.
  assert.strictEqual(git(["add", ".gitattributes", ".gitignore"]).status, 0);
  assert.strictEqual(git(["commit", "-m", "baseline tracker"]).status, 0, "baseline commit failed");
  assert.strictEqual(git(["remote", "add", "origin", bare]).status, 0);
  assert.strictEqual(git(["push", "-u", "origin", "main"]).status, 0, "baseline push failed");
  return { root, bare, base, git };
}

/** List the refs the bare remote currently holds. */
function remoteRefs(bare: string): string[] {
  const result = spawnSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname)"], { encoding: "utf-8" });
  assert.strictEqual(result.status, 0, "for-each-ref failed");
  return result.stdout.trim().split("\n").filter(Boolean);
}

/** Run the registered gated importer through pm's real dispatch engine. */
async function runGatedImport(
  pmRoot: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ext = await harnessPromise;
  const result = await ext.runImporter({
    importer: "github",
    args: ["acme/widgets"],
    options,
    pmRoot,
  });
  assert.strictEqual(result.handled, true);
  return result.result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plan verification — completeness and provenance idempotency, fail-closed
// ---------------------------------------------------------------------------

test("parseImportOptions reads the gate flag without changing defaults", () => {
  assert.strictEqual(parseImportOptions({}).gate, false);
  assert.strictEqual(parseImportOptions({ gate: true }).gate, true);
  assert.strictEqual(parseImportOptions({ gate: "1" }).gate, true);
});

test("gated previews redact issue titles and labels in both import modes", async () => {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...values: unknown[]) => { messages.push(values.join(" ")); };
  try {
    for (const atomic of [false, true]) {
      const malicious = { ...issue(1, GH_TOKEN, "Public body"), labels: [{ name: GH_TOKEN }] };
      const result = await runImport("acme/widgets", "unused-preview", parseImportOptions({ gate: true, dryRun: true, atomic }), {
        resolveToken: () => undefined, fetchIssues: async () => [malicious], readItems: () => [],
      });
      assert.ok("wouldImport" in result);
      assert.equal(result.wouldImport, 1);
    }
    assert.ok(messages.some(message => message.includes("(gated title)")));
    assert.ok(!messages.join("\n").includes(GH_TOKEN));
  } finally {
    console.error = original;
  }
});

test("verifyImportPlanCompleteness passes a reconciling plan and fails every drift", () => {
  const issues = [issue(1, "One", "b1"), issue(2, "Two", "b2"), issue(3, "Blank", "   ")];

  // Reconciling plan: two prepared entries plus one explicit skip.
  const prepared = [planEntry(1, ["gh:acme/widgets#1"]), planEntry(2, ["gh:acme/widgets#2"])];
  const receipts = verifyImportPlanCompleteness(issues, prepared, [3]);
  assert.deepStrictEqual(receipts, { fetched: 3, planned: 2, skipped: 1 });

  // An unaccounted issue (fetch delivered it, the plan lost it).
  assert.throws(
    () => verifyImportPlanCompleteness(issues, prepared, []),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /import plan is incomplete/);
      assert.match(err.message, /unaccounted \[3\]/);
      return true;
    },
  );

  // An entry planned outside the fetched set.
  assert.throws(
    () =>
      verifyImportPlanCompleteness(
        [issue(1, "One", "b1")],
        [planEntry(7, ["gh:acme/widgets#7"])],
        [],
      ),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /out-of-plan \[7\]/);
      return true;
    },
  );

  // The same issue planned twice.
  assert.throws(
    () =>
      verifyImportPlanCompleteness(
        [issue(1, "One", "b1")],
        [planEntry(1, ["gh:acme/widgets#1"]), planEntry(1, ["gh:acme/widgets#1"])],
        [],
      ),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /duplicates 1/);
      return true;
    },
  );
});

test("verifyImportIdempotency fails duplicate provenance, untagged creates, and conflicting targets", () => {
  const existing = [
    { id: "item-a", tags: ["gh:acme/widgets#1"] },
    { id: "item-b", tags: ["gh:acme/widgets#1"] }, // duplicate provenance
  ];
  assert.throws(
    () =>
      verifyImportIdempotency(existing, [planEntry(2, ["gh:acme/widgets#2"])], "acme/widgets"),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /1 duplicate provenance tag\(s\)/);
      return true;
    },
  );

  // A new entry that would be born without its provenance tag.
  assert.throws(
    () =>
      verifyImportIdempotency([], [planEntry(2, [])], "acme/widgets"),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /without a provenance tag/);
      return true;
    },
  );

  // Two plan entries resolving to the same existing item.
  assert.throws(
    () =>
      verifyImportIdempotency(
        [{ id: "item-a", tags: ["gh:acme/widgets#1"] }],
        [
          planEntry(1, ["gh:acme/widgets#1"], { id: "item-a", tags: ["gh:acme/widgets#1"] }),
          planEntry(2, ["gh:acme/widgets#2"], { id: "item-a", tags: ["gh:acme/widgets#1"] }),
        ],
        "acme/widgets",
      ),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /1 conflicting target/);
      return true;
    },
  );

  // A clean plan is proven a no-op: every entry matched by provenance or born tagged.
  const receipts = verifyImportIdempotency(
    [{ id: "item-a", tags: ["gh:acme/widgets#1"] }],
    [
      planEntry(1, ["gh:acme/widgets#1"], { id: "item-a", tags: ["gh:acme/widgets#1"] }),
      planEntry(2, ["gh:acme/widgets#2"]),
    ],
    "acme/widgets",
  );
  assert.deepStrictEqual(receipts, { provenance_indexed: 1, matched_by_provenance: 1, new_entries: 1 });
});

test("a gated import refuses to write when the corpus cannot yield an idempotent plan", async () => {
  const issues = [issue(1, "One", "b1"), issue(2, "Two", "b2")];
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));
  try {
    await assert.rejects(
      runImport("acme/widgets", "/unused-gated-workspace", parseImportOptions({ gate: true, dryRun: true }), {
        resolveToken: () => undefined,
        fetchIssues: async () => issues,
        readItems: () => [
          { id: "dup-a", tags: ["gh:acme/widgets#1"] },
          { id: "dup-b", tags: ["gh:acme/widgets#1"] },
        ],
      }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /import plan is not idempotent/);
        return true;
      },
    );
    assert.ok(
      !messages.some((message) => /pm github gate: plan verified/.test(message)),
      "the idempotency refusal happens before the plan is reported as verified",
    );
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// Adversarial full-sequence — malicious fixtures can never reach the remote
// ---------------------------------------------------------------------------

test("adversarial: token in a body, token in a comment, email, and host path prevent any push", async () => {
  const { root, bare, base, git } = initSyncRepo();
  try {
    const malicious = [
      issue(1, "Leaked token in body", `CI config: use ${GH_TOKEN} for deploys`),
      issue(2, "Leaked token in comment", "clean body"),
      issue(3, "Personal email in body", `contact ${PERSONAL_EMAIL} for the fix`),
      issue(4, "Host path in body", `crash log at ${HOME_PATH}`),
    ];
    const comments = new Map<number, GhComment[]>([
      [2, [{ id: 101, user: { login: "mallory" }, created_at: "2026-10-02T00:00:00Z", body: `psst: ${GH_TOKEN}` }]],
    ]);

    await withMockGithub(githubHandler(malicious, comments), async () => {
      const ext = await harnessPromise;

      // Workflow step: dry-run plan (no gate failures yet — nothing is written).
      const plan = await ext.runImporter({
        importer: "github",
        args: ["acme/widgets"],
        options: { atomic: true, dryRun: true, "with-comments": true },
        pmRoot: root,
      });
      const planResult = plan.result as Record<string, unknown>;
      assert.strictEqual(planResult.dryRun, true);
      assert.strictEqual(planResult.wouldImport, 4);

      // Workflow step: the gated import. It verifies the plan, writes, scans the
      // proposed tracker change, and MUST exit non-zero on the findings.
      await assert.rejects(
        ext.runImporter({
          importer: "github",
          args: ["acme/widgets"],
          options: { atomic: true, gate: true, "with-comments": true },
          pmRoot: root,
        }),
        (err: unknown) => {
          assert.strictEqual((err as { exitCode?: number }).exitCode, 1);
          const message = (err as Error).message;
          assert.match(message, /FAIL/);
          assert.match(message, /github-token-classic/);
          assert.match(message, /email-address/);
          assert.match(message, /absolute-host-path/);
          assert.ok(!message.includes(GH_TOKEN), "the failure must never echo the token");
          assert.ok(!message.includes(PERSONAL_EMAIL), "the failure must never echo the email");
          return true;
        },
      );

      // The workflow stops here: no commit, no push, and the bare remote still
      // holds exactly the baseline ref it started with.
      assert.deepStrictEqual(remoteRefs(bare), ["refs/heads/main"]);

      // In-memory preflight rejects the import before sensitive values reach
      // disk. The post-write gate remains a separate protection for formatting.
      const clean = await ext.runCommand({ command: "github gate", global: { json: true }, pmRoot: root });
      assert.equal((clean.result as { verdict: string }).verdict, "pass");

    });
    assert.strictEqual(git(["status", "--porcelain", "--", ".agents/pm"]).stdout.trim(), "");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("adversarial: a high-entropy secret assignment in a body fails the gate", async () => {
  const { root, bare, base } = initSyncRepo();
  try {
    await withMockGithub(githubHandler([issue(9, "Hardcoded secret", `deploy_token: "${HIGH_ENTROPY_SECRET}"`)]), async () => {
      const ext = await harnessPromise;
      await assert.rejects(
        ext.runImporter({
          importer: "github",
          args: ["acme/widgets"],
          options: { atomic: true, gate: true },
          pmRoot: root,
        }),
        (err: unknown) => {
          assert.match((err as Error).message, /high-entropy-assignment/);
          return true;
        },
      );
      assert.deepStrictEqual(remoteRefs(bare), ["refs/heads/main"]);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Positive full-sequence — clean import passes the gate, pushes to the remote,
// and a second gated run is a provenance-keyed no-op
// ---------------------------------------------------------------------------

test("clean flow: gated import passes, health stays strict, the push reaches the remote, and a second run is a no-op", async () => {
  const { root, bare, base, git } = initSyncRepo();
  try {
    const clean = [issue(1, "Feature one", "needs a flag"), issue(2, "Bug two", "crashes on start")];
    await withMockGithub(githubHandler(clean), async () => {
      const ext = await harnessPromise;

      // Gated import: plan checks pass, the write lands, the gate scans and passes.
      const first = await runGatedImport(root, { atomic: true, gate: true });
      assert.strictEqual(first.imported, 2);
      assert.strictEqual(first.updated, 0);
      const receipt = first.gate as ImportGateReceipt;
      assert.strictEqual(receipt.verdict, "pass");
      assert.strictEqual(receipt.findings, 0);
      assert.ok(receipt.scanned_files >= 2, "the new items and their history were scanned");

      // Workflow step: strict health over the freshly imported tracker.
      const health = spawnSync(PM_BIN, ["--path", root, "health", "--strict-exit"], PM_SPAWN_OPTS);
      assert.strictEqual(health.status, 0, `strict health failed: ${health.stdout} ${health.stderr}`);

      // Workflow step: commit the gated change and push the sync branch.
      assert.strictEqual(git(["add", ".agents/pm"]).status, 0);
      const staged = git(["diff", "--cached", "--name-only", "--", ".agents/pm"]).stdout.trim().split("\n").filter(Boolean);
      const toonFiles = staged.filter((changed) => changed.endsWith(".toon"));
      assert.strictEqual(toonFiles.length, 2, "one staged .toon per imported issue");
      assert.strictEqual(git(["commit", "-m", "chore(pm): sync GitHub issues (gated)"]).status, 0);
      assert.strictEqual(git(["push", "--force", "origin", `main:refs/heads/${SYNC_BRANCH}`]).status, 0);
      assert.ok(
        remoteRefs(bare).includes(`refs/heads/${SYNC_BRANCH}`),
        "the clean gated change reaches the remote",
      );

      // The identical plan resumes its completed journal without new writes.
      // Recovered counts describe the durable batch, rather than new updates.
      const second = await runGatedImport(root, { atomic: true, gate: true });
      assert.strictEqual(second.imported, 0);
      assert.strictEqual(second.updated, 0);
      assert.strictEqual(second.recovered, true);
      assert.strictEqual(second.recoveredItems, 2);
      assert.strictEqual(second.transactionId, first.transactionId);
      assert.strictEqual(git(["diff", "--name-only", "--", ".agents/pm"]).stdout.trim(), "");
      assert.strictEqual((second.gate as ImportGateReceipt).verdict, "pass");

      const list = spawnSync(
        PM_BIN,
        ["--pm-path", root, "--output-include", "full", "--output-limit", "unbounded", "--output-budget", "unbounded", "list", "--all", "--json"],
        PM_SPAWN_OPTS,
      );
      assert.strictEqual(list.status, 0, "pm list --all failed after the second run");
      const parsed = JSON.parse(list.stdout) as { items?: Array<{ id: string; tags?: string[] }> };
      assert.strictEqual(parsed.items?.length, 2, "no item was duplicated by the re-import");
      const provenance = parsed.items!.flatMap((item) => item.tags ?? []).filter((tag) => tag.startsWith("gh:acme/widgets#"));
      assert.deepStrictEqual([...provenance].sort(), ["gh:acme/widgets#1", "gh:acme/widgets#2"]);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("gated dry-run embeds the verified plan receipts and writes nothing", async () => {
  const { root, base, git } = initSyncRepo();
  try {
    await withMockGithub(githubHandler([issue(1, "Feature one", "needs a flag")]), async () => {
      const preview = await runGatedImport(root, { atomic: true, gate: true, dryRun: true });
      assert.strictEqual(preview.dryRun, true);
      assert.strictEqual(preview.wouldImport, 1);
      const gate = preview.gate as Record<string, unknown>;
      assert.deepStrictEqual(gate.completeness, { fetched: 1, planned: 1, skipped: 0 });
      assert.deepStrictEqual(gate.idempotency, { provenance_indexed: 0, matched_by_provenance: 0, new_entries: 1 });
      assert.strictEqual(gate.scan, "post-write");
      // Nothing was written: the working tree still matches the baseline commit.
      assert.strictEqual(git(["status", "--porcelain"]).stdout.trim(), "");
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The reusable workflow contract — the file a fleet repo actually calls
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowPath = path.join(repoRoot, ".github", "workflows", "pm-github-sync.yml");
const workflow = fs.readFileSync(workflowPath, "utf-8");
const callerExample = fs.readFileSync(path.join(repoRoot, "docs", "sync-workflow-caller.yml"), "utf-8");

/** Offset of one named step within the workflow source, for ordering assertions. */
function stepOffset(name: string): number {
  const match = new RegExp(`^\\s*- name: ${name.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")}$`, "m").exec(workflow);
  assert.ok(match, `workflow should contain the step "${name}"`);
  return match.index;
}

test("the reusable sync workflow is a workflow_call with an optional legacy version input", () => {
  assert.match(workflow, /^on:\n  workflow_call:/m);
  assert.match(workflow, /pm-github-version:\n\s+description:[^\n]+\n\s+type: string\n\s+required: false/);
  assert.match(workflow, /repository:\n\s+description:/);
  assert.match(workflow, /post-import-script:[\s\S]*?default: "changelog:full"/);
  assert.match(workflow, /ci-workflows:[\s\S]*?default: "ci.yml"/);
  assert.doesNotMatch(workflow, /^on:\n  schedule:/m, "the schedule stays with the caller");
  // Job permissions cover issue reads, branch pushes, review PR writes and dispatch.
  const permissions = /^    permissions:\n      contents: write\n      pull-requests: write\n      issues: read\n      actions: write\n/m;
  assert.match(workflow, permissions);
  assert.ok(
    (workflow.match(/^    permissions:/gm) ?? []).length === 1,
    "no second, broader permission block",
  );
});

test("the caller default branch guard is first and preserves the remaining step order", () => {
  const steps = workflow.split(/\n      - name: /).slice(1);
  assert.deepEqual(steps.map(step => step.split("\n")[0]), [
    "Require caller default branch", "Resolve pm-github release version", "Validate sync inputs", "Checkout caller default branch",
    "Validate npm project directory", "Setup Node.js", "Prepare sync branch from default branch",
    "Install dependencies", "Resolve sync commit scope", "Install pinned pm-github extension",
    "Configure PM merge drivers", "Verify gate is available", "Validate GitHub access",
    "Revalidate GitHub blockers (report only)", "Preview GitHub to pm plan",
    "Gated GitHub to pm import", "Verify repeat import is a no-op", "Run caller post-import script",
    "Gate tracker and regenerated changelog", "Verify strict pm health",
    "Commit gated sync changes and open review PR", "Dispatch caller CI and report parked runs",
  ]);
  assert.match(steps[0]!, /RUN_REF: \$\{\{ github.ref \}\}/);
  assert.match(steps[0]!, /EVENT_DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(steps[0]!, /shell: bash/);
  assert.doesNotMatch(steps[0]!, /\n        (?:if|continue-on-error):/);
  assert.doesNotMatch(workflowShell(["Require caller default branch"]), /\$\{\{|=~/);
  assert.match(callerExample, /Callers need no guard of their own/);
});

/** Bind realistic caller event metadata and inject only the external gh command. */
function guardEnvironment(base: string, payload: { repository?: { default_branch: string }; [key: string]: unknown },
  ref: string, apiBranch: string, apiStatus = 0): NodeJS.ProcessEnv {
  const eventPath = path.join(base, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8")) as typeof payload;
  // These assertions tie the simulated runner bindings to the actual step env.
  const guard = workflow.slice(stepOffset("Require caller default branch"), stepOffset("Validate sync inputs"));
  assert.match(guard, /RUN_REF: \$\{\{ github.ref \}\}/);
  assert.match(guard, /EVENT_DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(guard, /GH_TOKEN: \$\{\{ github.token \}\}/);
  const command = path.join(base, "gh");
  fs.writeFileSync(command, `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'api repos/acme/widgets --jq .default_branch // empty' ]] || exit 98
[[ "$GH_TOKEN" == synthetic-test-token ]] || exit 99
printf '%s' "$API_BRANCH"
exit "$API_STATUS"
`, { mode: 0o755 });
  return { ...process.env, RUN_REF: ref, EVENT_DEFAULT_BRANCH: event.repository?.default_branch ?? "",
    DEFAULT_BRANCH: "", GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "schedule" in event ? "schedule" : "workflow_dispatch",
    GITHUB_REPOSITORY: "acme/widgets", GH_TOKEN: "synthetic-test-token", PATH: base + path.delimiter + process.env.PATH,
    API_BRANCH: apiBranch, API_STATUS: String(apiStatus),
    GITHUB_OUTPUT: path.join(base, "guard-output"), GITHUB_ENV: path.join(base, "guard-env") };
}

test("the first workflow step refuses non-default refs with one diagnostic naming both refs", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-ref-"));
  try {
    for (const ref of ["refs/heads/feature/sync", "refs/tags/main", "refs/heads/main-extra", "refs/heads/$(printf injected)", ""]) {
      const env = guardEnvironment(base, { inputs: {}, ref, repository: { default_branch: "main" } }, ref, "main");
      const result = await executeWorkflow(workflowShell(["Require caller default branch"]), repoRoot, env);
      assert.equal(result.code, 1, `must refuse ${ref}`);
      assert.equal(result.stdout, `::error::Sync ref "${ref}" must match caller default branch ref "refs/heads/main".\n`);
      assert.equal(result.stderr, "");
      assert.ok(!fs.existsSync(env.GITHUB_OUTPUT!), "a refused ref cannot provide a checkout branch");
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the first workflow step accepts realistic schedule payloads without repository and dispatched payloads", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-events-"));
  try {
    for (const branch of ["main", "trunk", "release/stable"]) {
      for (const payload of [{ schedule: "17 2 * * *" }, { inputs: {}, ref: branch, repository: { default_branch: branch } }]) {
        const env = guardEnvironment(base, payload, `refs/heads/${branch}`, branch);
        for (const file of [env.GITHUB_OUTPUT!, env.GITHUB_ENV!]) fs.rmSync(file, { force: true });
        const result = await executeWorkflow(workflowShell(["Require caller default branch"]), repoRoot, env);
        assert.equal(result.code, 0, `${env.GITHUB_EVENT_NAME} on ${branch}: ${result.stdout + result.stderr}`);
        assert.equal(result.stdout + result.stderr, "");
        assert.equal(fs.readFileSync(env.GITHUB_OUTPUT!, "utf8"), `branch=${branch}\n`);
        assert.equal(fs.readFileSync(env.GITHUB_ENV!, "utf8"), `DEFAULT_BRANCH=${branch}\n`);
      }
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the first workflow step prefers the API, falls back to present payload metadata and fails closed", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-resolution-"));
  try {
    const payload = { inputs: {}, repository: { default_branch: "trunk" } };
    for (const [apiBranch, status, accepted] of [["trunk", 0, true], ["", 1, true], ["", 0, true], ["main", 0, false]] as const) {
      const env = guardEnvironment(base, payload, "refs/heads/trunk", apiBranch, status);
      const result = await executeWorkflow(workflowShell(["Require caller default branch"]), repoRoot, env);
      assert.equal(result.code, accepted ? 0 : 1, result.stdout + result.stderr);
    }
    for (const [apiBranch, status] of [["", 1], ["", 0], ["trunk\nINJECTED=value", 0], ["null", 1]] as const) {
      const env = guardEnvironment(base, { schedule: "17 2 * * *" }, "refs/heads/trunk", apiBranch, status);
      fs.rmSync(env.GITHUB_OUTPUT!, { force: true });
      const result = await executeWorkflow(workflowShell(["Require caller default branch"]), repoRoot, env);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, "::error::Cannot resolve a valid caller default branch from the repository API or event payload.\n");
      assert.ok(!fs.existsSync(env.GITHUB_OUTPUT!));
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("every action the workflow uses is pinned by commit SHA", () => {
  const uses = [...workflow.matchAll(/^\s*uses: ([^\s#]+)/gm)].map((match) => match[1]!);
  assert.ok(uses.length >= 2, "the workflow uses actions");
  for (const ref of uses) {
    assert.match(
      ref,
      /@([0-9a-f]{40})\s*$/,
      `action ${ref} must be pinned by SHA`,
    );
  }
});

test("the gated import runs after validate/plan and before health, commit, and push", () => {
  const validate = stepOffset("Validate GitHub access");
  const plan = stepOffset("Preview GitHub to pm plan");
  const gated = stepOffset("Gated GitHub to pm import");
  const health = stepOffset("Verify strict pm health");
  const commit = stepOffset("Commit gated sync changes and open review PR");
  const install = stepOffset("Install pinned pm-github extension");
  assert.ok(install < validate, "the pinned extension is installed before it is used");
  assert.ok(validate < plan && plan < gated, "validate and dry-run plan precede the gated import");
  const postImport = stepOffset("Run caller post-import script");
  const finalGate = stepOffset("Gate tracker and regenerated changelog");
  const dispatch = stepOffset("Dispatch caller CI and report parked runs");
  assert.ok(gated < postImport && postImport < finalGate && finalGate < health && health < commit && commit < dispatch,
    "post-import output is gated before health/publication and CI follows the PR");
  assert.match(workflow, /import "\$\{REPOSITORY\}" --state all --atomic --gate/);
  assert.match(workflow, /pm health --strict-exit/);
  // No staged catch-all that could commit unscanned content.
  assert.doesNotMatch(workflow, /git add -A/);
  assert.match(workflow, /git --literal-pathspecs add --pathspec-from-file=/);
});

test("the caller default branch drives checkout, reset, PR bases and permanent item links", () => {
  assert.match(
    workflow,
    /https:\/\/github\.com\/%s\/blob\/%s\/%s/,
    "the link template accepts the resolved default branch",
  );
  assert.match(workflow, /"\$\{PM_SYNC_TRACKER\}"\/\*\/\*\.toon/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /gh pr edit/);
  assert.doesNotMatch(workflow, /\bmain\b/, "no operation or documentation in the reusable workflow hard-codes main");
  assert.match(workflow, /ref: \$\{\{ steps.caller_branch.outputs.branch \}\}/);
  assert.match(workflowShell(["Prepare sync branch from default branch"]), /git switch --force-create "\$\{SYNC_BRANCH\}" "origin\/\$\{DEFAULT_BRANCH\}"/);
  assert.equal((workflow.match(/--base "\$\{DEFAULT_BRANCH\}"/g) ?? []).length, 2);
  // The push is explicit and force-resets only the automation branch.
  assert.match(workflow, /git push --force-with-lease=/);
});

test("the caller example pins the reusable workflow release", () => {
  assert.match(callerExample, /^on:\n  schedule:\n    - cron:/m, "the caller owns the schedule");
  assert.match(
    callerExample,
    /uses: unbraind\/pm-github\/\.github\/workflows\/pm-github-sync\.yml@RELEASE_COMMIT_SHA/,
  );
  assert.doesNotMatch(callerExample, /pm-github-version/);
  assert.match(callerExample, /npm-project-dir: "\."/);
  assert.match(callerExample, /npm-project-dir: tests\/oracle/);
  assert.match(callerExample, /^permissions:\n  contents: write\n  pull-requests: write\n/m);
  assert.match(callerExample, /^  actions: write/m);
  const lines = callerExample.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
  assert.ok(lines.length <= 40, "the caller stays a small, reviewable file");
});
/** Extract executable shell from the workflow so the real push ordering is tested. */
function workflowShell(names: readonly string[]): string {
  return names.map(name => {
    const start = stepOffset(name);
    const next = workflow.indexOf("\n      - name:", start + 1);
    const step = workflow.slice(start, next < 0 ? undefined : next);
    const block = /        run: \|\n([\s\S]*)/.exec(step);
    if (block) return block[1]!.split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
    const single = /        run: (.+)/.exec(step);
    assert.ok(single, `${name} needs executable shell`);
    return single[1]!;
  }).join("\n");
}

/** Run a real workflow shell while allowing the local mock HTTP server to respond. */
function executeWorkflow(shell: string, root: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", "set -euo pipefail\n" + shell], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    // Decode the streams, not each chunk, so a multibyte character split
    // across two chunks is not turned into replacement characters.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

/** Pack from the package tracker, even when npm runs prepare despite --ignore-scripts. */
function packWorkflowCandidate(packageRoot: string, destination: string, env: NodeJS.ProcessEnv): ReturnType<typeof executeWorkflow> {
  // npm 10's directory packer still invokes prepare with --ignore-scripts.
  // Its merge installer must use this checkout's tracker, not the caller fixture.
  // Keep any lifecycle stdout out of npm's JSON receipt on those versions.
  return executeWorkflow(`npm pack --ignore-scripts --foreground-scripts=false --json --pack-destination '${destination.replace(/'/g, "'\\''")}'`, packageRoot,
    { ...env, PM_PATH: path.join(packageRoot, ".agents", "pm") });
}

/** Install the candidate and create a local gh PR receipt boundary, never a network writer. */
async function prepareWorkflowFixture(root: string, base: string): Promise<NodeJS.ProcessEnv> {
  if (!fs.existsSync(path.join(root, "package.json"))) fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  // Match caller dependency/runtime ignores before installing the extension;
  // fixture setup itself must not masquerade as a post-import change.
  fs.appendFileSync(path.join(root, ".gitignore"), "\nnode_modules/\n.agents/pm/extensions/\n.agents/pm/locks/\n.agents/pm/checkpoints/\n");
  assert.equal(spawnSync("git", ["add", "--", "package.json", ".gitignore"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Sync Fixture", "-c", "user.email=fixture@users.noreply.github.com",
    "commit", "-qm", "caller dependency configuration"], { cwd: root }).status, 0);
  const bin = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules/.bin/pm"), path.join(bin, "pm"));
  fs.mkdirSync(path.join(root, "node_modules/@unbrained"), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, "node_modules/@unbrained/pm-cli"), path.join(root, "node_modules/@unbrained/pm-cli"));
  const tools = path.join(base, "tools");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "auth" && "$2" == "setup-git" ]]; then exit 0; fi
if [[ "$1" == "--version" ]]; then printf 'gh fixture\\n'; exit 0; fi
case "$1 $2" in
  "pr list")
    printf '%s\\n' "$*" >> "\${REVIEW_ACTIONS}.pr-args"
    entries=""
    if [[ -n "\${OWN_OPEN_PR:-}" ]]; then
      entries+="{\\"number\\":\${OWN_OPEN_PR},\\"headRepository\\":{\\"name\\":\\"\${REPOSITORY#*/}\\"},\\"headRepositoryOwner\\":{\\"login\\":\\"\${REPOSITORY%%/*}\\"},\\"isCrossRepository\\":false},"
    fi
    # A fork can open a PR from a branch with the same name as the sync branch.
    if [[ -n "\${FORK_OPEN_PR:-}" ]]; then
      entries+="{\\"number\\":\${FORK_OPEN_PR},\\"headRepository\\":{\\"name\\":\\"widgets-fork\\"},\\"headRepositoryOwner\\":{\\"login\\":\\"fixture-fork\\"},\\"isCrossRepository\\":true},"
    fi
    printf '[%s]' "\${entries%,}"
    ;;
  "pr create"|"pr edit")
    printf '%s\\n' "$*" >> "\${REVIEW_ACTIONS}.pr-args"
    printf '%s\\n' "$2" >> "\${REVIEW_ACTIONS}"
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--body-file" ]]; then cp "$2" "\${REVIEW_RECEIPT}"; break; fi
      shift
    done
    printf 'https://example.invalid/review/1\\n'
    ;;
  "pr close")
    printf 'close\\n' >> "\${REVIEW_ACTIONS}"
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--comment" ]]; then printf '%s\\n' "$2" >> "\${REVIEW_RECEIPT}.close-comment"; break; fi
      shift
    done
    ;;
  "workflow run")
    [[ -s "\${REVIEW_RECEIPT}" ]] || exit 2
    git ls-remote --exit-code origin "refs/heads/\${SYNC_BRANCH}" >/dev/null || exit 2
    printf '%s\\n' "$*" >> "\${REVIEW_ACTIONS}.dispatch"
    exit "\${DISPATCH_STATUS:-0}"
    ;;
  "run list")
    printf '%s\\n' "$*" >> "\${REVIEW_ACTIONS}.runs"
    printf '%s\\n' "\${PARKED_RUN_URL:-}"
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: tools + path.delimiter + bin + path.delimiter + process.env.PATH,
    GH_TOKEN: "synthetic-test-token", GITHUB_TOKEN: "synthetic-test-token", PM_AUTHOR: "codex-sol",
    PM_GLOBAL_PATH: fixtureGlobalRoot, PM_TELEMETRY_INLINE_FLUSH: "1", PM_PATH: path.join(root, ".agents", "pm"), REPOSITORY: "acme/widgets", CALLING_REPOSITORY: "acme/widgets",
    NPM_PROJECT_PATH: root, GITHUB_WORKSPACE: root,
    POST_IMPORT_SCRIPT: "changelog:full", CI_WORKFLOWS: "ci.yml",
    PM_GITHUB_VERSION: "2026.10.4", DEFAULT_BRANCH: "main", SYNC_BRANCH, SYNC_LEASE: "", RUNNER_TEMP: base,
    GITHUB_ENV: path.join(base, "job-env"), REVIEW_RECEIPT: path.join(base, "review.md"), REVIEW_ACTIONS: path.join(base, "review-actions") };
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const packed = await packWorkflowCandidate(packageRoot, base, env);
  assert.equal(packed.code, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];
  const archive = path.join(base, filename).replace(/'/g, "'\\''");
  const installed = await executeWorkflow(`./node_modules/.bin/pm package install '${archive}' --project`, root, env);
  assert.equal(installed.code, 0, installed.stderr);
  const restored = await executeWorkflow(workflowShell(["Configure PM merge drivers", "Verify gate is available"]), root, env);
  assert.equal(restored.code, 0, restored.stderr);
  return env;
}

const WORKFLOW_IMPORT_SEQUENCE = ["Resolve sync commit scope", "Validate GitHub access", "Revalidate GitHub blockers (report only)", "Preview GitHub to pm plan", "Gated GitHub to pm import",
  "Verify repeat import is a no-op", "Run caller post-import script", "Gate tracker and regenerated changelog",
  "Verify strict pm health", "Commit gated sync changes and open review PR", "Dispatch caller CI and report parked runs"] as const;

test("workflow packing isolates prepare from the caller tracker in clones and linked worktrees", async () => {
  const { root, base } = initSyncRepo();
  try {
    const clone = path.join(base, "package-clone");
    const worktree = path.join(base, "package-worktree");
    assert.equal(spawnSync("git", ["clone", "--quiet", "--no-hardlinks", repoRoot, clone]).status, 0);
    assert.equal(spawnSync("git", ["-C", clone, "worktree", "add", "--quiet", "--detach", worktree]).status, 0);
    assert.ok(fs.statSync(path.join(clone, ".git")).isDirectory());
    assert.ok(fs.statSync(path.join(worktree, ".git")).isFile());
    const tools = path.join(base, "pack-tools");
    fs.mkdirSync(tools);
    const npm = await executeWorkflow("command -v npm", repoRoot, process.env);
    assert.equal(npm.code, 0, npm.stderr);
    // Exercise npm 10's lifecycle behavior on every npm version: invoke the real
    // package hook before packing. No stub replaces pm or its merge installer.
    fs.writeFileSync(path.join(tools, "npm"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$PM_PATH" >> "$PACK_PREPARE_RECEIPT"
PATH="$PWD/node_modules/.bin:$PATH" node scripts/prepare-merge-driver.ts >&2
exec '${npm.stdout.trim().replace(/'/g, "'\\''")}' "$@"
`, { mode: 0o755 });
    const receipt = path.join(base, "prepare-receipt");
    const env = { ...process.env, PM_PATH: path.join(root, ".agents", "pm"), PACK_PREPARE_RECEIPT: receipt,
      npm_config_foreground_scripts: "true",
      PATH: tools + path.delimiter + process.env.PATH };
    const before = fs.readFileSync(path.join(root, ".agents", "pm", "settings.json"), "utf8");
    for (const packageRoot of [clone, worktree]) {
      for (const directory of ["node_modules", "dist"]) {
        fs.symlinkSync(path.join(repoRoot, directory), path.join(packageRoot, directory), "dir");
      }
      const packed = await packWorkflowCandidate(packageRoot, base, env);
      assert.equal(packed.code, 0, packed.stderr);
      const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];
      assert.ok(fs.statSync(path.join(base, filename)).size > 0);
      assert.equal(fs.readFileSync(path.join(root, ".agents", "pm", "settings.json"), "utf8"), before);
    }
    assert.deepEqual(fs.readFileSync(receipt, "utf8").trim().split("\n"),
      [clone, worktree].map(packageRoot => path.join(packageRoot, ".agents", "pm")));
    assert.equal(env.PM_PATH, path.join(root, ".agents", "pm"), "caller commands keep their own tracker");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the executable reusable workflow never publishes each adversarial fixture", async () => {
  const cases = [
    { body: GH_TOKEN, comment: "", rule: "github-token-classic" },
    { body: "clean", comment: GH_TOKEN, rule: "github-token-classic" },
    { body: PERSONAL_EMAIL, comment: "", rule: "email-address" },
    { body: HOME_PATH, comment: "", rule: "absolute-host-path" },
    { body: `accessToken = "${HIGH_ENTROPY_SECRET}"`, comment: "", rule: "high-entropy-assignment" },
    { body: `api_key = "${HIGH_ENTROPY_SECRET}2026-10-05"`, comment: "", rule: "high-entropy-assignment" },
    { body: "xapp-" + "1-" + "A".repeat(36), comment: "", rule: "slack-token" },
    { body: "phone: " + "415" + "555" + "0123", comment: "", rule: "phone-number" },
    { body: "C:" + "/" + "Users/fixture/report.txt", comment: "", rule: "windows-host-path" },
  ];
  for (const fixture of cases) {
    const { root, base, bare, git } = initSyncRepo();
    try {
      const env = await prepareWorkflowFixture(root, base);
      assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
      const comments = new Map<number, GhComment[]>([[1, [{ id: 100, body: fixture.comment,
        user: { login: "fixture" }, created_at: "2026-10-01T00:00:00Z" }]]]);
      const issues = [issue(1, "Synthetic issue", fixture.body)];
      const handle = githubHandler(issues, comments);
      await withMockGithub((req, res, url, server) => {
        if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
        else handle(req, res, url, server);
      }, async () => {
        const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
          PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE });
        assert.notEqual(result.code, 0, "the actual shell must stop at the gate");
        assert.ok(result.stderr.includes(fixture.rule), "the expected privacy rule rejects this fixture");
        for (const sensitive of [GH_TOKEN, HIGH_ENTROPY_SECRET, PERSONAL_EMAIL, HOME_PATH]) {
          assert.ok(!result.stdout.includes(sensitive) && !result.stderr.includes(sensitive));
        }
        assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
        assert.deepEqual(fs.readdirSync(path.join(root, ".agents/pm/issues")).filter(file => file.endsWith(".toon")), [],
          "preflight never writes malicious issue data to an item file");
        assert.ok(!fs.existsSync(env.REVIEW_RECEIPT!), "no review is opened after a gate failure");
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("the executable reusable workflow pushes only a clean import and creates or updates linked reviews", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    for (const file of ["ci.yml", "codeql.yaml"]) fs.writeFileSync(path.join(root, ".github/workflows", file), "on: workflow_dispatch\n");
    fs.writeFileSync(path.join(root, "generate-changelog.cjs"), `const fs = require("node:fs");
const items = fs.readdirSync(".agents/pm/issues").filter(file => file.endsWith(".toon"));
if (items.length !== 1) process.exit(1);
fs.writeFileSync("CHANGELOG.md", "# Changelog\\n- " + items[0] + "\\n");
`);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "changelog:full": "node generate-changelog.cjs" } }));
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n");
    assert.equal(git(["add", "--", ".github/workflows", "generate-changelog.cjs", "package.json", "CHANGELOG.md"]).status, 0);
    assert.equal(git(["commit", "-qm", "caller changelog and dispatchable CI"]).status, 0);
    assert.equal(git(["push", "-q", "origin", "main"]).status, 0);
    const env = await prepareWorkflowFixture(root, base);
    env.CI_WORKFLOWS = "ci.yml missing.yml\ncodeql.yaml";
    env.PARKED_RUN_URL = "https://example.invalid/actions/runs/123";
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    const handle = githubHandler([{ ...issue(1, "Synthetic issue", "Reviewed public body."), state: "closed", state_reason: "completed", closed_at: "2026-10-02T00:00:00Z" }]);
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else handle(req, res, url, server);
    }, async () => {
      const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE });
      assert.equal(result.code, 0, result.stderr + "\n" + result.stdout);
      assert.deepEqual(remoteRefs(bare), ["refs/heads/" + SYNC_BRANCH, "refs/heads/main"].sort());
      const review = fs.readFileSync(env.REVIEW_RECEIPT!, "utf8");
      assert.match(review, /https:\/\/github\.com\/acme\/widgets\/blob\/main\/\.agents\/pm\/issues\/[^)]+\.toon/);
      // While the PR is open the main link may not resolve yet, so each item
      // also links its proposed version on the sync branch.
      assert.ok(review.includes(`([proposed](https://github.com/acme/widgets/blob/${SYNC_BRANCH}/.agents/pm/issues/`), review);
      assert.match(fs.readFileSync(env.GITHUB_ENV!, "utf8"), /^SYNC_PUBLISHED=true$/m, "subsequent Actions steps see publication success");
      const lease = git(["rev-parse", "HEAD"]).stdout.trim();
      const publishedChangelog = spawnSync("git", ["--git-dir", bare, "show", `${SYNC_BRANCH}:CHANGELOG.md`], { encoding: "utf8" });
      assert.equal(publishedChangelog.status, 0);
      assert.match(publishedChangelog.stdout, /- .*\.toon/);
      const publishedPaths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).stdout.trim().split("\n");
      assert.ok(publishedPaths.includes("CHANGELOG.md"), "the sync commit includes regenerated changelog output");
      assert.ok(publishedPaths.some(file => /^\.agents\/pm\/issues\/.*\.toon$/.test(file)), "the same sync commit includes tracker items");
      assert.deepEqual(fs.readFileSync(env.REVIEW_ACTIONS! + ".dispatch", "utf8").trim().split("\n"),
        ["ci.yml", "codeql.yaml"].map(file => `workflow run ${file} -R acme/widgets --ref ${SYNC_BRANCH}`));
      assert.match(result.stdout, /::notice::Skipping missing caller workflow: missing.yml/);
      assert.ok(result.stdout.includes(`::notice::A pull-request workflow requires maintainer approval: ${env.PARKED_RUN_URL}`));
      assert.ok(fs.readFileSync(env.REVIEW_ACTIONS! + ".runs", "utf8").includes(`--commit ${lease} --status action_required`));
      // Each Actions job starts from a fresh checkout, without old local journals.
      const nextRoot = path.join(base, "next-work");
      assert.equal(spawnSync("git", ["clone", "--branch", "main", bare, nextRoot], { encoding: "utf8" }).status, 0);
      const nextEnv = await prepareWorkflowFixture(nextRoot, base);
      nextEnv.CI_WORKFLOWS = "ci.yml codeql.yaml";
      assert.equal(spawnSync("git", ["-C", nextRoot, "switch", "-c", SYNC_BRANCH]).status, 0);
      assert.equal(spawnSync("git", ["-C", nextRoot, "config", "user.name", "Fixture"]).status, 0);
      assert.equal(spawnSync("git", ["-C", nextRoot, "config", "user.email", "fixture@users.noreply.github.com"]).status, 0);
      const update = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), nextRoot, { ...nextEnv,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, SYNC_LEASE: lease, OWN_OPEN_PR: "1" });
      assert.equal(update.code, 0, update.stderr + "\n" + update.stdout);
      assert.deepEqual(fs.readFileSync(env.REVIEW_ACTIONS!, "utf8").trim().split("\n"), ["create", "edit"]);
      assert.equal(fs.readFileSync(env.REVIEW_ACTIONS! + ".dispatch", "utf8").trim().split("\n").length, 4,
        "both PR creation and update dispatch caller CI");
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the caller default branch trunk flows from schedule guard through real Git preparation and review", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    assert.equal(git(["branch", "-m", "trunk"]).status, 0);
    assert.equal(git(["push", "-u", "origin", "trunk"]).status, 0);
    assert.equal(spawnSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/trunk"]).status, 0);
    assert.equal(git(["push", "origin", "--delete", "main"]).status, 0);
    const fixtureEnv = await prepareWorkflowFixture(root, base);
    assert.equal(git(["push", "origin", "trunk"]).status, 0, "publish the caller dependency setup on its default branch");
    const guardEnv = guardEnvironment(base, { schedule: "17 2 * * *" }, "refs/heads/trunk", "trunk");
    const guarded = await executeWorkflow(workflowShell(["Require caller default branch"]), root, guardEnv);
    assert.equal(guarded.code, 0, guarded.stdout + guarded.stderr);
    const output = fs.readFileSync(guardEnv.GITHUB_OUTPUT!, "utf8").trim().split("=")[1]!;
    assert.equal(output, "trunk", "checkout action receives the guard output");
    assert.match(workflow, /ref: \$\{\{ steps.caller_branch.outputs.branch \}\}/);
    assert.equal(git(["switch", "--detach", output]).status, 0, "checkout the resolved default branch");
    const exported = fs.readFileSync(guardEnv.GITHUB_ENV!, "utf8").trim().split("=")[1]!;
    const env: NodeJS.ProcessEnv = { ...fixtureEnv, DEFAULT_BRANCH: exported };
    const prepared = await executeWorkflow(workflowShell(["Prepare sync branch from default branch"]), root, env);
    assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
    assert.equal(git(["branch", "--show-current"]).stdout.trim(), SYNC_BRANCH);
    assert.equal(git(["rev-parse", "HEAD"]).stdout, git(["rev-parse", "origin/trunk"]).stdout);
    const handle = githubHandler([issue(1, "Synthetic trunk issue", "Reviewed public body.")]);
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else handle(req, res, url, server);
    }, async () => {
      const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(remoteRefs(bare), ["refs/heads/" + SYNC_BRANCH, "refs/heads/trunk"].sort());
      const prArgs = fs.readFileSync(env.REVIEW_ACTIONS! + ".pr-args", "utf8").trim().split("\n");
      assert.equal(prArgs.length, 2);
      for (const args of prArgs) assert.match(args, /--base trunk(?: |$)/);
      assert.match(prArgs[0]!, /^pr list /);
      assert.match(prArgs[1]!, /^pr create /);
      const body = fs.readFileSync(env.REVIEW_RECEIPT!, "utf8");
      assert.match(body, /https:\/\/github\.com\/acme\/widgets\/blob\/trunk\/\.agents\/pm\/issues\/[^)]+\.toon/);
      assert.ok(body.includes("`trunk` is never pushed directly."));
      assert.doesNotMatch(body, /\bmain\b/);
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the workflow never edits a fork PR sharing the sync branch name", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    const handle = githubHandler([issue(1, "Synthetic issue", "Reviewed public body.")]);
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else handle(req, res, url, server);
    }, async () => {
      // gh pr list --head matches branch names, so the only listed PR is a
      // fork PR opened from a branch with the same name as the sync branch.
      const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, FORK_OPEN_PR: "7" });
      assert.equal(result.code, 0, result.stderr + "\n" + result.stdout);
      assert.deepEqual(fs.readFileSync(env.REVIEW_ACTIONS!, "utf8").trim().split("\n"), ["create"],
        "the fork PR is never edited; the workflow opens its own review PR instead");
      assert.ok(fs.readFileSync(env.REVIEW_RECEIPT!, "utf8").length > 0);
      assert.deepEqual(remoteRefs(bare), ["refs/heads/" + SYNC_BRANCH, "refs/heads/main"].sort());
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});


/**
 * Replay the full import sequence on a fixture whose tracker already matches
 * GitHub, so the run proposes no change ("no PR is needed").
 *
 * @param prListOverrides - Environment shaping which open PRs `gh pr list` lists.
 * @param changelogState - Optional caller changelog drift to regenerate after a no-op import.
 * @returns The exit code, output, recorded review-PR actions and remote refs.
 */
async function replayNoChangeSequence(prListOverrides: NodeJS.ProcessEnv, changelogState?: "stale" | "absent"): Promise<{
  code: number | null; stdout: string; stderr: string;
  reviewActions: string[] | undefined; refs: string[];
  status: string; changelog: string | undefined; published: boolean;
}> {
  const { root, base, bare, git } = initSyncRepo();
  try {
    // The caller restricts extensions to an explicit list without pm-github, so
    // installing the pinned extension edits settings.json in the checkout.
    const settingsPath = path.join(root, ".agents", "pm", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { extensions: { enabled: string[] } };
    settings.extensions.enabled = ["pm-other"];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    assert.equal(git(["commit", "-qam", "restrict enabled extensions"]).status, 0);
    if (changelogState) {
      fs.writeFileSync(path.join(root, "generate-changelog.cjs"), 'require("node:fs").writeFileSync("CHANGELOG.md", "# Fresh changelog\\n");\n');
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "changelog:full": "node generate-changelog.cjs" } }));
      if (changelogState === "stale") fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Stale changelog\n");
      assert.equal(git(["add", "--", "generate-changelog.cjs", "package.json", ...(changelogState === "stale" ? ["CHANGELOG.md"] : [])]).status, 0);
      assert.equal(git(["commit", "-qm", "caller changelog regeneration fixture"]).status, 0);
    }
    assert.equal(git(["push", "-q", bare, "main"]).status, 0);
    const env = await prepareWorkflowFixture(root, base);
    assert.notEqual(git(["diff", "--quiet", "--", ".agents/pm/settings.json"]).status, 0, "precondition: install edits settings.json");
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    let result: Awaited<ReturnType<typeof executeWorkflow>> | undefined;
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else githubHandler([])(req, res, url, server);
    }, async () => {
      result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, ...prListOverrides });
    });
    const actionsPath = env.REVIEW_ACTIONS!;
    return { code: result!.code, stdout: result!.stdout, stderr: result!.stderr,
      reviewActions: fs.existsSync(actionsPath) ? fs.readFileSync(actionsPath, "utf8").trim().split("\n") : undefined,
      refs: remoteRefs(bare), status: git(["status", "--porcelain"]).stdout.trim(),
      changelog: fs.existsSync(path.join(root, "CHANGELOG.md")) ? fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8") : undefined,
      published: fs.readFileSync(env.GITHUB_ENV!, "utf8").includes("SYNC_PUBLISHED=true") };
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test("an install-only settings change never reaches the sync commit", async () => {
  const run = await replayNoChangeSequence({});
  assert.equal(run.code, 0, run.stderr + "\n" + run.stdout);
  assert.match(run.stdout, /no PR is needed/);
  assert.equal(run.reviewActions, undefined, "no review PR was created, edited or closed");
  assert.deepEqual(run.refs, ["refs/heads/main"]);
});

test("a no-change run closes an own open sync PR and exits successfully", async () => {
  const run = await replayNoChangeSequence({ OWN_OPEN_PR: "1" });
  assert.equal(run.code, 0, run.stderr + "\n" + run.stdout);
  assert.match(run.stdout, /no PR is needed/);
  assert.deepEqual(run.reviewActions, ["close"], "the stale own review PR is closed");
  assert.deepEqual(run.refs, ["refs/heads/main"], "a no-change run pushes nothing");
});

test("a no-change run with only a fork PR sharing the branch name closes nothing", async () => {
  const run = await replayNoChangeSequence({ FORK_OPEN_PR: "7" });
  assert.equal(run.code, 0, run.stderr + "\n" + run.stdout);
  assert.match(run.stdout, /no PR is needed/);
  assert.equal(run.reviewActions, undefined, "a foreign fork PR is never touched");
  assert.deepEqual(run.refs, ["refs/heads/main"]);
});

test("a no-op import discards stale changelog drift and leaves a clean checkout without publication", async () => {
  for (const ownPr of [undefined, "1"]) {
    const run = await replayNoChangeSequence({ OWN_OPEN_PR: ownPr }, "stale");
    assert.equal(run.code, 0, run.stderr + "\n" + run.stdout);
    assert.match(run.stdout, /::notice::.*changelog differs from a fresh regeneration.*changelog:check owns that/);
    assert.equal(run.changelog, "# Stale changelog\n", "restore the committed caller changelog");
    assert.equal(run.status, "", "both index and working tree are clean");
    assert.deepEqual(run.reviewActions, ownPr ? ["close"] : undefined);
    assert.deepEqual(run.refs, ["refs/heads/main"], "the no-op run does not push");
    assert.equal(run.published, false, "the no-op run does not dispatch caller CI");
  }
});

test("a no-op import discards a newly generated changelog absent from HEAD", async () => {
  const run = await replayNoChangeSequence({}, "absent");
  assert.equal(run.code, 0, run.stderr + "\n" + run.stdout);
  assert.match(run.stdout, /::notice::.*changelog:check owns that/);
  assert.equal(run.changelog, undefined);
  assert.equal(run.status, "");
  assert.equal(run.reviewActions, undefined);
  assert.deepEqual(run.refs, ["refs/heads/main"]);
  assert.equal(run.published, false);
});

test("packed installed CLI repeats a completed gated import under native Bun within 45 seconds", { timeout: 180_000 }, async () => {
  const { root, base, bare } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    const handle = githubHandler([issue(1, "Synthetic issue", "Reviewed public body.")]);
    await withMockGithub(handle, async () => {
      const runEnv = { ...env, PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE };
      const first = await executeWorkflow(workflowShell(["Gated GitHub to pm import"]), root, runEnv);
      assert.equal(first.code, 0, first.stderr);
      const snapshot = () => fs.readdirSync(path.join(root, ".agents/pm/issues")).filter(file => file.endsWith(".toon"))
        .map(file => fs.readFileSync(path.join(root, ".agents/pm/issues", file), "utf8"));
      const before = snapshot();
      assert.equal(before.length, 1);
      const cli = fs.realpathSync(path.join(root, "node_modules/.bin/pm"));
      for (let repeat = 0; repeat < 3; repeat++) {
        const started = Date.now();
        const result = await boundedCli("bun", ["--bun", cli, "github", "import", "acme/widgets", "--state", "all", "--atomic", "--gate", "--with-comments", "--json"], root, runEnv);
        assert.equal(result.timedOut, false);
        assert.equal(result.signal, null, `native Bun repeat ${repeat + 1} exceeded its unchanged 45s budget: ${result.stderr}`);
        assert.equal(result.code, 0, result.stderr);
        assert.ok(Date.now() - started < 45_000);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
      }
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("gated comment imports reject malformed second HTTP pages before writing", async () => {
  const { root, base, git } = initSyncRepo();
  try {
    for (const badPage of ["not JSON", "{}"] ) {
      await withMockGithub((req, res, _body, baseUrl) => {
        if ((req.url ?? "").includes("page=2")) { res.end(badPage); return; }
        if ((req.url ?? "").includes("/comments")) {
          jsonResponse(res, 200, [{ id: 1, body: "public comment" }], { Link: `<${baseUrl}/repos/acme/widgets/issues/1/comments?page=2>; rel="next"` });
          return;
        }
        jsonResponse(res, 200, [{ ...issue(1, "Public issue", "Public body"), comments: 2 }]);
      }, async server => {
        for (const atomic of [true, false]) {
          await assert.rejects(runGatedImport(root, { gate: true, atomic, "with-comments": true }), /comments for issue #1 could not be read/);
          assert.equal(git(["status", "--porcelain", "--", ".agents/pm"]).stdout.trim(), "");
        }
        assert.equal(server.requests.filter(req => req.url.includes("page=2")).length, 2);
      });
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("gated pre-write input errors carry the command exit code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-preview-error-"));
  try {
    await assert.rejects(runImport("acme/widgets", root, parseImportOptions({ gate: true, atomic: true }), {
      resolveToken: () => undefined, fetchIssues: async () => [issue(1, "Public", "Body")], readItems: () => [],
    }), error => error instanceof CommandError && error.exitCode === 1 && /not inside a Git work tree/.test(error.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** Run the real directory validator and consume its environment file as Actions does. */
async function resolveNpmProject(root: string, base: string, input: string): Promise<{ result: Awaited<ReturnType<typeof executeWorkflow>>; env: NodeJS.ProcessEnv }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_WORKSPACE: root, GITHUB_ENV: path.join(base, "npm-env"),
    GITHUB_PATH: path.join(base, "npm-path"), NPM_PROJECT_DIR: input, POST_IMPORT_SCRIPT: "changelog:full",
    NPM_RECEIPT: path.join(base, "npm-script-receipt") };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
  const result = await executeWorkflow(workflowShell(["Validate npm project directory"]), root, env);
  if (result.code === 0) {
    const exported = fs.readFileSync(env.GITHUB_ENV!, "utf8");
    assert.match(exported, /^NPM_PROJECT_PATH=[^\r\n]+\n$/);
    env.NPM_PROJECT_PATH = exported.slice("NPM_PROJECT_PATH=".length).trimEnd();
  }
  return { result, env };
}

for (const directory of [".", "tests/oracle"]) {
  test(`npm-project-dir ${directory === "." ? "default" : "subdirectory"} installs, prepends PATH and runs the caller script in the selected project`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-npm-project-"));
    const root = path.join(base, "work");
    const project = path.join(root, directory);
    fs.mkdirSync(project, { recursive: true });
    const manifest = JSON.stringify({ name: "sync-project", version: "1.0.0", scripts: {
      preinstall: "node -e 'process.exit(88)'",
      "changelog:full": `node -e 'require("node:fs").writeFileSync(process.env.NPM_RECEIPT, process.cwd())'`,
    } });
    const lock = JSON.stringify({ name: "sync-project", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "sync-project", version: "1.0.0", hasInstallScript: true } } });
    fs.writeFileSync(path.join(project, "package.json"), manifest);
    fs.writeFileSync(path.join(project, "package-lock.json"), lock);
    try {
      const defaultInput = /npm-project-dir:\n\s+description:[^\n]+\n\s+type: string\n\s+required: false\n\s+default: "([^"\n]+)"/.exec(workflow);
      assert.ok(defaultInput, "the optional input declares its default");
      assert.match(workflow, /NPM_PROJECT_DIR: \$\{\{ inputs.npm-project-dir \}\}/);
      const { result, env } = await resolveNpmProject(root, base, directory === "." ? defaultInput[1]! : directory);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(env.NPM_PROJECT_PATH, project);
      assert.ok(stepOffset("Checkout caller default branch") < stepOffset("Validate npm project directory"));
      assert.ok(stepOffset("Validate npm project directory") < stepOffset("Setup Node.js"));
      assert.match(workflow, /cache-dependency-path: \|\n\s+\$\{\{ env.NPM_PROJECT_PATH \}\}\/package-lock.json\n\s+\$\{\{ env.NPM_PROJECT_PATH \}\}\/npm-shrinkwrap.json/);
      const install = await executeWorkflow(workflowShell(["Install dependencies"]), root, env);
      assert.equal(install.code, 0, install.stdout + install.stderr);
      assert.equal(fs.readFileSync(env.GITHUB_PATH!, "utf8"), `${project}/node_modules/.bin\n`);
      // npm must ignore the failing lifecycle script and preserve both manifests.
      assert.equal(fs.readFileSync(path.join(project, "package.json"), "utf8"), manifest);
      assert.equal(fs.readFileSync(path.join(project, "package-lock.json"), "utf8"), lock);
      const post = await executeWorkflow(workflowShell(["Run caller post-import script"]), root, env);
      assert.equal(post.code, 0, post.stdout + post.stderr);
      assert.equal(fs.readFileSync(env.NPM_RECEIPT!, "utf8"), project);
      if (directory === ".") {
        // Compare the legacy default's observable files byte for byte.
        const legacyEnv = { ...env, GITHUB_PATH: path.join(base, "legacy-path"), NPM_RECEIPT: path.join(base, "legacy-receipt") };
        const legacy = await executeWorkflow('npm ci --ignore-scripts\nprintf \'%s/node_modules/.bin\\n\' "$GITHUB_WORKSPACE" >> "$GITHUB_PATH"\nnpm run --if-present "$POST_IMPORT_SCRIPT"', root, legacyEnv);
        assert.equal(legacy.code, 0, legacy.stdout + legacy.stderr);
        for (const key of ["GITHUB_PATH", "NPM_RECEIPT"] as const) {
          assert.deepEqual(fs.readFileSync(env[key]!), fs.readFileSync(legacyEnv[key]!));
        }
      } else assert.equal(fs.existsSync(path.join(root, "package.json")), false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}

for (const scenario of ["parent", "embedded-parent", "absolute", "missing-package", "missing-directory", "symlink-escape", "symlink-newline-target", "newline", "colon", "empty"] as const) {
  test(`npm-project-dir refuses ${scenario} before install or environment publication`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-npm-invalid-"));
    const root = path.join(base, "work");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, "empty"));
    fs.writeFileSync(path.join(base, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.symlinkSync(base, path.join(root, "escape"), "dir");
    fs.mkdirSync(path.join(root, "canonical\n"));
    fs.mkdirSync(path.join(root, "canonical"));
    fs.writeFileSync(path.join(root, "canonical", "package.json"), "{}");
    fs.symlinkSync("canonical\n", path.join(root, "newline-link"), "dir");
    const inputs = { parent: "..", "embedded-parent": "empty/../", absolute: root,
      "missing-package": "empty", "missing-directory": "absent", "symlink-escape": "escape", "symlink-newline-target": "newline-link",
      newline: ".\nINJECTED=value", colon: "empty:other", empty: "" };
    try {
      const { result, env } = await resolveNpmProject(root, base, inputs[scenario]);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, "::error::npm-project-dir must be a relative path without .. segments, resolve inside the workspace, and contain package.json.\n");
      assert.equal(result.stderr, "");
      assert.equal(fs.existsSync(env.GITHUB_ENV!), false);
      assert.equal(fs.existsSync(env.GITHUB_PATH!), false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}

test("npm-project-dir subdirectory CLI and SDK keep the tracker and publication at the repository root", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    const project = path.join(root, "tests", "oracle");
    fs.mkdirSync(project, { recursive: true });
    fs.renameSync(path.join(root, "package.json"), path.join(project, "package.json"));
    fs.renameSync(path.join(root, "node_modules"), path.join(project, "node_modules"));
    // The fixture uses the real pinned CLI/SDK and packed candidate extension.
    env.NPM_PROJECT_PATH = project;
    env.PATH = path.join(project, "node_modules", ".bin") + path.delimiter + env.PATH;
    assert.equal(git(["add", "--", "package.json", "tests/oracle/package.json"]).status, 0);
    assert.equal(git(["commit", "-qm", "nested caller npm project"]).status, 0);
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    const handle = githubHandler([issue(1, "Public nested caller issue", "Reviewed public body.")]);
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else handle(req, res, url, server);
    }, async () => {
      const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root,
        { ...env, PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE });
      assert.equal(result.code, 0, result.stdout + result.stderr + git(["diff", "--", ".gitattributes"]).stdout);
      assert.equal(fs.existsSync(path.join(root, "package.json")), false);
      assert.match(fs.readFileSync(env.GITHUB_ENV!, "utf8"), /^PM_SYNC_TRACKER=\.agents\/pm$/m);
      assert.ok(remoteRefs(bare).includes("refs/heads/" + SYNC_BRANCH));
      const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).stdout.trim().split("\n");
      assert.ok(changed.some(file => file.endsWith(".toon")), "a nonempty import was published");
      assert.ok(changed.every(file => file.startsWith(".agents/pm/") || file === "CHANGELOG.md"));
      assert.equal(fs.existsSync(path.join(project, ".agents")), false);
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("workflow input shell accepts numeric same-day pins and refuses floating versions", async () => {
  for (const [version, valid] of [["2026.10.6", true], ["2026.10.6-1", true], ["2026.10.6-12", true], ["latest", false], ["^2026.10.6", false], ["2026.10.6-beta", false], ["2026.10.6-1; true", false]] as const) {
    const result = await executeWorkflow(workflowShell(["Validate sync inputs"]), repoRoot, {
      ...process.env, REPOSITORY: "acme/widgets", CALLING_REPOSITORY: "acme/widgets", SYNC_BRANCH, PM_GITHUB_VERSION: version,
    });
    assert.equal(result.code === 0, valid, version);
    if (!valid) assert.match(result.stdout, /::error::pm-github-version must be an exact numeric version: N\.N\.N or N\.N\.N-N\./);
  }
});

test("workflow input shell diagnoses a foreign repository and branch outside automation/", async () => {
  for (const [input, value, diagnostic] of [
    ["REPOSITORY", "acme/other", "::error::repository must equal the calling repository (acme/widgets)."],
    ["SYNC_BRANCH", "feature/sync", "::error::sync-branch must start with automation/."],
    ["POST_IMPORT_SCRIPT", "npm run changelog:full", "::error::post-import-script must be an npm script name, not a shell command."],
    ["POST_IMPORT_SCRIPT", "--version", "::error::post-import-script must be an npm script name, not a shell command."],
  ] as const) {
    const result = await executeWorkflow(workflowShell(["Validate sync inputs"]), repoRoot, {
      ...process.env, REPOSITORY: "acme/widgets", CALLING_REPOSITORY: "acme/widgets", SYNC_BRANCH, PM_GITHUB_VERSION: "2026.10.6",
      [input]: value,
    });
    assert.equal(result.code, 1, input);
    assert.ok(result.stdout.includes(diagnostic), result.stdout);
  }
});

test("workflow credentials stay out of install steps and checkout persistence", () => {
  const steps = workflow.split(/\n      - name: /).slice(1);
  const tokenSteps = steps.filter(step => step.includes("GH_TOKEN:")).map(step => step.split("\n")[0]);
  assert.deepEqual(tokenSteps, ["Require caller default branch", "Validate GitHub access", "Revalidate GitHub blockers (report only)", "Preview GitHub to pm plan", "Gated GitHub to pm import", "Verify repeat import is a no-op", "Commit gated sync changes and open review PR", "Dispatch caller CI and report parked runs"]);
  assert.doesNotMatch(workflow.slice(0, stepOffset("Require caller default branch")), /GH_TOKEN:/);
  assert.match(steps.find(step => step.startsWith("Checkout caller default branch"))!, /persist-credentials: false/);
  assert.match(workflowShell(["Install dependencies"]), /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflowShell(["Prepare sync branch from default branch"]), /git fetch|git ls-remote/);
  assert.match(workflowShell(["Commit gated sync changes and open review PR"]), /gh auth setup-git\n\s*git push/);
});

test("scheduled blocker report warns on clearance, preserves items, and fails on query errors", async () => {
  const { root, base } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    const created = spawnSync(PM_BIN, ["--pm-path", path.join(root, ".agents", "pm"), "create", "task", "Closed upstream blocker", "--blocked-reason", "unbraind/pm-cli#854", "--json"], { ...PM_SPAWN_OPTS, cwd: root, env });
    assert.equal(created.status, 0, created.stderr);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    assert.ok(id);
    assert.equal(spawnSync(PM_BIN, ["--pm-path", path.join(root, ".agents", "pm"), "update", id, "--status", "blocked"], { ...PM_SPAWN_OPTS, cwd: root, env }).status, 0);
    const itemPath = path.join(root, ".agents", "pm", "tasks", `${id}.toon`);
    const before = fs.readFileSync(itemPath, "utf8");
    for (const [file,expected] of [["issue-854-closed.json", 0], ["graphql-error-data-null.json", 1]] as const) {
      await withMockGithub((_req, res) => jsonResponse(res, 200, fs.readFileSync(path.join(repoRoot, "test", "fixtures", "blockers", file), "utf8")), async server => {
        const result = await executeWorkflow(workflowShell(["Revalidate GitHub blockers (report only)"]), root, { ...env, PM_GITHUB_API_BASE: server.baseUrl });
        assert.equal(result.code, expected, result.stderr);
        if (expected === 0) assert.match(result.stdout, /::warning::GitHub blockers have cleared/);
        else assert.doesNotMatch(result.stdout, /::warning::/);
        assert.equal(fs.readFileSync(itemPath, "utf8"), before);
      });
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});


test("post-import changelog findings and script failures block publication", async () => {
  for (const script of ["generate-secret", "fail-script"]) {
    const { root, base, bare, git } = initSyncRepo();
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: {
        "generate-secret": "node generate-secret.cjs", "fail-script": "node -e 'process.exit(19)'",
      } }));
      fs.writeFileSync(path.join(root, "generate-secret.cjs"),
        'require("node:fs").writeFileSync("CHANGELOG.md", process.env.SYNTHETIC_SECRET + "\\n");\n');
      assert.equal(git(["add", "--", "package.json", "generate-secret.cjs"]).status, 0);
      assert.equal(git(["commit", "-qm", "caller scripts"]).status, 0);
      const env = await prepareWorkflowFixture(root, base);
      assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
      const handle = githubHandler([issue(1, "Public issue", "Reviewed public body.")]);
      await withMockGithub((req, res, url, server) => {
        if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
        else handle(req, res, url, server);
      }, async () => {
        const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
          PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, POST_IMPORT_SCRIPT: script, SYNTHETIC_SECRET: GH_TOKEN });
        assert.notEqual(result.code, 0);
        if (script === "generate-secret") {
          assert.match(result.stderr, /github-token-classic/);
          assert.ok(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").includes(GH_TOKEN));
          assert.ok(!result.stdout.includes(GH_TOKEN) && !result.stderr.includes(GH_TOKEN));
        } else assert.equal(result.code, 19);
        assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
        assert.ok(!fs.existsSync(env.REVIEW_RECEIPT!));
        assert.ok(!fs.existsSync(env.REVIEW_ACTIONS! + ".dispatch"));
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("caller post-import changes outside the commit scope fail closed for every Git status class", async () => {
  for (const mode of ["staged", "unstaged", "untracked", "credential", "rename", "multiple"] as const) {
    const { root, base, bare, git } = initSyncRepo();
    try {
      const offending = mode === "multiple" ? ["extra.txt", "second.txt"] : ["extra.txt"];
      fs.writeFileSync(path.join(root, "extra.txt"), "baseline\n");
      fs.writeFileSync(path.join(root, "post-import.ts"), `import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const mode = process.env.SCOPE_TEST_MODE;
if (mode !== "rename") writeFileSync("extra.txt", mode === "credential" ? process.env.SYNTHETIC_SECRET! : "changed\\n");
if (mode === "staged" || mode === "credential") execFileSync("git", ["add", "--", "extra.txt"]);
if (mode === "rename") execFileSync("git", ["mv", "extra.txt", ".agents/pm/extra.txt"]);
if (mode === "multiple") writeFileSync("second.txt", "changed\\n");
`);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "post-import-run": "node post-import.ts" } }));
      const baselinePaths = ["package.json", "post-import.ts", ...(mode === "untracked" ? [] : ["extra.txt"])];
      assert.equal(git(["add", "--", ...baselinePaths]).status, 0);
      assert.equal(git(["commit", "-qm", "caller fixture"]).status, 0);
      assert.equal(git(["push", "-q", "origin", "main"]).status, 0);
      if (mode === "untracked") fs.unlinkSync(path.join(root, "extra.txt"));
      const before = spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).stdout;
      const env = await prepareWorkflowFixture(root, base);
      assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
      const handle = githubHandler([issue(1, "Public issue", "Reviewed public body.")]);
      await withMockGithub((req, res, url, server) => {
        if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
        else handle(req, res, url, server);
      }, async () => {
        const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
          PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, POST_IMPORT_SCRIPT: "post-import-run",
          SCOPE_TEST_MODE: mode, SYNTHETIC_SECRET: GH_TOKEN });
        assert.notEqual(result.code, 0, `must reject ${mode}: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /Changed path outside sync commit scope/);
        for (const file of offending) assert.ok(result.stdout.includes(file), result.stdout);
        assert.ok(!result.stdout.includes(GH_TOKEN) && !result.stderr.includes(GH_TOKEN));
        assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
        assert.equal(spawnSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).stdout, before);
        assert.ok(!fs.existsSync(env.REVIEW_RECEIPT!));
        assert.ok(!fs.existsSync(env.REVIEW_ACTIONS! + ".dispatch"));
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("publication rechecks late changes and rescans the exact working content it commits", async () => {
  for (const mode of ["staged", "unstaged", "untracked", "credential", "tracker-secret"] as const) {
    const { root, base, bare, git } = initSyncRepo();
    try {
      const env = await prepareWorkflowFixture(root, base);
      assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
      const handle = githubHandler([issue(1, "Public issue", "Reviewed public body.")]);
      await withMockGithub((req, res, url, server) => {
        if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
        else handle(req, res, url, server);
      }, async () => {
        const filename = mode === "tracker-secret" ? "CHANGELOG.md" : mode === "unstaged" ? "package.json" : "late.txt";
        const mutate = `node -e 'require("node:fs").writeFileSync(process.env.LATE_PATH, process.env.LATE_CONTENT)'\n`
          + (mode === "staged" || mode === "credential" ? 'git add -- "$LATE_PATH"\n' : "");
        // Insert immediately BEFORE the final status check and scan, after link
        // generation, so both the early gate and the commit-step entry pass.
        const lateShell = workflowShell(WORKFLOW_IMPORT_SEQUENCE).replace(
          'gate_sync_change\nrestore_sync_setup\ncheck_sync_scope\ngit --literal-pathspecs commit --only',
          mutate + 'gate_sync_change\nrestore_sync_setup\ncheck_sync_scope\ngit --literal-pathspecs commit --only');
        assert.ok(lateShell.includes(mutate), "late injection must execute before the commit gate");
        const result = await executeWorkflow(lateShell, root, { ...env,
          PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, LATE_PATH: filename,
          LATE_CONTENT: mode === "credential" || mode === "tracker-secret" ? GH_TOKEN : "changed\n" });
        assert.notEqual(result.code, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
        if (mode === "tracker-secret") assert.match(result.stderr, /github-token-classic/);
        else assert.ok(result.stdout.includes(filename), result.stdout);
        assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("restricted commit excludes unrelated staged content even when scope checks are bypassed", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    const handle = githubHandler([issue(1, "Public issue", "Reviewed public body.")]);
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else handle(req, res, url, server);
    }, async () => {
      const shell = workflowShell(WORKFLOW_IMPORT_SEQUENCE).replace(/^\s*check_sync_scope$/gm, "")
        .replace('source "${RUNNER_TEMP}/pm-github-sync-scope.sh"\ngate_sync_change',
          'node -e \'require("node:fs").writeFileSync("extra.txt", "unscanned")\'\ngit add -- extra.txt\nsource "${RUNNER_TEMP}/pm-github-sync-scope.sh"\ngate_sync_change');
      const result = await executeWorkflow(shell, root, { ...env, PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE });
      assert.equal(result.code, 0, result.stderr + "\n" + result.stdout);
      assert.ok(remoteRefs(bare).includes("refs/heads/" + SYNC_BRANCH), "scope-only revert allows publication");
      assert.equal(spawnSync("git", ["--git-dir", bare, "cat-file", "-e", `${SYNC_BRANCH}:extra.txt`]).status, 128,
        "explicit commit pathspec still prevents publication of the unrelated file");
      assert.equal(git(["diff", "--cached", "--name-only", "--", "extra.txt"]).stdout.trim(), "extra.txt");
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("post-import script can be overridden or disabled and defaults tolerate an absent script", async () => {
  const { root, base } = initSyncRepo();
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { custom: "node custom.cjs" } }));
    fs.writeFileSync(path.join(root, "custom.cjs"), 'require("node:fs").writeFileSync("CHANGELOG.md", "custom");\n');
    const shell = workflowShell(["Run caller post-import script"]);
    for (const script of ["changelog:full", "", "custom"]) {
      const result = await executeWorkflow(shell, root, { ...process.env, NPM_PROJECT_PATH: root, POST_IMPORT_SCRIPT: script });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(root, "CHANGELOG.md")), script === "custom");
    }
    assert.equal(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), "custom");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("dispatch handles disabled, invalid, failed, and unpublished caller workflows", async () => {
  const { root, base, git } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github/workflows/ci.yml"), "on: workflow_dispatch\n");
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    assert.equal(git(["push", "-q", "origin", SYNC_BRANCH]).status, 0);
    fs.writeFileSync(env.REVIEW_RECEIPT!, "Existing review");
    const shell = workflowShell(["Dispatch caller CI and report parked runs"]);
    for (const [overrides, expected] of [
      [{ SYNC_PUBLISHED: "false", CI_WORKFLOWS: "ci.yml" }, 0],
      [{ SYNC_PUBLISHED: "true", CI_WORKFLOWS: "" }, 0],
      [{ SYNC_PUBLISHED: "true", CI_WORKFLOWS: "../ci.yml" }, 1],
      [{ SYNC_PUBLISHED: "true", CI_WORKFLOWS: "ci.yml", DISPATCH_STATUS: "23" }, 23],
    ] as const) {
      const result = await executeWorkflow(shell, root, { ...env, ...overrides });
      assert.equal(result.code, expected, result.stderr);
      if (expected !== 23) assert.ok(!fs.existsSync(env.REVIEW_ACTIONS! + ".dispatch"));
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

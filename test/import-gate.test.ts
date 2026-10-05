// Gated import pipeline: plan completeness + provenance idempotency verified
// BEFORE any mutation, the fail-closed tracker privacy gate AFTER it, and the
// full workflow sequence replayed on a REAL Git repository with a bare remote —
// the adversarial cases prove a malicious issue body, comment, email, or host
// path fails the gated import step so nothing is ever committed or pushed to
// the remote. The positive case proves the whole sequence: plan → gated import
// → strict health → commit/push → a second gated run that is a no-op for item
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
import { jsonResponse, withMockGithub, type MockGithubHandler } from "./helpers/mock-github-server.ts";

const MANIFEST_CAPABILITIES = ["commands", "importers", "schema", "hooks", "preflight", "search"] as const;
const harnessPromise: Promise<ExtensionTestHarness> =
  createExtensionTestHarness(extension, { capabilities: [...MANIFEST_CAPABILITIES] });

const PM_BIN = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_SPAWN_OPTS = { encoding: "utf-8" as const, shell: process.platform === "win32" };
const SYNC_BRANCH = "automation/pm-github-sync";

// --- Fake-but-well-formed malicious fixtures, assembled from parts.
const GH_TOKEN = "ghp_" + "A".repeat(36);
const PERSONAL_EMAIL = "alice.person@example.org";
const HOME_PATH = "/" + "home" + "/alice/report.txt";
const HIGH_ENTROPY_SECRET = "Zj9kP2mQ7xW4nB8vC5tR1sD";

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
 * Build the mock GitHub handler serving one issues page plus per-issue comments.
 *
 * Comments are served for every issue so the `--with-comments` paths can embed
 * adversarial comment fixtures exactly as the real REST API would deliver them.
 *
 * @param issues - The issues the "repository" holds.
 * @param commentsByNumber - Comment fixtures keyed by issue number.
 * @returns The request handler.
 */
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

test("a real completed SDK journal with reset item files cannot authorize a push", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    await withMockGithub(githubHandler([issue(1, "Synthetic issue", "Public body")]), async () => {
      await runGatedImport(root, { atomic: true, gate: true });
      assert.equal(git(["add", ".agents/pm"]).status, 0);
      assert.equal(git(["reset", "--hard", "HEAD"]).status, 0);
      await assert.rejects(runGatedImport(root, { atomic: true, gate: true }), /persisted corpus does not account/);
      assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

function githubHandler(
  issues: readonly GhIssue[],
  commentsByNumber: ReadonlyMap<number, readonly GhComment[]> = new Map(),
): MockGithubHandler {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
      messages.some((message) => /pm github gate: plan verified|Fetching issues/.test(message)),
      "the gate runs its plan phase before failing",
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
    assert.strictEqual(git(["status", "--porcelain"]).status, 0);
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

      // Second gated run: everything matches by provenance — zero creates, all
      // updates, no new items, gate passes again. That is the provenance-keyed
      // no-op guarantee the plan phase verifies on every gated run.
      const second = await runGatedImport(root, { atomic: true, gate: true });
      assert.strictEqual(second.imported, 0);
      assert.strictEqual(second.updated, 2);
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

test("the reusable sync workflow is a workflow_call with explicit pinned inputs", () => {
  assert.match(workflow, /^on:\n  workflow_call:/m);
  assert.match(workflow, /pm-github-version:\n\s+description:[^\n]+\n\s+type: string\n\s+required: true/);
  assert.match(workflow, /repository:\n\s+description:/);
  assert.doesNotMatch(workflow, /^on:\n  schedule:/m, "the schedule stays with the caller");
  // Least privilege: exactly the two permissions a gated sync needs.
  const permissions = /^permissions:\n  contents: write\n  pull-requests: write\n/m;
  assert.match(workflow, permissions);
  assert.ok(
    (workflow.match(/^permissions:/gm) ?? []).length === 1,
    "no second, broader permission block",
  );
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
  assert.ok(gated < health && health < commit, "the gate precedes health, commit, and push");
  assert.match(workflow, /import "\$\{REPOSITORY\}" --state all --atomic --gate/);
  assert.match(workflow, /pm health --strict-exit/);
  // No staged catch-all that could commit unscanned content.
  assert.doesNotMatch(workflow, /git add -A/);
  assert.match(workflow, /git --literal-pathspecs add --pathspec-from-file=/);
});

test("the PR body links every changed item as a permanent main-tree pm link", () => {
  assert.match(
    workflow,
    /https:\/\/github\.com\/%s\/blob\/main\/%s/,
    "the link template targets the main-tree item path",
  );
  assert.match(workflow, /\.agents\/pm\/\*\/\*\.toon/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /gh pr edit/);
  // The push is explicit and force-resets the automation branch from main.
  assert.match(workflow, /git push --force-with-lease=/);
});

test("the caller example pins the reusable workflow and the extension version", () => {
  assert.match(callerExample, /^on:\n  schedule:\n    - cron:/m, "the caller owns the schedule");
  assert.match(
    callerExample,
    /uses: unbraind\/pm-github\/\.github\/workflows\/pm-github-sync\.yml@RELEASE_COMMIT_SHA/,
  );
  assert.match(callerExample, /pm-github-version: "RELEASE_VERSION"/);
  assert.match(callerExample, /^permissions:\n  contents: write\n  pull-requests: write\n/m);
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
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

/** Install the candidate and create a local gh PR receipt boundary, never a network writer. */
async function prepareWorkflowFixture(root: string, base: string): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules/.bin/pm"), path.join(bin, "pm"));
  const tools = path.join(base, "tools");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--version" ]]; then printf 'gh fixture\\n'; exit 0; fi
case "$1 $2" in
  "pr list") printf '%s' "\${EXISTING_PR:-}" ;;
  "pr create"|"pr edit")
    printf '%s\\n' "$2" >> "\${REVIEW_ACTIONS}"
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--body-file" ]]; then cp "$2" "\${REVIEW_RECEIPT}"; break; fi
      shift
    done
    printf 'https://example.invalid/review/1\\n'
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: tools + path.delimiter + process.env.PATH,
    GH_TOKEN: "synthetic-test-token", GITHUB_TOKEN: "synthetic-test-token", PM_AUTHOR: "codex-sol",
    PM_PATH: path.join(root, ".agents", "pm"), REPOSITORY: "acme/widgets", CALLING_REPOSITORY: "acme/widgets",
    PM_GITHUB_VERSION: "2026.10.4", SYNC_BRANCH, SYNC_LEASE: "", RUNNER_TEMP: base,
    GITHUB_ENV: path.join(base, "job-env"), REVIEW_RECEIPT: path.join(base, "review.md"), REVIEW_ACTIONS: path.join(base, "review-actions") };
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const packed = await executeWorkflow(`npm pack --ignore-scripts --json --pack-destination '${base.replace(/'/g, "'\\''")}'`, packageRoot, env);
  assert.equal(packed.code, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];
  const archive = path.join(base, filename).replace(/'/g, "'\\''");
  const installed = await executeWorkflow(`./node_modules/.bin/pm package install '${archive}' --project`, root, env);
  assert.equal(installed.code, 0, installed.stderr);
  const restored = await executeWorkflow(workflowShell(["Configure PM merge drivers", "Verify gate is available"]), root, env);
  assert.equal(restored.code, 0, restored.stderr);
  return env;
}

const WORKFLOW_IMPORT_SEQUENCE = ["Validate GitHub access", "Preview GitHub to pm plan", "Gated GitHub to pm import",
  "Verify repeat import is a no-op", "Verify strict pm health", "Commit gated sync changes and open review PR"] as const;

test("the executable reusable workflow never publishes each adversarial fixture", async () => {
  const cases = [
    { body: GH_TOKEN, comment: "" },
    { body: "clean", comment: GH_TOKEN },
    { body: PERSONAL_EMAIL, comment: "" },
    { body: HOME_PATH, comment: "" },
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
        assert.ok(!result.stdout.includes(GH_TOKEN) && !result.stderr.includes(GH_TOKEN));
        assert.deepEqual(remoteRefs(bare), ["refs/heads/main"]);
        assert.ok(!fs.existsSync(env.REVIEW_RECEIPT!), "no review is opened after a gate failure");
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("the executable reusable workflow pushes only a clean import and creates or updates linked reviews", async () => {
  const { root, base, bare, git } = initSyncRepo();
  try {
    const env = await prepareWorkflowFixture(root, base);
    assert.equal(git(["switch", "-c", SYNC_BRANCH]).status, 0);
    const handle = githubHandler([issue(1, "Synthetic issue", "Reviewed public body.")]);
    await withMockGithub((req, res, url, server) => {
      if (req.url === "/repos/acme/widgets") jsonResponse(res, 200, { private: false });
      else handle(req, res, url, server);
    }, async () => {
      const result = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), root, { ...env,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE });
      assert.equal(result.code, 0, result.stderr + "\n" + result.stdout);
      assert.deepEqual(remoteRefs(bare), ["refs/heads/" + SYNC_BRANCH, "refs/heads/main"].sort());
      assert.match(fs.readFileSync(env.REVIEW_RECEIPT!, "utf8"), /https:\/\/github\.com\/acme\/widgets\/blob\/main\/\.agents\/pm\/issues\/[^)]+\.toon/);
      const lease = git(["rev-parse", "HEAD"]).stdout.trim();
      // Each Actions job starts from a fresh checkout, without old local journals.
      const nextRoot = path.join(base, "next-work");
      assert.equal(spawnSync("git", ["clone", "--branch", "main", bare, nextRoot], { encoding: "utf8" }).status, 0);
      const nextEnv = await prepareWorkflowFixture(nextRoot, base);
      assert.equal(spawnSync("git", ["-C", nextRoot, "switch", "-c", SYNC_BRANCH]).status, 0);
      assert.equal(spawnSync("git", ["-C", nextRoot, "config", "user.name", "Fixture"]).status, 0);
      assert.equal(spawnSync("git", ["-C", nextRoot, "config", "user.email", "fixture@users.noreply.github.com"]).status, 0);
      const update = await executeWorkflow(workflowShell(WORKFLOW_IMPORT_SEQUENCE), nextRoot, { ...nextEnv,
        PM_GITHUB_API_BASE: process.env.PM_GITHUB_API_BASE, SYNC_LEASE: lease, EXISTING_PR: "1" });
      assert.equal(update.code, 0, update.stderr + "\n" + update.stdout);
      assert.deepEqual(fs.readFileSync(env.REVIEW_ACTIONS!, "utf8").trim().split("\n"), ["create", "edit"]);
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

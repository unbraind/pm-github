/** Exercise reserved-ID recovery and repeat sync through a real PM CLI and tracker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { comments, create, getHistoryPath, getItemPath, init, normalizeItemId, readLocatedItem, renderPmCommand } from "@unbrained/pm-cli/sdk";
import { appendBlockerComments, buildCommentText, deriveAtomicItemId, importGithubAtomic, parseImportOptions, runImport, syncGithubCommentsToAnnotations, type BlockerReferenceState, type GhComment, type GhIssue } from "../index.ts";
import { appendGithubComment } from "../comment-mirror.ts";
import { assertGithubImportOwner, GithubImportOwnershipError } from "../import-ownership.ts";
import { withGithubInvocationScope } from "../workspace.ts";
import { withReservedIdRepair } from "../import-repair.ts";
import { readWorkflowFailure } from "../workflow-diagnostic.ts";
import { projectItemTag } from "../projects.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { captureStderr, jsonResponse, withMockGithub } from "./helpers/mock-github-server.ts";
import { decode } from "@toon-format/toon";
import { parse } from "yaml";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
const repo = "fixture/widgets";
const id = deriveAtomicItemId(repo, 7, "fixture-", normalizeItemId);
const issue: GhIssue = {
  number: 7, title: "Upstream issue", body: "Upstream issue body.", state: "open",
  labels: [], assignee: null, milestone: null, comments: 1, html_url: `https://github.com/${repo}/issues/7`,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};
const remoteComment: GhComment = {
  id: 42, user: { login: "fixture[bot]" }, created_at: "2026-01-01T03:04:05Z",
  body: `A long source comment. ${"Public fixture text. ".repeat(85)} <!-- pm-github:comment:19 --> followed by prose.`,
};
/** The repair command a refusal must offer, scoped to the exact tracker the failed import used. */
const repairArgs = (root: string) => ["--pm-path", root, "update", id, "--field", `github_url=${issue.html_url}`] as const;
/** The same command as the refusal renders it, for substring assertions on JSON and TOON output. */
const repairCommand = (root: string) => renderPmCommand([...repairArgs(root)]);
const localNotes = Array.from({ length: 17 }, (_, index) => `Local note ${index}. ${"Current work. ".repeat(95)}`);

/** Make a curated item with native history, plus a built project extension for CLI calls. */
async function fixture(t: TestContext, git = true, candidate = true) {
  const directory = mkdtempSync(join(tmpdir(), "pm-github-linked-import-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
  const client = { pmRoot, cwd: directory, author: "fixture", noExtensions: true };
  await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, client);
  if (candidate) {
    const extension = join(pmRoot, "extensions", "pm-github");
    mkdirSync(extension, { recursive: true });
    for (const file of ["dist", "manifest.json", "package.json"]) {
      cpSync(join(packageRoot, file), join(extension, file), { recursive: true });
    }
    symlinkSync(join(packageRoot, "node_modules"), join(extension, "node_modules"), "junction");
  }
  await create({ id, type: "Task", title: "Curated title", description: "Curated description.",
    body: "Curated body.", author: "fixture", tags: `gh:${repo}#7` }, client);
  const itemPath = getItemPath(pmRoot, "task", id);
  const historyPath = getHistoryPath(pmRoot, id);
  const environment = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "fixture",
    PM_GLOBAL_PATH: join(directory, "global"), GITHUB_TOKEN: "fixture" };
  return {
    directory, pmRoot, client, itemPath, environment,
    snapshot: () => ({ item: readFileSync(itemPath, "utf8"), history: readFileSync(historyPath, "utf8") }),
    invoke: (args: string[], api?: string) => boundedCli(process.execPath, [cli, "--path", pmRoot, ...args],
      directory, { ...environment, PM_GITHUB_API_BASE: api }),
  };
}

/** Return complete comment rows from the on-disk item with no SDK output projection. */
async function storedComments(itemPath: string) {
  return (await readLocatedItem({ itemPath, id, type: "task", item_format: "toon" })).document.metadata.comments!;
}

/**
 * A second ordinary tracker holding an item with the SAME id under a different
 * title. Executing a copied repair command from this directory must never
 * touch it: without the failing invocation's tracker selector the copy would
 * resolve this tracker instead and link the decoy item.
 */
async function decoyTracker(t: TestContext, itemId: string) {
  const directory = mkdtempSync(join(tmpdir(), "pm-github-repair-decoy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  const client = { pmRoot, cwd: directory, author: "fixture", noExtensions: true };
  await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, client);
  await create({ id: itemId, type: "Task", title: "Decoy title", description: "Decoy description.",
    body: "Decoy body.", author: "fixture" }, client);
  const environment: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(directory, "global") };
  delete environment.PM_PATH;
  return {
    directory, pmRoot,
    snapshot: () => ({
      item: readFileSync(getItemPath(pmRoot, "task", itemId), "utf8"),
      history: readFileSync(getHistoryPath(pmRoot, itemId), "utf8"),
    }),
    environment,
  };
}

/** Serve the GitHub issue and its comments without credentials or remote writes. */
function source<T>(run: (base: string) => Promise<T>, record = issue) {
  return withMockGithub((req, res) => {
    const path = req.url?.split("?")[0];
    if (path?.endsWith("/comments")) jsonResponse(res, 200, [remoteComment]);
    else if (path?.endsWith("/timeline") || path?.endsWith("/releases")) jsonResponse(res, 200, []);
    else jsonResponse(res, 200, path?.endsWith("/issues/7") ? record : [record]);
  }, async server => {
    const result = await run(server.baseUrl);
    assert.ok(server.requests.length > 0);
    assert.ok(server.requests.every(request => request.method === "GET"));
    return result;
  });
}

test("reusable sync binds apply and repeat to the preview source and preserves all durable bytes", async t => {
  const tracker = await fixture(t);
  const linked = await tracker.invoke(["update", id, "--field", `github_url=${issue.html_url}`]);
  assert.equal(linked.code, 0, linked.stderr);
  const runner = mkdtempSync(join(tmpdir(), "pm-github-sync-runner-"));
  t.after(() => rmSync(runner, { recursive: true, force: true }));
  const closed: GhIssue = {
    ...issue, number: 8, html_url: `https://github.com/${repo}/issues/8`,
    title: "Closed mirror", body: "Blocked by #7\r\n\r\nSource body.  \r\n",
    state: "closed", state_reason: "completed", closed_at: issue.updated_at,
    labels: [{ name: "first" }, { name: "second" }],
  };
  const canceled: GhIssue = {
    ...closed, number: 9, html_url: `https://github.com/${repo}/issues/9`,
    title: "Canceled mirror", state_reason: "not_planned", comments: 0,
  };
  let issues = [issue, closed, canceled];
  let comment = remoteComment;
  let closingCommit = "a".repeat(40);
  const workflow = parse(readFileSync(join(packageRoot, ".github/workflows/pm-github-sync.yml"), "utf8")) as
    { jobs: { "gated-sync": { steps: Array<{ name: string; run?: string }> } } };
  writeFileSync(join(runner, "pm-github-sync-scope.sh"), [
    'tracker_scope=( ".agents/pm/issues" ".agents/pm/tasks" ".agents/pm/history" )',
    'stage_sync_paths() { git add -- "$@"; }',
    'report_workflow_failure() { pm github workflow-diagnostic --report "$1" --error-file "$2" --diff "${3:-/dev/null}" --json; }',
  ].join("\n"));
  const preview = "Preview GitHub to pm plan";
  const apply = "Gated GitHub to pm import";
  const repeat = "Verify repeat import is a no-op";
  const report = join(runner, "pm-github-import.json");

  /** Retain the native item documents and append-only history streams. */
  const durable = () => readdirSync(tracker.pmRoot, { recursive: true }).map(String)
    .filter(file => /^(?:issues|tasks)\/.*\.toon$|^history\/.*\.jsonl$/.test(file)).sort()
    .map(file => [file, readFileSync(join(tracker.pmRoot, file), "utf8")]);

  await withMockGithub((req, res) => {
    const url = req.url?.split("?")[0];
    if (url?.endsWith("/comments")) jsonResponse(res, 200, [comment]);
    else if (url?.endsWith("/timeline")) jsonResponse(res, 200, [{
      event: "closed", created_at: closed.closed_at, commit_id: closingCommit,
    }]);
    else jsonResponse(res, 200, issues);
  }, async server => {
    /** Execute the checked-in workflow steps with the real local CLI. */
    const step = (name: string) => boundedCli("bash", ["-c", workflow.jobs["gated-sync"].steps.find(step => step.name === name)!.run!],
      tracker.directory, { ...tracker.environment, PM_GITHUB_API_BASE: server.baseUrl, REPOSITORY: repo,
        RUNNER_TEMP: runner, PATH: join(packageRoot, "node_modules/.bin") + delimiter + process.env.PATH });
    const original = durable();
    const planned = await step(preview);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const expected = JSON.parse(readFileSync(report, "utf8")).source_snapshot;
    assert.match(expected, /^[a-f0-9]{64}$/);
    issues = [];
    let outcome = await step(apply);
    assert.notEqual(outcome.code, 0);
    assert.match(outcome.stdout, /source drift.*No branch was published/);
    assert.deepEqual(durable(), original);

    issues = [issue, closed, canceled];
    outcome = await step(apply);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).addedComments, 1);
    assert.equal((await storedComments(tracker.itemPath)).length, 1);
    assert.match(tracker.snapshot().item, /Curated body\./);
    const afterApply = durable();
    comment = { ...remoteComment, body: "An edit to the same source comment." };
    outcome = await step(repeat);
    assert.notEqual(outcome.code, 0);
    assert.match(outcome.stdout, /source drift.*No branch was published/);
    assert.deepEqual(durable(), afterApply);

    comment = remoteComment;
    closingCommit = "b".repeat(40);
    outcome = await step(repeat);
    assert.notEqual(outcome.code, 0);
    assert.match(outcome.stdout, /source drift.*No branch was published/);
    assert.deepEqual(durable(), afterApply);

    closingCommit = "a".repeat(40);
    issues = [canceled, { ...closed, labels: [...closed.labels].reverse() }, issue];
    outcome = await step(repeat);
    assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
    const repeated = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(repeated.source_snapshot, expected);
    assert.equal(repeated.unchanged, true);
    assert.deepEqual(durable(), afterApply);
    const diff = spawnSync("git", ["diff", "--exit-code", "--", ".agents/pm/issues", ".agents/pm/tasks", ".agents/pm/history"], { cwd: tracker.directory });
    assert.equal(diff.status, 0);
  });
});

test("reusable sync diagnoses an incompatible published hold and rejects malformed snapshot receipts", async t => {
  const tracker = await fixture(t, false, false);
  const version = "2026.11.26";
  const environment: NodeJS.ProcessEnv = { ...tracker.environment, NPM_CONFIG_USERCONFIG: "/dev/null" };
  for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_MEDIA_SERVER"]) delete environment[key];
  const installed = await boundedCli(process.execPath, [cli, "--path", tracker.pmRoot, "package", "install",
    `npm:pm-github@${version}`, "--project"], tracker.directory, environment, 90_000);
  assert.equal(installed.code, 0, installed.stderr);
  const manifest = JSON.parse(readFileSync(join(tracker.pmRoot, "extensions", "pm-github", "package.json"), "utf8"));
  assert.equal(manifest.version, version);
  const linked = await tracker.invoke(["update", id, "--field", `github_url=${issue.html_url}`]);
  assert.equal(linked.code, 0, linked.stderr);
  const runner = join(tracker.directory, "runner");
  mkdirSync(runner);
  writeFileSync(join(runner, "pm-github-sync-scope.sh"), "report_workflow_failure() { printf 'Preview command failed\\n'; }\n");
  const workflow = parse(readFileSync(join(packageRoot, ".github/workflows/pm-github-sync.yml"), "utf8")) as
    { jobs: { "gated-sync": { steps: Array<{ name: string; run?: string }> } } };
  const script = workflow.jobs["gated-sync"].steps.find(step => step.name === "Preview GitHub to pm plan")!.run!;
  const before = tracker.snapshot();
  await source(async base => {
    const outcome = await boundedCli("bash", ["-c", script], tracker.directory, { ...environment,
      PM_GITHUB_API_BASE: base, PM_GITHUB_VERSION: version, REPOSITORY: repo, RUNNER_TEMP: runner,
      PATH: join(packageRoot, "node_modules/.bin") + delimiter + process.env.PATH });
    assert.equal(outcome.code, 1, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /pm-github 2026\.11\.26.*valid source_snapshot.*Remove the pm-github-version hold.*--expect-source.*No branch was published/);
    const report = JSON.parse(readFileSync(join(runner, "pm-github-import.json"), "utf8"));
    assert.equal(report.source_snapshot, undefined);
    assert.deepEqual(tracker.snapshot(), before);
  });

  const valid = JSON.stringify({ source_snapshot: "a".repeat(64) });
  const invalid = ["{}", JSON.stringify({ source_snapshot: 7 }), JSON.stringify({ source_snapshot: "a".repeat(64) + "\n" }), valid + "\n{}"];
  const shim = 'pm() { printf "%s\\n" "${FIXTURE_PREVIEW}"; }\n';
  for (const preview of [...invalid, valid]) {
    const outcome = await boundedCli("bash", ["-c", shim + script], tracker.directory, { ...environment,
      FIXTURE_PREVIEW: preview, PM_GITHUB_VERSION: version, REPOSITORY: repo, RUNNER_TEMP: runner });
    assert.equal(outcome.code, preview === valid ? 0 : 1, outcome.stdout + outcome.stderr);
    assert.equal(readFileSync(join(runner, "pm-github-source-snapshot"), "utf8"), preview === valid ? "a".repeat(64) + "\n" : "");
  }
});

test("sync pin guides explain the snapshot requirement and how old holds recover", () => {
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8").split("## Self-versioned workflows and Dependabot")[1]!.split("\n## ")[0]!;
  for (const doc of [readme, ...["docs/daily-sync-recovery.md", "docs/workflow-version-callers.md"].map(file => readFileSync(join(packageRoot, file), "utf8"))]) {
    assert.match(doc, /source_snapshot/);
    assert.match(doc, /--expect-source|snapshot support/);
    assert.match(doc, /2026\.11\.26/);
    assert.match(doc, /remove (?:the old |the )?.{0,35}hold/i);
  }
});

test("reusable sync reports citation ownership remedies before checking snapshot support", async t => {
  const tracker = await fixture(t, false);
  const candidates = [];
  for (const title of [`Fix ${repo}#7`, `Handle ${repo}#7`]) candidates.push((await create({ type: "Task", title }, tracker.client)).item);
  const files = candidates.flatMap(item => [getItemPath(tracker.pmRoot, "Task", item.id), getHistoryPath(tracker.pmRoot, item.id)]);
  const runner = join(tracker.directory, "runner");
  mkdirSync(runner);
  writeFileSync(join(runner, "pm-github-sync-scope.sh"), 'report_workflow_failure() { pm github workflow-diagnostic --report "$1" --error-file "$2" --json; }\n');
  const workflow = parse(readFileSync(join(packageRoot, ".github/workflows/pm-github-sync.yml"), "utf8")) as
    { jobs: { "gated-sync": { steps: Array<{ name: string; run?: string }> } } };
  const script = workflow.jobs["gated-sync"].steps.find(step => step.name === "Preview GitHub to pm plan")!.run!;
  const environment = { ...tracker.environment, ADOPT_CITED: "true", PM_GITHUB_VERSION: "2026.11.27",
    REPOSITORY: repo, RUNNER_TEMP: runner, PATH: join(packageRoot, "node_modules/.bin") + delimiter + process.env.PATH };
  const before = tracker.snapshot();
  const candidateBytes = files.map(file => readFileSync(file, "utf8"));
  await source(async base => {
    const outcome = await boundedCli("bash", ["-c", script], tracker.directory, { ...environment, PM_GITHUB_API_BASE: base });
    const report = JSON.parse(readFileSync(join(runner, "pm-github-import.json"), "utf8"));
    assert.equal(report.blocked, true);
    assert.equal(report.code, "ambiguous_citation");
    assert.equal(outcome.code, 1);
    assert.match(outcome.stdout, /ambiguous_citation.*Set github_url to https:\/\/github.com\/fixture\/widgets\/issues\/7/);
    assert.doesNotMatch(outcome.stdout, /pm-github-version hold/);
    const shim = 'pm() { if [[ "$1 $2" == "github import" ]]; then printf "%s\\n" "$BLOCKED_RECEIPT"; else command pm "$@"; fi; }\n';
    const contradictory = await boundedCli("bash", ["-c", shim + script], tracker.directory, { ...environment,
      BLOCKED_RECEIPT: JSON.stringify({ ...report, source_snapshot: "a".repeat(64) }) });
    assert.equal(contradictory.code, 1);
    assert.match(contradictory.stdout, /ambiguous_citation.*Set github_url/);
  });
  assert.deepEqual(tracker.snapshot(), before);
  assert.deepEqual(files.map(file => readFileSync(file, "utf8")), candidateBytes);
});

test("Projects CLI reports ambiguous links in JSON and TOON without writes in a non-git tracker", async t => {
  const tracker = await fixture(t, false);
  const ref = { owner: "fixture", number: 5 };
  const tags = ["first", "second"].map(card => projectItemTag(ref, card));
  const linked = await tracker.invoke(["update", id, "--add-tags", tags.join(",")]);
  assert.equal(linked.code, 0, linked.stderr);
  const before = tracker.snapshot();
  await withMockGithub((request, response, body) => {
    assert.equal(request.url, "/graphql");
    const { query } = JSON.parse(body);
    if (query.includes("projectV2(number:")) {
      jsonResponse(response, 200, { data: { organization: { projectV2: { id: "board", title: "Fixture board" } } } });
    } else {
      assert.match(query, /items\(first:/);
      const nodes = ["first", "second"].map(card => ({ id: card, content: { __typename: "DraftIssue", title: card } }));
      jsonResponse(response, 200, { data: { node: { items: { nodes, pageInfo: { hasNextPage: false } } } } });
    }
  }, async server => {
    for (const format of ["json", "toon"]) {
      const result = await tracker.invoke(["github", "project", "import", "fixture/5", "--output-format", format], server.baseUrl);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      if (format === "json") assert.match(result.stdout + result.stderr, /github_project_link_conflict/);
      assert.match(result.stdout + result.stderr, /Multiple project cards claim the same tracker item/);
      assert.deepEqual(tracker.snapshot(), before);
    }
  });
});

test("legacy TOON import reports annotation-only writes and accepts the same source on a non-git repeat", async t => {
  const tracker = await fixture(t, false);
  const linked = await tracker.invoke(["update", id, "--field", `github_url=${issue.html_url}`]);
  assert.equal(linked.code, 0, linked.stderr);
  await source(async base => {
    const args = ["gh-issues", "import", repo, "--atomic", "--output-format", "toon"];
    const prepared = await tracker.invoke(args, base);
    assert.equal(prepared.code, 0, prepared.stderr);
    const applied = await tracker.invoke([...args, "--comments-mode", "annotations"], base);
    assert.equal(applied.code, 0, applied.stderr);
    const annotation = decode(applied.stdout) as { updated: number; addedComments: number; unchanged?: boolean };
    assert.equal(annotation.updated, 0);
    assert.equal(annotation.addedComments, 1);
    assert.equal(annotation.unchanged, undefined);
    const initial = tracker.snapshot();
    const basePreview = await tracker.invoke([...args, "--comments-mode", "annotations", "--dry-run", "--gate"], base);
    assert.equal(basePreview.code, 0, basePreview.stderr);
    const { source_snapshot: expected } = decode(basePreview.stdout) as { source_snapshot: string };
    assert.match(expected, /^[a-f0-9]{64}$/);
    const result = await tracker.invoke([...args, "--comments-mode", "annotations", "--expect-source", expected], base);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((decode(result.stdout) as { unchanged: boolean }).unchanged, true);
    assert.deepEqual(tracker.snapshot(), initial);
    const invalid = await tracker.invoke([...args, "--expect-source", "bad"], base);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /requires the full source_snapshot/);
    assert.throws(() => parseImportOptions({ "expect-source": "" }), /requires the full source_snapshot/);
  });
});

test("snapshot-bound selected issues distinguish missing or excluded source from unreadable source in JSON and TOON", async t => {
  const tracker = await fixture(t, false);
  assert.equal((await tracker.invoke(["update", id, "--field", `github_url=${issue.html_url}`])).code, 0);
  const selectedPr = { ...issue, number: 8, html_url: `https://github.com/${repo}/pull/8`, comments: 0, pull_request: {} };
  const selectedIssue = { ...issue, comments: 0 };
  let issueStatus = 200;
  await withMockGithub((request, response) => {
    if (request.url?.endsWith("/issues/7")) jsonResponse(response, issueStatus, issueStatus === 200 ? selectedIssue : {});
    else if (request.url?.endsWith("/issues/8")) jsonResponse(response, 200, selectedPr);
    else jsonResponse(response, 200, []);
  }, async server => {
    const before = tracker.snapshot();
    const histories = readdirSync(join(tracker.pmRoot, "history")).sort();
    for (const format of ["json", "toon"] as const) {
      const command = format === "json" ? ["github", "import", repo] : ["gh-issues", "import", repo, "--atomic"];
      const args = [...command, "--output-format", format, "--issue", format === "json" ? "7" : "8,7"];
      const preview = await tracker.invoke([...args, "--include-prs", "--gate", "--dry-run"], server.baseUrl);
      assert.equal(preview.code, 0, preview.stderr);
      const snapshot = ((format === "json" ? JSON.parse(preview.stdout) : decode(preview.stdout)) as { source_snapshot: string }).source_snapshot;
      assert.match(snapshot, /^[a-f0-9]{64}$/);
      issueStatus = 404;
      const bound = await tracker.invoke([...args, "--include-prs", "--expect-source", snapshot], server.baseUrl);
      assert.notEqual(bound.code, 0);
      assert.match(bound.stderr, format === "json" ? /github_import_source_drift/ : /GitHub import source drift/i);
      const ordinary = await tracker.invoke([...args, "--include-prs"], server.baseUrl);
      assert.notEqual(ordinary.code, 0);
      assert.match(ordinary.stderr, /not found \(HTTP 404\)/);
      issueStatus = 403;
      const denied = await tracker.invoke([...args, "--include-prs", "--expect-source", snapshot], server.baseUrl);
      assert.notEqual(denied.code, 0);
      assert.match(denied.stderr, /HTTP 403/);
      assert.doesNotMatch(denied.stderr, /source drift|source_drift/i);
      issueStatus = 200;
      if (format === "toon") {
        const excluded = await tracker.invoke([...args, "--expect-source", snapshot], server.baseUrl);
        assert.notEqual(excluded.code, 0);
        assert.match(excluded.stderr, /GitHub import source drift/i);
      }
      assert.deepEqual(tracker.snapshot(), before);
      assert.deepEqual(readdirSync(join(tracker.pmRoot, "history")).sort(), histories);
    }
  });
});

test("gated import and the legacy alias report an executable, tracker-scoped reserved-ID repair in JSON and TOON", async t => {
  const tracker = await fixture(t);
  const decoy = await decoyTracker(t, id);
  const command = repairCommand(tracker.pmRoot);
  const original = tracker.snapshot();
  const decoyOriginal = decoy.snapshot();
  await source(async base => {
    for (const mode of [
      { cli: "github", flags: ["--atomic", "--gate", "--dry-run", "--json"] },
      { cli: "gh-issues", flags: ["--output-format", "toon"] },
    ]) {
      const refused = await tracker.invoke([mode.cli, "import", repo, ...mode.flags], base);
      assert.equal(refused.code, 2, refused.stderr);
      assert.ok(refused.stderr.includes(command), refused.stderr);
      if (mode.cli === "github") {
        const errorFile = join(tracker.directory, "sync-stderr.json");
        writeFileSync(errorFile, refused.stderr);
        const error = JSON.parse(refused.stderr.slice(refused.stderr.indexOf("{"))) as { code: string; examples: string[]; required: string };
        assert.equal(error.code, "github_import_owner_conflict");
        assert.ok(error.required.includes(command));
        assert.ok(error.examples.includes(command));
        const reason = readWorkflowFailure(undefined, errorFile, undefined).reason;
        assert.match(reason, new RegExp(`pm --pm-path .*update ${id} --field github_url=${issue.html_url.replaceAll("/", "\\/")}`), reason);
      }
      assert.deepEqual(tracker.snapshot(), original);
      assert.deepEqual(decoy.snapshot(), decoyOriginal);
    }
    // Copy the offered command verbatim into a different workspace directory and
    // run it there: the selector it carries must keep it on the failed import's
    // tracker, never on the same-ID item the decoy directory holds.
    const copied = await boundedCli(process.execPath, [cli, ...repairArgs(tracker.pmRoot)], decoy.directory, decoy.environment);
    assert.equal(copied.code, 0, copied.stderr);
    assert.deepEqual(decoy.snapshot(), decoyOriginal, "a copied repair must never touch another tracker's same-ID item");
    const preview = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stderr, /1 matched by provenance/);
    const applied = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--json"], base);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).imported, 0);
    assert.match(tracker.snapshot().item, /Curated title[\s\S]*Curated body\./);
  });
});

test("a reserved item with contradictory provenance keeps the plain refusal and no link offer", async t => {
  const tracker = await fixture(t);
  const wrongNumber = await tracker.invoke(["update", id, "--field", "github_number=8"]);
  assert.equal(wrongNumber.code, 0, wrongNumber.stderr);
  const original = tracker.snapshot();
  await source(async base => {
    const refused = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(refused.code, 2, refused.stderr);
    assert.ok(refused.stderr.includes("github_import_owner_conflict"), refused.stderr);
    assert.ok(!refused.stderr.includes("--field github_url="), "a link that would create contradictory ownership must not be offered");
    assert.ok(!refused.stderr.includes("pm update"), refused.stderr);
    assert.deepEqual(tracker.snapshot(), original);
    // The unrepairable refusal is stable: a retry names the same conflict and
    // still writes nothing.
    const retry = await tracker.invoke(["github", "import", repo, "--atomic", "--gate", "--dry-run", "--json"], base);
    assert.equal(retry.code, 2, retry.stderr);
    assert.deepEqual(tracker.snapshot(), original);
  });
});

test("only an unowned reserved creation target with consistent provenance receives the scoped link command", async () => {
  const command = repairCommand("tracker-b");
  const target = { id, repo, number: 7, allowCreate: true, mirrorContent: true };
  const createTarget = [{ ...target, id: "fixture-other" }, target];
  const alreadyLinked = { id, github_url: issue.html_url };
  const differentOwner = { id, github_url: issue.html_url.replace("/7", "/8") };
  const invalidClaims = { ...alreadyLinked, github_repo: "fixture/other", github_number: 9 };
  for (const [item, targets] of [
    [alreadyLinked, createTarget],
    [differentOwner, createTarget],
    [invalidClaims, createTarget],
    // Incomplete provenance that would contradict the offered link keeps the
    // plain refusal: a wrong github_number or github_repo must never be told to
    // link, because the next import would then see two owners and block.
    [{ id, github_number: 8 }, createTarget],
    [{ id, github_repo: "fixture/other" }, createTarget],
    [{ id, github_number: 8, github_repo: "fixture/widgets" }, createTarget],
    [{ id }, [{ ...target, allowCreate: false }]],
  ] as const) {
    await assert.rejects(withGithubInvocationScope("tracker-b", () => withReservedIdRepair(targets, async () => assertGithubImportOwner(item, target))), error =>
      error instanceof GithubImportOwnershipError && !error.message.includes(command));
  }
  for (const item of [{ id }, { id, github_number: 7 }, { id, github_repo: "fixture/widgets" }]) {
    await assert.rejects(withGithubInvocationScope("tracker-b", () => withReservedIdRepair(createTarget, async () => assertGithubImportOwner(item, target))),
      error => error instanceof Error && error.message.includes(command));
  }
  // An implicit selection stays implicit: the copy replays the caller's shell.
  await assert.rejects(withGithubInvocationScope(undefined, () => withReservedIdRepair(createTarget, async () => assertGithubImportOwner({ id }, target))),
    error => error instanceof Error && error.message.includes(`pm update ${id} --field github_url=${issue.html_url}`));
  const unrelated = new Error("Unrelated transaction failure");
  await assert.rejects(withGithubInvocationScope("tracker-b", () => withReservedIdRepair(createTarget, async () => { throw unrelated; })), error => error === unrelated);
});

test("issue-start help and documentation describe creating the tracked owner through import", async t => {
  const tracker = await fixture(t, false);
  for (const importer of ["github", "gh-issues"]) {
    const help = await tracker.invoke([importer, "import", "--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.ok(help.stdout.includes("pm github import <owner>/<repo> --issue <N>"), help.stdout);
    assert.ok(help.stdout.includes("<prefix>-github-<repo-hash>-<N>"), help.stdout);
  }
  const guide = readFileSync(join(packageRoot, "docs", "import-issue-work.md"), "utf8");
  assert.ok(guide.includes("pm github import <owner>/<repo> --issue <N>"));
  assert.ok(guide.includes("create an ordinary item with a generated ID"));
  // The repair guidance must state the limits of its own copy safety instead
  // of claiming cross-directory safety no selector can guarantee.
  const flatGuide = guide.replace(/\s+/g, " ");
  assert.ok(flatGuide.includes("Only an absolute selector keeps the command safe from any other directory."));
  assert.ok(flatGuide.includes("run the copy from the same directory and environment"));
});

test("native mirror records the source timestamp and recognizes existing long comments by ID", async t => {
  const tracker = await fixture(t, false);
  const legacy = { ...remoteComment, id: 50 };
  await comments(id, { add: `${legacy.body}\n\n<!-- pm-github:comment:50 -->`, author: "fixture[bot]" }, tracker.client);
  const [oldRow] = await storedComments(tracker.itemPath);
  const incoming = { ...remoteComment, user: null, body: "Second GitHub comment." };
  assert.deepEqual(await syncGithubCommentsToAnnotations(id, [{ ...legacy, body: "Edited remotely." }, incoming, incoming], tracker.pmRoot, 7),
    { added: 1, skipped: 2, failed: 0 });
  const rows = await storedComments(tracker.itemPath);
  const mirrored = rows.find(row => row.author === "github");
  assert.equal(mirrored?.created_at, incoming.created_at);
  assert.deepEqual(rows.find(row => row.author === "fixture[bot]"), oldRow);
});

test("invalid source comment timestamps are refused, never stored, and stay retryable", async t => {
  const tracker = await fixture(t, false);
  const malformed = [
    { ...remoteComment, id: 61, created_at: "", body: "Missing timestamp." },
    { ...remoteComment, id: 62, created_at: "not-a-timestamp", body: "Garbage timestamp." },
    { ...remoteComment, id: 63, created_at: "2026-02-31T25:61:61Z", body: "Out-of-range timestamp." },
    // Date parsing would roll these impossible or free-form dates forward;
    // the mirror must refuse them instead of storing a time that never existed.
    { ...remoteComment, id: 64, created_at: "2026-02-30T03:04:05Z", body: "Impossible calendar date." },
    { ...remoteComment, id: 65, created_at: "2027-02-29T00:00:00Z", body: "Non-leap-year February 29." },
    { ...remoteComment, id: 66, created_at: "February 31, 2026", body: "Free-form rolled date." },
    { ...remoteComment, id: 67, created_at: "2/31/2026", body: "Ambiguous rolled date." },
  ] satisfies GhComment[];
  const batch = [remoteComment, { ...remoteComment, id: 68, created_at: "2028-02-29T00:00:00Z", body: "A real leap day." }, ...malformed];
  const first = await captureStderr(() => syncGithubCommentsToAnnotations(id, batch, tracker.pmRoot, 7));
  assert.deepEqual(first.result, { added: 2, skipped: 0, failed: 7 });
  assert.match(first.stderr.join("\n"), /invalid source timestamp and was refused/);
  assert.doesNotMatch(first.stderr.join("\n"), /nothing was written/i);
  const rows = await storedComments(tracker.itemPath);
  assert.equal(rows.length, 2, "only the comments with real calendar timestamps may be stored");
  assert.equal(rows[0]!.created_at, remoteComment.created_at);
  const leap = rows.find(row => row.text.includes("A real leap day."));
  assert.equal(leap?.created_at, "2028-02-29T00:00:00Z");
  // A refused comment is never marked synced by its ID: the next sync retries
  // it, fails it again, and leaves the tracker byte-identical.
  const settled = tracker.snapshot();
  assert.deepEqual(await syncGithubCommentsToAnnotations(id, batch, tracker.pmRoot, 7), { added: 0, skipped: 2, failed: 7 });
  assert.deepEqual(tracker.snapshot(), settled, "a refused comment must never change the tracker");
  assert.equal((await storedComments(tracker.itemPath)).length, 2);
});

test("linked reserved-ID import repeats byte-for-byte with newer, long local comments", async t => {
  const tracker = await fixture(t);
  const repair = await tracker.invoke([...repairArgs(tracker.pmRoot)]);
  assert.equal(repair.code, 0, repair.stderr);
  for (const add of localNotes) await comments(id, { add }, tracker.client);
  const before = await storedComments(tracker.itemPath);
  assert.ok(before.every(comment => Date.parse(comment.created_at) > Date.parse(remoteComment.created_at)));
  await source(async base => {
    const args = ["github", "import", repo, "--state", "all", "--atomic", "--gate", "--with-comments", "--json"];
    const first = await tracker.invoke(args, base);
    assert.equal(first.code, 0, first.stderr);
    const snapshot = tracker.snapshot();
    const repeat = await tracker.invoke(args, base);
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).unchanged, true);
    assert.deepEqual(tracker.snapshot(), snapshot, "a repeated import must change neither the item nor its history");
    const rows = await storedComments(tracker.itemPath);
    const mirrored = rows.filter(row => row.author === remoteComment.user!.login);
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0]!.created_at, remoteComment.created_at);
    assert.deepEqual(rows.filter(row => row.author !== remoteComment.user!.login), before);
    assert.ok(mirrored[0]!.text.endsWith("<!-- pm-github:comment:42 -->"));
  });
});

test("an atomic import that meets a reserved item mid-transaction still refuses with the repair", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pm-github-atomic-repair-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  const client = { pmRoot, cwd: directory, author: "fixture", noExtensions: true };
  await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, client);
  // The item appears only after the import's own planning, inside its atomic
  // commit; the rethrow path must surface the repair refusal itself, not the
  // generic transaction-failure wrapper that would bury its typed code.
  const dependencies = {
    resolveToken: () => "fixture",
    fetchIssues: async () => [issue],
    fetchIssueComments: async () => [],
    commitAtomic: async (root: string, repoArg: string, entries: Parameters<typeof importGithubAtomic>[2], opts: Parameters<typeof importGithubAtomic>[3]) => {
      await create({ id, type: "Task", title: "Hand-created mid-flight", description: "d",
        body: "b", author: "fixture", tags: `gh:${repo}#7` }, client);
      return importGithubAtomic(root, repoArg, entries, opts);
    },
  };
  await assert.rejects(runImport(repo, pmRoot, parseImportOptions({ atomic: true }), dependencies), error => {
    const refusal = error as { code?: string; exitCode?: number; message: string };
    return refusal.code === "github_import_owner_conflict" && refusal.exitCode === 2 &&
      refusal.message.startsWith("If this item belongs to") &&
      refusal.message.includes(`pm update ${id} --field github_url=${issue.html_url}`);
  });
});

test("the comment mirror's release guidance replays the failing invocation's tracker selector", async t => {
  const tracker = await fixture(t, false);
  // Strict ownership enforcement turns a held item into a refused write; the
  // default preset would only warn and the comment would land.
  const strict = await tracker.invoke(["config", "project", "set", "governance.ownership_enforcement", "strict"]);
  assert.equal(strict.code, 0, strict.stderr);
  const held = await tracker.invoke(["claim", id]);
  assert.equal(held.code, 0, held.stderr);
  // The write is refused by the item's current owner; the guidance it renders
  // must release THIS tracker's item, not whatever tracker the copy runs in.
  await assert.rejects(withGithubInvocationScope("tracker-b", () => appendGithubComment(id, tracker.pmRoot, remoteComment, buildCommentText(remoteComment))), error => {
    const examples = (error as { context?: { examples?: string[] } }).context?.examples ?? [];
    return error instanceof Error && examples.includes(`pm --pm-path tracker-b release ${id}`);
  });
});

test("long grouped blocker comments stay deduplicated on preview and apply without Git", async t => {
  const tracker = await fixture(t, false);
  for (const add of localNotes) await comments(id, { add }, tracker.client);
  const states: BlockerReferenceState[] = Array.from({ length: 18 }, (_, index) => ({
    raw: `${repo}#${index + 1}`, repo, number: index + 1, form: "repo_hash", state: "closed",
    closed_at: "2026-01-01T00:00:00Z",
  }));
  const cleared = [{ itemId: id, states }];
  assert.deepEqual(await appendBlockerComments(tracker.pmRoot, cleared, false), { added: 1, skipped: 0, failed: 0 });
  const snapshot = tracker.snapshot();
  for (const dryRun of [true, false]) {
    assert.deepEqual(await appendBlockerComments(tracker.pmRoot, cleared, dryRun), { added: 0, skipped: 1, failed: 0 });
    assert.deepEqual(tracker.snapshot(), snapshot);
  }
});

/** Final review classes use real trackers, SDK policies and peer-native state. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { init, create, get, mutateItem, readSettings, getItemPath, getHistoryPath, comments,
  runWithActiveExtensions, setActiveExtensionHooks, listAllComplete, WorkspaceTransactionInterruptedError } from "@unbrained/pm-cli/sdk";
import { runImport, parseImportOptions, importGithubAtomic, prepareGithubImport, listUnfinishedGithubImports,
  readGithubImportPlan, resumeGithubImport, linkImportedDependencies, type GhIssue } from "../index.ts";
import { runCloseout, type CloseoutApi } from "../closeout.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

const repo = "o/r";
const source: GhIssue = { number: 8, title: "Source issue", body: "Public body", state: "open", labels: [], user: null, assignee: null, milestone: null,
  created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z", html_url: "https://github.com/o/r/issues/8" };
const comment = { id: 71, body: "Public comment", user: { login: "fixture" }, created_at: "2025-02-01T00:00:00Z" };

/** Isolate real tracker writes; gated cases also have an empty real Git worktree. */
async function tracker(run: (root: string) => Promise<void>, git = false) {
  const directory = mkdtempSync(join(tmpdir(), "github-r7-"));
  const root = join(directory, "tracker");
  try {
    if (git) assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Only remote source data is supplied; every item and annotation mutation is native. */
async function sync(root: string, atomic: boolean, gate = false, issues = [source]) {
  return captureStderr(() => runImport(repo, root, parseImportOptions({ atomic, gate, "with-comments": true, "comments-mode": "annotations" }), {
    resolveToken: () => undefined, fetchIssues: async () => issues, fetchIssueComments: async () => [comment], fetchIssueTimeline: async () => [],
  }));
}

/** Change explicit identities with the supported SDK mutation and retained history. */
async function own(root: string, id: string, url: string, number?: number) {
  await mutateItem({ pmRoot: root, id, settings: await readSettings(root), author: "fixture", op: "update", mutate: document => {
    document.metadata.github_url = url;
    if (number !== undefined) { document.metadata.github_repo = repo; document.metadata.github_number = number; }
    return { changedFields: ["github_url", "github_repo", "github_number"] };
  } });
}

/** Snapshot the native item and its audit stream together. */
async function bytes(root: string, id: string) {
  const item = (await get(id, {}, { pmRoot: root })).item;
  return [readFileSync(getItemPath(root, item.type!, id), "utf8"), readFileSync(getHistoryPath(root, id), "utf8")];
}

for (const atomic of [false, true]) for (const gate of [false, true]) test(`Round7 annotation refusal is best-effort after commit (atomic=${atomic}, gate=${gate})`, async () => tracker(async root => {
  let attempts = 0;
  let error: unknown;
  let result: Awaited<ReturnType<typeof sync>> | undefined;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "fixture-comments", run: context => {
      if (context.operation === "comment_add") { attempts++; return { allow: false, code: "fixture_comment_refused", remediation: "Retry source comments on the next normal sync" }; }
    } }] });
    try { result = await sync(root, atomic, gate); } catch (caught) { error = caught; }
  });
  assert.equal(attempts, 1, "Each entry must attempt annotation synchronization exactly once");
  const items = (await listAllComplete({}, { pmRoot: root })).items;
  assert.equal(items.length, 1); assert.equal(items[0]!.title, source.title);
  assert.deepEqual(await listUnfinishedGithubImports(root), []);
  const plans = join(root, "transactions/pm-github");
  assert.deepEqual(existsSync(plans) ? readdirSync(plans).filter(name => name.endsWith(".json")) : [], [], "A comment refusal must not retain a committed item plan");
  if (gate) assert.match(String(error), /1 planned write\(s\) failed/);
  else { assert.equal(error, undefined); assert.ok(result && "commentWriteFailures" in result.result); assert.equal(result.result.commentWriteFailures, 1); }
  await sync(root, atomic, gate);
  assert.equal((await comments(items[0]!.id, {}, { pmRoot: root })).comments.length, 1, "A later normal sync repairs side data without duplicating items");
}, true));

for (const gate of [false, true]) test(`Round7 annotation refusal during replay cleans the committed plan (gate=${gate})`, async () => tracker(async root => {
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({ "with-comments": true, "comments-mode": "annotations" }), undefined, undefined,
    async () => [comment], { items: [], releases: [], timeline: async () => [] }))!;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => {
    if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Committed before annotations");
  } }), /committed journal/);
  const item = (await listAllComplete({}, { pmRoot: root })).items[0]!;
  const before = await bytes(root, item.id);
  let attempts = 0;
  let error: unknown;
  let result: Awaited<ReturnType<typeof runImport>> | undefined;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "fixture-replay-comments", run: context => {
      if (context.operation === "comment_add") { attempts++; return { allow: false, code: "fixture_comment_refused", remediation: "Retry comments on normal sync" }; }
    } }] });
    try { result = (await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true, gate }), {
      fetchIssues: async () => { throw new Error("Replay cannot fetch changed source input"); },
    }))).result; } catch (caught) { error = caught; }
  });
  assert.equal(attempts, 1);
  assert.deepEqual(await bytes(root, item.id), before);
  assert.deepEqual(readdirSync(join(root, "transactions/pm-github")).filter(name => name.endsWith(".json")), []);
  if (gate) assert.match(String(error), /1 planned write\(s\) failed/);
  else { assert.equal(error, undefined); assert.ok(result && "commentWriteFailures" in result); assert.equal(result.commentWriteFailures, 1); }
  await sync(root, true, gate);
  assert.equal((await comments(item.id, {}, { pmRoot: root })).comments.length, 1);
}, true));

for (const replay of [false, true]) test(`Round7 annotation refusal through direct atomic API cleans its gated plan (replay=${replay})`, async () => tracker(async root => {
  const entry = (await prepareGithubImport(source, repo, parseImportOptions({ "with-comments": true, "comments-mode": "annotations" }), undefined, undefined,
    async () => [comment], { items: [], releases: [], timeline: async () => [] }))!;
  if (replay) await assert.rejects(() => importGithubAtomic(root, repo, [entry], { onTransition: context => {
    if (context.transition === "committed") throw new WorkspaceTransactionInterruptedError("Committed before comments");
  } }), /committed journal/);
  let attempts = 0;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "fixture-direct-comments", run: context => {
      if (context.operation === "comment_add") { attempts++; return { allow: false, code: "fixture_comment_refused", remediation: "Repair on next normal sync" }; }
    } }] });
    await assert.rejects(async () => {
      if (!replay) return importGithubAtomic(root, repo, [entry], { gate: true });
      const file = readdirSync(join(root, "transactions/pm-github")).find(name => name.endsWith(".json"))!;
      return resumeGithubImport(root, (await readGithubImportPlan(root, file.slice(0, -5)))!, { gate: true });
    }, /1 planned write\(s\) failed/);
  });
  assert.equal(attempts, 1);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
  assert.deepEqual(readdirSync(join(root, "transactions/pm-github")).filter(name => name.endsWith(".json")), []);
}, true));

for (const scenario of ["changed", "unchanged", "mixed"] as const) test(`Round7 atomic annotations synchronize each entry once (${scenario})`, async () => tracker(async root => {
  if (scenario !== "changed") await sync(root, true, false, [source]);
  const incoming = new Map([8, 9].map(number => [number, { ...comment, id: 100 + number }]));
  let attempts = 0;
  await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [], beforeMutation: [{ layer: "project", name: "annotation-pass-observer", run: context => {
      if (context.operation !== "comment_add") return;
      attempts++;
      // Native comment text is already prepared. Advancing only the incoming
      // fixture cursor makes an unwanted second sync produce an extra write.
      const remote = incoming.get(Number(context.before?.metadata.github_number));
      assert.ok(remote);
      remote.id++;
    } }] });
    await captureStderr(() => runImport(repo, root, parseImportOptions({ atomic: true, "with-comments": true, "comments-mode": "annotations" }), {
      resolveToken: () => undefined,
      fetchIssues: async () => scenario === "mixed" ? [source, { ...source, number: 9, html_url: "https://github.com/o/r/issues/9" }] : [source],
      fetchIssueComments: async issue => [incoming.get(issue.number)!], fetchIssueTimeline: async () => [],
    }));
  });
  assert.equal(attempts, scenario === "mixed" ? 2 : 1, "Every entry must make one annotation pass");
  for (const item of (await listAllComplete({}, { pmRoot: root })).items) {
    const stored = (await comments(item.id, {}, { pmRoot: root })).comments;
    assert.equal(stored.length, scenario !== "changed" && item.github_number === 8 ? 2 : 1);
    assert.ok(stored.some(entry => entry.text.includes(`pm-github:comment:${100 + Number(item.github_number)}`)));
  }
}));

for (const duplicate of ["target", "source", "contradictory", "none"] as const) test(`Round7 dependency ownership is unique (${duplicate})`, async () => tracker(async root => {
  const ids: string[] = [];
  for (const number of [7, 8, ...(duplicate === "target" ? [7] : duplicate === "source" ? [8] : [])]) {
    const item = (await create({ title: `Local ${number}`, type: "Task" }, { pmRoot: root })).item;
    await own(root, item.id, `https://github.com/o/r/issues/${number}`); ids.push(item.id);
  }
  if (duplicate === "contradictory") await own(root, ids[0]!, "https://github.com/o/r/issues/7", 9);
  if (duplicate === "none") for (let i = 0; i < 2; i++) {
    const mention = (await create({ title: "Shared reference", type: "Chore", tags: "gh:o/r#7" }, { pmRoot: root })).item;
    ids.push(mention.id);
  }
  const before = await Promise.all(ids.map(id => bytes(root, id)));
  const result = await linkImportedDependencies(repo, [{ ...source, body: "Blocked by #7" }], root);
  if (duplicate === "none") { assert.equal(result.linked, 1); assert.equal(result.failures.length, 0); }
  else {
    assert.equal(result.linked, 0);
    assert.match(result.failures.join("\n"), /ambiguous_github_dependency_owner/);
    for (const id of duplicate === "target" ? [ids[0]!, ids[2]!] : duplicate === "source" ? [ids[1]!, ids[2]!] : [ids[0]!]) assert.ok(result.failures.some(failure => failure.includes(id)));
    assert.deepEqual(await Promise.all(ids.map(id => bytes(root, id))), before);
  }
}));

for (const gate of [false, true]) test(`Round7 failed atomic preflight never starts a transaction (gate=${gate})`, async () => tracker(async root => {
  const unsafe = { ...source, body: "ghp_" + "A".repeat(36) };
  const entry = (await prepareGithubImport(unsafe, repo, parseImportOptions({}), undefined, undefined, undefined, { items: [], releases: [], timeline: async () => [] }))!;
  let transitions = 0;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { gate, onTransition: () => { transitions++; throw new WorkspaceTransactionInterruptedError("Must never reach the first mutation"); } }),
    (error: unknown) => (error as { code: string }).code === "github_import_preflight_failed");
  assert.equal(transitions, 0);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
  assert.equal(existsSync(join(root, "transactions")), false);
  entry.body = "Public body";
  let interrupted = false;
  await assert.rejects(() => importGithubAtomic(root, repo, [entry], { gate, onTransition: context => {
    if (!interrupted && context.transition === "prepared") { interrupted = true; throw new WorkspaceTransactionInterruptedError("Fixture interruption"); }
  } }), /interrupted/);
  const pending = await listUnfinishedGithubImports(root);
  assert.equal(pending.length, 1);
  const record = (await readGithubImportPlan(root, pending[0]!.transactionId))!;
  assert.equal(record.preflight?.verdict, "pass");
  await resumeGithubImport(root, record);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}));

/** Valid delivery evidence is shared by conflicting and unrelated local items. */
function delivery(body: string): CloseoutApi {
  const sha = "a".repeat(40);
  return { base: "https://api.github.com", next: () => undefined, get: async endpoint => ({ body: JSON.stringify(
    endpoint.includes("/pulls/") ? endpoint.includes("/commits?") ? [] : {
      number: 1, commits: 0, merged: true, merged_at: "2027-01-01T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: `https://github.com/${repo}/pull/1`,
      body, head: { sha }, base: { ref: "main", repo: { full_name: repo } },
    } : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
      : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "success", app: { id: 1 } }] } : []),
  }) };
}

for (const mode of ["eligible", "skip", "context", "foreign", "terminal", "epic"] as const) test(`Round7 closeout isolates explicit identity conflicts (${mode})`, async () => tracker(async root => {
  const bad = (await create({ title: "Conflicting delivery", type: mode === "epic" ? "Epic" : "Task", status: mode === "terminal" ? "canceled" : "in_progress", ...(mode === "terminal" ? { closeReason: "Fixture canceled delivery" } : {}) }, { pmRoot: root })).item;
  const good = (await create({ title: "Unrelated delivery", type: "Task", status: "in_progress" }, { pmRoot: root })).item;
  await own(root, bad.id, "https://github.com/other/project/issues/7", 8);
  const before = await bytes(root, bad.id);
  const link = (id: string) => `https://github.com/${repo}/blob/main/.agents/pm/tasks/${id}.toon`;
  const body = `${mode === "context" ? "Context" : "Closes"} ${mode === "foreign" ? link(bad.id).replace("github.com/o/r/", "github.com/other/project/") : link(bad.id)}\n\nCloses ${link(good.id)}`;
  const result = await runCloseout(root, repo, { pr: "1", apply: true, ...(mode === "skip" ? { skip: bad.id } : {}) }, delivery(body));
  assert.equal(result.closed, 1);
  assert.equal((await get(good.id, {}, { pmRoot: root })).item.status, "closed");
  assert.deepEqual(await bytes(root, bad.id), before);
  assert.equal(result.plan.find(row => row.item === bad.id)?.code, mode === "skip" ? "explicit_skip" : mode === "context" ? "not_delivery" : mode === "foreign" ? "other_repository" : mode === "terminal" ? "already_terminal" : mode === "epic" ? "epic" : "github_identity_conflict");
}));

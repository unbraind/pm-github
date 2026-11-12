/** Preserve the complete closeout selection matrix in a separately replayable workflow suite. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { get } from "@unbrained/pm-cli/sdk";
import type { runCloseout } from "../closeout.ts";
import { branch, claimKinds, fixture, setup } from "./helpers/closeout-workflow.ts";
import type { DecisionCase, WorkflowFixture } from "./helpers/closeout-workflow.ts";

/** Reuse immutable input baselines; the workflow resets Git and tracker state before every cell. */
interface SharedDecisionFixture {
  fixture: WorkflowFixture;
  cell: DecisionCase;
  environment: string;
  setupFiles: { path: string; contents: Buffer }[];
  release: () => void;
  done: Promise<void>;
}
const decisionFixtures = new Map<string, Promise<SharedDecisionFixture>>();

/** Retain real SDK/CLI/publication behavior while avoiding redundant fixture creation. */
async function decisionFixture(cell: DecisionCase): Promise<WorkflowFixture> {
  // A missing competitor needs its own unresolved-selector baseline for the ambiguous source.
  const key = `${cell.selection}/${cell.selection === "ambiguous" && cell.competitor === "none"}/${cell.selection === "claim kinds" && cell.primaryClaim === "delivery tag"}/${cell.selection === "claim kinds" && cell.competitor !== "none" && cell.competitorClaim === "delivery tag"}`;
  let pending = decisionFixtures.get(key);
  if (!pending) {
    let release = () => {};
    const lifetime = new Promise<void>(resolveLifetime => { release = resolveLifetime; });
    const sharedCell = { ...cell };
    pending = new Promise<SharedDecisionFixture>((resolveReady, reject) => {
      const done = fixture(async f => {
        const prepared = await f.run(setup);
        assert.equal(prepared.code, 0, prepared.out);
        const setupFiles = [join(f.pmRoot, "settings.json"), join(f.pmRoot, "history/_workspace.jsonl")]
          .filter(existsSync).map(path => ({ path, contents: readFileSync(path) }));
        resolveReady({ fixture: f, cell: sharedCell, release, done,
          environment: readFileSync(f.env.GITHUB_ENV!, "utf8"), setupFiles });
        await lifetime;
      }, sharedCell);
      void done.catch(reject);
    });
    decisionFixtures.set(key, pending);
  }
  const shared = await pending;
  Object.assign(shared.cell, cell);
  const f = shared.fixture;
  // Restore the disposable input even when a previous mutation-control cell failed before publication.
  f.git("reset", "--hard", "trunk");
  // Restore only workflow-owned setup inputs; publication restores these before committing.
  for (const file of shared.setupFiles) writeFileSync(file.path, file.contents);
  writeFileSync(f.env.GITHUB_ENV!, shared.environment);
  delete f.env.PEER_RETAG_APPLIED;
  // A prior cell's PR receipt must never count as publication by the current cell.
  for (const path of [f.env.PR_STATE!, f.env.PR_BODY!]) rmSync(path, { force: true });
  writeFileSync(f.env.RECEIPTS!, "");
  return f;
}

/** Release every initialized peer before aggregating setup and teardown failures. */
async function releaseDecisionFixtures(fixtures: Iterable<Promise<Pick<SharedDecisionFixture, "release" | "done">>>): Promise<void> {
  const setups = await Promise.allSettled(fixtures);
  const failures: unknown[] = [];
  const finished: Promise<void>[] = [];
  for (const result of setups) {
    if (result.status === "rejected") { failures.push(result.reason); continue; }
    try { result.value.release(); } catch (error) { failures.push(error); }
    finished.push(result.value.done);
  }
  for (const result of await Promise.allSettled(finished)) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Decision fixture cleanup failed");
}

test.after(() => releaseDecisionFixtures(decisionFixtures.values()));

test("decision cleanup releases initialized real fixtures despite setup and teardown failures", async () => {
  const roots: string[] = [];
  const forceRelease: (() => void)[] = [];
  const setupFailure = new Error("injected setup failure");
  const teardownFailure = new Error("injected teardown failure");
  const pending: Promise<Pick<SharedDecisionFixture, "release" | "done">>[] = [];
  /** Create real SDK trackers and HTTP evidence servers, then hold their lifetime. */
  function initialize(mode: "setup failure" | "teardown failure" | "success") {
    const ready = new Promise<Pick<SharedDecisionFixture, "release" | "done">>((resolveReady, reject) => {
      let release = () => {};
      const lifetime = new Promise<void>(resolveLifetime => { release = resolveLifetime; });
      forceRelease.push(release);
      const done = fixture(async f => {
        roots.push(f.base);
        if (mode === "setup failure") throw setupFailure;
        resolveReady({ release, done });
        await lifetime;
        if (mode === "teardown failure") throw teardownFailure;
      });
      void done.catch(reject);
    });
    pending.push(ready);
    return ready;
  }
  try {
    await assert.rejects(initialize("setup failure"), error => error === setupFailure);
    await initialize("teardown failure");
    await initialize("success");
    await assert.rejects(releaseDecisionFixtures(pending), (error: unknown) => {
      assert.ok(roots.every(root => !existsSync(root)), "initialized peers were cleaned before setup failure was reported");
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [setupFailure, teardownFailure]);
      return true;
    });
    assert.equal(roots.length, 3);
    assert.ok(roots.every(root => !existsSync(root)), "all real trackers and HTTP servers reached fixture cleanup");
  } finally {
    // Keep the regression itself leak-free when a behavioral revert fails early.
    for (const release of forceRelease) release();
    const initialized = await Promise.allSettled(pending);
    await Promise.allSettled(initialized.flatMap(result => result.status === "fulfilled" ? [result.value.done] : []));
  }
});


/** Retain all 36 selection/peer rows and cross both claim dimensions with all six evidence states. */
const decisionCases: DecisionCase[] = [];
for (const selection of ["explicit delivery tag", "single post-criteria claim", "ambiguous"] as const) {
  for (const competitor of ["none", "valid", "missing merge SHA", "failed evidence fetch", "failed checks", "pagination cut"] as const) {
    for (const peer of ["none", "retag mid-run"] as const) decisionCases.push({ selection, competitor, peer, primaryClaim: selection === "ambiguous" && competitor === "none" ? "mention-only" : "closing keyword", competitorClaim: "closing keyword" });
  }
}
for (const primaryClaim of claimKinds) for (const competitorClaim of claimKinds) {
  for (const competitor of ["none", "valid", "missing merge SHA", "failed evidence fetch", "failed checks", "pagination cut"] as const) {
    decisionCases.push({ selection: "claim kinds", competitor, peer: "none", primaryClaim, competitorClaim });
  }
}

/** Expected winners are defined from the table inputs, independently of the closeout implementation. */
function expectedDecision(cell: DecisionCase): { chosen?: number; candidates: number[]; context: number[]; held: boolean } {
  const { selection, competitor, peer, primaryClaim, competitorClaim } = cell;
  if (selection !== "claim kinds") {
    // Preserve the earlier mention-only input with an unmatched selector: it is context, not ambiguity.
    if (selection === "ambiguous" && competitor === "none") return { candidates: [], context: [2], held: false };
    const closes = selection !== "ambiguous" && (peer === "retag mid-run" ? selection === "explicit delivery tag" && competitor === "valid"
      : selection === "explicit delivery tag" || competitor !== "failed evidence fetch");
    return { chosen: closes ? peer === "retag mid-run" ? 1 : 2 : undefined, candidates: competitor === "none" ? [2] : [1, 2], context: [], held: !closes };
  }
  const primary = !["mention-only", "link-only"].includes(primaryClaim);
  const other = competitor !== "none" && (!["mention-only", "link-only"].includes(competitorClaim) || competitor === "failed evidence fetch");
  const tags = [primaryClaim === "delivery tag" ? 2 : 0, competitor !== "none" && competitorClaim === "delivery tag" ? 1 : 0].filter(Boolean);
  const candidates = [...(other ? [1] : []), ...(primary ? [2] : [])];
  const context = [...(competitor !== "none" && !other ? [1] : []), ...(!primary ? [2] : [])];
  const selected = tags.length === 1 ? tags[0] : tags.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
  const chosen = selected === 2 || (selected === 1 && competitor === "valid") ? selected : undefined;
  return { chosen, candidates, context, held: candidates.length > 0 && chosen === undefined };
}

for (const cell of decisionCases) {
  const { selection, competitor, peer, primaryClaim, competitorClaim } = cell;
  const expected = expectedDecision(cell);
  test(`item decision end to end: ${selection} / ${competitor} / ${peer} / primary=${primaryClaim} / competitor=${competitorClaim}`, async () => {
    const f = await decisionFixture(cell);
    const result = await f.run(["Prepare sync branch from default branch", "Close delivered tracker items", "Commit gated closeout changes and open review PR"]);
    const report = JSON.parse(readFileSync(join(f.base, "pm-github-closeout.json"), "utf8")) as Awaited<ReturnType<typeof runCloseout>>;
    const item = (await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item;
    assert.equal(f.env.PEER_RETAG_APPLIED === "true", peer === "retag mid-run");
    assert.equal(result.code, 0, result.out);
    const closes = expected.chosen !== undefined;
    const publishes = closes || expected.held;
    assert.equal(existsSync(f.env.PR_STATE!), publishes, "only a close or hold publishes tracker changes");
    assert.equal(item.status, closes ? "closed" : "in_progress", JSON.stringify(report));
    assert.equal(report.closed, closes ? 1 : 0);
    assert.equal(report.failed, 0);
    const published = publishes ? `refs/remotes/origin/${branch}` : "trunk";
    const itemPath = `.agents/pm/tasks/${f.id}.toon`;
    const publishedItem = f.git("show", `${published}:${itemPath}`);
    const localItem = readFileSync(join(f.root, itemPath), "utf8").trim();
    if (!publishes && peer === "retag mid-run") {
      assert.notEqual(publishedItem, localItem, "a peer edit alone stays local without a closeout publication");
      assert.deepEqual(item.tags, ["delivery-pr:https://github.com/acme/widgets/pull/1"]);
    } else assert.equal(publishedItem, localItem);
    const history = f.git("show", `${published}:.agents/pm/history/${f.id}.jsonl`);
    assert.equal(history.split('"op":"close"').length - 1, closes ? 1 : 0);
    const body = publishes ? readFileSync(f.env.PR_BODY!, "utf8") : "";
    assert.deepEqual(report.plan.filter(row => row.code === "not_delivery").map(row => row.pr).sort(), expected.context);
    for (const row of report.plan.filter(row => row.code === "not_delivery")) {
      assert.equal(row.action, "skip");
      assert.equal(row.candidates, undefined);
      assert.equal(row.missing_evidence, undefined);
      if (publishes) assert.match(body, new RegExp(`"pr": ${row.pr},\\s*"action": "skip",\\s*"code": "not_delivery"`));
    }
    if (closes) {
      const chosen = expected.chosen!;
      const provenance = JSON.parse(item.close_reason!) as { pr: number; url: string; head_sha: string; merge_commit_sha: string; merged_at: string; checks: string[] };
      assert.deepEqual(provenance, { pr: chosen, url: `https://github.com/acme/widgets/pull/${chosen}`, head_sha: String(chosen).repeat(40),
        merge_commit_sha: (chosen === 1 ? "a" : "b").repeat(40), merged_at: `2026-10-0${chosen === 1 ? 4 : 8}T00:00:00Z`, checks: ["CI"] });
      assert.equal(item.completed_at, provenance.merged_at.replace("Z", ".000Z"));
      assert.match(item.resolution!, new RegExp(`pull/${chosen} `));
      assert.equal(item.expected_result, item.acceptance_criteria);
      assert.ok(item.actual_result!.includes(provenance.merged_at));
      assert.deepEqual(report.plan.filter(row => row.code !== "not_delivery").sort((a, b) => a.pr - b.pr).map(row => [row.pr, row.action, row.code]),
        expected.candidates.map(pr => [pr, pr === chosen ? "close" : "skip", pr === chosen ? "head_checks_passed" : "duplicate_selection"]));
      assert.match(body, new RegExp(`"pr": ${chosen},\\s*"action": "close"`));
      assert.doesNotMatch(body, /"action": "needs_review"|"action": "refuse"/);
      assert.equal(f.git("ls-tree", "--name-only", published, ".agents/pm/closeout-review.json"), "");
    } else if (expected.held) {
      const held = report.plan.filter(row => row.code !== "not_delivery").sort((a, b) => a.pr - b.pr);
      assert.deepEqual(held.map(row => [row.pr, row.action, row.code, row.candidates]),
        expected.candidates.map(pr => [pr, "needs_review", "needs_review", expected.candidates]));
      for (const row of held) assert.ok(row.missing_evidence?.every(gap => expected.candidates.includes(gap.pr)) ?? true);
      const review = JSON.parse(f.git("show", `${published}:.agents/pm/closeout-review.json`)) as { needs_review: { candidates: number[] }[] };
      assert.deepEqual(review.needs_review.map(row => row.candidates), [expected.candidates]);
      assert.match(body, /"action": "needs_review"/);
      assert.doesNotMatch(body, /"action": "close"|"action": "refuse"/);
    } else {
      assert.ok(report.plan.every(row => row.action === "skip" && row.code === "not_delivery"));
      assert.equal(f.git("ls-tree", "--name-only", published, ".agents/pm/closeout-review.json"), "");
    }
    if (!closes) assert.doesNotMatch(readFileSync(f.env.RECEIPTS!, "utf8"), /pr merge .*--auto/);
  });
}

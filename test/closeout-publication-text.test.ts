/** The closeout PR title, summary sentence and action counts must agree with the plan the run wrote. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, get } from "@unbrained/pm-cli/sdk";
import { branch, fixture, finish, reviewTitle, setup, shell, title } from "./helpers/closeout-workflow.ts";

/** The published summary block embedded in the PR body between json fences. */
interface PublishedSummary {
  plan: { item: string; pr: number; action: string; code: string }[];
  counts: { close: number; refuse: number; skip: number; needs_review: number };
  skipped: Record<string, number>;
}

/** Every plan row as the closeout command's JSON receipt writes it. */
interface PlanRow { item: string; pr: number; action: string; code: string }

/** Codes the workflow projection folds into per-reason skip counts. */
const routineCodes = ["already_terminal", "other_repository", "duplicate_selection", "explicit_skip", "not_merged"] as const;

/** Independent oracle for the workflow's summary projection and per-action counts. */
function projectedPlan(rows: PlanRow[]): { action: string; code: string }[] {
  return rows.filter(row => !routineCodes.some(code => code === row.code))
    .map(row => ({ action: row.action === "skip" && row.code !== "not_delivery" ? "refuse" : row.action, code: row.code }));
}

/** Count the four published actions over the projected plan rows. */
function actionCounts(rows: PlanRow[]): { close: number; refuse: number; skip: number; needs_review: number } {
  const counts = { close: 0, refuse: 0, skip: 0, needs_review: 0 };
  for (const row of projectedPlan(rows)) {
    if (row.action === "close" || row.action === "refuse" || row.action === "skip" || row.action === "needs_review") counts[row.action]++;
    else assert.fail(`unexpected projected action: ${row.action}`);
  }
  return counts;
}

/** Parse the json summary block the PR body embeds. */
function publishedSummary(body: string): PublishedSummary {
  const block = /```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(block, "PR body embeds the closeout summary json block");
  return JSON.parse(block[1]!) as PublishedSummary;
}

/** The run's own closeout JSON receipt written under the runner temp directory. */
function planReceipt(base: string): PlanRow[] {
  return (JSON.parse(readFileSync(join(base, "pm-github-closeout.json"), "utf8")) as { plan: PlanRow[] }).plan;
}

test("a plan with no close action opens a review-only closeout PR that reports the per-action counts", async () => fixture(async f => {
  // A mentioned-only epic cannot be delivered by a pull request, so its rows are
  // refusals; the ambiguous delivery of the fixture item holds both for review.
  const epic = await create({ title: "Epic container mentioned without delivery", type: "Epic", author: "fixture" }, { pmRoot: f.pmRoot, noExtensions: true });
  f.git("add", "--", ".agents/pm");
  f.git("commit", "-qm", "Add epic container");
  f.git("push", "origin", "trunk");
  Object.assign(f.env, { AMBIGUOUS: "true", SUMMARY_ROWS: "true", SUMMARY_ITEM: epic.item.id });
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "in_progress");
  const receipts = readFileSync(f.env.RECEIPTS!, "utf8");
  assert.ok(receipts.includes(`--title ${reviewTitle}`), "the review-only plan takes the review-only PR title");
  assert.ok(!receipts.includes(`--title ${title}`), "closure wording never appears without a close action");
  assert.ok(f.git("show", `refs/remotes/origin/${branch}:.agents/pm/closeout-review.json`).length > 0);
  const body = readFileSync(f.env.PR_BODY!, "utf8");
  assert.match(body, /No items were closed by this closeout run; it records merged-PR closeout review candidates only\. Plan actions: close 0, skip 0, refuse 2, needs_review 2;/);
  assert.doesNotMatch(body, /verified delivery and head checks for closed items/);
  const summary = publishedSummary(body);
  assert.deepEqual(summary.counts, { close: 0, refuse: 2, skip: 0, needs_review: 2 });
  assert.deepEqual(summary.counts, actionCounts(planReceipt(f.base)));
  assert.equal(summary.skipped["other_repository"], 2);
  assert.deepEqual(summary.plan.map(row => [row.action, row.code]).sort(),
    [["needs_review", "needs_review"], ["needs_review", "needs_review"], ["refuse", "epic"], ["refuse", "epic"]]);
}));

test("a plan with at least one close action keeps the closure title, summary and counts", async () => fixture(async f => {
  f.env.SUMMARY_ROWS = "true";
  const result = await f.run([...setup, ...finish]);
  assert.equal(result.code, 0, result.out);
  assert.equal((await get(f.id, {}, { pmRoot: f.pmRoot, noExtensions: true })).item.status, "closed");
  const receipts = readFileSync(f.env.RECEIPTS!, "utf8");
  assert.ok(receipts.includes(`--title ${title}`), "a closing plan keeps the closure PR title");
  assert.ok(!receipts.includes(`--title ${reviewTitle}`));
  const body = readFileSync(f.env.PR_BODY!, "utf8");
  assert.match(body, /The closeout command verified delivery and head checks for closed items; needs_review items remain open with every candidate listed below\./);
  assert.doesNotMatch(body, /No items were closed by this closeout run/);
  const summary = publishedSummary(body);
  assert.deepEqual(summary.counts, { close: 1, refuse: 0, skip: 0, needs_review: 0 });
  assert.deepEqual(summary.counts, actionCounts(planReceipt(f.base)));
  assert.equal(summary.skipped["other_repository"], 1);
}));

/** Deterministic linear-congruential generator so the property corpus is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

test("for random action mixes the workflow's real title, summary and counts always agree with the plan", () => {
  const publication = shell("Commit gated closeout changes and open review PR");
  const filter = /jq '(\.plan as \$all[\s\S]*?)' "\$\{RUNNER_TEMP\}\/pm-github-closeout\.json" > "\$\{summary_file\}"/.exec(publication);
  assert.ok(filter, "the publication step derives the summary from the run's plan JSON");
  const derivation = /^closeout_publication_text\(\) \{[\s\S]*?^\}/m.exec(publication);
  assert.ok(derivation, "the publication step derives its title and summary sentence from the counts");
  const codes = ["already_terminal", "other_repository", "duplicate_selection", "explicit_skip", "not_merged", "unknown_item",
    "epic", "active_children", "not_delivery", "close_failed", "head_checks_passed", "head_checks_failed",
    "head_evidence_unavailable", "required_checks_unverified", "incomplete_merge", "needs_review",
    "github_import_owner_conflict", "github_identity_conflict"] as const;
  const actions = ["close", "skip", "needs_review"] as const;
  const random = seeded(20261122);
  const explicit: PlanRow[][] = [
    [],
    [{ item: "a", pr: 42, action: "skip", code: "not_delivery" }, { item: "b", pr: 42, action: "skip", code: "unknown_item" }, { item: "c", pr: 42, action: "needs_review", code: "needs_review" }],
    [{ item: "a", pr: 42, action: "close", code: "head_checks_passed" }, { item: "b", pr: 42, action: "skip", code: "not_delivery" }],
    [{ item: "a", pr: 42, action: "skip", code: "already_terminal" }, { item: "b", pr: 43, action: "skip", code: "not_merged" }],
  ];
  for (let round = 0; round < 250; round++) {
    const rows: PlanRow[] = explicit[round] ?? Array.from({ length: Math.floor(random() * 13) }, (_, index) => ({
      item: `pm-github-p${index}`, pr: 42 + Math.floor(random() * 3),
      action: actions[Math.floor(random() * actions.length)]!, code: codes[Math.floor(random() * codes.length)]!,
    }));
    const root = mkdtempSync(join(tmpdir(), "closeout-title-"));
    try {
      const closeoutFile = join(root, "pm-github-closeout.json");
      const summaryFile = join(root, "pm-github-closeout-summary.json");
      writeFileSync(closeoutFile, JSON.stringify({ command: "github closeout", repo: "acme/widgets", dry_run: false, plan: rows, checks: [], closed: 0, failed: 0 }));
      const projection: SpawnSyncReturns<string> = spawnSync("jq", [filter[1]!, closeoutFile], { encoding: "utf8" });
      assert.equal(projection.status, 0, projection.stderr);
      writeFileSync(summaryFile, projection.stdout);
      const summary = JSON.parse(projection.stdout) as PublishedSummary;
      const counts = actionCounts(rows);
      // The published counts match an independent computation over the same plan.
      assert.deepEqual(summary.counts, counts, JSON.stringify(rows));
      assert.deepEqual(summary.plan.map(row => [row.action, row.code]), projectedPlan(rows).map(row => [row.action, row.code]));
      const expectedSkipped: Record<string, number> = {};
      for (const row of rows) if (routineCodes.some(code => code === row.code)) expectedSkipped[row.code] = (expectedSkipped[row.code] ?? 0) + 1;
      assert.deepEqual(summary.skipped, expectedSkipped);
      // The real workflow function picks title and summary wording from those counts.
      const text: SpawnSyncReturns<string> = spawnSync("bash", ["-c", `${derivation[0]}\ncloseout_publication_text`],
        { encoding: "utf8", env: { ...process.env, summary_file: summaryFile, DEFAULT_BRANCH: "trunk" } });
      assert.equal(text.status, 0, text.stderr);
      const [derivedTitle, derivedSummary] = text.stdout.split("\n");
      if (counts.close > 0) {
        assert.equal(derivedTitle, title, JSON.stringify(rows));
        assert.match(derivedSummary!, /^The closeout command verified delivery and head checks for closed items;/, JSON.stringify(rows));
        assert.ok(!derivedSummary!.includes("No items were closed"), JSON.stringify(rows));
      } else {
        assert.equal(derivedTitle, reviewTitle, JSON.stringify(rows));
        const sentence = /^No items were closed by this closeout run; it records merged-PR closeout review candidates only\. Plan actions: close (\d+), skip (\d+), refuse (\d+), needs_review (\d+);/.exec(derivedSummary!);
        assert.ok(sentence, JSON.stringify(rows));
        assert.deepEqual(sentence.slice(1).map(Number), [counts.close, counts.skip, counts.refuse, counts.needs_review], JSON.stringify(rows));
        assert.ok(!derivedSummary!.includes("verified delivery and head checks for closed items"), JSON.stringify(rows));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

/** Non-git, real-tracker delivery selection and fail-closed ambiguity regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { create, get, update, runWithReproducibleProcessEnvironment } from "@unbrained/pm-cli/sdk";
import { compactCloseoutReport, runCloseout, type CloseoutApi } from "../closeout.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

const repo = "example/delivery";
const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;
/** Fixture controls only external evidence; item creation, edits and closeout use the SDK. */
interface SelectionOptions {
  dates: number[];
  criteriaDay?: number;
  tags?: number[];
  body?: "claim" | "mention" | "none";
  commits?: "claim" | "mention" | "invalid" | "error";
  history?: "missing" | "invalid" | "unverified";
  failure?: number;
  mentionPr?: number;
}

/** Run selection with git absent from PATH and inspect all durable completion evidence. */
async function selection(options: SelectionOptions) {
  const root = mkdtempSync(join(tmpdir(), "delivery-selection-"));
  const sdk = { pmRoot: root, noExtensions: true };
  try {
    const init = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], {
      cwd: root, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    assert.equal(init.status, 0, init.stderr);
    const item = await runWithReproducibleProcessEnvironment({ PM_CLOCK: at(1), PM_SEED: "delivery" }, async () =>
      (await create({ title: "Enforce acceptance criteria", type: "Issue", author: "fixture", acceptanceCriteria: "Initial criteria" }, sdk)).item);
    if (options.criteriaDay) await runWithReproducibleProcessEnvironment({ PM_CLOCK: at(options.criteriaDay), PM_SEED: "criteria" }, () =>
      update(item.id, { acceptanceCriteria: "Updated acceptance criteria" }, sdk));
    // A later unrelated edit must not move the acceptance cutoff.
    await runWithReproducibleProcessEnvironment({ PM_CLOCK: at(20), PM_SEED: "annotation" }, () =>
      update(item.id, { status: "in_progress", tags: options.tags?.map(n => `delivery-pr:${prUrl(n)}`).join(",") }, sdk));
    const historyPath = join(root, "history", `${item.id}.jsonl`);
    const validHistory = readFileSync(historyPath, "utf8");
    if (options.history === "missing") rmSync(historyPath);
    if (options.history === "invalid") writeFileSync(historyPath, "{invalid\n");
    if (options.history === "unverified") {
      const events = readFileSync(historyPath, "utf8").trim().split("\n");
      const first = JSON.parse(events[0]!) as { after_hash: string };
      first.after_hash = "broken";
      events[0] = JSON.stringify(first);
      writeFileSync(historyPath, events.join("\n") + "\n");
    }
    const reference = `https://github.com/${repo}/blob/main/.agents/pm/issues/${item.id}.toon`;
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async endpoint => {
      const number = Number(/\/pulls\/(\d+)/.exec(endpoint)?.[1]);
      const headNumber = Number.parseInt(/\/commits\/(\w{2})/.exec(endpoint)?.[1] ?? "00", 16);
      if (endpoint.includes("/commits?")) {
        if (options.commits === "error") throw new Error("Unavailable commit evidence");
        return { body: JSON.stringify(options.commits === "invalid" ? [{}] : options.commits ? [{ commit: {
          message: options.commits === "claim" ? `Closes ${item.id}\nSee ${reference}` : `See ${reference}`,
        } }] : []) };
      }
      const value = endpoint.includes("/pulls/") ? {
        number, merged: true, merged_at: at(options.dates[number - 1]!), merge_commit_sha: "b".repeat(40), html_url: prUrl(number),
        body: options.body === "none" ? "Routine work" : `${options.body === "mention" || options.mentionPr === number ? "See" : "Closes"} ${reference}`,
        head: { sha: number.toString(16).padStart(2, "0").repeat(20) }, base: { ref: "main", repo: { full_name: repo } },
      } : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: headNumber.toString(16).padStart(2, "0").repeat(20),
          status: "completed", conclusion: options.failure === headNumber ? "failure" : "success", app: { id: 1 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const before = options.history === "missing" ? "" : readFileSync(historyPath, "utf8");
    const report = await withEnv({ PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) }, () =>
      runCloseout(root, repo, { pr: options.dates.map((_, i) => String(i + 1)), apply: true }, api));
    if (options.history !== "missing") assert.equal(report.closed === 0 ? readFileSync(historyPath, "utf8") : before, before);
    if (options.history === "invalid") writeFileSync(historyPath, validHistory);
    const result = (await get(item.id, {}, sdk)).item;
    if (report.closed === 0 && !options.history) assert.equal(readFileSync(historyPath, "utf8"), before);
    return { report, item: result, history: options.history ? "" : readFileSync(historyPath, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("one claimed merged PR after acceptance closes without git at its merge time", async () => {
  const { report, item } = await selection({ dates: [8] });
  assert.equal(report.closed, 1);
  assert.equal(item.completed_at, "2026-10-08T00:00:00.000Z");
});

test("only the later PR after the last acceptance change supplies all close evidence", async () => {
  const { report, item, history } = await selection({ dates: [4, 8], criteriaDay: 7 });
  assert.equal(report.closed, 1);
  assert.deepEqual(report.plan.map(row => [row.pr, row.action]), [[1, "skip"], [2, "close"]]);
  assert.equal(item.completed_at, "2026-10-08T00:00:00.000Z");
  assert.match(item.resolution!, /pull\/2/);
  assert.match(item.actual_result!, /Merged at 2026-10-08/);
  assert.equal((JSON.parse(item.close_reason!) as { pr: number }).pr, 2);
  const event = history.trim().split("\n").map(line => JSON.parse(line) as { op: string; patch: { path: string; value: unknown }[] }).find(event => event.op === "close")!;
  for (const field of ["completed_at", "resolution", "actual_result", "close_reason"] as const) {
    assert.equal(event.patch.find(patch => patch.path === `/metadata/${field}`)!.value, item[field]);
  }
});

test("ambiguous linked merged PRs stay open with every candidate in compact review output", async () => {
  const { report, item } = await selection({ dates: [4, 8] });
  assert.equal(report.closed, 0);
  assert.equal(item.status, "in_progress");
  assert.ok(compactCloseoutReport(report).plan.every(row => row.action === "needs_review"));
  assert.deepEqual(report.plan.map(row => row.candidates), [[1, 2], [1, 2]]);
});

test("explicit delivery link selects its PR even when another claim merged later", async () => {
  const { report, item } = await selection({ dates: [4, 8], tags: [1] });
  assert.equal(report.closed, 1);
  assert.equal(item.completed_at, "2026-10-04T00:00:00.000Z");
});

test("explicit delivery link supplies attribution without description references", async () => {
  const { report } = await selection({ dates: [4, 8], tags: [2], body: "none" });
  assert.equal(report.closed, 1);
  assert.equal(report.plan[0]!.pr, 2);
});

for (const tags of [[1, 2], [99]]) test(`unresolved explicit delivery links hold all candidates: ${tags}`, async () => {
  const { report } = await selection({ dates: [4, 8], tags });
  assert.equal(report.closed, 0);
  assert.ok(report.plan.every(row => row.code === "needs_review"));
});

for (const history of ["missing", "invalid", "unverified"] as const) test(`unavailable acceptance history holds delivery: ${history}`, async () => {
  const { report } = await selection({ dates: [8], history });
  assert.equal(report.closed, 0);
  assert.equal(report.plan[0]!.code, "needs_review");
});

test("a claim before or equal to the acceptance change stays open", async () => {
  for (const day of [8, 9]) {
    const { report } = await selection({ dates: [8], criteriaDay: day });
    assert.equal(report.closed, 0);
    assert.equal(report.plan[0]!.code, "needs_review");
  }
});

test("a unique later claim with failing checks never falls back to an earlier PR", async () => {
  const { report } = await selection({ dates: [4, 8], criteriaDay: 7, failure: 2 });
  assert.equal(report.closed, 0);
  assert.deepEqual(report.plan.map(row => row.code), ["duplicate_selection", "head_checks_failed"]);
});

test("commit claims can supply unique delivery, while mentions and unavailable commits cannot", async () => {
  const { report } = await selection({ dates: [8], body: "none", commits: "claim" });
  assert.equal(report.closed, 1);
  const upgraded = await selection({ dates: [8], body: "mention", commits: "claim" });
  assert.equal(upgraded.report.closed, 1);
  for (const commits of ["mention", "invalid", "error"] as const) {
    const { report } = await selection({ dates: [8], body: "mention", commits });
    assert.equal(report.closed, 0);
    assert.equal(report.plan[0]!.code, "not_delivery");
  }
});


test("unreadable later commit claims never permit fallback to an earlier description claim", async () => {
  const { report } = await selection({ dates: [4, 8], mentionPr: 2, commits: "error" });
  assert.equal(report.closed, 0);
  assert.ok(report.plan.every(row => row.code === "needs_review"));
  assert.deepEqual(report.plan[0]!.candidates, [1, 2]);
});

test("unreadable commits before changed criteria cannot supply another qualifying claim", async () => {
  const { report } = await selection({ dates: [4, 8], criteriaDay: 7, mentionPr: 1, commits: "error" });
  assert.equal(report.closed, 1);
  assert.equal(report.plan.find(row => row.action === "close")!.pr, 2);
});

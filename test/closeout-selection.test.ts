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
  unlinkedPr?: number;
  errorPr?: number;
  since?: boolean;
  status?: "canceled";
  excluded?: boolean;
  container?: "epic" | "children";
  gap?: "missing-merged" | "merge-sha" | "invalid-merge-sha" | "merge-time" | "invalid-time" | "head-sha" | "missing-head" | "null-head" | "missing-checks" | "failed-checks" | "required-metadata" | "checks-fetch" | "checks-pagination" | "commits-fetch" | "invalid-commits" | "commits-pagination" | "commits-count" | "missing-commits-count" | "invalid-commits-count" | "pr-fetch";
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
      (await create({ title: "Enforce acceptance criteria", type: options.container === "epic" ? "Epic" : "Issue", author: "fixture", acceptanceCriteria: "Initial criteria" }, sdk)).item);
    if (options.criteriaDay) await runWithReproducibleProcessEnvironment({ PM_CLOCK: at(options.criteriaDay), PM_SEED: "criteria" }, () =>
      update(item.id, { acceptanceCriteria: "Updated acceptance criteria" }, sdk));
    // A later unrelated edit must not move the acceptance cutoff.
    await runWithReproducibleProcessEnvironment({ PM_CLOCK: at(20), PM_SEED: "annotation" }, () =>
      update(item.id, { status: "in_progress", tags: options.tags?.map(n => `delivery-pr:${prUrl(n)}`).join(",") }, sdk));
    if (options.container === "children") await create({ title: "Undelivered child", type: "Task", parent: item.id, author: "fixture" }, sdk);
    if (options.status) await update(item.id, { status: options.status }, sdk);
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
    const api: CloseoutApi = { base: "https://api.github.com", next: link => link, get: async endpoint => {
      const number = Number(/\/pulls\/(\d+)/.exec(endpoint)?.[1]);
      const headNumber = Number.parseInt(/\/commits\/(\w{2})/.exec(endpoint)?.[1] ?? "00", 16);
      if (endpoint.includes("/pulls?")) return { body: JSON.stringify(options.dates.map((day, i) => ({ number: i + 1, merged_at: options.gap === "merge-time" ? null : at(day), updated_at: at(day) }))) };
      const affected = number === 1 || headNumber === 1;
      if (number === 1 && options.gap === "pr-fetch" && !endpoint.includes("/commits?")) throw new Error("PR unavailable");
      if (options.gap === "required-metadata" && endpoint.includes("/branches/gap/")) throw new Error("HTTP 403");
      if (headNumber === 1 && options.gap === "checks-fetch" && endpoint.includes("/check-runs")) throw new Error("Checks unavailable");
      if (endpoint.includes("/commits?")) {
        if (number === 1 && options.gap === "invalid-commits") return { body: "[{}]" };
        if (number === 1 && options.gap === "commits-fetch") throw new Error("Commits unavailable");
        if (number === 1 && options.gap === "commits-pagination") return { body: "[]", linkHeader: endpoint };
        if (options.commits === "error" && (options.errorPr === undefined || options.errorPr === number)) throw new Error("Unavailable commit evidence");
        return { body: JSON.stringify(options.commits === "invalid" ? [{}] : options.commits ? [{ commit: {
          message: options.commits === "claim" ? `Closes ${item.id}\nSee ${reference}` : `See ${reference}`,
        } }] : []) };
      }
      const value = endpoint.includes("/pulls/") ? {
        number, commits: affected && options.gap === "invalid-commits-count" ? -1 : affected && options.gap === "missing-commits-count" ? undefined : affected && (options.gap === "commits-count" || options.gap === "invalid-commits") ? 1 : options.commits ? 1 : 0, merged: affected && options.gap === "missing-merged" ? undefined : true, merged_at: affected && options.gap === "merge-time" ? null : affected && options.gap === "invalid-time" ? "invalid" : at(options.dates[number - 1]!), merge_commit_sha: affected && options.gap === "merge-sha" ? null : affected && options.gap === "invalid-merge-sha" ? "invalid" : "b".repeat(40), html_url: prUrl(number),
        body: options.body === "none" || options.unlinkedPr === number ? "Routine work" : `${options.body === "mention" || options.mentionPr === number ? "See" : "Closes"} ${reference}`,
        head: affected && options.gap === "missing-head" ? undefined : affected && options.gap === "null-head" ? null : { sha: affected && options.gap === "head-sha" ? "invalid" : number.toString(16).padStart(2, "0").repeat(20) }, base: { ref: affected && options.gap === "required-metadata" ? "gap" : "main", repo: { full_name: repo } },
      } : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: headNumber.toString(16).padStart(2, "0").repeat(20),
          status: "completed", conclusion: options.failure === headNumber || (headNumber === 1 && options.gap === "failed-checks") ? "failure" : "success", app: { id: 1 } }] } : [];
      if (headNumber === 1 && endpoint.includes("/check-runs")) {
        if (options.gap === "missing-checks") return { body: JSON.stringify({ total_count: 0, check_runs: [] }) };
        if (options.gap === "checks-pagination") return { body: JSON.stringify({ total_count: 2, check_runs: [] }) };
      }
      return { body: JSON.stringify(value) };
    } };
    const before = options.history === "missing" ? "" : readFileSync(historyPath, "utf8");
    const report = await withEnv({ PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) }, () =>
      runCloseout(root, repo, { ...(options.since ? { since: at(1) } : { pr: options.dates.map((_, i) => String(i + 1)) }), skip: options.excluded ? item.id : undefined, apply: true }, api));
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
    assert.equal(report.plan[0]!.code, commits === "mention" ? "not_delivery" : "needs_review");
  }
});


test("unreadable later commit claims never permit fallback to an earlier description claim", async () => {
  const { report } = await selection({ dates: [4, 8], mentionPr: 2, commits: "error" });
  assert.equal(report.closed, 0);
  assert.ok(report.plan.every(row => row.code === "needs_review"));
  assert.deepEqual(report.plan[0]!.candidates, [1, 2]);
});

test("unreadable commits before changed criteria cannot supply another qualifying claim", async () => {
  const { report } = await selection({ dates: [4, 8], criteriaDay: 7, mentionPr: 1, commits: "error", errorPr: 1 });
  assert.equal(report.closed, 1);
  assert.equal(report.plan.find(row => row.action === "close")!.pr, 2);
});


for (const gap of ["missing-merged", "merge-sha", "invalid-merge-sha", "merge-time", "invalid-time", "head-sha", "missing-head", "null-head", "missing-checks", "failed-checks", "required-metadata", "checks-fetch", "checks-pagination", "commits-fetch", "invalid-commits", "commits-pagination", "commits-count", "missing-commits-count", "invalid-commits-count", "pr-fetch"] as const) {
  for (const other of [true, false]) test(`incomplete candidate holds attribution: ${gap}, other valid claim=${other}`, async () => {
    const { report, item } = await selection({ dates: other ? [8, 9] : [8], gap, mentionPr: gap === "commits-count" || gap === "missing-commits-count" || gap === "invalid-commits-count" ? 1 : undefined, tags: gap === "pr-fetch" && !other ? [1] : undefined });
    assert.equal(report.closed, 0);
    assert.equal(item.status, "in_progress");
    assert.ok(report.plan.length > 0);
    for (const row of report.plan) {
      assert.equal(row.action, gap === "failed-checks" && !other ? "skip" : "needs_review");
      if (gap === "failed-checks" && !other) continue;
      assert.deepEqual(row.candidates, other ? [1, 2] : [1]);
      if (gap !== "failed-checks") assert.ok(row.missing_evidence?.some(gap => gap.pr === 1), JSON.stringify(row));
    }
  });
}


test("since retains missing merge timestamps and holds the linked candidate", async () => {
  const { report } = await selection({ dates: [8, 9], gap: "merge-time", since: true });
  assert.equal(report.closed, 0);
  assert.deepEqual(report.plan[0]!.candidates, [1, 2]);
  assert.ok(report.plan[0]!.missing_evidence?.some(gap => gap.pr === 1));
});

test("an explicit valid delivery link resolves an incomplete competing candidate", async () => {
  const { report } = await selection({ dates: [8, 9], gap: "merge-sha", tags: [2] });
  assert.equal(report.closed, 1);
  assert.equal(report.plan.find(row => row.action === "close")!.pr, 2);
});

for (const scope of ["terminal", "excluded", "epic", "children"] as const) test(`unreadable PRs cannot select ineligible items: ${scope}`, async () => {
  const { report, item } = await selection({ dates: [8], gap: "pr-fetch", status: scope === "terminal" ? "canceled" : undefined,
    excluded: scope === "excluded", container: scope === "epic" || scope === "children" ? scope : undefined });
  assert.equal(report.closed, 0);
  assert.ok(report.plan.every(row => row.item !== item.id));
});


test("explicit delivery link cannot leave a held row for its closed item after a competing PR fetch fails", async () => {
  const { report, item } = await selection({ dates: [8, 9], gap: "pr-fetch", tags: [2] });
  assert.equal(report.closed, 1);
  assert.equal(item.status, "closed");
  assert.ok(report.plan.every(row => row.action !== "needs_review"));
});


for (const gap of ["commits-fetch", "invalid-commits", "commits-pagination", "commits-count", "missing-commits-count", "invalid-commits-count"] as const) {
  for (const other of [true, false]) test(`unreadable commit-only candidates hold attribution: ${gap}, other valid claim=${other}`, async () => {
    const { report, item } = await selection({ dates: other ? [8, 9] : [8], gap, unlinkedPr: 1 });
    assert.equal(report.closed, 0);
    assert.equal(item.status, "in_progress");
    assert.ok(report.plan.length > 0);
    for (const row of report.plan) {
      assert.equal(row.action, "needs_review");
      assert.deepEqual(row.candidates, other ? [1, 2] : [1]);
      assert.ok(row.missing_evidence?.some(gap => gap.pr === 1));
    }
  });
}

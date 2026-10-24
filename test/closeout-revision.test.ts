/** Schedule peer edits at read/write boundaries while retaining all real SDK persistence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { create, get, update, close, comments, docs, deleteItem, runWithActiveExtensions, setActiveExtensionServices, runWithReproducibleProcessEnvironment, PmCliError } from "@unbrained/pm-cli/sdk";
import { runCloseout, type CloseoutApi, type CloseoutObserver } from "../closeout.ts";

const repo = "fixture/project";
const prUrl = (number: number) => `https://github.com/${repo}/pull/${number}`;
const boundaries = ["snapshot", ...[1, 2].flatMap(n => ["pull", "protection", "rules", "checks", "statuses", "commits"].map(step => `${n}:${step}`)), "history", "selection", "before_close", "locked"];
const edits = ["retag", "criteria", "second_claim", "peer_close", "comment", "links"] as const;

/** Initialize one non-git tracker and inject edits at an observed real operation boundary. */
async function interleave(boundary: string, edit: typeof edits[number], twice = false, extraItems = false) {
  const root = mkdtempSync(join(tmpdir(), "closeout-revision-"));
  const sdk = { pmRoot: root, noExtensions: true };
  try {
    const initialized = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], {
      cwd: root, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(existsSync(join(root, ".git")), false);
    const item = (await create({ title: "Revision-bound delivery", type: "Issue", author: "fixture", acceptanceCriteria: "Original criteria" }, sdk)).item;
    await update(item.id, { status: "in_progress", tags: `delivery-pr:${prUrl(1)}` }, sdk);
    const others: string[] = [];
    if (extraItems) for (let n = 0; n < 2; n++) {
      const extra = (await create({ title: `Independent item ${n}`, type: "Issue", author: "fixture" }, sdk)).item;
      await update(extra.id, { status: "in_progress", tags: n === 0 ? `delivery-pr:${prUrl(1)}` : undefined }, sdk);
      others.push(extra.id);
    }
    let independentClosed = false;
    let injected = 0;
    let lockedRefusals = 0;
    let fetches = 0;
    /** A genuine peer operation; lock contention must refuse it before any persistence. */
    const peer = async () => {
      if (edit === "peer_close") await close(item.id, "Peer closure", { author: "peer", resolution: "Peer", expectedResult: "Peer", actualResult: "Peer" }, sdk);
      else if (edit === "comment") await comments(item.id, { add: "Peer annotation", author: "peer" }, sdk);
      else if (edit === "links") await docs(item.id, { add: ["README.md"], author: "peer" }, sdk);
      else await update(item.id, edit === "retag" ? { tags: `delivery-pr:${prUrl(2)}` }
        : edit === "second_claim" ? { addTags: [`delivery-pr:${prUrl(2)}`] }
        : { acceptanceCriteria: `Peer criteria ${injected}` }, sdk);
    };
    const observe = async (point: string) => {
      if (point === "locked" && extraItems && !independentClosed) {
        independentClosed = true;
        await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
          await update(others[1]!, { title: "Independent peer update" }, sdk);
          await close(others[1]!, "Independent peer closure", { resolution: "Peer", expectedResult: "Peer", actualResult: "Peer" }, sdk);
        });
      }
      if (point !== boundary || injected >= (twice ? 2 : 1)) return;
      injected++;
      if (point === "locked") {
        await assert.rejects(peer, (error: unknown) => error instanceof PmCliError && error.code === "lock_conflict");
        lockedRefusals++;
      } else await peer();
    };
    const observer: CloseoutObserver = observe;
    let currentPr = 1;
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async endpoint => {
      fetches++;
      const number = Number(/\/pulls\/(\d+)/.exec(endpoint)?.[1]);
      const kind = endpoint.includes("/commits?") ? "commits" : endpoint.includes("/pulls/") ? "pull"
        : endpoint.includes("/protection/") ? "protection" : endpoint.includes("/rules/") ? "rules"
        : endpoint.includes("/check-runs") ? "checks" : "statuses";
      if (kind === "pull") currentPr = number;
      const head = currentPr.toString().repeat(40);
      const value = kind === "pull" ? { number, body: `Closes ${item.id}${extraItems ? `\nCloses ${others[0]}` : ""}`, merged: true, commits: 0,
        merged_at: "2099-10-08T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: prUrl(number),
        head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } }
        : kind === "protection" ? { contexts: ["CI"], checks: [] }
        : kind === "checks" ? { total_count: 1, check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      await observe(`${currentPr}:${kind}`);
      return { body: JSON.stringify(value) };
    } };
    const report = await runCloseout(root, repo, { pr: ["1", "2"], apply: true }, api, observer);
    const final = (await get(item.id, { depth: "full" }, sdk)).item;
    const history = readFileSync(join(root, "history", `${item.id}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line) as { op: string; author: string; before_hash: string; after_hash: string });
    assert.equal(injected, twice ? 2 : 1);
    assert.equal(report.failed, 0);
    if (extraItems) {
      assert.equal((await get(others[0]!, {}, sdk)).item.status, "closed");
      const otherHistory = readFileSync(join(root, "history", `${others[0]}.jsonl`), "utf8");
      assert.equal(otherHistory.split('"op":"close"').length - 1, 1);
      assert.equal((await get(others[1]!, {}, sdk)).item.close_reason, "Independent peer closure");
    }
    if (boundary === "locked") {
      assert.equal(lockedRefusals, 1);
      assert.equal(report.closed, extraItems ? 2 : 1);
    } else if (edit === "peer_close") {
      assert.equal(report.closed, 0);
      assert.equal(final.close_reason, "Peer closure");
      assert.ok(report.plan.every(row => row.code === "already_terminal"));
    } else if (edit === "second_claim" || twice) {
      assert.equal(report.closed, 0);
      assert.equal(final.status, "in_progress");
      assert.ok(report.plan.every(row => row.action === "needs_review"));
      if (twice) assert.match(report.plan[0]!.reason, /changed again/);
    } else assert.equal(report.closed, extraItems ? 2 : 1);
    if (report.closed) {
      const chosen = (JSON.parse(final.close_reason!) as { pr: number }).pr;
      assert.equal(chosen, boundary !== "locked" && edit === "retag" ? 2 : 1);
      assert.deepEqual(final.tags, [`delivery-pr:${prUrl(chosen)}`]);
      assert.equal(final.expected_result, final.acceptance_criteria);
      assert.match(final.resolution!, new RegExp(`pull/${chosen} `));
      const eventIndex = history.findIndex(event => event.op === "close" && event.author === "pm-github");
      assert.equal(history[eventIndex]!.before_hash, history[eventIndex - 1]!.after_hash);
      assert.equal(history.filter(event => event.op === "close" && event.author === "pm-github").length, 1);
    } else assert.equal(history.filter(event => event.op === "close" && event.author === "pm-github").length, 0);
    assert.ok(fetches <= 24, "at most one re-selection");
    return report;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const boundary of boundaries) for (const edit of edits) {
  test(`revision-bound closeout: ${edit} at ${boundary}`, async () => { await interleave(boundary, edit); });
}
test("revision-bound closeout holds a second concurrent change after one re-selection", async () => { await interleave("before_close", "criteria", true); });

test("revision-bound closeout retries only its item and isolates its guard from other writes", async () => {
  await interleave("1:pull", "retag", false, true);
});

test("closeout refuses a removed authoritative snapshot before fetching or mutating", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-removed-"));
  try {
    const sdk = { pmRoot: root, noExtensions: true };
    const initialized = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], { cwd: root, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const item = (await create({ title: "Removed peer item", type: "Issue", author: "fixture" }, sdk)).item;
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async () => { throw new Error("Must not fetch"); } };
    await assert.rejects(() => runCloseout(root, repo, { pr: "1", apply: true }, api, async point => {
      if (point === "listed") await deleteItem(item.id, { author: "peer" }, sdk);
    }), /snapshot unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Exercise implicit SDK unblocking, including refused side effects during a re-selection. */
async function dependentScenario(mode: "stable" | "changed" | "retry_changed" | "handled") {
  const root = mkdtempSync(join(tmpdir(), "closeout-dependent-"));
  const sdk = { pmRoot: root, noExtensions: true };
  try {
    const initialized = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], { cwd: root, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const blocker = (await create({ title: "Blocker delivery", type: "Issue", author: "fixture" }, sdk)).item.id;
    const dependent = (await create({ title: "Dependent delivery", type: "Issue", author: "fixture" }, sdk)).item.id;
    const other = (await create({ title: "Peer prerequisite", type: "Issue", author: "fixture" }, sdk)).item.id;
    await update(blocker, { status: "in_progress" }, sdk);
    await update(dependent, { status: "blocked", blockedBy: blocker }, sdk);
    let locks = 0;
    let attempts = 0;
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async endpoint => {
      const head = "a".repeat(40);
      const value = endpoint.includes("/commits?") ? [] : endpoint.includes("/pulls/") ? { number: 1,
        body: `Closes https://github.com/${repo}/blob/main/.agents/pm/issues/${blocker}.toon${mode === "handled" ? `\nCloses https://github.com/${repo}/blob/main/.agents/pm/issues/${dependent}.toon` : ""}`, merged: true, commits: 0,
        merged_at: "2099-10-08T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: prUrl(1),
        head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } }
        : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const report = await runCloseout(root, repo, { pr: "1", apply: true }, api, async point => {
      if (point === "before_close" && ++attempts === 1 && mode === "retry_changed") await update(blocker, { title: "Peer edit before lock" }, sdk);
      if (point !== "locked") return;
      locks++;
      if ((mode === "changed" || mode === "handled") && locks === 1 || mode === "retry_changed" && locks === 2) {
        await runWithActiveExtensions({ path: root, noExtensions: true }, () => update(dependent, { blockedBy: other }, sdk));
      }
    });
    const item = (await get(dependent, { depth: "full" }, sdk)).item;
    assert.equal(report.failed, 0);
    assert.equal(report.closed, mode === "handled" ? 2 : 1);
    assert.equal(item.status, mode === "stable" ? "open" : mode === "handled" ? "closed" : "blocked");
    if (mode === "changed" || mode === "retry_changed") {
      assert.equal(item.blocked_by, other);
      const held = report.plan.find(row => row.item === dependent)!;
      assert.equal(held.action, "needs_review");
      assert.match(held.reason, mode === "changed" ? /no delivery evidence/ : /automatic unblock held/);
    }
    assert.equal(report.plan.filter(row => row.action === "close").length, report.closed);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const mode of ["stable", "changed", "retry_changed", "handled"] as const) test(`revision-bound SDK dependent update: ${mode}`, async () => {
  await dependentScenario(mode);
});


/** Pause the real SDK between its item write and history append, without replacing either write. */
test("closeout binds acceptance history to the same authoritative document revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-history-revision-"));
  const sdk = { pmRoot: root, noExtensions: true };
  let releasePeer = () => {};
  let peer: Promise<unknown> | undefined;
  try {
    const initialized = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], { cwd: root, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const id = await runWithReproducibleProcessEnvironment({ PM_CLOCK: "2026-10-01T00:00:00Z", PM_SEED: "history-revision", PM_CLOCK_TICK_MS: "1" }, async () => {
      const item = (await create({ title: "Acceptance history revision", type: "Issue", acceptanceCriteria: "Original criteria", author: "fixture" }, sdk)).item;
      await update(item.id, { status: "in_progress" }, sdk);
      return item.id;
    });
    let signalWritten = () => {};
    const written = new Promise<void>(resolve => { signalWritten = resolve; });
    const resume = new Promise<void>(resolve => { releasePeer = resolve; });
    peer = runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
      setActiveExtensionServices({ overrides: [{ layer: "project", name: "history-append-barrier", service: "history_append", run: async () => {
        signalWritten();
        await resume;
        return { handled: false };
      } }] });
      await runWithReproducibleProcessEnvironment({ PM_CLOCK: "2026-10-20T00:00:00Z", PM_SEED: "peer-history" }, () =>
        update(id, { acceptanceCriteria: "Peer criteria after the merge" }, sdk));
    });
    await written;
    assert.equal((await get(id, {}, sdk)).item.acceptance_criteria, "Peer criteria after the merge");
    const head = "a".repeat(40);
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async endpoint => {
      const value = endpoint.includes("/commits?") ? [] : endpoint.includes("/pulls/") ? { number: 1, body: `Closes ${id}`, merged: true, commits: 0,
        merged_at: "2026-10-08T00:00:00Z", merge_commit_sha: "b".repeat(40), html_url: prUrl(1), head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } }
        : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const report = await runCloseout(root, repo, { pr: "1", apply: true }, api, async point => {
      if (point === "selection") { releasePeer(); await peer; }
    });
    assert.equal(report.closed, 0);
    assert.equal(report.plan[0]!.action, "needs_review");
    assert.equal((await get(id, {}, sdk)).item.status, "in_progress");
    assert.ok(!readFileSync(join(root, "history", `${id}.jsonl`), "utf8").includes('"op":"close"'));
  } finally {
    releasePeer();
    await peer;
    rmSync(root, { recursive: true, force: true });
  }
});

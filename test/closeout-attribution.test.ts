/** Real PR shapes distinguish a reported gap from explicit delivery attribution. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { create, get, update, commitImportedItem, getItemPath, readSettings } from "@unbrained/pm-cli/sdk";
import { runCloseout, type CloseoutApi } from "../closeout.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

const repo = "unbraind/pm-ado";
const url = (n: number) => `https://github.com/${repo}/pull/${n}`;
const head = "a".repeat(40);
/** Minimal public text fetched with gh pr view; no reviewer summaries or identities retained. */
const recorded = [16, 19].map(n => JSON.parse(readFileSync(new URL(`./fixtures/closeout-attribution/pm-ado-${n}.json`, import.meta.url), "utf8")) as { number: number; body: string });

/** Real SDK tracker plus complete HTTP-boundary evidence; neither SDK nor mutation is mocked. */
async function scenario(linked: boolean, bodies?: string[], facts: Partial<Record<number, { at?: string; success?: boolean }>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "closeout-attribution-"));
  try {
    const init = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], { cwd: root, encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
    assert.equal(init.status, 0, init.stderr);
    const sdk = { pmRoot: root, noExtensions: true };
    const item = (await create({ title: "Enforce statement coverage", type: "Issue", author: "fixture" }, sdk)).item;
    await update(item.id, { status: "in_progress" }, sdk);
    if (linked) {
      await commitImportedItem({ pmRoot: root, id: item.id, itemPath: getItemPath(root, "Issue", item.id), settings: await readSettings(root),
        document: { metadata: { ...item, status: "in_progress", pr_url: url(19) }, body: "" }, author: "fixture", message: "Link delivery PR", conflictWarningPrefix: "fixture" });
    }
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async endpoint => {
      const n = Number(endpoint.split("/").at(-1));
      const evidenceNumber = endpoint.includes("/commits/") ? Number.parseInt(endpoint.split("/commits/")[1]!.slice(0, 2), 16) - 64 : n;
      const evidenceHead = (evidenceNumber + 64).toString(16).repeat(20);
      const value = endpoint.includes("/pulls/") ? { number: n, body: (bodies?.[[16, 19, 20].indexOf(n)] ?? recorded.find(p => p.number === n)!.body).replaceAll("pm-ado-5w3m", item.id),
        merged: true, merged_at: facts[n]?.at ?? (n === 16 ? "2026-10-04T12:58:08Z" : "2026-10-08T01:19:51Z"), merge_commit_sha: n.toString(16).repeat(20),
        html_url: url(n), head: { sha: evidenceHead }, base: { ref: "main", repo: { full_name: repo } } }
        : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 2, check_runs: [{ name: "CI", head_sha: evidenceHead, status: "completed", conclusion: facts[evidenceNumber]?.success === false ? "failure" : "success", app: { id: 7 } },
          { name: `Delivery ${evidenceNumber}`, head_sha: evidenceHead, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const report = await withEnv({ PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) }, () =>
      runCloseout(root, repo, { pr: bodies?.length === 3 ? ["16", "19", "20"] : ["16", "19"], apply: true }, api));
    return { report, item: (await get(item.id, {}, sdk)).item,
      history: readFileSync(join(root, "history", `${item.id}.jsonl`), "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("earlier gap report and later structured PM item delivery select #19 with consistent durable evidence without git", async () => {
  const { report, item, history } = await scenario(false);
  assert.equal(report.closed, 1);
  assert.deepEqual(report.plan.filter(row => row.code !== "unknown_item").map(row => [row.pr, row.action]), [[16, "skip"], [19, "close"]]);
  assert.equal(item.completed_at, "2026-10-08T01:19:51.000Z");
  assert.equal(item.resolution, `Delivered by ${url(19)} (merge 131313131313, head 535353535353)`);
  assert.equal(item.actual_result, "Merged at 2026-10-08T01:19:51Z; required checks satisfied; successful head checks: CI, Delivery 19");
  assert.equal(item.close_reason, JSON.stringify({ pr: 19, url: url(19), merge_commit_sha: (19).toString(16).repeat(20),
    head_sha: (19 + 64).toString(16).repeat(20), merged_at: "2026-10-08T01:19:51Z", checks: ["CI", "Delivery 19"] }));
  const closeEvent = history.trim().split("\n").map(line => JSON.parse(line) as { op: string; patch: { path: string; value: unknown }[] }).filter(event => event.op === "close");
  assert.equal(closeEvent.length, 1);
  for (const field of ["completed_at", "resolution", "actual_result", "close_reason"] as const) {
    assert.equal(closeEvent[0]!.patch.find(patch => patch.path === `/metadata/${field}`)!.value, item[field]);
  }
});

test("mention only remains open even with tracker PR metadata", async () => {
  const mention = "Leaves pm-ado-5w3m open; follow-up gap tracked in https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon";
  const { report, item, history } = await scenario(true, [mention, mention]);
  assert.equal(report.closed, 0);
  assert.deepEqual(report.plan.map(row => row.code), ["not_delivery", "not_delivery"]);
  assert.ok(report.plan.every(row => /mentioned, not delivered/i.test(row.reason)));
  assert.equal(item.status, "in_progress");
  assert.ok(!history.includes('"op":"close"'));
});

test("structured item lines with follow-up prose remain mentions", async () => {
  for (const suffix of [" leaves pm-ado-5w3m open", ") (follow-up gap tracked in this item)"]) {
    const { report, item } = await scenario(false, ["No delivery claim", `PM item: https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon${suffix}`]);
    assert.equal(report.closed, 0);
    assert.equal(report.plan[0]!.code, "not_delivery");
    assert.equal(item.status, "in_progress");
  }
});

test("closing a different item that shares a prefix never delivers the mentioned item", async () => {
  const { report, item } = await scenario(false, ["No delivery claim", "Closes pm-ado-5w3m-extra\nSee https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon"]);
  assert.equal(report.closed, 0);
  assert.equal(report.plan[0]!.code, "not_delivery");
  assert.equal(item.status, "in_progress");
});

test("closing item ids and pm-github trailers explicitly deliver without a canonical body link", async () => {
  for (const declaration of ["Closes pm-ado-5w3m", "- Fixes pm-ado-5w3m.", "pm-github: pm-ado-5w3m", "PM item: pm-ado-5w3m",
    "PM item: [delivery](https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon)", "*\tFixes\tpm-ado-5w3m!\t",
    "See https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/unrelated.toon\nSee https://github.com/other/repo/blob/main/.agents/pm/issues/pm-ado-5w3m.toon\nCloses pm-ado-5w3m"]) {
    const { report } = await scenario(false, ["No delivery claim", declaration]);
    assert.equal(report.closed, 1);
    assert.equal(report.plan[0]!.pr, 19);
  }
});

test("multiline keywords and trailers never declare delivery", async () => {
  for (const declaration of ["Closes\npm-ado-5w3m", "pm-github:\npm-ado-5w3m", "Closes\r\npm-ado-5w3m", "pm-github:\t\npm-ado-5w3m"]) {
    const { report, item } = await scenario(false, ["No delivery claim", declaration]);
    assert.equal(report.closed, 0, declaration);
    assert.equal(item.status, "in_progress");
    assert.ok(report.plan.every(row => row.action === "skip"));
  }
});

test("latest qualifying delivery wins while a third mention remains not_delivery", async () => {
  const mention = "See https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon";
  const { report, item } = await scenario(false, ["Closes pm-ado-5w3m", "pm-github: pm-ado-5w3m", mention]);
  assert.equal(report.closed, 1);
  assert.deepEqual(report.plan.map(row => [row.pr, row.code]), [[16, "duplicate_selection"], [19, "head_checks_passed"], [20, "not_delivery"]]);
  assert.equal(item.status, "closed");
});

test("merge time selects delivery independently of PR number and passing checks remain required", async () => {
  for (const facts of [
    { 16: { at: "2026-10-09T00:00:00Z" } },
    { 19: { success: false } },
  ]) {
    const { report, item } = await scenario(false, ["Closes pm-ado-5w3m", "pm-github: pm-ado-5w3m"], facts);
    assert.equal(report.closed, 1);
    assert.equal(report.plan.find(row => row.action === "close")!.pr, 16);
    assert.match(item.resolution!, /pull\/16/);
  }
});

test("many items and PRs preserve declaration boundaries, casing, punctuation and latest delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-many-declarations-"));
  try {
    const init = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "bulk"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const sdk = { pmRoot: root, noExtensions: true };
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await create({ title: `Delivery candidate ${i}`, type: "Issue", author: "fixture" }, sdk)).item.id);
    assert.ok(ids[29]!.includes("k"));
    const verbs = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "deliver", "delivers", "delivered"];
    const expected: string[] = [];
    const bodies = verbs.map((verb, i) => {
      const number = i + 1;
      expected.push(`${number}:${ids[i * 2]}`, `${number}:${ids[i * 2 + 1]}`);
      return [`- ${verb.toUpperCase()}\t${ids[i * 2]!.toUpperCase()}${i % 2 ? "." : "!"}\t`,
        `pm-github:\t${ids[i * 2 + 1]}`, `Closes ${ids[i * 2]}`,
        `Closes\n${ids[26]}`, `Reports ${ids[27]}`, `Closes ${ids[28]}!!`,
        `Closes ${ids[29]!.replace("k", "K")}`, "Closes unmatched-ß", "Closes unmatched-ſ", "Closes unmatched-Σ",
        `See https://github.com/${repo}/blob/main/.agents/pm/issues/${ids[25]}.toon`,
        ...(i < 2 ? [`Delivers ${ids[24]}`] : []),
      ].join("\r\n");
    });
    const api: CloseoutApi = { base: "https://api.github.com", next: () => undefined, get: async endpoint => {
      const n = Number(endpoint.split("/").at(-1));
      const value = endpoint.includes("/pulls/") ? { number: n, body: bodies[n - 1], merged: true,
        merged_at: "2026-10-08T01:19:51Z", merge_commit_sha: "b".repeat(40), html_url: url(n),
        head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } }
        : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const report = await runCloseout(root, repo, { pr: verbs.map((_, i) => String(i + 1)), "dry-run": true }, api);
    assert.equal(report.closed, 0);
    assert.equal(report.failed, 0);
    assert.equal(report.checks.length, 12);
    assert.equal(report.plan.length, 38);
    expected.push(`2:${ids[24]}`);
    assert.deepEqual(report.plan.filter(row => row.action === "close").map(row => `${row.pr}:${row.item}`).sort(), expected.sort());
    assert.deepEqual(report.plan.filter(row => row.code === "duplicate_selection").map(row => [row.pr, row.item]), [[1, ids[24]]]);
    assert.deepEqual(report.plan.filter(row => row.code === "not_delivery").map(row => [row.pr, row.item]), verbs.map((_, i) => [i + 1, ids[25]]));
    for (const id of ids) assert.equal((await get(id, {}, sdk)).item.status, "open");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Real PR shapes distinguish a reported gap from explicit delivery attribution. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, get, update, commitImportedItem, getItemPath, readSettings } from "@unbrained/pm-cli/sdk";
import { runCloseout, type CloseoutApi } from "../closeout.ts";

const repo = "unbraind/pm-ado";
const url = (n: number) => `https://github.com/${repo}/pull/${n}`;
const head = "a".repeat(40);
/** Minimal public text fetched with gh pr view; no reviewer summaries or identities retained. */
const recorded = [16, 19].map(n => JSON.parse(readFileSync(new URL(`./fixtures/closeout-attribution/pm-ado-${n}.json`, import.meta.url), "utf8")) as { number: number; body: string });

/** Real SDK tracker plus complete HTTP-boundary evidence; neither SDK nor mutation is mocked. */
async function scenario(linked: boolean, bodies?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "closeout-attribution-"));
  try {
    const init = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], { cwd: root, encoding: "utf8" });
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
      const value = endpoint.includes("/pulls/") ? { number: n, body: (bodies?.[[16, 19, 20].indexOf(n)] ?? recorded.find(p => p.number === n)!.body).replaceAll("pm-ado-5w3m", item.id),
        merged: true, merged_at: n === 16 ? "2026-10-04T12:58:08Z" : "2026-10-08T01:19:51Z", merge_commit_sha: "b".repeat(40),
        html_url: url(n), head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } }
        : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const report = await runCloseout(root, repo, { pr: bodies?.length === 3 ? ["16", "19", "20"] : ["16", "19"], apply: true }, api);
    return { report, item: (await get(item.id, {}, sdk)).item };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("real gap-reporting #16 and delivery #19 bare links never infer delivery from in-progress status", async () => {
  const { report, item } = await scenario(false);
  assert.equal(report.closed, 0);
  assert.deepEqual(report.plan.filter(row => row.code !== "unknown_item").map(row => [row.pr, row.code]), [[16, "not_delivery"], [19, "not_delivery"]]);
  assert.equal(item.status, "in_progress");
});

test("the item's explicit PR link selects real delivery #19 and its merge chronology", async () => {
  const { report, item } = await scenario(true);
  assert.equal(report.closed, 1);
  assert.ok(report.plan.some(row => row.pr === 16 && row.code === "not_delivery"));
  assert.ok(report.plan.some(row => row.pr === 19 && row.action === "close"));
  assert.equal(item.completed_at, "2026-10-08T01:19:51.000Z");
  assert.match(item.resolution!, /pull\/19/);
});

test("closing item ids and pm-github trailers explicitly deliver without a canonical body link", async () => {
  for (const declaration of ["Closes pm-ado-5w3m", "- Fixes pm-ado-5w3m.", "pm-github: pm-ado-5w3m", "*\tFixes\tpm-ado-5w3m!\t",
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

test("ambiguity applies to two claiming PRs while a third mention remains not_delivery", async () => {
  const mention = "See https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/pm-ado-5w3m.toon";
  const { report, item } = await scenario(false, ["Closes pm-ado-5w3m", "pm-github: pm-ado-5w3m", mention]);
  assert.equal(report.closed, 0);
  assert.deepEqual(report.plan.map(row => [row.pr, row.code]), [[16, "ambiguous_delivery"], [19, "ambiguous_delivery"], [20, "not_delivery"]]);
  assert.equal(item.status, "in_progress");
});

test("two explicit merged delivery claims remain ambiguous before any close", async () => {
  const { report, item } = await scenario(false, ["Closes pm-ado-5w3m", "pm-github: pm-ado-5w3m"]);
  assert.equal(report.closed, 0);
  assert.ok(report.plan.every(row => row.action === "skip" && row.code === "ambiguous_delivery"));
  assert.equal(item.status, "in_progress");
});

test("many items and PRs preserve declaration boundaries, casing, punctuation and ambiguity", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-many-declarations-"));
  try {
    const init = spawnSync(join(import.meta.dirname, "../node_modules/.bin/pm"), ["--pm-path", root, "init", "fixture"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const sdk = { pmRoot: root, noExtensions: true };
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await create({ title: `Delivery candidate ${i}`, type: "Issue", author: "fixture" }, sdk)).item.id);
    const verbs = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "deliver", "delivers", "delivered"];
    const expected: string[] = [];
    const bodies = verbs.map((verb, i) => {
      const number = i + 1;
      expected.push(`${number}:${ids[i * 2]}`, `${number}:${ids[i * 2 + 1]}`);
      return [`- ${verb.toUpperCase()}\t${ids[i * 2]!.toUpperCase()}${i % 2 ? "." : "!"}\t`,
        `pm-github:\t${ids[i * 2 + 1]}`, `Closes ${ids[i * 2]}`,
        `Closes\n${ids[26]}`, `Reports ${ids[27]}`, `Closes ${ids[28]}!!`,
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
    assert.deepEqual(report.plan.filter(row => row.action === "close").map(row => `${row.pr}:${row.item}`).sort(), expected.sort());
    assert.deepEqual(report.plan.filter(row => row.code === "ambiguous_delivery").map(row => [row.pr, row.item]), [[1, ids[24]], [2, ids[24]]]);
    assert.deepEqual(report.plan.filter(row => row.code === "not_delivery").map(row => [row.pr, row.item]), verbs.map((_, i) => [i + 1, ids[25]]));
    for (const id of ids) assert.equal((await get(id, {}, sdk)).item.status, "open");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

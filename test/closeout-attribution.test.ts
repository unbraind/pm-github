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
      const value = endpoint.includes("/pulls/") ? { number: n, body: (bodies?.[n === 16 ? 0 : 1] ?? recorded.find(p => p.number === n)!.body).replaceAll("pm-ado-5w3m", item.id),
        merged: true, merged_at: n === 16 ? "2026-10-04T12:58:08Z" : "2026-10-08T01:19:51Z", merge_commit_sha: "b".repeat(40),
        html_url: url(n), head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } }
        : endpoint.includes("/protection/") ? { contexts: ["CI"], checks: [] }
        : endpoint.includes("/check-runs") ? { total_count: 1, check_runs: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 } }] } : [];
      return { body: JSON.stringify(value) };
    } };
    const report = await runCloseout(root, repo, { pr: ["16", "19"], apply: true }, api);
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
  for (const declaration of ["Closes pm-ado-5w3m", "- Fixes pm-ado-5w3m.", "pm-github: pm-ado-5w3m",
    "See https://github.com/unbraind/pm-ado/blob/main/.agents/pm/issues/unrelated.toon\nSee https://github.com/other/repo/blob/main/.agents/pm/issues/pm-ado-5w3m.toon\nCloses pm-ado-5w3m"]) {
    const { report } = await scenario(false, ["No delivery claim", declaration]);
    assert.equal(report.closed, 1);
    assert.equal(report.plan[0]!.pr, 19);
  }
});

test("two explicit merged delivery claims remain ambiguous before any close", async () => {
  const { report, item } = await scenario(false, ["Closes pm-ado-5w3m", "pm-github: pm-ado-5w3m"]);
  assert.equal(report.closed, 0);
  assert.ok(report.plan.every(row => row.action === "skip" && row.code === "ambiguous_delivery"));
  assert.equal(item.status, "in_progress");
});

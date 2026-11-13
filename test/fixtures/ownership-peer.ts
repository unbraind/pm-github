/** Schedule a real SDK peer relink immediately before delegating to the real pinned CLI. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { get, mutateItem, getItemPath, getHistoryPath, readSettings, readHistoryEntries, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
import assert from "node:assert/strict";

/** The one-shot receipt records the exact peer revision the following CLI must preserve. */
export async function runOwnershipPeer(planFile: string): Promise<void> {
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as { root: string; id: string; receipt: string; realPm: string };
  if (!existsSync(plan.receipt)) {
    const item = (await get(plan.id, {}, { pmRoot: plan.root })).item;
    await mutateItem({ pmRoot: plan.root, id: plan.id, settings: await readSettings(plan.root), author: "fixture-peer", op: "update",
      message: "Peer relink before CLI write", mutate: document => {
        document.metadata.github_url = "https://github.com/other/project/issues/8";
        document.metadata.github_repo = "other/project"; document.metadata.github_number = 8;
        return { changedFields: ["github_url", "github_repo", "github_number"] };
      } });
    const history = verifyHistoryEntries(await readHistoryEntries(getHistoryPath(plan.root, plan.id), plan.id));
    assert.equal(history.ok, true, history.errors.join("; "));
    assert.equal(history.latest_after_hash, (await get(plan.id, {}, { pmRoot: plan.root })).item_hash);
    writeFileSync(plan.receipt, JSON.stringify([readFileSync(getItemPath(plan.root, item.type!, plan.id), "utf8"), readFileSync(getHistoryPath(plan.root, plan.id), "utf8")]));
  }
  const result = spawnSync(plan.realPm, process.argv.slice(2), { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

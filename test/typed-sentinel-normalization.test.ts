/** Typed SDK identities must survive importer comparison and unchanged detection. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { normalizeImportValue } from "../import-fidelity.ts";

test("GH-1614 importer normalization preserves literal typed assignee identities", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "github-typed-identities-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const client = new PmClient({ cwd, pmRoot: join(cwd, "tracker"), author: "fixture", noExtensions: true });
  await client.run("init", { prefix: "fixture", withPackages: false, agentGuidance: "skip" });
  const { item } = await client.create({ title: "Literal typed identity", type: "Task" });
  for (const assignee of ["none", "null", " Name "]) {
    await client.update(item.id, { assignee });
    const current = (await client.get(item.id)).item;
    assert.equal(current.assignee, assignee.trim());
    assert.equal(normalizeImportValue("assignee", assignee), current.assignee);
  }
  assert.equal(normalizeImportValue("sprint", "none"), "none");
  await client.update(item.id, { unset: ["assignee"] });
  assert.equal((await client.get(item.id)).item.assignee, undefined);
  assert.equal(normalizeImportValue("assignee", undefined), "");
});

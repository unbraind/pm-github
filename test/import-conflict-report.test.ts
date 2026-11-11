/** Execute the workflow's conflict projection; source/local text never enters the PR body. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("sync PR includes title/state conflicts from the pre-apply plan without quoting titles", () => {
  const workflow = readFileSync(new URL("../.github/workflows/pm-github-sync.yml", import.meta.url), "utf8");
  const command = workflow.split("\n").find(line => line.includes("jq -r '.plan[]?"))?.trim();
  assert.ok(command);
  const directory = mkdtempSync(join(tmpdir(), "import-conflicts-"));
  try {
    writeFileSync(join(directory, "pm-github-import.json"), JSON.stringify({ plan: [
      { issue: 1, identity: { title_conflict: true }, title: "Do not publish this text" },
      { issue: 2, identity: { conflict: { local: "open", github: "closed" } } },
      { issue: 3, identity: { title_conflict: true, conflict: {} } },
      { issue: 4, identity: {} },
    ] }));
    const result = spawnSync("bash", ["-euc", command], { env: { ...process.env, RUNNER_TEMP: directory }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(join(directory, "pm-github-import-conflicts.md"), "utf8");
    assert.match(output, /Issue #1: title differs/);
    assert.match(output, /Issue #2: state differs/);
    assert.match(output, /Issue #3: title differs.*state differs/);
    assert.doesNotMatch(output, /Issue #4|Do not publish/);
    assert.match(workflow, /cat "\$\{RUNNER_TEMP\}\/pm-github-import-conflicts.md"/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

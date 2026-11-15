/** The package changelog-date command retains its own heading grammar self-test. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("the changelog-date control's heading grammar accepts and rejects the matrix it claims to", () => {
  const script = resolve(import.meta.dirname, "../scripts/verify-release-changelog-date.sh");
  const run = spawnSync("bash", [script, "--self-test"], { encoding: "utf-8" });
  assert.equal(
    run.status,
    0,
    `the heading grammar disagreed with its own matrix:\n${run.stdout}\n${run.stderr}`,
  );
  // A self-test that silently checked nothing would also exit 0, so require the
  // matrix to have actually run.
  assert.ok(
    run.stdout.includes("ok - reject ## 2026.1.2 - 2026-13-40"),
    "the impossible-date case must be exercised, not skipped",
  );
  assert.ok(
    run.stdout.includes("ok - accept ## 2026.1.2"),
    "the bare-version case must be exercised, not skipped",
  );
});

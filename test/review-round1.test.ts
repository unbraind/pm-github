/** Regressions for reviewed documentation and fixture hygiene contracts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withReadOnlyDirectory } from "./helpers/read-only-directory.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("README gate links resolve to the published command heading", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /### `pm github gate`/);
  assert.match(readme, /\[`pm github gate`\]\(#pm-github-gate\)/);
  assert.doesNotMatch(readme, /#privacy-gate-pm-github-gate/);
});

test("coverage task current result records the verified exact-100 gate", () => {
  const task = fs.readFileSync(path.join(repoRoot, ".agents/pm/tasks/pm-github-9cjx.toon"), "utf8");
  const result = /^actual_result: (.*)$/m.exec(task)![1]!;
  assert.match(result, /100\/100\/100\/100/);
  assert.match(result, /passes/);
  assert.doesNotMatch(result, /gate fails/);
});

test("privacy fixtures never store the complete high-entropy secret literal", () => {
  const value = "Zj9kP2mQ7xW4" + "nB8vC5tR1sD";
  for (const filename of ["gate.test.ts", "gate-paths.test.ts", "import-gate.test.ts"]) {
    assert.ok(!fs.readFileSync(path.join(repoRoot, "test", filename), "utf8").includes(value), filename);
  }
});

test("withReadOnlyDirectory restores directory permissions even when the callback throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-cleanup-"));
  try {
    const before = fs.statSync(dir).mode & 0o777;
    const observed: number[] = [];
    await assert.rejects(
      withReadOnlyDirectory(dir, async () => {
        observed.push(fs.statSync(dir).mode & 0o777);
        throw new Error("forced sync failure");
      }),
      /forced sync failure/,
    );
    assert.deepEqual(observed, [0o555], "the directory is read-only while the callback runs");
    assert.equal(fs.statSync(dir).mode & 0o777, before, "the original mode is restored after the throw");
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Regressions for reviewed documentation and fixture hygiene contracts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

test("comment failure fixture restores directory permissions even when sync throws", async () => {
  const source = fs.readFileSync(path.join(repoRoot, "test/coverage-remainder.test.ts"), "utf8");
  const modern = source.indexOf('    const tasksDir =');
  const start = modern >= 0 ? modern : source.indexOf('    fs.chmodSync(path.join(root, ".agents", "pm", "tasks"), 0o555);');
  assert.ok(start >= 0, "permission fixture exists");
  const end = source.indexOf('\n  } finally {', start);
  const block = source.slice(start, end);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-github-cleanup-"));
  const tasksDir = path.join(root, ".agents/pm/tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  try {
    const invoke = new Function("fs", "path", "root", "captureStderr", "syncGithubCommentsToAnnotations", "itemId", "assert", `return (async () => { ${block} })();`);
    await assert.rejects(invoke(fs, path, root, () => Promise.reject(new Error("forced sync failure")), () => {}, "fixture", assert), /forced sync failure/);
    assert.equal(fs.statSync(tasksDir).mode & 0o777, 0o755);
  } finally {
    fs.chmodSync(tasksDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

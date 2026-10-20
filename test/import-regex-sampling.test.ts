/** Deterministic scheduler-pause replay for the imported-text timing guards. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { nodeToolingExecutable } from "../scripts/main-invocation.ts";

const pattern = "ownership whitespace trigger|locator punctuation trigger|API-base slash trim";

for (const [scenario, durations, passes] of [
  ["one scheduler pause", [100, 1, 2], true],
  ["three slow operations", [100, 100, 100], false],
] as const) {
  test(`regex timing guards handle ${scenario} without changing the 50 ms limit`, t => {
    const root = mkdtempSync(join(tmpdir(), "regex-sampling-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const preload = join(root, "clock.mjs");
    // Only replace the target file's explicit measurements. Node's own test
    // deadlines and other consumers retain their real monotonic clock.
    writeFileSync(preload, `import { performance } from 'node:perf_hooks';
const realNow = performance.now.bind(performance);
const durations = ${JSON.stringify(durations)};
let calls = 0;
Object.defineProperty(performance, 'now', { value() {
  if (!new Error().stack.includes('import-regex.test.ts:')) return realNow();
  const call = calls++;
  return call % 2 === 0 ? 0 : durations[Math.floor(call / 2) % 3];
} });
`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(nodeToolingExecutable(process.versions), ["--import", pathToFileURL(preload).href,
      "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, "test/import-regex.test.ts"],
    { env, cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, passes ? 0 : 1, result.stdout + result.stderr);
    assert.match(result.stdout, passes ? /# pass 3\b/ : /# fail 3\b/);
  });
}

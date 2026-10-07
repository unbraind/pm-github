import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const nodeExecutable = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
assert.ok(nodeExecutable, "lifecycle fixtures require a Node executable");

/**
 * Execute lifecycle and executable-lookup scenarios in a fresh Node process.
 *
 * Bun can retain the original executable search path after process.env changes.
 * The child receives its environment at startup, keeping host tools and tokens
 * outside failure fixtures. Native harness behavior stays in the parent suite.
 */
export function nodeScenario(code: string, environment: Record<string, string | undefined> = {}): void {
  const env = { ...process.env, ...environment };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(nodeExecutable, ["--input-type=module", "--eval", code], {
    encoding: "utf8", env, timeout: 60000,
  });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stderr}\n${result.stdout}`);
}

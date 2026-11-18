/** Run admission regressions with the published deferral-aware SDK. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { testTime } from "./support/time.ts";
import { nodeToolingExecutable } from "../scripts/main-invocation.ts";

for (const [testName, flags] of [
  ["GitHub import admission against the deferral-aware PM SDK", [
    "--import", join(import.meta.dirname, "helpers/strict-import-sdk-loader.ts"),
    "--test-name-pattern", "^(strict |default atomic |another create )",
  ]],
  ["GitHub import admission against the progressive-only PM SDK", [
    "--test-name-pattern", "^progressive-only SDK",
  ]],
] as const) {
  test(testName, () => {
    const env = { ...process.env, PM_AUTHOR: "pm-github" };
    Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
    const result = spawnSync(nodeToolingExecutable(process.versions), [
      ...flags, "--test", join(import.meta.dirname, "helpers/strict-import-sdk-scenarios.ts"),
    ], { env, encoding: "utf8", timeout: testTime(120_000) });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  });
}

/** Run admission regressions with the current and progressive-only published SDKs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testTime } from "./support/time.ts";
import { withPackedFixture } from "./helpers/packed-fixture.ts";
import { nodeToolingExecutable } from "../scripts/main-invocation.ts";

const scenarios = join(import.meta.dirname, "helpers/strict-import-sdk-scenarios.ts");

/** Run real tracker scenarios against the SDK selected by the child loader. */
function runAdmissionScenarios(pattern: string, flags: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(nodeToolingExecutable(process.versions), [
    ...flags, "--test-name-pattern", pattern, "--test", scenarios,
  ], { env, encoding: "utf8", timeout: testTime(120_000) });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
}

test("GitHub import admission against the deferral-aware PM SDK", () => {
  const env = { ...process.env, PM_AUTHOR: "pm-github" };
  Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
  runAdmissionScenarios("^(strict |default atomic |another create )", [], env);
});

test("GitHub import admission against the progressive-only PM SDK", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-github-admission-sdk-"));
  await withPackedFixture(scratch, async ({ root, env }) => {
    const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline",
      "--no-package-lock", "--no-save", "@unbrained/pm-cli@2026.11.6"], { cwd: root, env: { ...env, NODE_V8_COVERAGE: undefined }, encoding: "utf8", timeout: testTime(120_000) });
    assert.equal(install.status, 0, install.error?.message ?? install.stdout + install.stderr);
    runAdmissionScenarios("^progressive-only SDK", ["--import", join(import.meta.dirname, "helpers/strict-import-sdk-loader.ts")],
      { ...env, PM_GITHUB_TEST_LEGACY_SDK_ROOT: root, PM_AUTHOR: "pm-github" });
  });
});

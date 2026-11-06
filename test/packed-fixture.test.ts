/** Real SDK trackers and child processes exercise packed-fixture teardown. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, readSettings, runInit, writeSettings } from "@unbrained/pm-cli/sdk";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { packedFixtureEnvironment, withFixtureCleanup } from "./helpers/packed-fixture.ts";
import { jsonResponse, withMockGithub } from "./helpers/mock-github-server.ts";

const cli = join(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");

test("packed environment owns its global root and awaits producers despite inherited overrides", () => {
  const env = packedFixtureEnvironment("fixture", "consumer", { PATH: "tools", HOME: "outside", PM_GLOBAL_PATH: "outside", PM_TELEMETRY_INLINE_FLUSH: "0",
    NPM_TOKEN: "synthetic", NODE_AUTH_TOKEN: "synthetic", NPM_MEDIA_SERVER: "synthetic", NODE_V8_COVERAGE: "receipts" });
  assert.equal(env.PM_GLOBAL_PATH, join("fixture", "global"));
  assert.equal(env.PM_TELEMETRY_INLINE_FLUSH, "1");
  assert.equal(env.HOME, join("fixture", "home"));
  assert.equal(env.NODE_V8_COVERAGE, "receipts", "Child coverage must remain enabled.");
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.NPM_MEDIA_SERVER, undefined);
});

test("real CLI flush completes before packed-fixture cleanup starts", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "pm-fixture-producer-"));
  const root = join(base, "consumer");
  const global = join(base, "global");
  mkdirSync(root);
  mkdirSync(global);
  mkdirSync(join(base, "home"));
  const preload = join(base, "runtime.ts");
  const runtimeReceipt = join(base, "runtime.json");
  writeFileSync(preload, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PM_FIXTURE_RUNTIME_RECEIPT!, JSON.stringify({ bun: process.versions.bun ?? null }));\n');
  let delivered = false;
  let responseFinished: Promise<void> = Promise.resolve();
  try {
    await runInit("fixture", { path: root, noExtensions: true }, { agentGuidance: "skip" });
    const item = (await create({ title: "Synthetic producer", type: "Task" }, { pmRoot: root, noExtensions: true })).item;
    await withMockGithub((_request, response) => {
      // Hold the real writer in its HTTP phase past the direct parent's exit.
      // Inline mode must await this response and its durable queue rewrite.
      responseFinished = new Promise(resolve => { setTimeout(() => {
        delivered = true;
        jsonResponse(response, 200, { ok: true });
        resolve();
      }, 1000); });
    }, async server => {
      const settings = await readSettings(global);
      settings.telemetry.enabled = true;
      settings.telemetry.endpoint = server.baseUrl;
      await writeSettings(global, settings);
      const env = packedFixtureEnvironment(base, root, { ...process.env, PM_GLOBAL_PATH: global, PM_TELEMETRY_INLINE_FLUSH: "0" });
      // Exercise the actual producer with synthetic events sent only to loopback.
      for (const key of ["NODE_ENV", "VITEST", "VITEST_WORKER_ID", "DO_NOT_TRACK", "PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY", "PM_TELEMETRY_FLUSH_CHILD"]) delete env[key];
      env.PM_TELEMETRY_OTEL_DISABLED = "1";
      env.PM_FIXTURE_RUNTIME_RECEIPT = runtimeReceipt;
      try {
        await withFixtureCleanup(base, async () => {
          const result = await boundedCli(process.execPath, ["--import", preload, cli, "--path", root, "update", item.id, "--title", "Producer finished", "--json"], root, env);
          assert.equal(result.timedOut, false);
          assert.equal(result.code, 0, result.stderr);
          assert.deepEqual(JSON.parse(readFileSync(runtimeReceipt, "utf8")), { bun: process.versions.bun ?? null }, "The actual producer must use the active test runtime.");
          assert.equal(delivered, true, "The actual telemetry writer must finish before teardown.");
          const state = JSON.parse(readFileSync(join(global, "runtime/telemetry/state.json"), "utf8")) as { last_successful_flush_at?: string };
          assert.ok(state.last_successful_flush_at, "A successful response must be durably recorded before cleanup.");
          assert.equal(readFileSync(join(global, "runtime/telemetry/events.jsonl"), "utf8").trim(), "");
        });
        assert.equal(existsSync(base), false);
      } finally { await responseFinished; }
    });
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("fixture cleanup preserves primary errors and refuses teardown-only failures", async () => {
  for (const failBody of [false, true]) {
    const base = mkdtempSync(join(tmpdir(), "pm-fixture-cleanup-"));
    const root = join(base, "tracker");
    const primary = new Error("Mixed-import byte assertion failed");
    const cleanup = Object.assign(new Error("Controlled cleanup failure"), { code: "ENOTEMPTY" });
    const marker = join(base, "child-finished");
    try {
      await runInit("fixture", { path: root, noExtensions: true }, { agentGuidance: "skip" });
      await create({ title: "Preserve cleanup evidence", type: "Task" }, { pmRoot: root, noExtensions: true });
      await assert.rejects(withFixtureCleanup(base, async () => {
        const result = await boundedCli(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'complete')", marker], base, packedFixtureEnvironment(base, root));
        assert.equal(result.code, 0, result.stderr);
        if (failBody) throw primary;
        return "assertions passed";
      }, path => {
        assert.equal(path, base);
        assert.equal(readFileSync(marker, "utf8"), "complete", "Cleanup follows the real child process.");
        throw cleanup;
      }), (error: unknown) => {
        if (failBody) {
          assert.ok(error instanceof AggregateError, "Report both failures instead of masking the import failure.");
          assert.equal(error.cause, primary);
          assert.equal(error.errors[0], primary);
          assert.equal(error.errors.length, 2);
          assert.equal(error.errors[1], cleanup);
        } else assert.equal(error, cleanup, "Cleanup failure must never turn into success.");
        return true;
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  // Positive controls belong to the same regression: reverting this helper must fail the test.
  for (const failBody of [false, true]) {
    const base = mkdtempSync(join(tmpdir(), "pm-fixture-result-"));
    const primary = new Error("Original assertion");
    const result = withFixtureCleanup(base, async () => { if (failBody) throw primary; return 42; });
    if (failBody) await assert.rejects(result, error => error === primary);
    else assert.equal(await result, 42);
    assert.equal(existsSync(base), false);
  }
});

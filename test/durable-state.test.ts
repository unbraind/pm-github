/** Platform selection is stubbed; publication and fsync use the real filesystem. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubStateSyncMode, syncGithubStatePath, writeGithubStateAtomic } from "../durable-state.ts";
import { flushGithubWebhookState } from "../webhooks.ts";

for (const platform of ["win32", "linux", "darwin"] as const) test(`durable state uses writable file sync and supported directory sync (${platform})`, async () => {
  assert.equal(githubStateSyncMode(false, platform), "r+", "FlushFileBuffers requires a writable file handle");
  assert.equal(githubStateSyncMode(true, platform), platform === "win32" ? undefined : "r");
  const root = await mkdtemp(join(tmpdir(), "github-sync-mode-"));
  try {
    const file = join(root, "nested/state.json");
    let platformChecks = 0;
    const options = { platform: () => { platformChecks++; return platform; } };
    await writeGithubStateAtomic(file, '{"sequence":1}', options);
    await writeGithubStateAtomic(file, '{"sequence":2}', options);
    assert.equal(await readFile(file, "utf8"), '{"sequence":2}');
    assert.equal(githubStateSyncMode(false), "r+");
    await syncGithubStatePath(file, false);
    assert.equal(platformChecks, 2);
    await flushGithubWebhookState(file, options.platform);
    assert.equal(platformChecks, 3);
    await assert.rejects(() => writeGithubStateAtomic(file, "collision", { ...options, exclusive: true }), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
    assert.equal(await readFile(file, "utf8"), '{"sequence":2}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

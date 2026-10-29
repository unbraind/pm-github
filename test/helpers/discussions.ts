/** Shared real non-git tracker fixtures for discussion tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init, PmClient, createExtensionCommandSdk } from "@unbrained/pm-cli/sdk";
import type { ExtensionCommandSdk } from "@unbrained/pm-cli/sdk/authoring";
import type { DiscussionCaptureInput } from "../../index.ts";
import { withEnv } from "./mock-github-server.ts";
/** Disposable non-git tracker with no executable git on its PATH. */
export async function discussionTracker(run: (root: string, sdk: ExtensionCommandSdk, item: string, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pm-discussion-"));
  const root = join(directory, "tracker");
  try {
    await withEnv({ PM_AUTHOR: "fixture", PM_PATH: root, GIT_CEILING_DIRECTORIES: dirname(directory), PATH: directory }, async () => {
      await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root, noExtensions: true });
      const client = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" });
      const item = (await client.create({ type: "Task", title: "Issue context", parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] })).item.id;
      await run(root, createExtensionCommandSdk(root, client), item, directory);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Stable attributed source; optional prose is deliberately not executed. */
export function discussionSource(body = "Use the native SDK.\r\nKeep exact whitespace.  ", id = 12) {
  return { id, body, user: { id: 7, login: "source-author" }, updated_at: "2026-10-01T00:00:00Z",
    issue_url: "https://api.github.com/repos/fixture/repo/issues/3", html_url: `https://github.com/fixture/repo/issues/3#issuecomment-${id}` };
}
/** Selection explicitly confirms one quoted half-open UTF-16 span. */
export function discussionRequest(item: string, source = discussionSource()): DiscussionCaptureInput {
  return { repo: "fixture/repo", issue: 3, item, selections: [{ comment: source.id, start: 0, end: source.body.length, quote: source.body, marked: true }] };
}

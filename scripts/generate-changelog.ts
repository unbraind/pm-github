/** Generate canonical PM release history plus explicitly tagged pending work. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { isMainInvocation } from "./main-invocation.ts";

/**
 * Render complete history without marking unfinished candidate items closed.
 *
 * Only the explicit `changelog-unreleased` tag admits a nonterminal item. Other
 * ongoing work cannot acquire a release entry just because it was claimed.
 *
 * @param root - Repository containing the tracker and release tags.
 * @param args - Optional pm-changelog arguments, including its check flag.
 * @returns The generator's status, or a failure when the complete read fails.
 */
export async function generateChangelog(root: string, args: readonly string[]): Promise<number> {
  try {
    const corpus = await listAllComplete({}, { cwd: root, pmRoot: resolve(root, ".agents/pm"), noExtensions: true });
    const items = corpus.items.filter(item => item.status === "closed" || item.tags?.includes("changelog-unreleased"));
    const cli = resolve(dirname(createRequire(import.meta.url).resolve("pm-changelog/package.json")), "dist/cli.js");
    const result = spawnSync("node", [cli, "--stdin", "--pm-root", ".agents/pm", "--status", [...new Set(["closed", ...items.map(item => item.status)])].join(","),
      "--mode", "replace", "--output", "CHANGELOG.md", "--all-release-tags", "--release-version-from-package",
      "--date-from-version", "--item-url-base", "https://github.com/unbraind/pm-github/blob/main/.agents/pm",
      "--respect-item-release", ...args], {
      cwd: root, input: JSON.stringify({ items }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env },
    });
    if (result.status === null) return 1;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.status;
  } catch {
    console.error("changelog: complete tracker read or generator invocation failed.");
    return 1;
  }
}

if (isMainInvocation(process.argv, import.meta.url)) process.exitCode = await generateChangelog(resolve(import.meta.dirname, ".."), process.argv.slice(2));

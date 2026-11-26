import { createPmCliExpectedError, renderPmCommand } from "@unbrained/pm-cli/sdk";
import { GithubImportOwnershipError, type GithubOwnedTarget } from "./import-ownership.ts";

/** Offer a link only for an unowned reserved destination. Keep other ownership refusals intact. */
export async function withReservedIdRepair<T>(targets: readonly GithubOwnedTarget[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (!(error instanceof GithubImportOwnershipError) || error.owners.length !== 1 ||
        error.owners[0] !== "curated/unowned for content mirroring; importer creation provenance missing") throw error;
    const target = targets.find(candidate => candidate.allowCreate && candidate.id === error.itemId);
    if (!target) throw error;
    const url = `https://github.com/${target.repo}/issues/${target.number}`;
    const command = renderPmCommand(["update", target.id, "--field", `github_url=${url}`]);
    const guidance = `If this item belongs to ${error.expected}, set github_url on this item to link it with \`${command}\`.`;
    throw createPmCliExpectedError(`${guidance} ${error.message}`, {
      exitCode: error.exitCode,
      context: { ...error.context, required: `${guidance} ${error.remedy}`, examples: [command] },
    });
  }
}

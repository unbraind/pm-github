import { createPmCliExpectedError, renderPmCommand } from "@unbrained/pm-cli/sdk";
import { githubOwnershipClaims, GithubImportOwnershipError, type GithubOwnedTarget } from "./import-ownership.ts";
import { githubInvocationPath, repairScopeArgs } from "./workspace.ts";
import type { PmItem } from "./index.ts";

/**
 * Offer a reserved-ID link repair only when applying it is safe and copy-safe.
 *
 * A repair is rendered from one invocation that already selected its tracker,
 * so the command replays that invocation's typed tracker selector: copying it
 * in a directory whose own tracker holds an item with the same ID must never
 * link that item instead. And incomplete provenance is not safe to link: the
 * command is kept only when the item's claims after the link are exactly the
 * target issue, evaluated with the same ownership-claims machinery the next
 * import uses, so the offered repair can never create contradictory ownership.
 * Every other ownership refusal stays intact.
 *
 * @param targets - Planned targets of the wrapped operation.
 * @param run - The operation whose reserved-ID refusal may carry a repair.
 * @returns The operation's result, or its refusal, with the repair attached
 * when the destination qualifies.
 */
export async function withReservedIdRepair<T>(targets: readonly GithubOwnedTarget[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (!(error instanceof GithubImportOwnershipError) || error.owners.length !== 1 ||
        error.owners[0] !== "curated/unowned for content mirroring; importer creation provenance missing") throw error;
    const target = targets.find(candidate => candidate.allowCreate && candidate.id === error.itemId);
    const item = error.refusedItem;
    if (!target || !item) throw error;
    const url = `https://github.com/${target.repo}/issues/${target.number}`;
    const expected = `${target.repo.toLowerCase()}#${target.number}`;
    const linked: PmItem = { ...item, github_url: url };
    const claims = githubOwnershipClaims(linked, false, false, [target.repo]).claims;
    if (claims.length !== 1 || claims[0] !== expected) throw error;
    const command = renderPmCommand([...repairScopeArgs(githubInvocationPath()), "update", target.id, "--field", `github_url=${url}`]);
    const guidance = `If this item belongs to ${error.expected}, set github_url on this item to link it with \`${command}\`.`;
    throw createPmCliExpectedError(`${guidance} ${error.message}`, {
      exitCode: error.exitCode,
      context: { ...error.context, required: `${guidance} ${error.remedy}`, examples: [command] },
    });
  }
}

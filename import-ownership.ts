/** Positive ownership checks at planning and the SDK's locked mutation boundary. */
import { AsyncResource } from "node:async_hooks";
import {
  get, EXIT_CODE, PmCliError, getActiveExtensionRegistrations, runWithActiveExtensions, setActiveExtensionHooks,
  setActiveExtensionRegistrations, runActiveBeforeMutationHooks, runActiveOnReadHooks,
  runActiveOnWriteHooks, runActiveOnIndexHooks,
} from "@unbrained/pm-cli/sdk";
import { importIdentityKeys } from "./import-fidelity.ts";
import type { PmItem } from "./index.ts";

const OWNER_REMEDY = "Restore the intended GitHub provenance only if this item belongs to that issue; otherwise use a different configured ID prefix or tracker. Keep the existing item and history. Reference tags do not grant ownership.";

/** Refuse an occupied target instead of treating an external-key ID as permission. */
export class GithubImportOwnershipError extends PmCliError {
  /** Stable category for automation and live collision refusals. */
  readonly code = "github_import_owner_conflict";
  /** Treat an occupied target as a resolvable usage conflict. */
  readonly exitCode = 2;
  /** Existing item whose destination cannot be reused. */
  readonly itemId: string;
  /** Normalized source identity requested by this operation. */
  readonly expected: string;
  /** Authoritative identities currently attached to the target. */
  readonly owners: readonly string[];
  /** Explicit recovery instruction; never silently reassign a colliding ID. */
  readonly remedy = OWNER_REMEDY;
  /** Name the requested identity and every current owner without quoting item content. */
  constructor(itemId: string, expected: string, owners: readonly string[]) {
    super(`GitHub import target ${itemId} is reserved for ${expected}, but its current owner is ${owners.join(" versus ") || "curated/unowned"}. ${OWNER_REMEDY} No conflicting item was written.`, 2, { code: "github_import_owner_conflict", required: OWNER_REMEDY });
    this.itemId = itemId; this.expected = expected; this.owners = owners;
  }
}

/** One planned target; an explicit first-link decision may establish its initial provenance. */
export interface GithubOwnedTarget {
  id: string;
  repo: string;
  number: number;
  allowCreate?: boolean;
  initialLink?: (item: PmItem) => boolean;
}

/** Require exactly one matching owner; explicit owners always outrank first-link evidence. */
export function assertGithubImportOwner(item: PmItem, target: GithubOwnedTarget): void {
  const expected = `${target.repo.toLowerCase()}#${target.number}`;
  const owners = importIdentityKeys(item);
  if (owners.length === 1 && owners[0] === expected) return;
  if (owners.length === 0 && target.initialLink?.(item)) return;
  throw new GithubImportOwnershipError(target.id, expected, owners);
}

/** Read ownership and the revision used to fence a following CLI write from the same snapshot. */
export async function readGithubImportOwner(pmRoot: string, target: GithubOwnedTarget): Promise<string | undefined> {
  let result: Awaited<ReturnType<typeof get>>;
  try { result = await get(target.id, {}, { pmRoot, noExtensions: true }); }
  catch (error: unknown) {
    if (target.allowCreate && error && typeof error === "object" && "exitCode" in error && error.exitCode === EXIT_CODE.NOT_FOUND) return undefined;
    throw error;
  }
  assertGithubImportOwner(result.item, target);
  return result.item_hash;
}

/** Preserve ambient hooks while adding positive ownership checks inside every target item lock. */
export async function withGithubImportOwners<T>(pmRoot: string, targets: readonly GithubOwnedTarget[], run: () => Promise<T>): Promise<T> {
  // Fail the whole selected batch before even creating an SDK journal.
  for (const target of targets) await readGithubImportOwner(pmRoot, target);
  const byId = new Map(targets.map(target => [target.id, target]));
  // Bound delegates retain the outer async-local extension scope, avoiding recursion
  // and preserving existing guards, policy/schema registrations and write hooks.
  const prior = AsyncResource.bind(runActiveBeforeMutationHooks);
  const onRead = AsyncResource.bind(runActiveOnReadHooks);
  const onWrite = AsyncResource.bind(runActiveOnWriteHooks);
  const onIndex = AsyncResource.bind(runActiveOnIndexHooks);
  const registrations = getActiveExtensionRegistrations();
  return runWithActiveExtensions({ path: pmRoot, noExtensions: true }, async () => {
    setActiveExtensionRegistrations(registrations);
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [],
      onRead: [{ layer: "project", name: "github-owner-delegate", run: async context => { await onRead(context); } }],
      onWrite: [{ layer: "project", name: "github-owner-delegate", run: async context => { await onWrite(context); } }],
      onIndex: [{ layer: "project", name: "github-owner-delegate", run: async context => { await onIndex(context); } }],
      beforeMutation: [{ layer: "project", name: "github-import-owner", run: async context => {
        const target = context.before && byId.get(context.before.metadata.id);
        if (target) {
          try { assertGithubImportOwner({ ...context.before!.metadata, body: context.before!.body }, target); }
          catch (error: unknown) {
            if (!(error instanceof GithubImportOwnershipError)) throw error;
            return { allow: false, code: error.code, message: error.message, remediation: error.remedy };
          }
        }
        await prior(context);
      } }],
    });
    return run();
  });
}

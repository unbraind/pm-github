/** Positive ownership checks at planning and the SDK's locked mutation boundary. */
import { AsyncResource } from "node:async_hooks";
import {
  PmClient, listAllItemMetadata, locateItem, readLocatedItem, hashDocument, EXIT_CODE, PmCliError, getActiveExtensionRegistrations, runWithActiveExtensions, setActiveExtensionHooks,
  setActiveExtensionRegistrations, runActiveBeforeMutationHooks, runActiveOnReadHooks,
  runActiveOnWriteHooks, runActiveOnIndexHooks,
} from "@unbrained/pm-cli/sdk";
import { normalizeGithubClaim, normalizeGithubRepository, parseGithubIssueUrl } from "./github-url.ts";
import { importIdentityKeys, legacyGithubLinkIdentities, explicitGithubIdentities, importerCreatedItem } from "./import-fidelity.ts";
import { readGithubWorkspace } from "./workspace.ts";
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
    super(`GitHub import target ${itemId} is reserved for ${expected}, but its current owner is ${owners.join(" versus ") || "curated/unowned"}. ${owners.some(owner => owner.includes("claimed by")) ? "multiple existing owners; import plan is not idempotent. " : ""}${OWNER_REMEDY} No conflicting item was written.`, 2, { code: "github_import_owner_conflict", required: OWNER_REMEDY });
    this.itemId = itemId; this.expected = expected; this.owners = owners;
  }
}

/** One planned target; an explicit first-link decision may establish its initial provenance. */
export interface GithubOwnedTarget {
  id: string;
  repo: string;
  number: number;
  allowCreate?: boolean;
  /** Full content updates require durable creation provenance, even on replay. */
  mirrorContent?: boolean;
  /** Minimum-SDK revision fencing is evaluated inside the native item lock. */
  expectedHash?: string;
  initialLink?: (item: PmItem) => boolean;
  /** Dependency endpoints must retain their unique ownership inside the source lock. */
  related?: readonly GithubOwnedTarget[];
}

/** Every asserted identity constrains a provenance-bearing item; references alone do not create an owner. */
export function githubOwnershipClaims(item: PmItem, provisional = false, allowReferenceTags = false): { owners: string[]; claims: string[]; evidence: boolean; kinds: string[]; direct: boolean } {
  const legacy = legacyGithubLinkIdentities(item);
  const direct = importIdentityKeys(item, { allowConflicts: true });
  const owners = new Set([...direct, ...legacy.map(target => target.key)]);
  const kinds = new Set<string>([...explicitGithubIdentities(item), ...legacy].map(target => target.kind!));
  const externalTarget = parseGithubIssueUrl(item.external_ref);
  if (externalTarget && !externalTarget.api) kinds.add(externalTarget.kind!);
  const external = normalizeGithubClaim(item.external_ref);
  if (external) owners.add(external);
  if (!owners.size && allowReferenceTags) for (const tag of item.tags ?? []) {
    const key = normalizeGithubClaim(tag); if (key) owners.add(key);
  }
  const repository = normalizeGithubRepository(item.github_repo);
  const number = Number.isSafeInteger(item.github_number) && Number(item.github_number) > 0 ? Number(item.github_number) : undefined;
  const generated = typeof item.description === "string" ? /^GH (?:issue|PR) #([1-9]\d*): (https?:\/\/\S+)(?: ·|$)/i.exec(item.description) : undefined;
  const source = generated && parseGithubIssueUrl(generated[2]);
  if (source) kinds.add(source.kind!);
  const evidence = provisional || owners.size > 0 || Boolean(repository) || item.github_number !== undefined || typeof item.github_link_only === "boolean" || Boolean(source);
  const claims = new Set(owners);
  if (evidence) {
    for (const tag of item.tags ?? []) { const key = normalizeGithubClaim(tag); if (key) claims.add(key); }
    if (source) claims.add(source.key);
    const keys = [...claims];
    const generatedNumber = generated ? Number(generated[1]) : undefined;
    for (const key of keys) {
      const [repo, n] = key.split("#");
      if (repository) claims.add(`${repository}#${n}`);
      if (number !== undefined) claims.add(`${repo}#${number}`);
      if (generatedNumber !== undefined) claims.add(`${repo}#${generatedNumber}`);
    }
  }
  return { owners: [...owners].sort(), claims: [...claims].sort(), evidence, kinds: [...kinds].sort(), direct: direct.length > 0 || Boolean(external) };
}

/** Refuse contradictory claims and competing owners from the same current metadata snapshot. */
export function assertGithubOwnershipConsistency(item: PmItem, target?: GithubOwnedTarget, peers: readonly PmItem[] = [], allowReferenceTags = false): string[] {
  const state = githubOwnershipClaims(item, Boolean(target?.initialLink), allowReferenceTags);
  const expected = target ? `${target.repo.toLowerCase()}#${target.number}` : state.owners[0] ?? state.claims[0] ?? "one consistent GitHub issue";
  if (state.claims.length > 1 || state.evidence && state.claims.some(key => key !== expected)) {
    throw new GithubImportOwnershipError(item.id ?? target?.id ?? "<unknown>", expected, state.claims);
  }
  const competitors = peers.flatMap(peer => {
    const claims = githubOwnershipClaims(peer, false, allowReferenceTags).claims;
    return peer.id !== item.id && claims.includes(expected) ? claims.map(key => `${key} claimed by ${peer.id}`) : [];
  });
  if (competitors.length) throw new GithubImportOwnershipError(item.id ?? target?.id ?? "<unknown>", expected, [expected, ...competitors]);
  return state.owners;
}

/** Select targets only after checking every claim and every peer; repository scoping never hides a contradiction. */
export function githubOwnedIdentityKeys(item: PmItem, peers: readonly PmItem[] = [], repo?: string, allowReferenceTags = false): string[] {
  const state = githubOwnershipClaims(item, false, allowReferenceTags);
  if (repo && !state.claims.some(key => key.slice(0, key.lastIndexOf("#")) === repo.toLowerCase())) return [];
  return assertGithubOwnershipConsistency(item, undefined, peers, allowReferenceTags);
}

/** Require one matching owner, consistent claims and unique current authority before every write. */
export function assertGithubImportOwner(item: PmItem, target: GithubOwnedTarget, peers: readonly PmItem[] = []): void {
  const expected = `${target.repo.toLowerCase()}#${target.number}`;
  const owners = assertGithubOwnershipConsistency(item, target, peers);
  if (target.mirrorContent && !importerCreatedItem(item, target.repo, target.number)) {
    throw new GithubImportOwnershipError(target.id, expected, [...owners, "curated/unowned for content mirroring; importer creation provenance missing"]);
  }
  if (owners.length === 1 && owners[0] === expected) return;
  if (owners.length === 0 && target.initialLink?.(item)) return;
  throw new GithubImportOwnershipError(target.id, expected, owners);
}

/** Read ownership and the revision used to fence a following native write from the same snapshot. */
export async function readGithubImportOwner(pmRoot: string, target: GithubOwnedTarget): Promise<string | undefined> {
  const { pmRoot: root, settings, types } = await readGithubWorkspace(pmRoot);
  const located = await locateItem(root, target.id, settings.id_prefix, settings.item_format, types.type_to_folder);
  if (!located) {
    if (!target.allowCreate) throw new PmCliError(`Item ${target.id} not found. GitHub import requires its intended item and history; restore them before retrying.`, EXIT_CODE.NOT_FOUND, { code: "item_not_found" });
    assertGithubOwnershipConsistency({ id: target.id }, target, await listAllItemMetadata(root, settings.item_format, types.type_to_folder, undefined, settings.schema));
    return undefined;
  }
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  assertGithubImportOwner({ ...document.metadata, body: document.body }, target,
    await listAllItemMetadata(root, settings.item_format, types.type_to_folder, undefined, settings.schema));
  return hashDocument(document);
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
        await prior(context);
        const id = (context.before ?? context.after)?.metadata.id;
        const target = id && byId.get(id);
        if (target) {
          try {
            if (target.expectedHash && context.before && hashDocument(context.before) !== target.expectedHash) {
              return { allow: false, code: "item_revision_conflict", message: `GitHub import target ${target.id} changed after its ownership read (expected revision ${target.expectedHash}, current ${hashDocument(context.before)}).`, remediation: "Read the current item and retry against its intended ownership and revision." };
            }
            const peers = await context.sdk.list();
            for (const related of target.related ?? []) {
              const item = peers.find(peer => peer.id === related.id);
              if (!item) throw new GithubImportOwnershipError(related.id, `${related.repo.toLowerCase()}#${related.number}`, ["missing dependency endpoint"]);
              assertGithubImportOwner(item, related, peers);
            }
            for (const document of [context.before, context.after]) if (document) {
              assertGithubImportOwner({ ...document.metadata, body: document.body }, target, peers);
            }
          } catch (error: unknown) {
            if (!(error instanceof GithubImportOwnershipError)) throw error;
            return { allow: false, code: error.code, message: error.message, remediation: error.remedy };
          }
        }
      } }],
    });
    return run();
  });
}

/** Run plain owned writes through native SDK locks, revisions and the same ownership hook as replay. */
export async function mutateGithubOwnedItem(pmRoot: string, target: GithubOwnedTarget, action: "create" | "update" | "close", options: Record<string, unknown>, expectedHash?: string): Promise<unknown> {
  const hash = expectedHash ?? await readGithubImportOwner(pmRoot, target);
  return withGithubImportOwners(pmRoot, [{ ...target, expectedHash: hash }], async () => {
    const client = PmClient.forActiveExtensionHost({ pmRoot, noExtensions: true });
    return client.run(action, action === "create"
      ? { options: { ...options, id: target.id } } : { id: target.id, options });
  });
}

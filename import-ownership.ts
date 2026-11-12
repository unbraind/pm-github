import { createHash } from "node:crypto";
import * as githubOwnershipSdk from "@unbrained/pm-cli/sdk";
/** Positive ownership checks at planning and the SDK's locked mutation boundary. */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import {
  PmClient, acquireLock, listAllItemMetadata, locateItem, readLocatedItem, hashDocument, EXIT_CODE, PmCliError, getActiveExtensionRegistrations, runWithActiveExtensions, setActiveExtensionHooks,
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

/** Use the same repository hash for import destinations and legacy identity verification. */
export function githubRepositoryHash(repo: string): string {
  return createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 12);
}

/** Reverse only a proven importer ID. Tags provide repository candidates, never claims or issue numbers. */
export function githubImporterIdentity(item: PmItem, repositories: readonly string[] = []): string | undefined {
  const id = typeof item.id === "string" && /(?:^|-)github-([a-f0-9]{12})-([1-9]\d*)$/.exec(item.id);
  if (!id || !importerCreatedItem(item, "", Number(id[2]))) return undefined;
  const candidates = new Set(repositories.map(repo => repo.toLowerCase()));
  const repo = normalizeGithubRepository(item.github_repo); if (repo) candidates.add(repo);
  for (const target of [...explicitGithubIdentities(item), ...legacyGithubLinkIdentities(item)]) candidates.add(target.repo);
  const external = normalizeGithubClaim(item.external_ref); if (external) candidates.add(external.split("#")[0]!);
  const generated = typeof item.description === "string" && /^GH (?:issue|PR) #[1-9]\d*: (https?:\/\/\S+)(?: ·|$)/i.exec(item.description);
  const source = generated && parseGithubIssueUrl(generated[1]); if (source) candidates.add(source.repo);
  for (const tag of item.tags ?? []) {
    const candidate = /^gh:([^/\s]+\/[^#\s]+)#/i.exec(tag)?.[1];
    if (candidate) candidates.add(candidate.toLowerCase());
  }
  for (const candidate of candidates) if (githubRepositoryHash(candidate) === id[1]) return `${candidate}#${id[2]}`;
  return undefined;
}

/** One parsed corpus snapshot, shared by every selected target in a batch. */
export interface GithubOwnershipIndex {
  items: readonly PmItem[];
  repositories: string[];
  states: WeakMap<PmItem, ReturnType<typeof githubOwnershipClaims>>;
  byId: Map<string, PmItem>;
  claimants: Map<string, Map<string, string[]>>;
}

/** Optional deterministic work counters; production callers need no observer. */
export interface GithubOwnershipWork { corpusReads?: number; claimParses?: number }

const ownershipWork = new AsyncLocalStorage<GithubOwnershipWork>();
// Nested fidelity writes inside one SDK transaction inherit its already installed guard.
const ownershipScope = new AsyncLocalStorage<{ root: string; targets: readonly GithubOwnedTarget[] }>();

/** Count actual claim parses and corpus reads without substituting SDK persistence. */
export function withGithubOwnershipWork<T>(work: GithubOwnershipWork, run: () => T): T {
  return ownershipWork.run(work, run);
}

/** Read one complete native metadata snapshot for a batch or a fresh write check. */
export async function readGithubOwnershipSnapshot(pmRoot: string, repositories: readonly string[] = []): Promise<GithubOwnershipIndex> {
  const { pmRoot: root, settings, types } = await readGithubWorkspace(pmRoot);
  const work = ownershipWork.getStore(); if (work) work.corpusReads = (work.corpusReads ?? 0) + 1;
  return buildGithubOwnershipIndex(await listAllItemMetadata(root, settings.item_format, types.type_to_folder, undefined, settings.schema), repositories);
}

/** Replace one committed/proposed item in a locked snapshot without rereading its peers. */
function updateOwnershipIndex(index: GithubOwnershipIndex, item: PmItem): void {
  if (!item.id) return;
  const old = index.byId.get(item.id);
  for (const key of old ? index.states.get(old)?.claims ?? [] : []) index.claimants.get(key)?.delete(item.id);
  const state = githubOwnershipClaims(item, false, false, index.repositories);
  index.states.set(item, state); index.byId.set(item.id, item);
  for (const key of state.claims) {
    const peers = index.claimants.get(key) ?? new Map<string, string[]>();
    peers.set(item.id, state.claims); index.claimants.set(key, peers);
  }
}

/** Parse each item once and index peer claims in linear snapshot work. */
export function buildGithubOwnershipIndex(items: readonly PmItem[], repositories: readonly string[] = []): GithubOwnershipIndex {
  const index: GithubOwnershipIndex = { items, repositories: [...repositories], states: new WeakMap(), byId: new Map(), claimants: new Map() };
  for (const item of items) {
    const state = githubOwnershipClaims(item, false, false, repositories);
    index.states.set(item, state);
    if (item.id) index.byId.set(item.id, item);
    for (const key of state.claims) {
      const peers = index.claimants.get(key) ?? new Map<string, string[]>();
      if (item.id) peers.set(item.id, state.claims);
      index.claimants.set(key, peers);
    }
  }
  return index;
}

/** Preserve array-based callers while letting batch paths share one already parsed index. */
function ownershipIndex(peers: readonly PmItem[] | GithubOwnershipIndex, repositories: readonly string[] = []): GithubOwnershipIndex {
  return Array.isArray(peers) ? buildGithubOwnershipIndex(peers, repositories) : peers as GithubOwnershipIndex;
}

/** Every asserted identity constrains a provenance-bearing item; references alone do not create an owner. */
export function githubOwnershipClaims(item: PmItem, provisional = false, _allowReferenceTags = false, repositories: readonly string[] = []): { owners: string[]; claims: string[]; evidence: boolean; kinds: string[]; direct: boolean } {
  const work = ownershipWork.getStore(); if (work) work.claimParses = (work.claimParses ?? 0) + 1;
  const legacy = legacyGithubLinkIdentities(item);
  const direct = importIdentityKeys(item, { allowConflicts: true });
  const owners = new Set([...direct, ...legacy.map(target => target.key)]);
  const kinds = new Set<string>([...explicitGithubIdentities(item), ...legacy].map(target => target.kind!));
  const externalTarget = parseGithubIssueUrl(item.external_ref);
  if (externalTarget && !externalTarget.api) kinds.add(externalTarget.kind!);
  const external = normalizeGithubClaim(item.external_ref);
  if (external) owners.add(external);
  const imported = githubImporterIdentity(item, repositories);
  if (imported) {
    owners.add(imported);
    const generated = typeof item.description === "string" && /^GH (?:issue|PR) #[1-9]\d*: (https?:\/\/\S+)(?: ·|$)/i.exec(item.description);
    const source = generated && parseGithubIssueUrl(generated[1]);
    if (source && !source.api && source.key === imported) kinds.add(source.kind!);
  }
  const repository = normalizeGithubRepository(item.github_repo);
  const number = Number.isSafeInteger(item.github_number) && Number(item.github_number) > 0 ? Number(item.github_number) : undefined;
  const evidence = provisional || owners.size > 0;
  const claims = new Set(owners);
  if (evidence) {
    const keys = [...claims];
    for (const key of keys) {
      const [repo, n] = key.split("#");
      if (repository) claims.add(`${repository}#${n}`);
      if (number !== undefined) claims.add(`${repo}#${number}`);
    }
  }
  return { owners: [...owners].sort(), claims: [...claims].sort(), evidence, kinds: [...kinds].sort(), direct: direct.length > 0 || Boolean(external) || Boolean(imported) };
}

/** Refuse contradictory claims and competing owners from the same current metadata snapshot. */
export function assertGithubOwnershipConsistency(item: PmItem, target?: GithubOwnedTarget, peers: readonly PmItem[] | GithubOwnershipIndex = [], _allowReferenceTags = false): string[] {
  const index = ownershipIndex(peers, target ? [target.repo] : []);
  const state = index.states.get(item) ?? githubOwnershipClaims(item, Boolean(target?.initialLink), false, index.repositories);
  const expected = target ? `${target.repo.toLowerCase()}#${target.number}` : state.owners[0] ?? state.claims[0] ?? "one consistent GitHub issue";
  if (state.claims.length > 1 || state.evidence && state.claims.some(key => key !== expected)) {
    throw new GithubImportOwnershipError(item.id ?? target?.id ?? "<unknown>", expected, state.claims);
  }
  const competitors = [...(index.claimants.get(expected) ?? [])].flatMap(([id, claims]) => id !== item.id ? claims.map(key => `${key} claimed by ${id}`) : []);
  if (competitors.length) throw new GithubImportOwnershipError(item.id ?? target?.id ?? "<unknown>", expected, [expected, ...competitors]);
  return state.owners;
}

/** Select targets only after checking every claim and every peer; repository scoping never hides a contradiction. */
export function githubOwnedIdentityKeys(item: PmItem, peers: readonly PmItem[] | GithubOwnershipIndex = [], repo?: string, _allowReferenceTags = false): string[] {
  const index = ownershipIndex(peers, repo ? [repo] : []);
  const state = index.states.get(item) ?? githubOwnershipClaims(item, false, false, index.repositories);
  if (repo && !state.claims.some(key => key.slice(0, key.lastIndexOf("#")) === repo.toLowerCase())) return [];
  return assertGithubOwnershipConsistency(item, undefined, index);
}

/** Require one matching owner, consistent claims and unique current authority before every write. */
export function assertGithubImportOwner(item: PmItem, target: GithubOwnedTarget, peers: readonly PmItem[] | GithubOwnershipIndex = []): void {
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
export async function readGithubImportOwner(pmRoot: string, target: GithubOwnedTarget, snapshot?: GithubOwnershipIndex): Promise<string | undefined> {
  const { pmRoot: root, settings, types } = await readGithubWorkspace(pmRoot);
  const peers = snapshot ?? buildGithubOwnershipIndex(await listAllItemMetadata(root, settings.item_format, types.type_to_folder, undefined, settings.schema), [target.repo]);
  const located = await locateItem(root, target.id, settings.id_prefix, settings.item_format, types.type_to_folder);
  if (!located) {
    if (!target.allowCreate) throw new PmCliError(`Item ${target.id} not found. GitHub import requires its intended item and history; restore them before retrying.`, EXIT_CODE.NOT_FOUND, { code: "item_not_found" });
    assertGithubOwnershipConsistency({ id: target.id }, target, peers);
    return undefined;
  }
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  assertGithubImportOwner({ ...document.metadata, body: document.body }, target,
    peers);
  return hashDocument(document);
}

const ownershipLeaseScope = new AsyncLocalStorage<ReadonlySet<string>>();

/** Serialize the tracker ownership namespace before SDK workspace/item locks; nested writes reuse the lease. */
export async function withGithubOwnershipLock<T>(pmRoot: string, run: () => Promise<T>): Promise<T> {
  const { pmRoot: root, settings } = await readGithubWorkspace(pmRoot);
  const active = ownershipLeaseScope.getStore();
  if (active?.has(root)) return run();
  // The minimum SDK exports acquireLock; newer hosts also expose generation fencing.
  const sdk = githubOwnershipSdk as typeof githubOwnershipSdk & {
    acquireLockLease?: (...args: Parameters<typeof acquireLock>) => Promise<{
      release: () => Promise<void>;
      fence: <R>(commit: () => Promise<R>) => Promise<R>;
    }>;
  };
  const args: Parameters<typeof acquireLock> = [root, "github-ownership", settings.locks.ttl_seconds, "pm-github:ownership", false, false, settings.locks.wait_ms];
  const lease = sdk.acquireLockLease ? await sdk.acquireLockLease(...args) : undefined;
  const release = lease?.release ?? await acquireLock(...args);
  const invoke = () => ownershipLeaseScope.run(new Set([...(active ?? []), root]), run);
  try { return lease ? await lease.fence(invoke) : await invoke(); }
  finally { await release(); }
}

/** Coordinate all ownership-changing paths before entering their native mutation guards. */
export async function withGithubImportOwners<T>(pmRoot: string, targets: readonly GithubOwnedTarget[], run: () => Promise<T>, work?: GithubOwnershipWork): Promise<T> {
  return withGithubOwnershipLock(pmRoot, () => withGithubImportOwnersUnderLease(pmRoot, targets, run, work));
}

/** Infer the mutation callback from the public SDK so the declared minimum remains supported. */
type GithubOwnershipMutationHook = NonNullable<NonNullable<Parameters<typeof setActiveExtensionHooks>[0]>["beforeMutation"]>[number]["run"];

/** Preserve ambient delegates and registrations while installing one native ownership check. */
async function withGithubOwnershipHooks<T>(pmRoot: string, name: string, delegateName: string, check: GithubOwnershipMutationHook, run: () => Promise<T>): Promise<T> {
  const prior = AsyncResource.bind(runActiveBeforeMutationHooks);
  const onRead = AsyncResource.bind(runActiveOnReadHooks), onWrite = AsyncResource.bind(runActiveOnWriteHooks), onIndex = AsyncResource.bind(runActiveOnIndexHooks);
  const registrations = getActiveExtensionRegistrations();
  return runWithActiveExtensions({ path: pmRoot, noExtensions: true }, async () => {
    setActiveExtensionRegistrations(registrations);
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [],
      onRead: [{ layer: "project", name: delegateName, run: async context => { await onRead(context); } }],
      onWrite: [{ layer: "project", name: delegateName, run: async context => { await onWrite(context); } }],
      onIndex: [{ layer: "project", name: delegateName, run: async context => { await onIndex(context); } }],
      beforeMutation: [{ layer: "project", name, run: async context => { await prior(context); return check(context); } }],
    });
    return run();
  });
}

/** Preserve ambient hooks while adding positive ownership checks inside every target item lock. */
async function withGithubImportOwnersUnderLease<T>(pmRoot: string, targets: readonly GithubOwnedTarget[], run: () => Promise<T>, work?: GithubOwnershipWork): Promise<T> {
  const active = ownershipScope.getStore();
  if (active?.root === pmRoot && targets.every(target => active.targets.some(outer => outer.id === target.id &&
    outer.repo.toLowerCase() === target.repo.toLowerCase() && outer.number === target.number &&
    (!target.mirrorContent || outer.mirrorContent) && (!target.expectedHash || target.expectedHash === outer.expectedHash) && !target.related?.length))) return run();
  const { pmRoot: root, settings, types } = await readGithubWorkspace(pmRoot);
  const corpus = await listAllItemMetadata(root, settings.item_format, types.type_to_folder, undefined, settings.schema);
  const observed = ownershipWork.getStore(); if (observed && observed !== work) observed.corpusReads = (observed.corpusReads ?? 0) + 1;
  if (work) work.corpusReads = (work.corpusReads ?? 0) + 1;
  const snapshot = buildGithubOwnershipIndex(corpus, targets.map(target => target.repo));
  let lockedIndex: Promise<GithubOwnershipIndex> | undefined;
  // Fail the whole selected batch before even creating an SDK journal.
  for (const target of targets) await readGithubImportOwner(pmRoot, target, snapshot);
  const byId = new Map(targets.map(target => [target.id, target]));
  return withGithubOwnershipHooks(pmRoot, "github-import-owner", "github-owner-delegate", async context => {
    const id = (context.before ?? context.after)?.metadata.id;
    const target = id && byId.get(id);
    if (target) {
      try {
        if (target.expectedHash && context.before && hashDocument(context.before) !== target.expectedHash) {
          return { allow: false, code: "item_revision_conflict", message: `GitHub import target ${target.id} changed after its ownership read (expected revision ${target.expectedHash}, current ${hashDocument(context.before)}).`, remediation: "Read the current item and retry against its intended ownership and revision." };
        }
        lockedIndex ??= context.sdk.list().then(items => {
          if (work) work.corpusReads = (work.corpusReads ?? 0) + 1;
          if (observed && observed !== work) observed.corpusReads = (observed.corpusReads ?? 0) + 1;
          return buildGithubOwnershipIndex(items, targets.map(target => target.repo));
        });
        const peers = await lockedIndex;
        for (const related of target.related ?? []) {
          const item = peers.byId.get(related.id);
          if (!item) throw new GithubImportOwnershipError(related.id, `${related.repo.toLowerCase()}#${related.number}`, ["missing dependency endpoint"]);
          assertGithubImportOwner(item, related, peers);
        }
        for (const document of [context.before, context.after]) if (document) {
          assertGithubImportOwner({ ...document.metadata, body: document.body }, target, peers);
        }
        if (context.after) updateOwnershipIndex(peers, { ...context.after.metadata, body: context.after.body });
      } catch (error: unknown) {
        if (!(error instanceof GithubImportOwnershipError)) throw error;
        return { allow: false, code: error.code, message: error.message, remediation: error.remedy };
      }
    }
  }, () => ownershipScope.run({ root, targets }, run));
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


/** Guard board-selected native changes against the complete owner corpus while allowing genuinely unowned items. */
export async function withGithubItemConsistency<T>(pmRoot: string, id: string, expected: readonly string[], run: () => Promise<T>): Promise<T> {
  return withGithubOwnershipLock(pmRoot, () => withGithubOwnershipHooks(pmRoot, "github-board-owner", "github-board-owner-delegate", async context => {
    if ((context.before ?? context.after)?.metadata.id !== id) return;
    const peers = buildGithubOwnershipIndex(await context.sdk.list(), expected.map(key => key.split("#")[0]!));
    for (const document of [context.before, context.after]) if (document) {
      const keys = assertGithubOwnershipConsistency({ ...document.metadata, body: document.body }, undefined, peers);
      if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new GithubImportOwnershipError(id, expected.join(" versus ") || "original unowned project item", keys);
    }
  }, run));
}

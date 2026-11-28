import { resolveCanonicalRelationshipKind, type UpdateCommandOptions } from "@unbrained/pm-cli/sdk";
import { normalizeGithubClaim, parseGithubIssueUrl } from "./github-url.ts";
import { mutateGithubOwnedItem, readGithubOwnershipSnapshot, withGithubOwnershipLock } from "./import-ownership.ts";
import type { PmItem } from "./index.ts";

/** The item selected to mirror one issue, including a stable future ID in previews. */
export interface IssueMirror { issue: number; item: string }

/** A native related edge between an imported issue and a citing item. */
export interface LocalIssueReference extends IssueMirror { local_item: string; kind: "related" }

/** Find whole tag atoms and complete GitHub issue URLs, independently of import ownership. */
function referenceKeys(item: PmItem): Set<string> {
  const keys = new Set<string>();
  for (const tag of item.tags ?? []) {
    const key = /^gh:/i.test(tag) ? normalizeGithubClaim(tag) : undefined;
    if (key) keys.add(key);
  }
  const url = parseGithubIssueUrl(item.github_url);
  if (url && !url.api) keys.add(url.key);
  return keys;
}

/** Read native related edges in either direction, including the SDK's legacy alias. */
function alreadyRelated(item: PmItem | undefined, other: string): boolean {
  const edges: unknown[] = Array.isArray(item?.dependencies) ? item.dependencies : [];
  return edges.some(edge => edge !== null && typeof edge === "object" && "id" in edge && edge.id === other &&
    "kind" in edge && typeof edge.kind === "string" && resolveCanonicalRelationshipKind(edge.kind) === "related");
}

/** Project the same missing native edges for preview and for apply. */
export function planLocalIssueReferences(items: readonly PmItem[], repo: string, mirrors: readonly IssueMirror[], projected: readonly PmItem[] = []): LocalIssueReference[] {
  if (!mirrors.length) return [];
  const repoKey = repo.toLowerCase();
  const byId = new Map(items.map(item => [item.id, item]));
  for (const item of projected) byId.set(item.id, { ...byId.get(item.id), ...item });
  const byKey = new Map(mirrors.map(mirror => [`${repoKey}#${mirror.issue}`, mirror]));
  const edges: LocalIssueReference[] = [];
  for (const item of byId.values()) {
    if (!item.id) continue;
    for (const key of referenceKeys(item)) {
      const mirror = byKey.get(key);
      if (mirror && item.id !== mirror.item && !alreadyRelated(item, mirror.item) && !alreadyRelated(byId.get(mirror.item), item.id)) {
        edges.push({ ...mirror, local_item: item.id, kind: "related" });
      }
    }
  }
  const pairs = new Set<string>();
  return edges.sort((a, b) => a.issue - b.issue || a.local_item.localeCompare(b.local_item)).filter(edge => {
    const pair = JSON.stringify([edge.item, edge.local_item].sort());
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    return true;
  });
}

/** Encode a mirror's required edges as one native, reversible SDK update. */
export function localIssueReferenceMutation(references: readonly LocalIssueReference[]) {
  const { item, issue } = references[0]!;
  const options = {
    dep: references.map(edge => `id=${edge.local_item},kind=${edge.kind}`),
    message: `Related to local items ${references.map(edge => edge.local_item).join(", ")} for GitHub issue #${issue}`,
  } satisfies UpdateCommandOptions;
  return { op: "update" as const, id: item, options };
}

/** Verify actual additions against current citations inside the SDK writer lock. */
export function guardLocalIssueReferences(repo: string, references: readonly LocalIssueReference[]) {
  const { item, issue } = references[0]!;
  return (peers: { items: readonly PmItem[] }, before?: PmItem, after?: PmItem): void => {
    const additions = references.filter(ref => !alreadyRelated(before, ref.local_item) && alreadyRelated(after, ref.local_item));
    if (!additions.length) return;
    const live = planLocalIssueReferences(peers.items, repo, [{ item, issue }]);
    if (additions.some(ref => !live.some(edge => edge.local_item === ref.local_item))) {
      throw new Error(`Local references to GitHub issue #${issue} changed during import. Retry the import.`);
    }
  };
}

/** Append only missing edges through the guarded SDK update API, targeting mirrors only. */
export async function applyLocalIssueReferences(pmRoot: string, repo: string, mirrors: readonly IssueMirror[], planned: readonly LocalIssueReference[]): Promise<LocalIssueReference[]> {
  if (!planned.length) return [];
  return withGithubOwnershipLock(pmRoot, async () => {
    const snapshot = await readGithubOwnershipSnapshot(pmRoot, [repo]);
    const edges = planLocalIssueReferences(snapshot.items, repo, mirrors.filter(mirror => snapshot.byId.has(mirror.item)));
    const grouped = new Map<string, LocalIssueReference[]>();
    for (const edge of edges) {
      const group = grouped.get(edge.item) ?? [];
      group.push(edge);
      grouped.set(edge.item, group);
    }
    for (const [id, references] of grouped) {
      const mutation = localIssueReferenceMutation(references);
      await mutateGithubOwnedItem(pmRoot, { id, repo, number: references[0]!.issue, mirrorContent: true,
        verifyPeers: guardLocalIssueReferences(repo, references),
      }, "update", mutation.options);
    }
    return edges;
  });
}

/** Omit an empty receipt and keep preview and write output structurally identical. */
export function localIssueReferenceReceipt(edges: readonly LocalIssueReference[] = []) {
  return edges.length ? { local_issue_references: edges } : {};
}

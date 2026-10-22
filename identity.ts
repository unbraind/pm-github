/** Offline identity diagnosis and explicitly approved, single-item provenance repairs. */
import { createHash } from "node:crypto";
import {
  resolvePmRoot, createPmCliExpectedError,
  commitItemMutations, previewItemMutations, getHistoryPath, readHistorySnapshot,
  type BulkItemMutation, type CommitItemMutationsOptions, type ItemMetadata,
} from "@unbrained/pm-cli/sdk";
import { readRefreshItems } from "./refresh.ts";

/** Full certified metadata plus the explicitly requested body projection. */
type IdentityItem = ItemMetadata & { body: string };

/** Stable machine-readable reasons for refusing identity work. */
export type IdentityRefusalCode = "invalid_options" | "incomplete_read" | "ambiguous_identity" | "stale_approval" | "unsupported_repair";
/** Throw an expected SDK error with a typed code and a concrete recovery instruction. */
function refuse(code: IdentityRefusalCode, remedy: string): never {
  throw createPmCliExpectedError(`GitHub identity explorer: ${code}. ${remedy}`, {
    exitCode: 2, context: { code, required: remedy },
  });
}
/** One item-to-identity edge; mentions never establish ownership. */
export interface IdentityEdge { item: string; identity: string; source: string; strength: "claim" | "mention" }
/** Compact native ownership evidence without titles, bodies or provider payloads. */
export interface IdentityNode { id: string; ownership: "github" | "provider" | "mixed" | "local"; providers: string[]; native_owner: string | null }
/** Bounded graph page with complete-corpus counts and explicit continuation. */
export interface IdentityReport {
  scanned: number; identities: number; collisions: number; mentions: number;
  total: number; next: number | null; nodes: IdentityNode[]; edges: IdentityEdge[];
}
/** A reviewable plan detaches only an exact GitHub provenance tag. */
export interface IdentityRepairPlan {
  identity: string; owner: string; detach: string; approval: string; revision: string;
  changes: { field: "tags"; before: string[]; after: string[] }[];
}
/** Canonicalize exact GitHub locators; opaque external references retain provider semantics. */
function identity(value: string): string {
  const match = /^(?:gh:([^/\s]+\/[^#\s]+)#|https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/)([1-9]\d*)(?:\/?(?:[?#].*)?)?$/i.exec(value);
  return match ? `gh:${(match[1] ?? match[2]!).toLowerCase()}#${BigInt(match[3]!).toString()}` : value;
}
/** Build edges from structured identity fields; prose URLs are explicitly weaker evidence. */
function graph(items: readonly IdentityItem[]): { nodes: IdentityNode[]; edges: IdentityEdge[] } {
  const nodes: IdentityNode[] = [];
  const edges: IdentityEdge[] = [];
  for (const item of items) {
    const id = item.id!;
    const providers = [...new Set(Object.keys(item).filter(key => /^(linear|jira|ado)_(?:.*_)?(?:id|key|url|identifier)$/i.test(key) && Boolean(item[key]) && (typeof item[key] !== "string" || item[key].trim() !== "")).map(key => key.split("_")[0]!.toLowerCase()))].sort();
    const claims: IdentityEdge[] = [];
    for (const tag of item.tags) if (/^gh:[^/\s]+\/[^#\s]+#[1-9]\d*$/i.test(tag)) claims.push({ item: id, identity: identity(tag), source: "tag", strength: "claim" });
    for (const source of ["external_ref", "github_url"]) {
      const value = item[source];
      if (typeof value === "string" && value.trim()) claims.push({ item: id, identity: identity(value), source, strength: "claim" });
    }
    const declared = /^GitHub issue(?:\s*:\s+|\s+)(https?:\/\/\S+)/i.exec(item.description);
    if (declared && identity(declared[1]!).startsWith("gh:")) claims.push({ item: id, identity: identity(declared[1]!), source: "declaration", strength: "claim" });
    const github = claims.some(edge => edge.identity.startsWith("gh:"));
    nodes.push({ id, providers, native_owner: typeof item.source_owner === "string" ? item.source_owner : null, ownership: providers.length ? (github && item.github_link_only !== true ? "mixed" : "provider") : github ? "github" : "local" });
    edges.push(...claims);
    for (const match of `${item.description}\n${item.body}`.matchAll(/https?:\/\/github\.com\/[^/\s<>]+\/[^/\s<>]+\/(?:issues|pull)\/[1-9]\d*/gi)) {
      const key = identity(match[0]);
      if (!claims.some(edge => edge.identity === key) && !edges.some(edge => edge.item === id && edge.identity === key && edge.strength === "mention")) edges.push({ item: id, identity: key, source: "prose", strength: "mention" });
    }
  }
  return { nodes, edges };
}
/** Read all statuses through the host's certified complete read, never a truncated CLI projection. */
async function read(pmRoot: string): Promise<IdentityItem[]> {
  try {
    return await readRefreshItems(pmRoot) as IdentityItem[];
  } catch { refuse("incomplete_read", "Restore a complete readable tracker and retry; no repair is safe with omitted items."); }
}
/** Diagnose all exact structured collisions and copied mentions with bounded identity pagination. */
export async function exploreGithubIdentities(pmRoot: string, options: { limit?: number; offset?: number; identity?: string } = {}): Promise<IdentityReport> {
  const { limit = 20, offset = 0 } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) refuse("invalid_options", "Use limit 1..100 and a nonnegative integer offset.");
  const items = await read(pmRoot);
  const { nodes, edges } = graph(items);
  const keys = [...new Set(edges.map(edge => edge.identity))].sort();
  const contradictory = new Set(nodes.filter(node => new Set(edges.filter(edge => edge.item === node.id && edge.strength === "claim" && edge.identity.startsWith("gh:")).map(edge => edge.identity)).size > 1).map(node => node.id));
  const collisions = keys.filter(key => new Set(edges.filter(edge => edge.identity === key && edge.strength === "claim").map(edge => edge.item)).size > 1 || edges.some(edge => edge.identity === key && edge.strength === "claim" && contradictory.has(edge.item)));
  const selected = options.identity === undefined ? keys.filter(key => collisions.includes(key) || edges.some(edge => edge.identity === key && edge.strength === "mention")) : keys.filter(key => key === identity(options.identity!));
  const page = selected.slice(offset, offset + limit);
  const shown = edges.filter(edge => page.includes(edge.identity));
  return { scanned: items.length, identities: keys.length, collisions: collisions.length, mentions: edges.filter(edge => edge.strength === "mention").length,
    total: selected.length, next: offset + limit < selected.length ? offset + limit : null,
    nodes: nodes.filter(node => shown.some(edge => edge.item === node.id)), edges: shown };
}
/** Bind approval to exact request, complete graph evidence and item revisions. */
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Refuse ownership ambiguity and build the only supported repair: detach a weak duplicate claim. */
function plan(items: IdentityItem[], key: string, owner: string, detach: string): IdentityRepairPlan {
  const { nodes, edges } = graph(items);
  const claims = edges.filter(edge => edge.identity === key && edge.strength === "claim");
  const owners = [...new Set(claims.filter(edge => ["github_url", "declaration"].includes(edge.source)).map(edge => edge.item))];
  const target = items.find(item => item.id === detach);
  if (!key.startsWith("gh:") || owner === detach || owners.length !== 1 || owners[0] !== owner || !target ||
    nodes.find(node => node.id === owner)!.ownership === "mixed" ||
    claims.some(edge => edge.item !== owner && edge.item !== detach) ||
    !claims.some(edge => edge.item === detach) || claims.some(edge => edge.item === detach && !["tag", "external_ref"].includes(edge.source)) ||
    target.source_owner ||
    edges.some(edge => [owner, detach].includes(edge.item) && edge.strength === "claim" && edge.identity.startsWith("gh:") && edge.identity !== key) ||
    target.github_link_only === false || Object.keys(target).some(field => /^github_/i.test(field))) {
    refuse("ambiguous_identity", "Inspect the graph and provider records. Select one independently declared owner and a duplicate carrying only a GitHub tag; conflicting source metadata requires manual provider review.");
  }
  if (typeof target.external_ref === "string" && identity(target.external_ref) === key) refuse("unsupported_repair", "The pinned SDK cannot clear core external_ref through audited item mutations. Repair that reference through its owning provider workflow; this command can detach GitHub tags only.");
  const tags = target.tags!;
  const retained = tags.filter(tag => identity(tag) !== key);
  const changes: IdentityRepairPlan["changes"] = [{ field: "tags", before: tags, after: retained }];
  return { identity: key, owner, detach, changes, revision: target.updated_at, approval: digest({ key, owner, detach, changes, nodes, edges, revisions: items.map(item => [item.id, item.updated_at]) }) };
}
/** Preview a scoped repair through real SDK semantic validation without touching the source tracker. */
export async function planGithubIdentityRepair(pmRoot: string, key: string, owner: string, detach: string): Promise<IdentityRepairPlan> {
  const proposed = plan(await read(pmRoot), identity(key), owner, detach);
  await previewItemMutations(transaction(pmRoot, proposed, "pm-github"));
  return proposed;
}
/** Encode the exact approved mutation in its native audited comment for crash recovery. */
function repairAudit(proposed: IdentityRepairPlan): string {
  return `GitHub identity repair ${Buffer.from(JSON.stringify(proposed)).toString("base64url")}`;
}
/** Translate the narrow plan to a host-owned audited mutation and optimistic item guard. */
function transaction(pmRoot: string, proposed: IdentityRepairPlan, author: string) {
  const options = { tags: proposed.changes[0]!.after.join(","), comment: [repairAudit(proposed)] };
  const mutations: BulkItemMutation[] = [{ op: "update", id: proposed.detach, options, match: { key: "updated_at", value: proposed.revision } }];
  return { pmRoot, author, transactionId: `github-identity-${proposed.approval}`, mutations };
}
/** Decode only a complete scoped tag plan from the immutable forward audit event. */
function auditedPlan(encoded: string): IdentityRepairPlan {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as IdentityRepairPlan;
    if (typeof value.revision !== "string" || !Number.isFinite(Date.parse(value.revision)) || value.changes.length !== 1 ||
      value.changes[0]!.field !== "tags" || !value.changes[0]!.after.every(tag => typeof tag === "string")) throw new Error("invalid audit");
    return value;
  } catch { refuse("stale_approval", "The audit marker cannot reconstruct the approved tag mutation; inspect tracker history before retrying."); }
}
/** Apply an exact approved plan with a writer-lock recheck; replay uses immutable SDK audit evidence. */
export async function applyGithubIdentityRepair(pmRoot: string, request: { identity: string; owner: string; detach: string; approval: string; author: string; onTransition?: CommitItemMutationsOptions["onTransition"] }): Promise<{ changed: boolean; transaction: string }> {
  if (!/^[a-f0-9]{64}$/.test(request.approval) || !request.author.trim()) refuse("invalid_options", "Supply the plan's full approval digest and a nonempty audit author.");
  pmRoot = resolvePmRoot(process.cwd(), pmRoot);
  const transactionId = `github-identity-${request.approval}`;
  const items = await read(pmRoot);
  const target = items.find(item => item.id === request.detach);
  if (target) {
    const history = await readHistorySnapshot(getHistoryPath(pmRoot, request.detach), request.detach);
    const marker = history.entries.filter(entry => String(entry.message).startsWith(`bulk-item-transaction ${transactionId} `)).at(-1);
    const encoded = marker && marker.message!.endsWith(" apply") ? /GitHub identity repair ([A-Za-z0-9_-]+)/.exec(JSON.stringify(marker.patch))?.[1] : undefined;
    if (encoded) {
      const saved = auditedPlan(encoded);
      const key = identity(request.identity);
      if (saved.identity !== key || saved.owner !== request.owner || saved.detach !== request.detach || saved.approval !== request.approval ||
        target.tags!.some(tag => identity(tag) === key) || (typeof target.external_ref === "string" && identity(target.external_ref) === key)) refuse("stale_approval", "The approved scope changed or its repaired claim was reintroduced; inspect and preview again.");
      await commitItemMutations(transaction(pmRoot, saved, marker!.author));
      return { changed: false, transaction: transactionId };
    }
  }
  const proposed = plan(items, identity(request.identity), request.owner, request.detach);
  if (proposed.approval !== request.approval) refuse("stale_approval", "Re-run the repair preview and review its new digest before applying.");
  await commitItemMutations({ ...transaction(pmRoot, proposed, request.author), onTransition: async context => {
    await request.onTransition?.(context);
    if (context.transition === "prepared" && plan(await read(pmRoot), proposed.identity, proposed.owner, proposed.detach).approval !== request.approval) refuse("stale_approval", "The tracker changed before the writer lock; preview and approve again.");
  } });
  return { changed: true, transaction: transactionId };
}

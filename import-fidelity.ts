/** Source lifecycle, release-window and cross-provider identity rules for issue imports. */
import { spawnSync } from "node:child_process";
import {
  acquireLock, appendHistoryEntry, canonicalDocument, createHistoryEntry, getHistoryPath,
  locateItem, normalizeItemId, readLocatedItem, readSettings, resolveItemTypeRegistry, resolvePmRoot, runActiveOnWriteHooks, serializeItemDocument, writeFileAtomic,
} from "@unbrained/pm-cli/sdk";
import { CommandError, fetchJSON, githubApiBase, githubGraphQL, parseNextLink, type GhIssue, type PmItem } from "./index.ts";

/**
 * Select the latest external edit or different lifecycle generation in immutable history.
 * Creation staging and compensation are transient; importing the desired state again
 * keeps the selected revision stable, including after an interrupted governed update.
 * @internal Shared by transaction planning and deterministic history-shape tests.
 */
export function selectImportContextIndex(entries: readonly { message?: string; patch: readonly { path: string; value?: unknown }[] }[], status: string): number {
  let currentStatus: unknown;
  let selected = -1;
  for (const [index, event] of entries.entries()) {
    for (const patch of event.patch) {
      if (patch.path === "/metadata/status") currentStatus = patch.value;
    }
    const message = event.message ?? "";
    const owned = /^(?:pm-github import create |bulk-item-transaction github-import-|Compensate interrupted bulk transaction github-import-|Preserve GitHub source lifecycle for issue #\d+$)/.test(message);
    const transient = /^(?:pm-github import create |Compensate interrupted bulk transaction github-import-)|^bulk-item-transaction github-import-.* compensate$/.test(message);
    if (!owned || (currentStatus !== undefined && currentStatus !== status && !transient)) selected = index;
  }
  return selected;
}

/** One locally available release tag and its actual Git date. */
export interface ImportRelease { tag: string; date: string }
/** Auditable desired source metadata, persisted beside the native lifecycle. */
export interface ImportFidelity {
  github_url: string;
  github_number: number;
  github_state: string;
  github_state_reason: string;
  github_created_at: string;
  github_updated_at: string;
  github_closed_at: string;
  github_close_reason: string;
  github_release: string;
}
/** Identity decision recorded before any import writes. */
export interface ImportMatch { item?: PmItem; linkOnly: boolean; via: string }

/** Normalize only complete HTTP issue/provider locators, never substring identities. */
function locators(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return [...text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)].map(match => match[0]!.replace(/[),.;]+$/, "").replace(/\/$/, "").toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/, "https://github.com/$1/$2/issues/$3"));
}

/** Copied body text and labels cannot transfer an established GitHub import to another owner. */
function copiedProviderMarkersOwnItem(item: PmItem): boolean {
  return item.github_link_only !== false && !item.tags?.some(tag => /^gh:[^/]+\/[^#]+#\d+$/.test(tag));
}

/** Extract declared provider fields and the description/body markers used by provider exporters. */
function providerProvenance(item: PmItem): string {
  const identities = new Set(Object.entries(item).filter(([key, value]) =>
    /^(linear|jira|ado)_(?:.*_)?(?:id|key|url|identifier)$/i.test(key) && Boolean(value) &&
    (typeof value !== "string" || value.trim() !== "")).map(([key]) => key));
  const declared = identities.size > 0 || (copiedProviderMarkersOwnItem(item) && item.tags?.some(tag => /^(linear|jira|ado):/i.test(tag))) ||
    Object.entries(item).some(([key, value]) => /^(provider|source|provenance)$/i.test(key) && (typeof value === "string"
      ? /^(?:pm-)?(?:linear|jira|ado)$/i.test(value.trim())
      : /"(?:provider|source|system)"\s*:\s*"(?:pm-)?(?:linear|jira|ado)"/i.test(JSON.stringify(value) ?? "")));
  return Object.entries(item).filter(([key, value]) => identities.has(key) ||
    (declared && /^provider$|url|link|provenance|source|external/i.test(key)) ||
    ((/description|provenance/i.test(key) || copiedProviderMarkersOwnItem(item)) && /description|body|provenance/i.test(key) && typeof value === "string" &&
      /\[(linear|jira|ado)\]|\b(linear|jira|ado)_(id|key|url)=|Jira(?:\s+[A-Z][A-Z0-9]+-\d+)?:\s/i.test(value)))
    .map(([, value]) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

/** Match GitHub locators or provider back-links before creation, refusing multiple owners. */
export function matchImportedIssue(items: readonly PmItem[], issue: GhIssue, tagged?: PmItem): ImportMatch {
  const issueUrl = locators(issue.html_url)[0]!;
  const bodyUrls = new Set(locators(issue.body ?? ""));
  const candidates = items.filter(item => item.id && (item.id === tagged?.id ||
    Object.entries(item).some(([key, value]) => /^(?:github_?url|provenance|external_?(?:links?|url)|links?)$/i.test(key) && locators(value).includes(issueUrl)) ||
    locators(providerProvenance(item)).some(url => bodyUrls.has(url))));
  if (candidates.length > 1) throw new CommandError(`GitHub issue #${issue.number} has multiple existing owners; import plan is not idempotent. No item was written for this issue.`);
  const item = candidates[0];
  const provider = item && (Boolean(providerProvenance(item)) || (copiedProviderMarkersOwnItem(item) && item.tags?.some(tag => /^(linear|jira|ado):/i.test(tag))));
  return { item, linkOnly: Boolean(item && (provider || item.github_link_only === true)),
    via: item ? (provider ? "provider-link" : item.id === tagged?.id ? "provenance-tag" : "github-url") : "new" };
}

/** Read calendar release tags from the selected tracker checkout, including annotated tag dates. */
export function readImportReleases(pmRoot: string): ImportRelease[] {
  const result = spawnSync("git", ["-C", pmRoot, "for-each-ref", "--format=%(refname:short)%09%(creatordate:iso-strict)", "refs/tags"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.trim().split("\n").flatMap(line => {
    const [tag, date] = line.split("\t");
    return /^v?\d{4}\.\d{1,2}\.\d{1,2}$/.test(tag!) && Number.isFinite(Date.parse(date!)) ? [{ tag: tag!, date: date! }] : [];
  }).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.tag.localeCompare(b.tag));
}

/** Select only the latest closure within GitHub's observed forward timestamp skew. */
function latestClosure(events: readonly unknown[], closedAt: string | null | undefined, graphql = false): Record<string, unknown> | undefined {
  const candidates = events.filter((event): event is Record<string, unknown> => event !== null && typeof event === "object" && !Array.isArray(event))
    .filter(event => graphql ? event.__typename === "ClosedEvent" : event.event === "closed");
  const key = graphql ? "createdAt" : "created_at";
  return candidates.filter(event => {
    const delta = typeof event[key] === "string" && closedAt ? Date.parse(event[key]) - Date.parse(closedAt) : NaN;
    return Number.isFinite(delta) && delta >= 0 && delta <= 5_000;
  }).sort((left, right) => Date.parse(String(left[key])) - Date.parse(String(right[key]))).at(-1);
}

/** Fetch every timeline page; only closure-specific events may supply resolution evidence. */
export async function fetchImportTimeline(issue: GhIssue, repo: string, token?: string): Promise<unknown[]> {
  if (issue.state !== "closed") return [];
  let url: string | undefined = `${githubApiBase()}/repos/${repo}/issues/${issue.number}/timeline?per_page=100`;
  const events: unknown[] = [];
  while (url) {
    const response = await fetchJSON(url, token);
    if (response.status !== 200) throw new CommandError(`Could not read closure timeline for issue #${issue.number} (HTTP ${response.status}).`);
    let page: unknown;
    try { page = JSON.parse(response.body); }
    catch { throw new CommandError(`Closure timeline for issue #${issue.number} is not valid JSON.`); }
    if (!Array.isArray(page)) throw new CommandError(`Invalid closure timeline for issue #${issue.number}.`);
    events.push(...page);
    url = parseNextLink(response.linkHeader);
  }
  const closed = latestClosure(events, issue.closed_at);
  if (token && !(typeof closed?.commit_id === "string" && /^[a-f0-9]{40}$/i.test(closed.commit_id))) {
    const [owner, name] = repo.split("/");
    let cursor: string | null = null;
    do {
      const data: { repository: { issue: { timelineItems: { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string } } } } } = await githubGraphQL(token,
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String) { repository(owner:$owner,name:$name) { issue: ${issue.pull_request ? "pullRequest" : "issue"}(number:$number) { timelineItems(first:100,after:$cursor,itemTypes:[CLOSED_EVENT,CONNECTED_EVENT]) { nodes { __typename ... on ClosedEvent { createdAt closer { __typename ... on PullRequest { url title } ... on Commit { url messageHeadline oid } } } ... on ConnectedEvent { createdAt subject { __typename ... on PullRequest { url title } } } } pageInfo { hasNextPage endCursor } } } } }`,
        { owner, name, number: issue.number, cursor });
      const connection = data.repository?.issue?.timelineItems;
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
        throw new CommandError(`Invalid GraphQL closure timeline for issue #${issue.number}.`);
      }
      events.push(...connection.nodes);
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
  }
  return events;
}

/** Accept only GitHub PR/commit evidence tied to the latest closure, excluding pre-reopen events. */
export function importCloseReason(issue: GhIssue, events: readonly unknown[]): string {
  const reason = issue.state_reason ?? "unspecified";
  const base = `Closed on GitHub as ${reason} on ${issue.closed_at ?? "an unknown date"}`;
  const records = events.filter((event): event is Record<string, unknown> => event !== null && typeof event === "object" && !Array.isArray(event));
  const closed = latestClosure(records, issue.closed_at);
  if (closed && typeof closed.commit_id === "string" && /^[a-f0-9]{40}$/i.test(closed.commit_id)) {
    const linkedCommit = typeof closed.commit_url === "string"
      ? /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/commits\/([a-f0-9]{40})$/.exec(closed.commit_url) : null;
    const repoUrl = linkedCommit && linkedCommit[3] === closed.commit_id
      ? `https://github.com/${linkedCommit[1]}/${linkedCommit[2]}` : issue.html_url.replace(/\/(?:issues|pull)\/\d+$/, "");
    return `${base}; closing commit ${repoUrl}/commit/${closed.commit_id}`;
  }
  const graphClosed = latestClosure(records, issue.closed_at, true);
  const graphEvents = [
    ...(graphClosed ? [graphClosed] : []),
    ...records.filter(event => event.__typename === "ConnectedEvent").reverse(),
  ];
  for (const event of graphEvents) {
    const closer = event.__typename === "ClosedEvent" ? event.closer : event.subject;
    if (closer && typeof closer === "object" && "url" in closer && typeof closer.url === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull\/\d+|commit\/[a-f0-9]{40})$/.test(closer.url)) {
      const title = "title" in closer ? closer.title : "messageHeadline" in closer ? closer.messageHeadline : undefined;
      return `${base}; ${event.__typename === "ClosedEvent" ? "closing" : "linked"} ${closer.url.includes("/pull/") ? "PR" : "commit"} ${closer.url}${typeof title === "string" ? ` (${JSON.stringify(title)})` : ""}`;
    }
  }
  const connected = records.find(event => event.event === "connected" && typeof event.url === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(event.url));
  return connected ? `${base}; linked PR ${connected.url}` : base;
}

/** Validate source lifetimes and assign the earliest release tag at or after the closure. */
export function buildImportFidelity(issue: GhIssue, releases: readonly ImportRelease[], timeline: readonly unknown[]): ImportFidelity {
  const created = Date.parse(issue.created_at);
  const updated = Date.parse(issue.updated_at);
  const closed = issue.closed_at ? Date.parse(issue.closed_at) : undefined;
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created ||
    (closed !== undefined && (!Number.isFinite(closed) || closed < created || closed > updated))) {
    throw new CommandError(`GitHub issue #${issue.number} has an invalid source lifetime; nothing may be imported.`);
  }
  return {
    github_url: issue.html_url, github_number: issue.number, github_state: issue.state,
    github_state_reason: issue.state_reason ?? "unspecified",
    github_created_at: issue.created_at, github_updated_at: issue.updated_at,
    github_closed_at: issue.state === "closed" ? issue.closed_at ?? "" : "",
    github_close_reason: issue.state === "closed" ? importCloseReason(issue, timeline) : "",
    github_release: issue.state === "closed" && closed !== undefined ? releases.find(release => Date.parse(release.date) >= closed)?.tag ?? "" : "",
  };
}

/** Project the import-owned metadata; undefined values remove stale native lifecycle fields. */
export function importFidelityFields(fidelity: ImportFidelity, linkOnly: boolean): Record<string, unknown> {
  return {
    ...fidelity, github_link_only: linkOnly,
    ...(!linkOnly ? {
      created_at: fidelity.github_created_at,
      close_reason: fidelity.github_state === "closed" ? fidelity.github_close_reason : undefined,
      ...(fidelity.github_closed_at || fidelity.github_state === "open" ? {
        closed_at: fidelity.github_closed_at || undefined,
        completed_at: fidelity.github_closed_at || undefined,
      } : {}),
      release: fidelity.github_release || undefined,
    } : {}),
  };
}

/** Compare source instants and tag sets without treating their serialized representation as a change. */
export function normalizeImportValue(field: string, value: unknown): unknown {
  if (field === "tags") return [...new Set(value as string[] ?? [])].sort();
  if (/^(?:github_)?(?:created|updated|closed|completed)_at$/.test(field) && typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return value;
}

/**
 * Finalize source metadata through public SDK lock, serialization and append-only history primitives.
 * High-level create/update reserve native timestamps. This import adapter appends a real
 * before/after event instead of editing past history; retrying identical metadata is a no-op.
 * Cross-provider owners retain their creation/completion dates, content and release.
 */
export async function persistImportFidelity(pmRoot: string, id: string, fidelity: ImportFidelity, linkOnly: boolean, normalizeFields = false): Promise<void> {
  pmRoot = resolvePmRoot(process.cwd(), pmRoot);
  const settings = await readSettings(pmRoot);
  id = normalizeItemId(id, settings.id_prefix);
  const unlock = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, "pm-github", false,
    settings.governance.force_required_for_stale_lock, settings.locks.wait_ms);
  try {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
    if (!located) throw new CommandError(`Imported item ${id} is missing during lifecycle finalization.`);
    const { document, raw } = await readLocatedItem(located);
    const before = canonicalDocument(document);
    for (const [field, value] of Object.entries(importFidelityFields(fidelity, linkOnly))) {
      if (normalizeFields && JSON.stringify(normalizeImportValue(field, document.metadata[field])) === JSON.stringify(normalizeImportValue(field, value))) continue;
      if (value === undefined) delete document.metadata[field];
      else document.metadata[field] = value;
    }
    if (document.metadata.closed_at && Date.parse(document.metadata.closed_at) < Date.parse(document.metadata.created_at)) {
      throw new CommandError(`GitHub issue #${fidelity.github_number} needs a source closure date before its lifecycle can be imported safely.`);
    }
    if (JSON.stringify(before) === JSON.stringify(canonicalDocument(document))) return;
    // SDK bulk rollback addresses history by native updated_at. Keep that clock
    // equal to the appended event timestamp; source time lives in github_updated_at.
    const now = new Date().toISOString();
    document.metadata.updated_at = now;
    const after = canonicalDocument(document);
    const history = createHistoryEntry({ nowIso: now, author: "pm-github", op: "import", before, after,
      message: `Preserve GitHub source lifecycle for issue #${fidelity.github_number}` });
    await writeFileAtomic(located.itemPath, serializeItemDocument(after, { format: located.item_format }));
    try { await appendHistoryEntry(getHistoryPath(pmRoot, id), history); }
    catch (error) { await writeFileAtomic(located.itemPath, raw); throw error; }
    const hookContext = { scope: "project" as const, item_id: id, item_type: after.metadata.type,
      before, after, changed_fields: history.patch.map(patch => patch.path) };
    await runActiveOnWriteHooks({ ...hookContext, path: located.itemPath, op: "import" });
    await runActiveOnWriteHooks({ ...hookContext, path: getHistoryPath(pmRoot, id), op: "import:history" });
  } finally { await unlock(); }
}

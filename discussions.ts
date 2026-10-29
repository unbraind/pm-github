/** Explicit GitHub issue-comment decisions, persisted only through the host-injected SDK. */
import { createHash } from "node:crypto";
import { createPmCliExpectedError, getHistoryPath, readHistorySnapshot, normalizeItemId, previewItemMutations, locateItem, readLocatedItem } from "@unbrained/pm-cli/sdk";
import type { ExtensionCommandSdk } from "@unbrained/pm-cli/sdk/authoring";
import { readGithubWorkspace } from "./workspace.ts";
import { fetchJSON, githubApiBase, resolveGitHubToken } from "./index.ts";
import { discussionRequestSchema, discussionSourceSchema, discussionEvidenceSchema, discussionReportSchema, type DiscussionCaptureInput, type DiscussionCaptureReport, type DiscussionDecisionEvidence } from "./discussion-schema.ts";
import { z } from "zod";

/** Stable refusals do not echo source text, provider responses or local paths. */
export type DiscussionRefusalCode = "invalid_selection" | "host_required" | "source_unavailable" | "source_changed" | "target_unavailable" | "stale_plan" | "invalid_output";
/** Selected comment reader allows real HTTP adapters without SDK mocks. */
export type DiscussionCommentReader = (repo: string, issue: number, comment: number) => Promise<unknown>;
/** Apply requires the exact preview digest; omitted approval is a read-only plan. */
export interface DiscussionCaptureOptions {
  approval?: string;
  maxOutputBytes?: number;
  readComment?: DiscussionCommentReader;
  /** @internal Deterministic interleavings use real SDK writers at each observable boundary. */
  onBoundary?: (boundary: "parent_read" | "source_read" | "target_read" | "before_write" | "after_write", index: number) => Promise<void>;
}
/** Typed expected failure with one bounded, actionable recovery instruction. */
export function refuseDiscussion(code: DiscussionRefusalCode, remedy: string): never {
  throw createPmCliExpectedError(`GitHub discussion capture: ${code}. ${remedy}`, { exitCode: 2, context: { code, required: remedy } });
}
/** Hash exact source bytes and SDK history, never a handwritten native normalizer. */
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Fetch only the selected issue and comment; PR review threads are owned by pm-review. */
export async function readGithubDiscussionComment(repo: string, issue: number, comment: number): Promise<unknown> {
  try {
    const token = resolveGitHubToken();
    const issueResult = await fetchJSON(`${githubApiBase()}/repos/${repo}/issues/${issue}`, token);
    if (issueResult.status !== 200 || Buffer.byteLength(issueResult.body) > 262144) throw new Error("incomplete issue");
    const issueRow = z.object({ number: z.number(), pull_request: z.unknown().optional() }).parse(JSON.parse(issueResult.body));
    if (issueRow.pull_request !== undefined || issueRow.number !== issue) throw new Error("not an issue");
    const result = await fetchJSON(`${githubApiBase()}/repos/${repo}/issues/comments/${comment}`, token);
    if (result.status !== 200 || Buffer.byteLength(result.body) > 524288) throw new Error("incomplete comment");
    return JSON.parse(result.body) as unknown;
  } catch { refuseDiscussion("source_unavailable", "Restore read access to the selected GitHub issue and comment; PR review comments use pm-review."); }
}

/** Validate remote attribution, exact issue membership and the explicitly marked span. */
async function evidence(input: DiscussionCaptureInput, selected: DiscussionCaptureInput["selections"][number], reader: DiscussionCommentReader): Promise<DiscussionDecisionEvidence> {
  let raw: unknown;
  try { raw = await reader(input.repo, input.issue, selected.comment); }
  catch { refuseDiscussion("source_unavailable", "Restore read access to this selected issue comment and preview again."); }
  const parsed = discussionSourceSchema.safeParse(raw);
  if (!parsed.success) refuseDiscussion("source_unavailable", "Fetch a complete bounded comment with author, body and update timestamp; preview again.");
  const source = parsed.data;
  const url = `https://github.com/${input.repo}/issues/${input.issue}#issuecomment-${selected.comment}`;
  if (source.id !== selected.comment || source.issue_url.toLowerCase() !== `https://api.github.com/repos/${input.repo}/issues/${input.issue}` || source.html_url.toLowerCase() !== url) {
    refuseDiscussion("invalid_selection", "Select a comment belonging to the exact repository and issue; cross-issue and PR passages are refused.");
  }
  if (selected.end <= selected.start || source.body.slice(selected.start, selected.end) !== selected.quote || selected.end > source.body.length) {
    refuseDiscussion("source_changed", "Read the current comment and select exact UTF-16 start/end offsets and quote bytes again.");
  }
  return discussionEvidenceSchema.parse({ type: "github.discussion-decision.v1", repo: input.repo, issue: input.issue,
    comment: source.id, url, revision: hash([source.id, source.body, source.issue_url, source.html_url, source.updated_at, source.user.id, source.user.login]), author: source.user, updatedAt: source.updated_at,
    span: { start: selected.start, end: selected.end, quote: selected.quote } });
}

/** SDK history length plus exact stream digest prevents content-only ABA approvals. */
async function revision(pmRoot: string, id: string): Promise<string> {
  const snapshot = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
  if (!snapshot.entries.length) refuseDiscussion("target_unavailable", "Restore readable native item history before capturing a related Decision.");
  return `${snapshot.entries.length}:${hash(snapshot.raw)}`;
}

/** Native document reads avoid command-level usage recording during a read-only plan. */
async function nativeItem(workspace: Awaited<ReturnType<typeof readGithubWorkspace>>, id: string) {
  const located = await locateItem(workspace.pmRoot, id, workspace.settings.id_prefix, workspace.settings.item_format, workspace.types.type_to_folder);
  return located ? (await readLocatedItem(located, { schema: workspace.settings.schema })).document : undefined;
}

/** Read the current deterministic target. Foreign or edited records are preserved individually. */
async function target(workspace: Awaited<ReturnType<typeof readGithubWorkspace>>, id: string, marker: string, body: string) {
  try {
    const document = await nativeItem(workspace, id);
    const snapshot = await readHistorySnapshot(getHistoryPath(workspace.pmRoot, id), id);
    if (!document) return snapshot.raw === null
      ? { state: "create" as const, revision: null, reason: "selected_marked_span" as const }
      : { state: "skipped" as const, revision: `${snapshot.entries.length}:${hash(snapshot.raw)}`, reason: "foreign_or_edited" as const };
    const message = snapshot.entries[0]?.message;
    const owned = snapshot.entries.length === 1 && typeof message === "string" && (message === marker || message.startsWith(`${marker} | `)) && document.body === body && document.metadata.type === "Decision";
    return { state: owned ? "unchanged" as const : "skipped" as const, revision: owned ? null : await revision(workspace.pmRoot, id), reason: owned ? "already_captured" as const : "foreign_or_edited" as const };
  } catch {
    return { state: "skipped" as const, revision: "unreadable", reason: "foreign_or_edited" as const };
  }
}

/** One native producer is shared by semantic preview and the actual SDK create. */
function nativeCreate(id: string, parent: string, source: DiscussionDecisionEvidence, marker: string, status: string) {
  return { id, type: "Decision", title: `GitHub issue #${source.issue} decision`, status,
    description: `Selected GitHub issue-comment evidence: ${source.url}`, body: JSON.stringify(source),
    parent, clearDeps: true, unset: ["sprint", "release", "goal", "objective"],
    tags: "github-discussion-decision", message: marker,
    doc: [`path: ${source.url}\nscope: project\nnote: Source revision ${source.revision}`] };
}

/** Reconcile final reads and ambiguous create failures through the same current-state verdict. */
function reconciledTarget(current: Awaited<ReturnType<typeof target>>) {
  return current.state === "create"
    ? { state: "refused" as const, reason: "write_failed" as const, remedy: "Check native tracker health and retry the reviewed capture; successful earlier rows are retained." }
    : { state: current.state, reason: current.reason, remedy: current.state === "skipped" ? "Preserve the existing record; review its native history." : "" };
}

/** Bound and validate every successful producer result before a write or response. */
export function validateDiscussionCaptureReport(value: unknown, maxOutputBytes = 65536): DiscussionCaptureReport {
  const parsed = discussionReportSchema.safeParse(value);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 131072 || !parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > maxOutputBytes) {
    refuseDiscussion("invalid_output", "Use at most ten spans of 4096 code units and a maxOutputBytes integer from 1024 through 131072; split oversized captures.");
  }
  return parsed.data;
}

/**
 * Preview and apply share source preparation, ownership checks and native create options.
 * Independent creates need no frozen journal or compensation. Retry always reads current
 * sources, parent history and each Decision. A workspace transaction would not exclude
 * ordinary SDK writers: the final read-to-create window remains explicitly optimistic.
 */
export async function captureGithubDiscussion(pmPath: string, value: DiscussionCaptureInput, sdk: ExtensionCommandSdk | undefined, options: DiscussionCaptureOptions = {}): Promise<DiscussionCaptureReport> {
  const parsed = discussionRequestSchema.safeParse(value);
  if (!parsed.success || options.approval !== undefined && (typeof options.approval !== "string" || !/^[a-f0-9]{64}$/.test(options.approval))) refuseDiscussion("invalid_selection", "Supply repo, positive issue, existing item and at most ten dense explicitly marked selections with exact offsets and quotes; approve only a full preview digest.");
  const input = parsed.data;
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1024 || options.maxOutputBytes > 131072)) refuseDiscussion("invalid_output", "Set maxOutputBytes to an integer from 1024 through 131072.");
  if (!sdk) refuseDiscussion("host_required", "Run with a supported pm extension host or inject its tracker-bound ExtensionCommandSdk.");
  const workspace = await readGithubWorkspace(pmPath);
  const { pmRoot, settings, statuses } = workspace;
  let parent: string;
  let parentRevision: string;
  try {
    const document = await nativeItem(workspace, input.item);
    if (!document) throw new Error("missing context item");
    parent = document.metadata.id;
    parentRevision = await revision(pmRoot, parent);
  } catch { refuseDiscussion("target_unavailable", "Select an existing readable native item with complete history in this tracker."); }
  await options.onBoundary?.("parent_read", -1);
  const reader = options.readComment ?? readGithubDiscussionComment;
  const rows: DiscussionCaptureReport["rows"] = [];
  const prepared = [];
  const seen = new Set<string>();
  for (const [index, selected] of input.selections.entries()) {
    try {
      const source = await evidence(input, selected, reader);
      await options.onBoundary?.("source_read", index);
      const key = hash({ parent, source });
      const id = normalizeItemId(`discussion-${key.slice(0, 32)}`, settings.id_prefix);
      const body = JSON.stringify(source);
      const marker = `github discussion capture v1 ${hash({ key, parentRevision })}`;
      const current = await target(workspace, id, marker, body);
      await options.onBoundary?.("target_read", index);
      const duplicate = seen.has(id); seen.add(id);
      if (!duplicate && current.state === "create") {
        try { await previewItemMutations({ pmRoot, author: "pm-github", transactionId: `discussion-preview-${hash({ id, parentRevision, source, settings })}`,
          mutations: [{ op: "create", id, options: nativeCreate(id, parent, source, marker, statuses.open_status) }] }); }
        catch {
          rows.push({ id, state: "refused", reason: "native_refused", remedy: "Native SDK semantic preview refused this Decision. Check configured create requirements and tracker health; preview again.", evidence: source });
          continue;
        }
      }
      rows.push({ id, state: duplicate ? "skipped" : current.state, reason: duplicate ? "duplicate_selection" : current.reason, remedy: current.state === "skipped" ? "Preserve the existing record; review its native history." : "", evidence: source });
      prepared.push({ index, selected, source, id, body, marker, current, duplicate });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "source_unavailable" && code !== "source_changed" && code !== "invalid_selection") throw error;
      rows.push({ id: `selection-${index + 1}`, state: "refused", reason: code, remedy: "Refresh this comment and review its exact marked selection; other records remain independent.", evidence: null });
    }
  }
  const schemaRevision = hash({ settings, statuses: statuses.definitions });
  const approval = hash({ pmRoot, parent, parentRevision, schemaRevision,
    rows: rows.map(row => ({ id: row.id, evidence: row.evidence, refusal: row.state === "refused" ? row.reason : null })),
    targets: prepared.map(row => row.current.revision) });
  if (options.approval !== undefined && options.approval !== approval) refuseDiscussion("stale_plan", "Source, target history or schema changed. Preview again and review the new approval digest; no frozen plan is replayed.");
  /** Derive counters from rows for every producer, including partial failure and retry receipts. */
  const report = (): DiscussionCaptureReport => validateDiscussionCaptureReport({ ok: true, mode: options.approval === undefined ? "plan" : "apply", approval, item: parent, status: statuses.open_status,
    selected: rows.length, created: rows.filter(row => row.state === "created").length, unchanged: rows.filter(row => row.state === "unchanged").length,
    skipped: rows.filter(row => row.state === "skipped").length, refused: rows.filter(row => row.state === "refused").length, rows }, options.maxOutputBytes);
  const preview = report();
  if (Buffer.byteLength(JSON.stringify(preview)) + rows.length * 512 > (options.maxOutputBytes ?? 65536)) refuseDiscussion("invalid_output", "Increase maxOutputBytes or select fewer spans; reserve space for per-record retry and refusal receipts.");
  if (options.approval !== undefined) for (const row of prepared) {
    if (row.duplicate || row.current.state !== "create") continue;
    await options.onBoundary?.("before_write", row.index);
    const fresh = await evidence(input, row.selected, reader);
    const currentParent = await revision(pmRoot, parent);
    const currentWorkspace = await readGithubWorkspace(pmPath);
    if (hash(fresh) !== hash(row.source) || currentParent !== parentRevision || hash({ settings: currentWorkspace.settings, statuses: currentWorkspace.statuses.definitions }) !== schemaRevision) {
      refuseDiscussion("stale_plan", "A selected source, parent history or schema changed before a write. Preserve successful earlier captures and preview again.");
    }
    const current = await target(workspace, row.id, row.marker, row.body);
    if (current.state !== "create") {
      Object.assign(rows[row.index]!, reconciledTarget(current));
      continue;
    }
    try {
      await sdk.client.create(nativeCreate(row.id, parent, row.source, row.marker, statuses.open_status));
      Object.assign(rows[row.index]!, { state: "created", reason: "captured" });
    } catch {
      const peer = await target(workspace, row.id, row.marker, row.body);
      Object.assign(rows[row.index]!, reconciledTarget(peer));
    }
    await options.onBoundary?.("after_write", row.index);
  }
  return report();
}

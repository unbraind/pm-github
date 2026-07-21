// pm-github — GitHub Issues + Projects v2 sync for pm-cli
//
// Capabilities (see manifest.json):
//   commands   — `pm gh-issues import` (legacy) + `pm github sync` +
//                `pm github project list|fields|import|sync` (Projects v2)
//   importers  — `pm github import <owner/repo>` (idempotent native import)
//   exporters  — `pm github export` (render pm items as a GitHub-issues payload)
//   schema     — declares github_url / github_number / github_state /
//                github_author / github_created_at / github_updated_at item fields
//   hooks      — afterCommand: actionable sync hint for github-linked items
//   preflight  — local guard for mutating github commands (token presence)
//
// Issues use the REST API; Projects v2 is GraphQL-only (see the Projects v2
// section below and the pure plan/mapping logic in ./projects.ts).

import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";
import type {
  BulkItemMutation,
  CommitItemMutationsOptions,
  CommitItemMutationsResult,
} from "@unbrained/pm-cli/sdk";

// The `comments()` annotation primitive is only exported from the public SDK
// since pm CLI 2026.7.14. Load it lazily so hosts on older CLI versions still
// load the extension fine (this is ESM — a missing named export in a static
// import kills the whole module at load time); only `--comments-mode
// annotations|both` needs it, and it degrades with a clear error instead.
type PmCommentsFn = (
  itemId: string,
  options: Record<string, unknown>,
  ctx: { pmRoot: string },
) => Promise<{ comments?: unknown[] } | undefined>;

async function loadPmComments(): Promise<PmCommentsFn> {
  const sdk = (await import("@unbrained/pm-cli/sdk")) as Record<string, unknown>;
  const fn = sdk.comments;
  if (typeof fn !== "function") {
    throw new Error(
      "the installed pm CLI does not export the SDK comments() primitive (requires pm CLI >= 2026.7.14)",
    );
  }
  return fn as PmCommentsFn;
}

import {
  type ProjectItem,
  type ProjectItemContent,
  type ProjectMeta,
  type ProjectRef,
  type ProjectStatusField,
  buildProjectImportPlan,
  buildProjectPullPlan,
  buildProjectPushPlan,
  parseProjectItemTag,
  parseProjectRef,
  parseStatusMap,
  projectItemTag,
} from "./projects.js";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | null;
  labels: Array<{ name: string }>;
  user?: { login: string } | null;
  assignee: { login: string } | null;
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments?: number;
  comments_url?: string;
  pull_request?: unknown;
  // GitHub sets `draft: true` on issues that are draft pull requests.
  draft?: boolean;
}

export interface GhComment {
  id: number;
  user: { login: string } | null;
  created_at: string;
  body: string | null;
}

// How fetched GitHub issue comments are persisted on the pm item.
//
// - "body"        — (default, byte-identical to pre-2026.7.14 behavior) flatten
//                   comments into the item body as blockquoted markdown under a
//                   `### GitHub comments (N)` heading. Governed by --with-comments.
// - "annotations" — sync comments into the pm item's native comments collection
//                   via the SDK `comments()` primitive. Comments are fetched
//                   regardless of --with-comments. Re-sync is idempotent: each
//                   stored comment carries a stable `<!-- pm-github:comment:N -->`
//                   marker (the GitHub comment id), so re-running import never
//                   duplicates.
// - "both"        — write the body section AND sync the native comments.
type CommentsMode = "body" | "annotations" | "both";

const COMMENTS_MODES: readonly CommentsMode[] = ["body", "annotations", "both"];

export interface ImportOptions {
  state: "open" | "closed" | "all";
  labels?: string;
  since?: string;
  assignee?: string;
  milestone?: string;
  includePrs: boolean;
  skipDrafts: boolean;
  withComments: boolean;
  commentsMode: CommentsMode;
  itemType: string;
  dryRun: boolean;
  atomic: boolean;
}

type CommitItemMutations = (
  options: CommitItemMutationsOptions,
) => Promise<CommitItemMutationsResult>;

export interface AtomicImportOptions {
  atomicAuthor?: string;
  commitItemMutations?: CommitItemMutations;
  normalizeItemId?: (input: string, prefix: string) => string;
  readSettings?: (pmRoot: string) => Promise<{ id_prefix?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  linkHeader?: string;
}

// Resolve a GitHub token so the importer is not stuck on the 60 req/hr
// unauthenticated quota and can read private repos. Order: explicit env vars,
// then the locally authenticated `gh` CLI if present.
export function resolveGitHubToken(): string | undefined {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  try {
    const result = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
    if (result.status === 0) {
      const token = result.stdout.trim();
      if (token) return token;
    }
  } catch {
    // gh not installed — fall back to unauthenticated requests.
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Decide whether the Authorization token may be forwarded to a redirect target.
// Only same-origin (scheme + host + port) redirects keep the credential; any
// origin change drops it to avoid leaking the token. Exported for
// unit testing.
export function sameOrigin(fromUrl: string, toUrl: string): boolean {
  try {
    return new URL(fromUrl).origin.toLowerCase() === new URL(toUrl).origin.toLowerCase();
  } catch {
    return false;
  }
}

// One low-level request, no retry/backoff (that lives in `request`). Follows up
// to `redirectsLeft` redirects; a cycle or an over-long chain rejects instead of
// overflowing the stack, and the token is only forwarded to same-host targets.
function requestOnce(
  method: string,
  url: string,
  token: string | undefined,
  payload?: string,
  redirectsLeft = 5,
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "pm-github",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = https.request(url, { method, headers }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // Drain the redirect response so the socket is returned to the pool.
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects following ${url}`));
          return;
        }
        // Resolve the (possibly relative) Location against the current URL, and
        // only carry the token forward on a same-host redirect.
        let target: string;
        try {
          target = new URL(res.headers.location, url).toString();
        } catch {
          reject(new Error(`invalid redirect Location from ${url}`));
          return;
        }
        const forwardToken = sameOrigin(url, target) ? token : undefined;
        requestOnce(method, target, forwardToken, payload, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers as Record<string, string | string[] | undefined>,
          linkHeader: typeof res.headers.link === "string" ? res.headers.link : undefined,
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("request timed out after 30s"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// How long (ms) to wait before retrying a rate-limited / transient response.
// Honors Retry-After (seconds) and the primary-rate-limit reset window
// (X-RateLimit-Remaining: 0 + X-RateLimit-Reset epoch), then falls back to
// exponential backoff. Capped so we never hang a CLI run indefinitely.
export function computeBackoffMs(
  headers: Record<string, string | string[] | undefined>,
  attempt: number,
  nowMs: number = Date.now(),
): number {
  const get = (k: string): string | undefined => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const cap = 60_000;
  const retryAfter = get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, cap);
  }
  const remaining = get("x-ratelimit-remaining");
  const reset = get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) {
      const wait = resetMs - nowMs;
      if (wait > 0) return Math.min(wait + 1000, cap);
    }
  }
  // Exponential backoff: 1s, 2s, 4s … capped.
  return Math.min(1000 * 2 ** attempt, cap);
}

// Parse GitHub's rate-limit headers (X-RateLimit-Remaining/Limit/Reset) off a
// response, case-insensitively. Returns undefined fields when a header is
// absent or non-numeric so callers can degrade gracefully. `reset` is the epoch
// seconds at which the window resets.
export interface RateLimitInfo {
  remaining?: number;
  limit?: number;
  reset?: number;
  /** True when the remaining quota is at/under the low-water mark. */
  low: boolean;
}

// Read GitHub's x-ratelimit-* headers into a structured snapshot, reporting a
// low-remaining warning once the budget drops below `lowThreshold`.
export function parseRateLimit(
  headers: Record<string, string | string[] | undefined>,
  lowThreshold = 10,
): RateLimitInfo {
  // Node lowercases response header names, but be defensive: scan
  // case-insensitively so a mixed-case key (e.g. from a different runtime or a
  // mocked response) is still found.
  const lower: Record<string, string | string[] | undefined> = {};
  for (const [hk, hv] of Object.entries(headers)) lower[hk.toLowerCase()] = hv;
  const get = (k: string): string | undefined => {
    const v = lower[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const num = (s: string | undefined): number | undefined => {
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const remaining = num(get("x-ratelimit-remaining"));
  const limit = num(get("x-ratelimit-limit"));
  const reset = num(get("x-ratelimit-reset"));
  return {
    remaining,
    limit,
    reset,
    low: remaining !== undefined && remaining <= lowThreshold,
  };
}

// Human-readable one-liner for a rate-limit snapshot, e.g.
// "GitHub API quota: 4998/5000 remaining (resets 2026-06-04T01:00:00.000Z)".
// Returns undefined when no quota headers were present.
export function formatRateLimit(info: RateLimitInfo): string | undefined {
  if (info.remaining === undefined) return undefined;
  const limitPart = info.limit !== undefined ? `/${info.limit}` : "";
  let resetPart = "";
  if (info.reset !== undefined) {
    try {
      resetPart = ` (resets ${new Date(info.reset * 1000).toISOString()})`;
    } catch {
      resetPart = "";
    }
  }
  return `GitHub API quota: ${info.remaining}${limitPart} remaining${resetPart}`;
}

// Decide whether a failed HTTP response is worth retrying: 429, any 5xx, or a
// 403 that is actually a primary/secondary rate-limit wall (remaining=0).
function isRetryableStatus(status: number, headers: Record<string, string | string[] | undefined>): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  // Secondary/primary rate limit surfaces as 403 with remaining=0.
  if (status === 403) {
    const v = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
    const remaining = Array.isArray(v) ? v[0] : v;
    if (remaining === "0") return true;
    if (headers["retry-after"] ?? headers["Retry-After"]) return true;
  }
  return false;
}

// Request with rate-limit/backoff handling. Retries on 429/5xx and GitHub
// rate-limit 403s, honoring Retry-After / X-RateLimit-Reset. Throws on a
// non-retryable error status so callers can map it to a semantic exit code.
async function request(
  method: string,
  url: string,
  token: string | undefined,
  payload?: string,
  maxRetries = 4,
): Promise<FetchResult> {
  let attempt = 0;
  for (;;) {
    const res = await requestOnce(method, url, token, payload);
    if (res.status >= 200 && res.status < 300) return res;
    if (attempt < maxRetries && isRetryableStatus(res.status, res.headers)) {
      const wait = computeBackoffMs(res.headers, attempt);
      console.error(
        `GitHub returned HTTP ${res.status}; retrying in ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt + 1}/${maxRetries})…`,
      );
      await sleep(wait);
      attempt++;
      continue;
    }
    throw new Error(`GitHub API returned HTTP ${res.status}`);
  }
}

// Fetch a single GitHub REST endpoint and return { body, linkHeader }.
function fetchJSON(url: string, token?: string): Promise<FetchResult> {
  return request("GET", url, token);
}

// Follow GitHub's RFC 5988 Link header so repos with more than one page of
// issues are fully imported instead of silently truncated at per_page.
export function parseNextLink(linkHeader?: string): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

// Map a GitHub issue/PR state (+ optional stateReason) onto a pm status,
// preserving `not_planned` closures as `canceled` rather than `closed`.
export function mapState(state: string, stateReason?: string | null): string {
  if (state === "closed" && stateReason === "not_planned") return "canceled";
  return state === "closed" ? "closed" : "open";
}

// Flags may arrive under their kebab-case (`dry-run`) or camelCase (`dryRun`)
// key depending on runtime normalization, so check every candidate.
export function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((k) => {
    const v = options[k];
    return v === true || v === "true" || v === "1";
  });
}

// Read the first non-empty trimmed string option under any of the given
// (kebab- or camel-case) keys; returns undefined when none are set.
export function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = options[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// Whether an option key was explicitly provided (even if empty/falsey).
export function optionProvided(options: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((k) => Object.prototype.hasOwnProperty.call(options, k));
}

// Parse a `--since` value into an ISO timestamp the GitHub `since` query param
// accepts. Accepts either an ISO 8601 timestamp (passed through, invalid date
// returns undefined) or a relative duration like `7d` / `12h` / `1w` / `30m`,
// resolved against `now`. This enables incremental imports without the caller
// having to compute an absolute timestamp first.
export function parseSince(value: string | undefined, nowMs: number = Date.now()): string | undefined {
  if (!value || !value.trim()) return undefined;
  const v = value.trim();
  const rel = /^(\d+)\s*(m|h|d|w)$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const unit = rel[2].toLowerCase();
    const ms =
      unit === "m" ? n * 60_000 :
      unit === "h" ? n * 3_600_000 :
      unit === "d" ? n * 86_400_000 :
      n * 604_800_000;
    const relativeDate = new Date(nowMs - ms);
    if (Number.isNaN(relativeDate.getTime())) return undefined;
    return relativeDate.toISOString();
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// Parse a `--label-map` option into a translation table from pm tag/label
// names to GitHub label names. Accepts `from=to` pairs, comma-separated in a
// single value ("bug=kind/bug,enhancement=kind/enhancement") or repeated as an
// array. Entries without a `=` or with an empty side are skipped. Returns
// undefined when no usable mapping was provided so callers can short-circuit.
export function parseLabelMap(
  options: Record<string, unknown>,
  ...keys: string[]
): Map<string, string> | undefined {
  const lookup = keys.length > 0 ? keys : ["label-map", "labelMap"];
  const raw = optionCsv(options, ...lookup);
  if (raw.length === 0) return undefined;
  const map = new Map<string, string>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue; // need a non-empty "from" before the '='
    const from = entry.slice(0, eq).trim();
    const to = entry.slice(eq + 1).trim();
    if (!from || !to) continue;
    map.set(from, to);
  }
  return map.size > 0 ? map : undefined;
}

// Apply a label translation table to a list of labels. Labels with a mapping
// are replaced; unmapped labels pass through unchanged. Two source labels that
// map to the same GitHub label are collapsed (GitHub rejects duplicate labels
// on an issue with a 422), preserving first-seen order.
export function applyLabelMap(
  labels: string[],
  labelMap: Map<string, string> | undefined,
): string[] {
  if (!labelMap || labelMap.size === 0) return labels;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const mapped = labelMap.get(label) ?? label;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

// Parse one or more CSV-like option values into a deduplicated string list.
// Accepts a single string ("a,b") or repeated values (["a,b", "c"]).
export function optionCsv(options: Record<string, unknown>, ...keys: string[]): string[] {
  const rawChunks: string[] = [];
  for (const k of keys) {
    const v = options[k];
    if (typeof v === "string") {
      rawChunks.push(v);
      continue;
    }
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (typeof entry === "string") rawChunks.push(entry);
      }
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of rawChunks) {
    for (const piece of chunk.split(",")) {
      const id = piece.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time — doubling side effects (e.g. a second GitHub fetch) and exiting
// with a generic code instead of a semantic one. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Provenance — link a pm item back to a specific GitHub issue
// ---------------------------------------------------------------------------

// Provenance lives in a machine-parseable tag (`gh:owner/repo#123`) AND in the
// declared schema fields/description. The tag is the idempotency key: it
// round-trips losslessly through `pm create --tags` / `pm list --json`, so a
// re-import can find the existing item and UPDATE it instead of duplicating.
export function provenanceTag(repo: string, issueNumber: number): string {
  return `gh:${repo.toLowerCase()}#${issueNumber}`;
}

// Parse a `gh:owner/repo#number` provenance tag into its repo + issue number;
// returns undefined for non-provenance tags.
export function parseProvenanceTag(tag: string): { repo: string; number: number } | undefined {
  const m = /^gh:([^#\s]+)#(\d+)$/.exec(tag.trim());
  if (!m) return undefined;
  return { repo: m[1].toLowerCase(), number: Number(m[2]) };
}

// Surface the GitHub issue author as a machine-readable tag (`github_author:login`)
// — consistent with how provenance rides on tags. Returns undefined when the
// API did not include a usable login (so we never emit an empty tag).
export function authorTag(issue: GhIssue): string | undefined {
  const login = issue.user?.login?.trim();
  if (!login) return undefined;
  return `github_author:${login}`;
}

// ---------------------------------------------------------------------------
// pm workspace I/O
// ---------------------------------------------------------------------------

export interface PmItem {
  id?: string;
  title?: string;
  status?: string;
  body?: string;
  description?: string;
  tags?: string[];
}

export interface ItemScopeResult<TItem> {
  selected: TItem[];
  missing: string[];
}

// Narrow a set of pm items to explicit IDs. Unknown IDs are surfaced so
// command handlers can fail fast instead of silently ignoring typos.
export function scopeItemsByIds<TItem extends { id?: string }>(
  items: TItem[],
  ids: string[] | undefined,
): ItemScopeResult<TItem> {
  if (!ids || ids.length === 0) {
    return { selected: [...items], missing: [] };
  }
  const wanted = new Set(ids);
  const selected = items.filter((item) => item.id && wanted.has(item.id));
  const found = new Set(
    selected
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const missing = ids.filter((id) => !found.has(id));
  return { selected, missing };
}

// Read every pm item (active + closed) via `pm list-all --full --include-body`
// so the idempotency index never misses closed issues and re-creates them.
function readPmItems(pmRoot: string): PmItem[] {
  // `list-all` (NOT `list`) so CLOSED items are included: `pm list` returns only
  // active items, which would make the idempotency index miss every closed
  // issue and re-create it as a DUPLICATE on re-import. `--full --include-body`
  // so tags and body survive the read instead of the brief projection.
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list-all", "--full", "--include-body", "--limit", "10000"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list-all failed");
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
    return items as PmItem[];
  } catch {
    throw new CommandError("Could not parse `pm list-all --json` output.");
  }
}

// Index existing pm items by their GitHub provenance tag for O(1) idempotent
// matching on re-import.
export function indexByProvenance(items: PmItem[]): Map<string, PmItem> {
  const index = new Map<string, PmItem>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      const p = parseProvenanceTag(tag);
      if (p && item.id) index.set(`${p.repo}#${p.number}`, item);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Atomic GitHub issue import (pm-cli >= 2026.7.20 commitItemMutations)
// ---------------------------------------------------------------------------

const ATOMIC_IMPORT_PREFIX = "github-import-";
let cachedCommitItemMutations: CommitItemMutations | undefined;

/** Fully rendered desired state for one GitHub issue import. */
export interface PreparedGithubImport {
  issueNumber: number;
  title: string;
  itemType: string;
  status: string;
  description: string;
  body: string;
  tags: string[];
  assignee?: string;
  milestone?: string;
  comments: GhComment[];
  syncAnnotations: boolean;
  match?: PmItem;
}

function assertSdkFunction<F>(fn: unknown, exportName: string): F {
  if (typeof fn !== "function") {
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the installed SDK does not export ${exportName} as a function. Upgrade @unbrained/pm-cli to >=2026.7.20.`,
      EXIT_CODE.USAGE,
    );
  }
  return fn as F;
}

/** Resolve the atomic bulk-mutation helper lazily so normal imports stay compatible. */
export async function resolveCommitItemMutations(
  importSdk?: () => Promise<Partial<typeof import("@unbrained/pm-cli/sdk")>>,
): Promise<CommitItemMutations> {
  if (importSdk) {
    let mod: Partial<typeof import("@unbrained/pm-cli/sdk")>;
    try {
      mod = await importSdk();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError(
        `--atomic requires @unbrained/pm-cli>=2026.7.20, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
        EXIT_CODE.USAGE,
      );
    }
    return assertSdkFunction<CommitItemMutations>(mod.commitItemMutations, "commitItemMutations");
  }
  if (cachedCommitItemMutations) return cachedCommitItemMutations;
  try {
    const mod = await import("@unbrained/pm-cli/sdk");
    cachedCommitItemMutations = assertSdkFunction<CommitItemMutations>(
      mod.commitItemMutations,
      "commitItemMutations",
    );
    return cachedCommitItemMutations;
  } catch (err: unknown) {
    if (err instanceof CommandError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.20, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
      EXIT_CODE.USAGE,
    );
  }
}

/**
 * Derive an order-independent transaction id from the exact desired import
 * state. Content changes produce a fresh transaction; a reordered retry of the
 * same GitHub response resumes the durable journal.
 */
export function deriveAtomicTransactionId(
  repo: string,
  entries: readonly PreparedGithubImport[],
): string {
  const canonical = [...entries]
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .map((entry) => ({
      issueNumber: entry.issueNumber,
      title: entry.title,
      itemType: entry.itemType,
      status: entry.status,
      description: entry.description,
      body: entry.body,
      tags: [...entry.tags].sort(),
      assignee: entry.assignee ?? null,
      milestone: entry.milestone ?? null,
    }));
  const digest = crypto
    .createHash("sha256")
    .update(repo.toLowerCase())
    .update("\x1f")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
  return `${ATOMIC_IMPORT_PREFIX}${digest}`;
}

/** Stable create id keyed by the external GitHub issue, never by fetch order. */
export function deriveAtomicItemId(
  repo: string,
  issueNumber: number,
  idPrefix: string,
  normalizeItemId: (input: string, prefix: string) => string,
): string {
  const repoToken = crypto
    .createHash("sha256")
    .update(repo.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return normalizeItemId(`github-${repoToken}-${issueNumber}`, idPrefix);
}

/** Map one rendered import entry to its reversible SDK mutation sequence. */
export function buildAtomicImportMutations(
  repo: string,
  entry: PreparedGithubImport,
  idPrefix: string,
  normalizeItemId: (input: string, prefix: string) => string,
): { itemId: string; mutations: BulkItemMutation[] } {
  const sharedOptions: Record<string, unknown> = {
    title: entry.title,
    type: entry.itemType,
    description: entry.description,
    body: entry.body,
    tags: entry.tags.join(","),
    ...(entry.assignee ? { assignee: entry.assignee } : {}),
    ...(entry.milestone ? { sprint: entry.milestone } : {}),
  };

  const managedItemId = deriveAtomicItemId(
    repo,
    entry.issueNumber,
    idPrefix,
    normalizeItemId,
  );

  // A missing match and a match at our deterministic external-key id use the
  // SAME create+update upsert plan. This is essential for crash recovery: if a
  // prior attempt stopped after create, the next provenance scan sees that
  // item, but commitItemMutations must still receive the original plan. The
  // create step treats an existing stable id as already applied; update then
  // makes later content-bearing transactions refresh the item normally.
  if (!entry.match?.id || entry.match.id === managedItemId) {
    const createStatus = entry.status === "closed" ? "open" : entry.status;
    const mutations: BulkItemMutation[] = [{
      op: "create",
      id: managedItemId,
      options: { ...sharedOptions, status: createStatus },
    }, {
      op: "update",
      id: managedItemId,
      options: {
        ...sharedOptions,
        ...(entry.status !== "closed" ? { status: entry.status } : {}),
      },
    }];
    if (entry.status === "closed") {
      mutations.push({
        op: "close",
        id: managedItemId,
        reason: `GitHub issue #${entry.issueNumber} closed`,
      });
    }
    return {
      itemId: managedItemId,
      mutations,
    };
  }

  const itemId = entry.match.id;
  const updateOptions: Record<string, unknown> = { ...sharedOptions };
  // close has a dedicated mutation so its reason is preserved. Every other
  // transition (open/reopen/canceled) is safely reversible as part of update.
  if (entry.status !== "closed") {
    updateOptions.status = entry.status;
  }
  const mutations: BulkItemMutation[] = [{
    op: "update",
    id: itemId,
    options: updateOptions,
  }];
  if (entry.status === "closed") {
    mutations.push({
      op: "close",
      id: itemId,
      reason: `GitHub issue #${entry.issueNumber} closed`,
    });
  }
  return { itemId, mutations };
}

/** Commit a complete issue-import batch under one crash-resumable transaction. */
export async function importGithubAtomic(
  pmRoot: string,
  repo: string,
  entries: readonly PreparedGithubImport[],
  opts: AtomicImportOptions = {},
): Promise<{
  transactionId: string;
  recovered: boolean;
  imported: number;
  updated: number;
  recoveredItems?: number;
  itemIds: Map<number, string>;
}> {
  const transactionId = deriveAtomicTransactionId(repo, entries);
  const commit = opts.commitItemMutations ?? await resolveCommitItemMutations();

  let sdk: typeof import("@unbrained/pm-cli/sdk") | undefined;
  const getSdk = async () => {
    if (sdk) return sdk;
    try {
      sdk = await import("@unbrained/pm-cli/sdk");
      return sdk;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError(
        `--atomic requires @unbrained/pm-cli>=2026.7.20, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
        EXIT_CODE.USAGE,
      );
    }
  };
  const normalizeItemId = opts.normalizeItemId ?? assertSdkFunction<
    (input: string, prefix: string) => string
  >((await getSdk()).normalizeItemId, "normalizeItemId");
  const readSettings = opts.readSettings ?? assertSdkFunction<
    (root: string) => Promise<{ id_prefix?: string }>
  >((await getSdk()).readSettings, "readSettings");

  let idPrefix = "pm-";
  try {
    const settings = await readSettings(pmRoot);
    if (settings?.id_prefix) idPrefix = String(settings.id_prefix);
  } catch {
    // Match normal import resilience: an unreadable optional setting falls
    // back to the canonical prefix; the mutation still validates the tracker.
  }

  const mutations: BulkItemMutation[] = [];
  const itemIds = new Map<number, string>();
  // The transaction journal fingerprints the ordered step plan. Canonicalize
  // by the stable GitHub issue number so a retry whose API page/order changed
  // supplies the exact same plan as well as the same transaction id.
  for (const entry of [...entries].sort((a, b) => a.issueNumber - b.issueNumber)) {
    const planned = buildAtomicImportMutations(repo, entry, idPrefix, normalizeItemId);
    itemIds.set(entry.issueNumber, planned.itemId);
    mutations.push(...planned.mutations);
  }

  try {
    const result = await commit({
      pmRoot,
      transactionId,
      author: opts.atomicAuthor ?? "pm-github",
      mutations,
      // This option selects how CREATE steps are compensated. The SDK's
      // commitItemMutations contract independently snapshots and version-
      // restores every UPDATE and CLOSE step (covered by the mixed rollback
      // integration test below this implementation).
      createCompensation: "delete",
    });
    // A recovered journal may include work applied by the interrupted process
    // as well as steps resumed now. The SDK intentionally returns the durable
    // final results, not a per-invocation delta, so create/update counts cannot
    // be reconstructed truthfully. Report the recovered batch separately.
    const recovered = Boolean(result?.recovered);
    return {
      transactionId,
      recovered,
      imported: recovered ? 0 : entries.filter((entry) => !entry.match?.id).length,
      updated: recovered ? 0 : entries.filter((entry) => Boolean(entry.match?.id)).length,
      ...(recovered ? { recoveredItems: entries.length } : {}),
      itemIds,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `Atomic GitHub import failed and was rolled back — every applied create/update/close was compensated; the tracker has no partial committed state from this import. Transaction id: ${transactionId}. Underlying error: ${msg}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared import core (used by both the legacy command and the importer)
// ---------------------------------------------------------------------------

// Build the GitHub issues list URL. `since`, `assignee`, `labels` and `state`
// are honored server-side; `milestone` is filtered client-side (the REST API
// keys milestones by number, not title).
export function buildIssuesUrl(repo: string, opts: ImportOptions): string {
  let url = `https://api.github.com/repos/${repo}/issues?state=${opts.state}&per_page=100`;
  if (opts.labels) url += `&labels=${encodeURIComponent(opts.labels)}`;
  if (opts.since) url += `&since=${encodeURIComponent(opts.since)}`;
  if (opts.assignee) url += `&assignee=${encodeURIComponent(opts.assignee)}`;
  return url;
}

// Page through GitHub's issues REST endpoint, following the Link header,
// applying the import filters, and returning the full issue list.
async function fetchAllIssues(repo: string, opts: ImportOptions, token?: string): Promise<GhIssue[]> {
  const issues: GhIssue[] = [];
  let nextUrl: string | undefined = buildIssuesUrl(repo, opts);
  while (nextUrl) {
    const { body, linkHeader } = await fetchJSON(nextUrl, token);
    let page: unknown;
    try {
      page = JSON.parse(body);
    } catch {
      throw new Error("Invalid JSON response from GitHub.");
    }
    if (!Array.isArray(page)) {
      throw new Error("Unexpected GitHub API response (expected an array of issues).");
    }
    issues.push(...(page as GhIssue[]));
    nextUrl = parseNextLink(linkHeader);
  }
  return issues;
}

// Fetch all review comments for a single issue/PR, paging through Link.
async function fetchComments(issue: GhIssue, repo: string, token?: string): Promise<GhComment[]> {
  if (!issue.comments || issue.comments <= 0) return [];
  const comments: GhComment[] = [];
  let nextUrl: string | undefined =
    issue.comments_url ||
    `https://api.github.com/repos/${repo}/issues/${issue.number}/comments?per_page=100`;
  while (nextUrl) {
    const { body, linkHeader } = await fetchJSON(nextUrl, token);
    let page: unknown;
    try {
      page = JSON.parse(body);
    } catch {
      break;
    }
    if (!Array.isArray(page)) break;
    comments.push(...(page as GhComment[]));
    nextUrl = parseNextLink(linkHeader);
  }
  return comments;
}

// Compose the pm item body for an issue, optionally appending its comments.
export function composeBody(issue: GhIssue, comments: GhComment[]): string {
  let body = issue.body || "";
  if (comments.length > 0) {
    const rendered = comments
      .map((c) => {
        const who = c.user?.login ?? "unknown";
        const when = c.created_at ? ` (${c.created_at})` : "";
        return `> **@${who}**${when}\n>\n${(c.body || "").split("\n").map((l) => `> ${l}`).join("\n")}`;
      })
      .join("\n\n");
    body = `${body}\n\n---\n\n### GitHub comments (${comments.length})\n\n${rendered}`.trim();
  }
  return body;
}

// ---------------------------------------------------------------------------
// Cross-process comment-sync lock (serializes marker dedupe, pm-github-503u)
// ---------------------------------------------------------------------------
//
// The native comment sync below does a read-markers-then-append sequence that
// spans several pm CLI mutations. Each individual mutation is locked by the pm
// CLI, but the check-then-act as a whole is not atomic across two concurrent
// `pm github import` processes on the same workspace: both can observe a
// GitHub comment id as absent and append it twice. The helper here closes that
// race with a lockfile in the workspace's own locks/ dir, following the pm
// CLI's locking convention (see core/lock/lock.js in pm-cli):
//
//   - location  <pm data dir>/locks/pm-github.comment-sync.<itemId>.lock — the
//     same locks/ dir the pm CLI itself uses (gitignored runtime state), with
//     a payload shape identical to the CLI's so `pm gc` can sweep our stale
//     locks by their embedded ttl_seconds. The "pm-github.comment-sync."
//     prefix keeps our namespace disjoint from the CLI's per-item mutation
//     locks (<itemId>.lock): we hold our lock ACROSS several CLI mutations, so
//     sharing a name would make the very mutations we wrap conflict with it.
//   - acquire   fs.openSync(path, "wx") — atomic O_EXCL create on POSIX.
//   - stale     a lock is broken (with a stderr warning) only when its owner
//     is provably gone: the recorded owner PID is dead, or it equals our own
//     PID (we know we don't hold it, so the PID was recycled). A lock with a
//     LIVE owner is never age-broken — a slow-but-alive holder keeps its lock
//     no matter how long it runs (a >TTL holder would otherwise lose the lock
//     mid-append and the race would reopen). Only when the payload is missing
//     or unparseable (caught mid-write, then abandoned) does the TTL (default
//     5 min, age from file mtime) apply as the break criterion.
//   - release   token-checked: each acquisition embeds a unique token in the
//     payload and release() unlinks the file only while it still carries that
//     token, so a holder whose lock was stale-broken (or swept by `pm gc`)
//     can never unlink a successor's lock.
//   - breaking  stale locks are removed under a breaker election (an O_EXCL
//     `<lock>.break` sidecar): only the single election winner may unlink,
//     and it re-verifies staleness under that mutex first — two concurrent
//     breakers can therefore never double-break, and a breaker can never
//     unlink a fresh lock that replaced the stale one it inspected.
//   - contend   a live, fresh lock is waited out with jittered backoff up to a
//     budget (default 30s). On timeout the caller reports "contended" and the
//     comment sync for that item is SKIPPED (never run unlocked) — a wedged
//     concurrent import can then cost a comment sync, recoverable by
//     re-running import, but can never produce a duplicate comment. When the
//     lock mechanism itself is unavailable (read-only fs etc.) the caller
//     reports "degraded" and proceeds unlocked with a warning, matching the
//     pre-lock best-effort behavior.

export const IMPORT_LOCK_TTL_MS_DEFAULT = 5 * 60_000;
export const IMPORT_LOCK_WAIT_MS_DEFAULT = 30_000;

// Payload written into the lock file. Mirrors the pm CLI's own lock payload so
// the CLI's `pm gc` lock sweep (which reads ttl_seconds) treats our locks
// exactly like its own.
export interface ImportLockPayload {
  id: string;
  pid: number;
  owner: string;
  /** Unique per acquisition; release() only unlinks a file carrying it. */
  token: string;
  created_at: string;
  ttl_seconds: number;
}

export interface ImportLock {
  /** Absolute path of the held lock file (diagnostics/tests). */
  path: string;
  /** Release the lock. Best-effort, idempotent, never throws. */
  release(): void;
}

export type ImportLockAcquisition =
  | { status: "acquired"; lock: ImportLock }
  // Another live process held the lock past the wait budget.
  | { status: "contended" }
  // The lock mechanism itself failed (fs error) — caller may proceed unlocked.
  | { status: "degraded" };

// Resolve the pm data dir (the dir holding settings.json and locks/) from the
// pmRoot the extension host hands the command, which may be either the
// workspace root (the dir containing .agents/pm) or the data dir itself — the
// pm CLI accepts both for --path, and tests pass the workspace root.
export function resolvePmDataDir(pmRoot: string): string {
  const nested = path.join(pmRoot, ".agents", "pm");
  try {
    if (fs.statSync(nested).isDirectory()) return nested;
  } catch {
    // Not the workspace-root form — assume pmRoot already is the data dir.
  }
  return pmRoot;
}

// Absolute lock file path for one item's comment-sync critical section. The
// item id is sanitized defensively (pm ids are already filename-safe, but the
// lock path must never become a traversal vector if that ever changes).
export function importCommentSyncLockPath(pmRoot: string, itemId: string): string {
  const safe = itemId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(resolvePmDataDir(pmRoot), "locks", `pm-github.comment-sync.${safe}.lock`);
}

function readImportLockPayload(lockPath: string): ImportLockPayload | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as ImportLockPayload;
  } catch {
    return undefined;
  }
}

function isLockOwnerAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to another user — still alive.
    // ESRCH means no such process — the lock owner is gone.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// A held lock is stale only when its owner is provably gone: the recorded
// owner PID is dead (crash without release), or it equals our own PID (we
// know we do not hold this lock, so the PID must have been recycled). A lock
// with a LIVE recorded owner is never age-broken — breaking a slow-but-alive
// holder mid-critical-section would reopen the duplicate-marker race this
// lock exists to close. Only when there is no usable owner PID (payload
// missing or unparseable — e.g. caught mid-write, then abandoned) does the
// TTL apply, with age taken from the payload's created_at falling back to
// the file mtime. (PID reuse can make a dead lock look alive and thus block
// until the wait budget — conservative; it can never break a live one.)
// Lock paths currently held by THIS process (any async task). Distinguishes a
// same-pid payload that is legitimately ours (in-process contention → wait)
// from a leftover written by a dead process whose PID we inherited (→ break).
const heldImportLocks = new Set<string>();

function importLockStaleReason(
  lockPath: string,
  payload: ImportLockPayload | undefined,
  mtimeMs: number,
  ttlMs: number,
): string | undefined {
  const pid = payload?.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    if (pid === process.pid) {
      // Our own PID: either another async task in THIS process holds it (the
      // in-process race the caller serializes too — contend, don't break), or
      // we provably don't hold it and the PID was recycled by a dead owner.
      return heldImportLocks.has(lockPath)
        ? undefined
        : `owner pid ${pid} is this process but the lock is not held in-process (pid recycled, lock abandoned)`;
    }
    return isLockOwnerAlive(pid) ? undefined : `owner pid ${pid} is dead`;
  }
  const createdMs = payload ? Date.parse(payload.created_at) : Number.NaN;
  const ageBase = Number.isFinite(createdMs) ? createdMs : mtimeMs;
  if (!Number.isFinite(ageBase) || Date.now() - ageBase > ttlMs) {
    return `no usable owner pid and older than TTL ${Math.round(ttlMs / 1000)}s`;
  }
  return undefined;
}

const IMPORT_LOCK_INITIAL_BACKOFF_MS = 25;
const IMPORT_LOCK_MAX_BACKOFF_MS = 200;
const IMPORT_LOCK_MAX_STALE_BREAKS = 3;
// A breaker's critical section is a handful of syscalls (re-stat, re-read,
// unlink) — a crashed breaker's sidecar goes stale in seconds, not minutes.
export const IMPORT_LOCK_BREAKER_TTL_MS = 10_000;

// Break a stale lock under a breaker election so the unlink can never race
// another breaker: two contenders may both judge the same file stale, but
// without mutual exclusion the slower one would execute its unlink AFTER the
// winner already re-created a fresh, live lock — silently unlinking that
// replacement and letting both proceed (the exact double-acquire this module
// exists to prevent). The election is an O_EXCL sidecar (`<lock>.break`):
// only its single winner may unlink, and it re-verifies staleness under the
// mutex first, so a lock that became live since the caller's check survives.
// Returns true when the stale lock was removed (caller should retry acquire
// immediately), false when the election was lost or the lock is live again
// (caller should fall through to the normal wait/backoff).
function breakStaleImportLock(lockPath: string, ttlMs: number, reason: string): boolean {
  const breakerPath = `${lockPath}.break`;
  let bfd: number | undefined;
  try {
    bfd = fs.openSync(breakerPath, "wx");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      // Another breaker is active. If IT crashed mid-break, its sidecar is
      // old — clear it and let the next iteration re-run the election.
      try {
        if (Date.now() - fs.statSync(breakerPath).mtimeMs > IMPORT_LOCK_BREAKER_TTL_MS) {
          fs.unlinkSync(breakerPath);
        }
      } catch {
        // Sidecar vanished (election finished) — retry normally.
      }
    }
    return false;
  }
  try {
    fs.closeSync(bfd);
    // Re-verify under the mutex: the lock we judged stale may have been
    // broken and re-acquired by a live owner since we looked at it.
    let payload: ImportLockPayload | undefined;
    let mtimeMs = Number.NaN;
    try {
      mtimeMs = fs.statSync(lockPath).mtimeMs;
      payload = readImportLockPayload(lockPath);
    } catch {
      return true; // already gone — acquire can proceed immediately
    }
    if (!importLockStaleReason(lockPath, payload, mtimeMs, ttlMs)) return false;
    console.error(`pm-github: breaking stale comment-sync lock ${lockPath} (${reason})`);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
    return true;
  } finally {
    try {
      fs.unlinkSync(breakerPath);
    } catch {
      // Best-effort: an aged-out sidecar may have been cleared by a peer.
    }
  }
}

// Acquire the cross-process comment-sync lock for one item. Never throws:
// every failure mode maps to one of the three acquisition statuses so the
// caller can decide how to degrade. `ttlMs`/`waitMs` are injectable for tests.
export async function acquireImportLock(
  pmRoot: string,
  itemId: string,
  opts: { ttlMs?: number; waitMs?: number } = {},
): Promise<ImportLockAcquisition> {
  const ttlMs = opts.ttlMs ?? IMPORT_LOCK_TTL_MS_DEFAULT;
  const waitMs = opts.waitMs ?? IMPORT_LOCK_WAIT_MS_DEFAULT;
  let lockPath: string;
  try {
    lockPath = importCommentSyncLockPath(pmRoot, itemId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`pm-github: comment-sync lock unavailable (${msg}) — proceeding without cross-process serialization`);
    return { status: "degraded" };
  }
  const payload: ImportLockPayload = {
    id: path.basename(lockPath, ".lock"),
    pid: process.pid,
    owner: "pm-github",
    token: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ttl_seconds: Math.ceil(ttlMs / 1000),
  };
  const startedAt = Date.now();
  let backoffMs = IMPORT_LOCK_INITIAL_BACKOFF_MS;
  let staleBreaks = 0;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
      fs.closeSync(fd);
      fd = undefined;
      heldImportLocks.add(lockPath);
      let released = false;
      return {
        status: "acquired",
        lock: {
          path: lockPath,
          release() {
            if (released) return;
            released = true;
            heldImportLocks.delete(lockPath);
            try {
              // Token check: only unlink the file while it is still OUR lock.
              // If it was stale-broken or gc-swept and re-acquired, the path
              // now holds the successor's lock — leave it alone.
              const current = readImportLockPayload(lockPath);
              if (current?.token !== payload.token) return;
              fs.unlinkSync(lockPath);
            } catch {
              // Best-effort: already gone (stale-broken by someone else, gc).
            }
          },
        },
      };
    } catch (err: unknown) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors on the failure path.
        }
        // We created the lockfile but failed to write/close it. Remove the
        // empty/partial file so other processes are not blocked until the
        // TTL expires on a lock that was never validly held.
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best-effort: already gone.
        }
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`pm-github: comment-sync lock failed (${msg}) — proceeding without cross-process serialization`);
        return { status: "degraded" };
      }
      // The lock exists. If it vanished before we could stat it, retry at once.
      let existing: ImportLockPayload | undefined;
      let mtimeMs = Number.NaN;
      try {
        mtimeMs = fs.statSync(lockPath).mtimeMs;
        existing = readImportLockPayload(lockPath);
      } catch {
        continue;
      }
      const staleReason = importLockStaleReason(lockPath, existing, mtimeMs, ttlMs);
      if (staleReason && staleBreaks < IMPORT_LOCK_MAX_STALE_BREAKS) {
        staleBreaks++;
        if (breakStaleImportLock(lockPath, ttlMs, staleReason)) continue;
        // Lost the breaker election or the lock turned out live on re-check —
        // fall through to the normal wait/backoff below.
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= waitMs) return { status: "contended" };
      // Jittered backoff, mirroring the pm CLI's lock wait (0.5x–1.5x jitter).
      const jittered = Math.max(1, Math.round(backoffMs * (0.5 + Math.random())));
      await sleep(Math.min(jittered, waitMs - elapsedMs));
      backoffMs = Math.min(backoffMs * 2, IMPORT_LOCK_MAX_BACKOFF_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Native comment sync (GitHub issue comments → pm comments collection)
// ---------------------------------------------------------------------------
//
// `--comments-mode annotations|both` mirrors a GitHub issue's conversation into
// the pm item's native comments collection (the SDK `comments()` primitive), so
// agents get structured, queryable comments instead of body-embedded text.
//
// Re-sync is idempotent: every stored comment carries a stable marker embedding
// the GitHub comment id (`<!-- pm-github:comment:N -->`). On re-import the
// already-synced ids are read back and skipped, so re-running import never
// duplicates a comment.

// Hidden HTML comment marker carrying the GitHub comment id. HTML comments are
// invisible in rendered markdown but survive `pm comments` storage verbatim.
export const COMMENT_MARKER_REGEX = /<!--\s*pm-github:comment:(\d+)\s*-->/;

// Build the text for a single native pm comment from a GitHub comment. The
// marker is appended so re-sync can de-duplicate on the GitHub comment id.
export function buildCommentText(comment: GhComment): string {
  const body = (comment.body || "").trim() || "(empty comment)";
  return `${body}\n\n<!-- pm-github:comment:${comment.id} -->`;
}

// Read the GitHub comment ids already synced into an item's native comments,
// by scanning each stored comment's text for the stable marker. Returns the set
// of synced ids (empty when none match, e.g. for hand-written pm comments).
export function extractSyncedCommentIds(stored: { text?: string }[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of stored) {
    if (!entry?.text) continue;
    const m = COMMENT_MARKER_REGEX.exec(entry.text);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

// Parse the newly-created item id out of `pm create --json` stdout, which
// returns `{ "item": { "id": "pm-xxxx", ... } }`. Returns undefined when the
// output cannot be parsed (e.g. an unexpected/older shape) so callers can fall
// back to a safe skip-with-warning instead of crashing the whole import.
export function parseCreatedItemId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout);
    const id = parsed?.item?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

// Sync GitHub issue comments into a pm item's native comments collection via
// the SDK `comments()` primitive. Idempotent: comments already present (matched
// by their GitHub comment id marker) are skipped, so re-running import never
// duplicates. Each GitHub comment becomes one pm comment authored by the
// GitHub login. Failures are logged and never abort the import.
//
// Concurrency (pm-github-503u, limitation lifted): the read-markers-then-append
// critical section is serialized across processes by a per-item lockfile (see
// acquireImportLock above), so two concurrent `pm github import` runs against
// the same workspace can no longer both observe a comment id as absent and
// append it twice. The lock is per ITEM, not per import run: unrelated issues
// in concurrent imports still sync in parallel, and only the one item whose
// comments are actively being synced is serialized — the smallest scope that
// closes the race. Stale locks (older than the TTL or owned by a dead PID) are
// broken with a stderr warning. If a live concurrent import holds the lock
// past the wait budget, this item's comment sync is skipped with a warning
// (never run unlocked, so a wedged peer can cost a sync — recoverable on the
// next import — but never cause a duplicate); if the lock mechanism itself is
// unavailable the sync proceeds unlocked as before, also with a warning.
export async function syncGithubCommentsToAnnotations(
  itemId: string,
  comments: GhComment[],
  pmRoot: string,
  issueNumber: number,
): Promise<{ added: number; skipped: number }> {
  if (comments.length === 0) return { added: 0, skipped: 0 };
  const acquisition = await acquireImportLock(pmRoot, itemId);
  if (acquisition.status === "contended") {
    console.error(
      `#${issueNumber}: comment sync for ${itemId} skipped — another import holds the ` +
        `comment-sync lock; re-run import to pick up the comments`,
    );
    return { added: 0, skipped: 0 };
  }
  const release = acquisition.status === "acquired" ? () => acquisition.lock.release() : () => {};
  try {
    let pmComments: PmCommentsFn;
    let existing: { text?: string }[] = [];
    try {
      pmComments = await loadPmComments();
      const list = await pmComments(itemId, {}, { pmRoot });
      existing = (list?.comments ?? []) as { text?: string }[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`#${issueNumber}: could not read existing comments for ${itemId} — ${msg}`);
      return { added: 0, skipped: 0 };
    }
    const synced = extractSyncedCommentIds(existing);
    let added = 0;
    let skipped = 0;
    for (const c of comments) {
      if (synced.has(c.id)) {
        skipped++;
        continue;
      }
      const author = c.user?.login ?? "github";
      try {
        await pmComments(itemId, { add: buildCommentText(c), author }, { pmRoot });
        added++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`#${issueNumber}: comment ${c.id} sync failed — ${msg}`);
      }
    }
    return { added, skipped };
  } finally {
    release();
  }
}

// A draft PR is an issue that is both a pull request and flagged `draft: true`.
// (Plain issues are never drafts.)
export function isDraftPr(issue: GhIssue): boolean {
  return Boolean(issue.pull_request) && issue.draft === true;
}

// Apply the client-side filters (PRs, drafts, milestone-by-title).
export function applyClientFilters(issues: GhIssue[], opts: ImportOptions): GhIssue[] {
  let result = issues;
  if (!opts.includePrs) result = result.filter((i) => !i.pull_request);
  // --skip-drafts only takes effect alongside --include-prs (without it, all
  // PRs — drafts included — are already filtered out above).
  if (opts.skipDrafts) result = result.filter((i) => !isDraftPr(i));
  if (opts.milestone) {
    result = result.filter((i) => i.milestone?.title === opts.milestone);
  }
  return result;
}

// Normalize CLI options into ImportOptions (state filter, labels, assignee,
// milestone, since-window, PR inclusion, draft skipping, comment fetching).
export function parseImportOptions(options: Record<string, unknown>): ImportOptions {
  // --state takes precedence; --all is the legacy shorthand for "all".
  const stateOpt = optionString(options, "state") as ImportOptions["state"] | undefined;
  const includeAll = optionEnabled(options, "all");
  const state: ImportOptions["state"] =
    stateOpt && ["open", "closed", "all"].includes(stateOpt)
      ? stateOpt
      : includeAll
        ? "all"
        : "open";
  const sinceInput = optionString(options, "since");
  const since = parseSince(sinceInput);
  if (optionProvided(options, "since") && !since) {
    throw new CommandError(
      "--since must be an ISO 8601 timestamp or a positive relative duration such as 30m, 12h, 7d, or 1w.",
      EXIT_CODE.USAGE,
    );
  }
  // --comments-mode controls how fetched GitHub comments are persisted.
  // Default "body" preserves the historical blockquoted-body behavior exactly.
  const commentsModeInput = optionString(options, "comments-mode", "commentsMode");
  if (commentsModeInput && !(COMMENTS_MODES as readonly string[]).includes(commentsModeInput)) {
    throw new CommandError(
      `--comments-mode must be one of: ${COMMENTS_MODES.join(", ")} (got ${commentsModeInput})`,
      EXIT_CODE.USAGE,
    );
  }
  // Resolve --with-comments first so commentsMode can reconcile against it.
  const withCommentsResolved = optionEnabled(options, "with-comments", "withComments", "include-comments", "includeComments");
  let commentsMode: CommentsMode = (commentsModeInput as CommentsMode) || "body";
  // Reconcile with the legacy --with-comments flag. --with-comments historically
  // means "fetch + embed in body". When the user also asks for annotations, the
  // intuitive combined intent is BOTH body and native comments (not silently
  // dropping --with-comments), so upgrade annotations → both. body/both are
  // already consistent with --with-comments and need no adjustment.
  if (withCommentsResolved && commentsMode === "annotations") {
    commentsMode = "both";
  }
  return {
    state,
    labels: optionString(options, "labels"),
    since,
    assignee: optionString(options, "assignee"),
    milestone: optionString(options, "milestone"),
    includePrs: optionEnabled(options, "include-prs", "includePrs"),
    skipDrafts: optionEnabled(options, "skip-drafts", "skipDrafts"),
    withComments: withCommentsResolved,
    commentsMode,
    itemType: optionString(options, "type") || "Issue",
    dryRun: optionEnabled(options, "dry-run", "dryRun"),
    atomic: optionEnabled(options, "atomic"),
  };
}

// Spawn the `pm` CLI with the given argv and return a normalized ok/stdout/stderr
// result (ok = exit code 0). Centralizes every pm mutation so callers share one
// error-handling shape.
function pmRun(args: string[]): { ok: boolean; stderr: string; stdout: string } {
  const result = spawnSync("pm", args, { encoding: "utf-8" });
  return { ok: result.status === 0, stderr: result.stderr || "", stdout: result.stdout || "" };
}

// Run the full import flow. Idempotent: items already linked (provenance tag)
// to a fetched issue are UPDATEd; new issues are created. Returns a structured
// result; throws CommandError (with a semantic exitCode) on failure.
async function runImport(repoArg: string | undefined, pmRoot: string, opts: ImportOptions) {
  if (!repoArg || !repoArg.includes("/")) {
    throw new CommandError(
      "Usage: pm github import <owner/repo> [--all|--state open|closed|all] " +
        "[--labels bug,enhancement] [--since <iso>] [--assignee <login>] " +
        "[--milestone <name>] [--include-prs] [--skip-drafts] [--with-comments] " +
        "[--comments-mode body|annotations|both] [--atomic]",
      EXIT_CODE.USAGE,
    );
  }
  const repo = repoArg;

  const token = resolveGitHubToken();
  console.error(
    `Fetching issues from ${repo}…${token ? "" : " (unauthenticated — 60 req/hr)"}`,
  );

  let fetched: GhIssue[];
  try {
    fetched = await fetchAllIssues(repo, opts, token);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = !token && /HTTP 403/.test(msg)
      ? " — set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise the rate limit (60→5000/hr) and reach private repos"
      : "";
    const exitCode = /HTTP 404/.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to fetch issues from ${repo}: ${msg}${hint}`, exitCode);
  }

  const filtered = applyClientFilters(fetched, opts);

  if (filtered.length === 0) {
    console.error("No issues found.");
    return { imported: 0, updated: 0, skipped: 0 };
  }

  console.error(`Found ${filtered.length} issue(s).`);

  // Build the idempotency index once up-front.
  const existing = opts.dryRun ? new Map<string, PmItem>() : indexByProvenance(readPmItems(pmRoot));

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (opts.atomic && !opts.dryRun) {
    const prepared: PreparedGithubImport[] = [];
    for (const issue of filtered) {
      const title = issue.title.trim();
      if (!title) {
        skipped++;
        continue;
      }

      const kind = issue.pull_request ? "PR" : "issue";
      const labels = issue.labels.map((label) => label.name).filter(Boolean);
      const tag = provenanceTag(repo, issue.number);
      const ghAuthorTag = authorTag(issue);
      const tags = [...labels, tag, ...(ghAuthorTag ? [ghAuthorTag] : [])];
      const status = mapState(issue.state, issue.state_reason);
      const author = issue.user?.login;
      const description =
        `GH ${kind} #${issue.number}: ${issue.html_url}` +
        (author ? ` · author @${author}` : "") +
        (issue.state_reason ? ` · state reason ${issue.state_reason}` : "") +
        (issue.created_at ? ` · created ${issue.created_at}` : "") +
        (issue.updated_at ? ` · updated ${issue.updated_at}` : "");
      const syncAnnotations = opts.commentsMode === "annotations" || opts.commentsMode === "both";
      const shouldFetchComments = opts.withComments || syncAnnotations;
      const writeCommentsToBody = opts.commentsMode === "body" || opts.commentsMode === "both";
      let comments: GhComment[] = [];
      if (shouldFetchComments) {
        try {
          comments = await fetchComments(issue, repo, token);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`#${issue.number}: failed to fetch comments — ${msg}`);
        }
      }
      prepared.push({
        issueNumber: issue.number,
        title,
        itemType: opts.itemType,
        status,
        description,
        body: writeCommentsToBody ? composeBody(issue, comments) : (issue.body || ""),
        tags,
        assignee: issue.assignee?.login,
        milestone: issue.milestone?.title,
        comments,
        syncAnnotations,
        match: existing.get(`${repo.toLowerCase()}#${issue.number}`),
      });
    }

    if (prepared.length === 0) {
      console.error(`Imported 0 new, updated 0 existing, skipped ${skipped}.`);
      return { imported: 0, updated: 0, skipped, atomic: true };
    }

    const result = await importGithubAtomic(pmRoot, repo, prepared);
    for (const entry of prepared) {
      if (!entry.syncAnnotations) continue;
      const itemId = result.itemIds.get(entry.issueNumber);
      if (itemId) {
        await syncGithubCommentsToAnnotations(
          itemId,
          entry.comments,
          pmRoot,
          entry.issueNumber,
        );
      }
    }
    if (result.recovered) {
      console.error(
        `Atomic import recovered transaction ${result.transactionId} covering ${result.recoveredItems ?? prepared.length} item(s).`,
      );
    } else {
      console.error(
        `Atomically imported ${result.imported} new, updated ${result.updated} existing, skipped ${skipped}.`,
      );
    }
    // itemIds is an internal post-commit routing map for native comments. Maps
    // serialize as `{}` in JSON, so keep it out of the public command result.
    return {
      transactionId: result.transactionId,
      recovered: result.recovered,
      imported: result.imported,
      updated: result.updated,
      ...(result.recoveredItems !== undefined ? { recoveredItems: result.recoveredItems } : {}),
      skipped,
      atomic: true,
    };
  }

  for (const issue of filtered) {
    const title = issue.title.trim();
    if (!title) {
      skipped++;
      continue;
    }

    const kind = issue.pull_request ? "PR" : "issue";
    const labels = issue.labels.map((l) => l.name).filter(Boolean);
    const tag = provenanceTag(repo, issue.number);
    const ghAuthorTag = authorTag(issue);
    const tags = [...labels, tag, ...(ghAuthorTag ? [ghAuthorTag] : [])];
    const status = mapState(issue.state, issue.state_reason);
    const assignee = issue.assignee?.login;
    const milestone = issue.milestone?.title;
    const key = `${repo.toLowerCase()}#${issue.number}`;
    const match = existing.get(key);

    // GitHub provenance lives in the description (human-readable) and the
    // declared schema fields (github_url/github_number/github_state/
    // github_author/github_created_at/github_updated_at). Author + timestamps
    // are appended additively so a re-import keeps them current.
    const author = issue.user?.login;
    const description =
      `GH ${kind} #${issue.number}: ${issue.html_url}` +
      (author ? ` · author @${author}` : "") +
      (issue.state_reason ? ` · state reason ${issue.state_reason}` : "") +
      (issue.created_at ? ` · created ${issue.created_at}` : "") +
      (issue.updated_at ? ` · updated ${issue.updated_at}` : "");

    // Comments are fetched when --with-comments asks for the legacy body
    // embedding OR when --comments-mode targets the native comments collection
    // (annotations/both). In default mode (body + no --with-comments) nothing is
    // fetched, keeping import output byte-identical to pre-2026.7.14 behavior.
    const syncAnnotations = opts.commentsMode === "annotations" || opts.commentsMode === "both";
    const shouldFetchComments = opts.withComments || syncAnnotations;
    // Comments land in the body only in body/both mode (the historical path).
    const writeCommentsToBody = opts.commentsMode === "body" || opts.commentsMode === "both";

    let comments: GhComment[] = [];
    if (shouldFetchComments) {
      try {
        comments = await fetchComments(issue, repo, token);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`#${issue.number}: failed to fetch comments — ${msg}`);
      }
    }
    const body = writeCommentsToBody ? composeBody(issue, comments) : (issue.body || "");

    if (opts.dryRun) {
      console.error(`  [dry-run] #${issue.number} ${title} (${status}, ${labels.join(",")})`);
      imported++;
      continue;
    }

    if (match?.id) {
      // Idempotent update — never duplicate. Status transitions go through the
      // proper command (close requires a reason; reopen via update --status).
      const updArgs = [
        "--path", pmRoot, "update", match.id,
        "--title", title,
        "--description", description,
        "--body", body,
        "--tags", tags.join(","),
        "--message", `Re-imported from GitHub #${issue.number}`,
      ];
      if (assignee) updArgs.push("--assignee", assignee);
      if (milestone) updArgs.push("--sprint", milestone);
      const upd = pmRun(updArgs);
      if (!upd.ok) {
        console.error(`#${issue.number}: update failed — ${upd.stderr}`);
        skipped++;
        continue;
      }
      // Reconcile status separately.
      if (status === "closed" && match.status !== "closed") {
        const close = pmRun(["--path", pmRoot, "close", match.id, "--reason", `GitHub issue #${issue.number} closed`]);
        if (!close.ok) {
          console.error(`#${issue.number}: close reconciliation failed — ${close.stderr}`);
          skipped++;
          continue;
        }
      } else if (status === "open" && match.status === "closed") {
        const reopen = pmRun(["--path", pmRoot, "update", match.id, "--status", "open", "--message", `GitHub issue #${issue.number} reopened`]);
        if (!reopen.ok) {
          console.error(`#${issue.number}: reopen reconciliation failed — ${reopen.stderr}`);
          skipped++;
          continue;
        }
      }
      if (syncAnnotations) {
        await syncGithubCommentsToAnnotations(match.id, comments, pmRoot, issue.number);
      }
      updated++;
      continue;
    }

    const createArgs = [
      "--path", pmRoot, "create",
      "--title", title,
      "--type", opts.itemType,
      "--status", status,
      "--description", description,
      "--body", body,
      "--tags", tags.join(","),
      "--message", `Imported from GitHub #${issue.number}`,
    ];
    if (assignee) createArgs.push("--assignee", assignee);
    if (milestone) createArgs.push("--sprint", milestone);
    // --json lets the annotations sync address the freshly-created item by id
    // without re-scanning the workspace; only added when we actually need the id.
    if (syncAnnotations) createArgs.push("--json");
    const created = pmRun(createArgs);
    if (!created.ok) {
      console.error(`#${issue.number}: create failed — ${created.stderr}`);
      skipped++;
      continue;
    }
    if (syncAnnotations) {
      const newId = parseCreatedItemId(created.stdout);
      if (newId) {
        await syncGithubCommentsToAnnotations(newId, comments, pmRoot, issue.number);
      } else {
        console.error(`#${issue.number}: could not parse created item id — comments not synced`);
      }
    }
    imported++;
  }

  if (opts.dryRun) {
    console.error(`[dry-run] Would import ${imported}, skip ${skipped}.`);
    return {
      dryRun: true,
      wouldImport: imported,
      wouldSkip: skipped,
      ...(opts.atomic ? { atomic: true } : {}),
    };
  }

  console.error(`Imported ${imported} new, updated ${updated} existing, skipped ${skipped}.`);
  if (imported === 0 && updated === 0 && skipped > 0) {
    throw new CommandError(`Imported 0 issue(s); ${skipped} failed.`);
  }
  return { imported, updated, skipped };
}

// ---------------------------------------------------------------------------
// Sync core — push pm status changes back to GitHub (close / reopen)
// ---------------------------------------------------------------------------

function pmStatusToGithubState(status: string | undefined): "open" | "closed" {
  return status === "closed" || status === "canceled" ? "closed" : "open";
}

// For every pm item that carries a provenance tag for `repo`, compute whether
// the linked GitHub issue's state should change to match the pm status, and
// (unless dry-run) PATCH it. Guarded by token + explicit --repo upstream.
export interface SyncPlanEntry {
  id: string;
  number: number;
  title: string;
  from: "open" | "closed";
  to: "open" | "closed";
}

// Build the pm → GitHub issue sync plan: for each pm item linked to `repo`, emit
// a create-or-update entry keyed by the issue's provenance tag.
export function planSync(items: PmItem[], repo: string): SyncPlanEntry[] {
  const plan: SyncPlanEntry[] = [];
  const repoLc = repo.toLowerCase();
  for (const item of items) {
    if (!item.id) continue;
    for (const tag of item.tags ?? []) {
      const p = parseProvenanceTag(tag);
      if (!p || p.repo !== repoLc) continue;
      const desired = pmStatusToGithubState(item.status);
      plan.push({
        id: item.id,
        number: p.number,
        title: item.title ?? "(untitled)",
        // `from` is unknown without a fetch; the planner records desired state
        // and the executor only PATCHes when GitHub disagrees.
        from: desired === "open" ? "closed" : "open",
        to: desired,
      });
    }
  }
  return plan;
}

// Command handler for `pm github sync`: preview or apply the pm → GitHub issue
// sync plan, scoped by --ids and honoring --dry-run / --apply.
async function runSync(ctx: any) {
  const options = ctx.options || {};
  const repo = optionString(options, "repo") || (ctx.args?.[0] as string | undefined);
  const dryRun = optionEnabled(options, "dry-run", "dryRun");
  const idsProvided = optionProvided(options, "ids");
  const scopedIds = optionCsv(options, "ids");

  if (!repo || !repo.includes("/")) {
    throw new CommandError(
      "Usage: pm github sync --repo <owner/repo> [--dry-run]  " +
        "(pushes pm item status to the linked GitHub issue: close/reopen)",
      EXIT_CODE.USAGE,
    );
  }
  if (idsProvided && scopedIds.length === 0) {
    throw new CommandError(
      "--ids requires at least one pm item id (comma-separated), e.g. --ids pm-123,pm-456.",
      EXIT_CODE.USAGE,
    );
  }

  const token = resolveGitHubToken();
  if (!token && !dryRun) {
    throw new CommandError(
      "pm github sync needs a GitHub token to mutate issues " +
        "(set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`). Use --dry-run to preview without a token.",
      EXIT_CODE.USAGE,
    );
  }

  const allItems = readPmItems(ctx.pm_root);
  const scoped = scopeItemsByIds(allItems, scopedIds.length > 0 ? scopedIds : undefined);
  if (scoped.missing.length > 0) {
    throw new CommandError(
      `--ids included unknown pm item id(s): ${scoped.missing.join(", ")}`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const plan = planSync(scoped.selected, repo);

  if (plan.length === 0) {
    const scopeNote = scopedIds.length > 0 ? ` from --ids (${scopedIds.join(", ")})` : "";
    console.error(
      `No pm items${scopeNote} linked to ${repo} ` +
        `(no \`gh:${repo.toLowerCase()}#N\` provenance tags).`,
    );
    return {
      synced: 0,
      skipped: 0,
      planned: 0,
      ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
    };
  }

  let synced = 0;
  let skipped = 0;
  for (const entry of plan) {
    // Fetch current state so we only PATCH on a genuine divergence.
    let current: GhIssue;
    try {
      const { body } = await fetchJSON(
        `https://api.github.com/repos/${repo}/issues/${entry.number}`,
        token,
      );
      current = JSON.parse(body) as GhIssue;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`#${entry.number}: could not read upstream state — ${msg}`);
      skipped++;
      continue;
    }
    if (current.state === entry.to) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.error(`  [dry-run] #${entry.number} "${entry.title}": ${current.state} → ${entry.to}`);
      synced++;
      continue;
    }
    try {
      await request(
        "PATCH",
        `https://api.github.com/repos/${repo}/issues/${entry.number}`,
        token,
        JSON.stringify({ state: entry.to }),
      );
      console.error(`#${entry.number} "${entry.title}": ${current.state} → ${entry.to}`);
      synced++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`#${entry.number}: PATCH failed — ${msg}`);
      skipped++;
    }
  }

  if (dryRun) {
    console.error(`[dry-run] Would update ${synced} issue(s) on ${repo}; ${skipped} already in sync/failed.`);
    return {
      dryRun: true,
      wouldSync: synced,
      skipped,
      planned: plan.length,
      ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
    };
  }
  console.error(`Synced ${synced} issue(s) on ${repo}; skipped ${skipped}.`);
  return { synced, skipped, planned: plan.length, ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}) };
}

// ---------------------------------------------------------------------------
// Export core — render pm items as a GitHub-issues payload
// ---------------------------------------------------------------------------

export interface GithubExportPayload {
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

// Convert a pm item into the GitHub issue create/update payload, dropping
// internal provenance tags from labels and applying the optional label map.
function itemToGithubPayload(item: PmItem, labelMap?: Map<string, string>): GithubExportPayload {
  // Drop our internal provenance tags from exported labels, then apply any
  // user-supplied label mapping (pm tag → GitHub label). Both issue provenance
  // (`gh:owner/repo#N`) and project provenance (`gh-project:owner/number#itemId`)
  // are stripped, but only via strict anchored matching — user labels that
  // merely contain similar text (e.g. `gh-project-notes`) are preserved.
  const labels = (item.tags ?? []).filter(
    (t) => !parseProvenanceTag(t) && !parseProjectItemTag(t),
  );
  return {
    title: item.title ?? "(untitled)",
    body: item.body || item.description || "",
    labels: applyLabelMap(labels, labelMap),
    state: item.status === "closed" || item.status === "canceled" ? "closed" : "open",
  };
}

// One planned export action: create a new GitHub issue, or update an existing
// one already linked to this pm item via its `gh:repo#N` provenance tag.
export interface ExportPlanEntry {
  id?: string;
  action: "create" | "update";
  number?: number;
  payload: GithubExportPayload;
}

// Build the create/update plan. `repo` (lowercased) decides which provenance
// tags count as an "already exported to THIS repo" link → update; everything
// else is a create. Pure + side-effect free so it can be unit-tested and
// printed verbatim in --dry-run.
export function buildExportPlan(
  items: PmItem[],
  repo: string | undefined,
  labelMap?: Map<string, string>,
): ExportPlanEntry[] {
  const repoLc = repo?.toLowerCase();
  const plan: ExportPlanEntry[] = [];
  for (const item of items) {
    const payload = itemToGithubPayload(item, labelMap);
    let number: number | undefined;
    if (repoLc) {
      for (const tag of item.tags ?? []) {
        const p = parseProvenanceTag(tag);
        if (p && p.repo === repoLc) {
          number = p.number;
          break;
        }
      }
    }
    plan.push({
      id: item.id,
      action: number === undefined ? "create" : "update",
      ...(number === undefined ? {} : { number }),
      payload,
    });
  }
  return plan;
}

// Export is SAFE BY DEFAULT: it only performs real GitHub writes when the user
// explicitly opts in (--apply / --no-dry-run, or the legacy --push alias) AND
// has not also passed --dry-run (which always wins). Anything else is a
// preview that prints the plan without touching GitHub.
export function exportWillApply(options: Record<string, unknown>): boolean {
  if (optionEnabled(options, "dry-run", "dryRun")) return false;
  if (optionEnabled(options, "no-dry-run", "noDryRun")) return true;
  return optionEnabled(options, "apply", "push");
}

// A single per-item write failure encountered while applying an export plan.
export interface ExportApplyFailure {
  id?: string;
  action: "create" | "update";
  number?: number;
  title: string;
  error: string;
}

// Outcome of applying an export plan to GitHub.
export interface ExportApplyResult {
  created: number;
  updated: number;
  failed: number;
  failures: ExportApplyFailure[];
}

// The minimal signature the apply loop needs from `request`. Kept injectable so
// the per-item isolation can be unit-tested without real network I/O.
export type ExportRequestFn = (
  method: string,
  url: string,
  token: string | undefined,
  payload?: string,
) => Promise<unknown>;

// Apply a (already-built) export plan to GitHub, one issue at a time.
//
// CRITICAL: each create/update is isolated. A single failed write (e.g. a 422
// for a label that does not exist on the repo) is recorded and the loop
// CONTINUES with the remaining items — it never abandons the rest of the batch.
// This mirrors the per-item isolation already used by the import/sync paths.
// Pure aside from the injected `requestFn`, so it is directly unit-testable.
export async function applyExportPlan(
  plan: ExportPlanEntry[],
  repo: string,
  token: string | undefined,
  requestFn: ExportRequestFn,
): Promise<ExportApplyResult> {
  let created = 0;
  let updated = 0;
  const failures: ExportApplyFailure[] = [];
  for (const entry of plan) {
    const p = entry.payload;
    try {
      // An "update" entry must carry the issue number; without it we must NOT
      // silently fall through to a POST (that would create a duplicate issue).
      // Record it as a per-item failure and continue.
      if (entry.action === "update" && entry.number === undefined) {
        throw new Error("update entry is missing its GitHub issue number");
      }
      if (entry.action === "update" && entry.number !== undefined) {
        await requestFn(
          "PATCH",
          `https://api.github.com/repos/${repo}/issues/${entry.number}`,
          token,
          JSON.stringify({ title: p.title, body: p.body, labels: p.labels, state: p.state }),
        );
        updated++;
      } else {
        await requestFn(
          "POST",
          `https://api.github.com/repos/${repo}/issues`,
          token,
          JSON.stringify({ title: p.title, body: p.body, labels: p.labels }),
        );
        created++;
      }
    } catch (err: unknown) {
      // Isolate the failure: record it and keep going so one bad item never
      // abandons the items that follow it (and that may already be writable).
      const msg = err instanceof Error ? err.message : String(err);
      const label = entry.action === "update" && entry.number !== undefined
        ? `#${entry.number}`
        : entry.id ?? `"${p.title}"`;
      console.error(`${label}: ${entry.action} failed — ${msg}`);
      failures.push({
        id: entry.id,
        action: entry.action,
        ...(entry.number === undefined ? {} : { number: entry.number }),
        title: p.title,
        error: msg,
      });
    }
  }
  return { created, updated, failed: failures.length, failures };
}

// Decide the EXIT STATUS of a completed `export --apply` batch.
//
// The per-item-continue design above is intentional: one bad item never aborts
// the batch. But the batch as a WHOLE still has to report honest success or
// failure to the shell. A non-empty plan that wrote NOTHING (zero creates, zero
// updates) yet recorded at least one failure is a total failure — exiting 0 in
// that case would let a CI/script step believe the export succeeded when in
// fact nothing reached GitHub. Returns a CommandError to throw in that case, or
// undefined when the batch should succeed (exit 0):
//   - empty plan (nothing to do)                       → success
//   - any creates/updates landed (partial or full)     → success (per-item
//     failures are already reported; the batch still wrote real changes)
//   - non-empty plan, nothing written, >=1 failure     → GENERIC_FAILURE
export function applyOutcomeError(
  plan: ExportPlanEntry[],
  result: ExportApplyResult,
  repo: string,
): CommandError | undefined {
  if (plan.length > 0 && result.created === 0 && result.updated === 0 && result.failed > 0) {
    return new CommandError(
      `All ${result.failed} item(s) failed to apply to ${repo}; ` +
        "no issues were created or updated. See errors above.",
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// runExport — shared handler for the `pm github export` exporter + command
// ---------------------------------------------------------------------------
//
// Export is SAFE BY DEFAULT: it previews the create/update plan and writes
// NOTHING. Real writes happen only with --apply (or --no-dry-run / legacy
// --push) AND a token AND --repo <owner/repo>. With --repo, items already
// linked to an issue in that repo (via the `gh:repo#N` provenance tag) are
// UPDATEd (upsert) rather than duplicated. --label-map translates pm tags to
// GitHub labels. --json returns the plan object; we never write our own
// stdout in JSON mode (pm renders the return value). Used by both the
// `registerExporter("github", ...)` entry point and the `pm github export`
// command so the surface stays consistent.
async function runExport(ctx: any) {
  const options = ctx.options || {};
  const jsonMode = ctx.global?.json === true;
  const format = optionString(options, "format") || "json";
  const repo = optionString(options, "repo") || ctx.args?.[0];
  const apply = exportWillApply(options);
  const idsProvided = optionProvided(options, "ids");
  const scopedIds = optionCsv(options, "ids");
  const labelMap = parseLabelMap(options, "label-map", "labelMap");
  if (idsProvided && scopedIds.length === 0) {
    throw new CommandError(
      "--ids requires at least one pm item id (comma-separated), e.g. --ids pm-123,pm-456.",
      EXIT_CODE.USAGE,
    );
  }

  const allItems = readPmItems(ctx.pm_root);
  const scoped = scopeItemsByIds(allItems, scopedIds.length > 0 ? scopedIds : undefined);
  if (scoped.missing.length > 0) {
    throw new CommandError(
      `--ids included unknown pm item id(s): ${scoped.missing.join(", ")}`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const plan = buildExportPlan(scoped.selected, repo, labelMap);
  const creates = plan.filter((e) => e.action === "create").length;
  const updates = plan.filter((e) => e.action === "update").length;

  if (!apply) {
    // Dry-run (default). Emit the plan; in JSON mode return it silently.
    if (!jsonMode) {
      if (format === "md" || format === "markdown") {
        const md = plan
          .map((e) => {
            const head = e.action === "update" ? `## [update #${e.number}] ${e.payload.title}` : `## [create] ${e.payload.title}`;
            return `${head}\n\n${e.payload.body}\n\n_labels: ${e.payload.labels.join(", ")} · state: ${e.payload.state}_\n`;
          })
          .join("\n");
        // Route the human preview to STDERR so STDOUT stays only the
        // host-rendered return value (parseable JSON when the caller passes
        // the global --json). Writing the preview to stdout via console.log
        // used to corrupt `pm github export --format json` output: the host
        // also renders the exporter's return object to stdout, yielding JSON
        // immediately followed by trailing YAML/markdown — not valid JSON.
        console.error(md);
      } else {
        console.error(JSON.stringify(plan, null, 2));
      }
      const scopeNote = scopedIds.length > 0
        ? ` Scoped to ${scoped.selected.length} item(s) via --ids.`
        : "";
      const labelNote = labelMap && labelMap.size > 0
        ? ` Label map applied (${labelMap.size} mapping(s)).`
        : "";
      console.error(
        `[dry-run] Would create ${creates} and update ${updates} issue(s)` +
          `${repo ? ` on ${repo}` : " (no --repo: all treated as create)"}. ` +
          scopeNote +
          labelNote +
          "Re-run with --apply --repo <owner/repo> to write to GitHub.",
      );
    }
    return {
      dry_run: true,
      plan,
      would_create: creates,
      would_update: updates,
      repo,
      ...(labelMap ? { label_map: Object.fromEntries(labelMap) } : {}),
      ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
    };
  }

  // --apply path: real writes. Require token + repo.
  const token = resolveGitHubToken();
  if (!token) {
    throw new CommandError(
      "--apply requires a GitHub token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).",
      EXIT_CODE.USAGE,
    );
  }
  if (!repo || !repo.includes("/")) {
    throw new CommandError("--apply requires --repo <owner/repo>.", EXIT_CODE.USAGE);
  }
  // Apply each item independently: a single failed create/update is
  // recorded and the batch CONTINUES, so one bad item (e.g. a 422 for a
  // missing label) never abandons the rest of the export.
  const { created, updated, failed, failures } = await applyExportPlan(
    plan,
    repo,
    token,
    request,
  );
  if (!jsonMode) {
    console.error(`Created ${created} and updated ${updated} issue(s) on ${repo}.`);
    if (failed > 0) {
      console.error(`${failed} item(s) failed and were skipped (see errors above).`);
    }
  }
  // Honest batch-level exit status. Per-item failures are tolerated as long
  // as SOMETHING was written, but a non-empty plan that wrote nothing and
  // recorded only failures must exit non-zero — otherwise a CI/script step
  // sees success when no issue reached GitHub. Thrown AFTER the summary so
  // the per-item errors and the summary line are emitted first for context.
  const outcomeError = applyOutcomeError(
    plan,
    { created, updated, failed, failures },
    repo,
  );
  if (outcomeError) throw outcomeError;
  return {
    applied: true,
    created,
    updated,
    failed,
    failures,
    repo,
    ...(labelMap ? { label_map: Object.fromEntries(labelMap) } : {}),
    ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
  };
}

// ---------------------------------------------------------------------------
// Search provider — reach GitHub from `pm search` for imported items
// ---------------------------------------------------------------------------
//
// The pm search runtime maps a provider's hits back to LOCAL item documents by
// id and DROPS any hit whose id is not a local item (see
// normalizeExtensionProviderHits in @unbrained/pm-cli). So this provider cannot
// surface arbitrary remote issues; instead it asks GitHub which issues in the
// repo match the query, then returns hits for the pm items that are already
// imported from those issues (matched by the `gh:repo#N` provenance tag).
// Semantics: "find my imported pm items whose upstream GitHub issue matches Q".

// Build the GitHub Search-API URL for issues in a repo matching the free-text
// query. Restricted to `type:issue repo:<repo>` so it never leaks across repos.
export function buildSearchUrl(repo: string, query: string): string {
  const q = `${query} repo:${repo} type:issue`;
  return `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`;
}

// Map GitHub search results to local pm-item hits. For every returned issue
// number we look up the pm item carrying the matching `gh:repo#N` provenance
// tag; only locally-present items become hits (the runtime would drop the rest
// anyway). Score is GitHub's relevance score, normalized into a sane range.
export function mapSearchHits(
  matchedNumbers: number[],
  repo: string,
  itemsByProvenance: Map<string, PmItem>,
): Array<{ id: string; score: number; matched_fields: string[] }> {
  const repoLc = repo.toLowerCase();
  const hits: Array<{ id: string; score: number; matched_fields: string[] }> = [];
  const seen = new Set<string>();
  let rank = matchedNumbers.length;
  for (const number of matchedNumbers) {
    const item = itemsByProvenance.get(`${repoLc}#${number}`);
    if (!item?.id || seen.has(item.id)) {
      rank--;
      continue;
    }
    seen.add(item.id);
    // Preserve GitHub's ranking: earlier results score higher. Normalize to
    // (0, 1] so hits clear pm's default score threshold.
    hits.push({
      id: item.id,
      score: matchedNumbers.length > 0 ? rank / matchedNumbers.length : 1,
      matched_fields: [`github:${repoLc}#${number}`],
    });
    rank--;
  }
  return hits;
}

interface GhSearchResponse {
  items?: Array<{ number?: number }>;
}

// Resolve the search target repo: an explicit option wins, then the
// PM_GITHUB_REPO env var (so a workspace can pin its upstream).
export function resolveSearchRepo(options: Record<string, unknown>): string | undefined {
  const opt = optionString(options, "repo", "github-repo", "githubRepo");
  if (opt && opt.includes("/")) return opt;
  const env = process.env.PM_GITHUB_REPO;
  if (env && env.includes("/")) return env.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Validate — diagnose gh/token availability + repo accessibility
// ---------------------------------------------------------------------------

export interface ValidateReport {
  ok: boolean;
  gh_cli: boolean;
  token: boolean;
  token_source: "env" | "gh" | "none";
  repo?: string;
  repo_accessible?: boolean;
  repo_status?: number;
  rate_limit_remaining?: number;
  rate_limit_limit?: number;
  rate_limit_reset?: number;
  rate_limit_low?: boolean;
  messages: string[];
}

// Detect whether the `gh` CLI is installed and runnable on PATH.
function detectGhCli(): boolean {
  try {
    const r = spawnSync("gh", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Report which token source is active: `env` (GITHUB_TOKEN/GH_TOKEN), `gh` (gh
// auth), or `none`.
function detectTokenSource(): "env" | "gh" | "none" {
  if ((process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim()) return "env";
  const token = resolveGitHubToken();
  return token ? "gh" : "none";
}

// Command handler for `pm github validate`: checks token source, gh CLI, rate
// limit, and the reachable issue counts for the configured repo.
async function runValidate(ctx: any): Promise<ValidateReport> {
  const options = ctx.options || {};
  const repo = optionString(options, "repo") || (ctx.args?.[0] as string | undefined);
  const gh_cli = detectGhCli();
  const token_source = detectTokenSource();
  const token = resolveGitHubToken();
  const report: ValidateReport = {
    ok: true,
    gh_cli,
    token: Boolean(token),
    token_source,
    messages: [],
  };

  if (!token) {
    report.messages.push(
      "No GitHub token resolvable (GITHUB_TOKEN/GH_TOKEN or `gh auth login`); " +
        "reads are capped at 60 req/hr and private repos are unreachable.",
    );
  } else {
    report.messages.push(`GitHub token resolved via ${token_source === "env" ? "environment" : "gh CLI"}.`);
  }
  if (!gh_cli) report.messages.push("`gh` CLI not found on PATH (optional; only used to borrow a token).");

  if (repo) {
    if (!repo.includes("/")) {
      report.ok = false;
      report.messages.push(`Invalid --repo "${repo}" (expected owner/repo).`);
    } else {
      report.repo = repo;
      try {
        const res = await fetchJSON(`https://api.github.com/repos/${repo}`, token);
        report.repo_accessible = res.status >= 200 && res.status < 300;
        report.repo_status = res.status;
        const rate = parseRateLimit(res.headers);
        if (rate.remaining !== undefined) report.rate_limit_remaining = rate.remaining;
        if (rate.limit !== undefined) report.rate_limit_limit = rate.limit;
        if (rate.reset !== undefined) report.rate_limit_reset = rate.reset;
        report.rate_limit_low = rate.low;
        const rateLine = formatRateLimit(rate);
        if (rateLine) report.messages.push(rateLine);
        if (rate.low) {
          report.messages.push(
            `WARNING: GitHub API quota is low (${rate.remaining} left)` +
              (token ? "" : " — set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise it (60→5000/hr)") +
              ".",
          );
        }
        if (report.repo_accessible) {
          report.messages.push(`Repo ${repo} is accessible (HTTP ${res.status}).`);
        } else {
          report.ok = false;
          report.messages.push(`Repo ${repo} returned HTTP ${res.status}.`);
        }
      } catch (err: unknown) {
        report.ok = false;
        report.repo_accessible = false;
        report.messages.push(`Repo ${repo} check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    report.messages.push("No --repo given; skipped repo accessibility check.");
  }

  return report;
}

// ---------------------------------------------------------------------------
// Preflight — local guard for mutating github commands (no network in-hook)
// ---------------------------------------------------------------------------

// Returns true if the command/args describe a github operation that will MUTATE
// state (a write import, an export --push, or a non-dry-run sync).
// ===========================================================================
// GitHub Projects v2 — GraphQL client, operations, and command handlers.
// Projects v2 is a GraphQL-only API; this section speaks it via the shared
// `request` infrastructure (retry/backoff/rate-limit) already defined above.
// The pure plan/mapping logic lives in ./projects.ts for unit-testability.
// ===========================================================================

const GRAPHQL_URL = "https://api.github.com/graphql";

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string; type?: string }>;
}

// One GraphQL round-trip. GraphQL reports business errors as HTTP 200 with an
// `errors` array, so we surface those explicitly. The combined user+org queries
// below intentionally return a partial error for the wrong owner type while the
// right one still resolves; we only throw when there is NO usable data.
async function githubGraphQL<T>(
  token: string | undefined,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!token) {
    throw new CommandError(
      "GitHub GraphQL requires a token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).",
      EXIT_CODE.USAGE,
    );
  }
  const payload = JSON.stringify({ query, variables });
  const res = await request("POST", GRAPHQL_URL, token, payload);
  let parsed: GraphQLResponse<T>;
  try {
    parsed = JSON.parse(res.body) as GraphQLResponse<T>;
  } catch {
    throw new CommandError(`GitHub GraphQL returned an unparseable response (HTTP ${res.status}).`);
  }
  if (parsed.data === undefined || parsed.data === null) {
    const messages = (parsed.errors ?? []).map((e) => e.message).join("; ");
    throw new CommandError(
      `GitHub GraphQL error${messages ? `: ${messages}` : ` (HTTP ${res.status})`}.`,
    );
  }
  return parsed.data;
}

const STATUS_FIELD_GQL = `
  statusField: field(name: "Status") {
    ... on ProjectV2SingleSelectField { id name options { id name } }
  }`;

// Resolve owner/number → project id + Status field. The owner may be a user or
// an org and GraphQL requires us to pick, so we ask both in one request and use
// whichever resolves.
async function resolveProject(ref: ProjectRef, token: string | undefined): Promise<ProjectMeta> {
  const query = `
    query($owner:String!,$number:Int!){
      user(login:$owner){ projectV2(number:$number){ id title url ${STATUS_FIELD_GQL} } }
      organization(login:$owner){ projectV2(number:$number){ id title url ${STATUS_FIELD_GQL} } }
    }`;
  const data = await githubGraphQL<any>(token, query, { owner: ref.owner, number: ref.number });
  const userNode = data.user?.projectV2;
  const orgNode = data.organization?.projectV2;
  const node = userNode ?? orgNode;
  if (!node) {
    throw new CommandError(
      `Project ${ref.owner}/${ref.number} not found or not accessible with the resolved token ` +
        "(need `project`/`read:project` scope; set GITHUB_TOKEN/GH_TOKEN or `gh auth login`).",
      EXIT_CODE.NOT_FOUND,
    );
  }
  const ownerType: ProjectMeta["ownerType"] = userNode ? "user" : "organization";
  const sf = node.statusField;
  const statusField: ProjectStatusField | undefined =
    sf && sf.id ? { id: sf.id, name: sf.name, options: sf.options ?? [] } : undefined;
  return { id: node.id, title: node.title ?? "", url: node.url ?? "", ownerType, statusField };
}

// Normalize a raw GraphQL project-item node into the ProjectItem model,
// tolerating null/undefined nodes and missing content (defensive against
// partial GraphQL errors / inaccessible items).
function normalizeProjectItemNode(n: any): ProjectItem {
  const c = n?.content ?? {};
  const tn = c.__typename;
  let content: ProjectItemContent;
  if (tn === "DraftIssue") {
    content = { typename: "DraftIssue", title: c.title ?? "", body: c.body ?? undefined };
  } else if (tn === "Issue") {
    content = {
      typename: "Issue",
      title: c.title ?? "",
      number: c.number,
      url: c.url,
      state: typeof c.state === "string" ? c.state.toLowerCase() : undefined,
      stateReason: typeof c.stateReason === "string" ? c.stateReason.toLowerCase() : null,
      repo: c.repository?.nameWithOwner,
    };
  } else if (tn === "PullRequest") {
    content = {
      typename: "PullRequest",
      title: c.title ?? "",
      number: c.number,
      url: c.url,
      state: typeof c.state === "string" ? c.state.toLowerCase() : undefined,
      repo: c.repository?.nameWithOwner,
    };
  } else {
    // Redacted or an item type we do not model — carry a placeholder so it is
    // counted but never mutated.
    content = { typename: "Unknown", title: "" };
  }
  const sv = n?.fieldValueByName;
  return {
    id: n?.id ?? "",
    statusOptionId: sv?.optionId ?? undefined,
    statusName: sv?.name ?? undefined,
    content,
  };
}

// Fetch every item on the board (paginated, 100/page).
async function fetchProjectItems(projectId: string, token: string | undefined): Promise<ProjectItem[]> {
  const query = `
    query($id:ID!,$cursor:String){
      node(id:$id){ ... on ProjectV2 {
        items(first:100, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id
            fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId } }
            content{
              __typename
              ... on DraftIssue { title body }
              ... on Issue { number title url state stateReason repository{ nameWithOwner } }
              ... on PullRequest { number title url state repository{ nameWithOwner } }
            }
          }
        }
      }}
    }`;
  const items: ProjectItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const data = await githubGraphQL<any>(token, query, { id: projectId, cursor: cursor ?? null });
    const conn = data.node?.items;
    if (!conn) break;
    for (const n of conn.nodes ?? []) {
      if (n) items.push(normalizeProjectItemNode(n));
    }
    if (conn.pageInfo?.hasNextPage && conn.pageInfo.endCursor) {
      cursor = conn.pageInfo.endCursor;
    } else {
      break;
    }
  }
  return items;
}

// Add a DraftIssue to a Projects v2 board and return the new project item id.
async function gqlAddDraft(
  projectId: string,
  title: string,
  body: string | undefined,
  token: string | undefined,
): Promise<string> {
  const q = `mutation($p:ID!,$t:String!,$b:String){ addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem{ id } } }`;
  const d = await githubGraphQL<any>(token, q, { p: projectId, t: title, b: body ?? "" });
  const id = d.addProjectV2DraftIssue?.projectItem?.id;
  if (!id) throw new CommandError("addProjectV2DraftIssue returned no item id.");
  return id;
}

// Link an existing repository issue/PR to a Projects v2 board and return the
// new project item id.
async function gqlAddIssue(projectId: string, contentId: string, token: string | undefined): Promise<string> {
  const q = `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`;
  const d = await githubGraphQL<any>(token, q, { p: projectId, c: contentId });
  const id = d.addProjectV2ItemById?.item?.id;
  if (!id) throw new CommandError("addProjectV2ItemById returned no item id.");
  return id;
}

// Set a project item's single-select Status field to the given option id.
async function gqlSetStatus(
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
  token: string | undefined,
): Promise<void> {
  const q = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`;
  await githubGraphQL<any>(token, q, { p: projectId, i: itemId, f: fieldId, o: optionId });
}

// Resolve the GraphQL node id of a repo's issue or PR by number, returning
// undefined when the item is not found or the repo ref is malformed.
async function gqlResolveIssueNodeId(
  repo: string,
  number: number,
  token: string | undefined,
): Promise<string | undefined> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return undefined;
  const q = `query($o:String!,$n:String!,$num:Int!){ repository(owner:$o,name:$n){ issueOrPullRequest(number:$num){ ... on Issue { id } ... on PullRequest { id } } } }`;
  const d = await githubGraphQL<any>(token, q, { o: owner, n: name, num: number });
  return d.repository?.issueOrPullRequest?.id ?? undefined;
}

// Compose a human-readable + provenance-bearing description for an imported
// project item (parallels the issue-import description).
function projectItemDescription(ref: ProjectRef, c: ProjectItemContent): string {
  const parts = [`GH project item ${ref.owner}/${ref.number}`];
  if (c.typename === "DraftIssue") parts.push("· draft issue");
  if (c.repo && typeof c.number === "number") parts.push(`· ${c.repo}#${c.number}`);
  if (c.url) parts.push(`· ${c.url}`);
  if (c.state) parts.push(`· state ${c.state}`);
  return parts.join(" ");
}

// --- project list ----------------------------------------------------------

// A page of a projectsV2 connection as returned by GitHub GraphQL.
export interface ProjectsV2Page {
  nodes?: any[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}

// Paginate a GitHub Projects v2 connection until pageInfo.hasNextPage is false.
// `fetchPage` returns the connection object (nodes + pageInfo) for the given
// cursor and may return null/undefined to stop early. Pure over the injected
// fetcher so the multi-page contract (no silent truncation, cursor threading)
// is unit-testable without network I/O. Mirrors the fetchProjectItems loop.
export async function collectProjectsV2Pages(
  fetchPage: (cursor: string | undefined) => Promise<ProjectsV2Page | null | undefined>,
): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (;;) {
    const conn = await fetchPage(cursor);
    if (!conn) break;
    for (const n of conn.nodes ?? []) if (n) out.push(n);
    // Continue only when GitHub explicitly reports more pages AND gives us a
    // cursor; otherwise stop so we never silently truncate by paging past the
    // end, nor loop forever on a missing endCursor.
    if (conn.pageInfo?.hasNextPage && conn.pageInfo?.endCursor) {
      cursor = conn.pageInfo.endCursor;
    } else {
      break;
    }
  }
  return out;
}

// Injectable GraphQL transport shape (matches githubGraphQL minus the token,
// which the caller closes over). Exported so the listing pagination path can be
// runtime-tested without network by passing a fake transport.
export type GraphQLTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<any>;

// Resolve + paginate the projectsV2 connection for a user-or-org owner using an
// injected GraphQL transport. A login is either a user or an organization,
// never both; querying both in one request lets us resolve the owner type
// without a round-trip, then we keep paginating the connection that actually
// exists so owners with more than 50/100 projects are fully listed instead of
// silently truncated (Greptile 2006f478). Returns raw connection nodes.
export async function listOwnerProjectsV2Nodes(
  owner: string,
  graphQL: GraphQLTransport,
): Promise<any[]> {
  let ownerType: "user" | "organization" | null = null;
  return collectProjectsV2Pages(async (cursor) => {
    const q = `
      query($owner:String!,$cursor:String){
        user(login:$owner){ projectsV2(first:100, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number title url closed shortDescription } } }
        organization(login:$owner){ projectsV2(first:100, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number title url closed shortDescription } } }
      }`;
    const d = await graphQL(q, { owner, cursor: cursor ?? null });
    if (ownerType === null) {
      if (d.user?.projectsV2) ownerType = "user";
      else if (d.organization?.projectsV2) ownerType = "organization";
    }
    return ownerType === "organization" ? d.organization?.projectsV2 : d.user?.projectsV2;
  });
}

async function runProjectList(ctx: any) {
  const options = ctx.options || {};
  const owner = optionString(options, "owner") || (ctx.args?.[0] as string | undefined);
  if (!owner) {
    throw new CommandError(
      "Usage: pm github project list <owner>  (a GitHub user or org login)",
      EXIT_CODE.USAGE,
    );
  }
  const token = resolveGitHubToken();
  const nodes = await listOwnerProjectsV2Nodes(owner, (q, vars) => githubGraphQL<any>(token, q, vars));
  const projects = nodes.map((n: any) => ({
    number: n.number,
    title: n.title ?? "",
    url: n.url ?? "",
    closed: !!n.closed,
    description: n.shortDescription ?? undefined,
  }));
  if (ctx.global?.json !== true) {
    if (projects.length === 0) {
      console.error(`No Projects v2 found for ${owner} (or none accessible with the resolved token).`);
    } else {
      console.error(`Projects for ${owner}:`);
      for (const p of projects) {
        console.error(`  #${p.number}  ${p.closed ? "[closed] " : ""}${p.title}  ${p.url}`);
      }
    }
  }
  return { owner, projects };
}

// --- project fields --------------------------------------------------------

async function runProjectFields(ctx: any) {
  const options = ctx.options || {};
  const ref = parseProjectRef(optionString(options, "project") || (ctx.args?.[0] as string | undefined));
  if (!ref) {
    throw new CommandError(
      "Usage: pm github project fields <owner/number>  (e.g. pm github project fields unbraind/5)",
      EXIT_CODE.USAGE,
    );
  }
  const token = resolveGitHubToken();
  const meta = await resolveProject(ref, token);
  const q = `
    query($id:ID!){ node(id:$id){ ... on ProjectV2 {
      fields(first:50){ nodes{
        __typename
        ... on ProjectV2FieldCommon { name dataType }
        ... on ProjectV2SingleSelectField { name options{ name } }
      } }
    }}}`;
  const d = await githubGraphQL<any>(token, q, { id: meta.id });
  const fields = (d.node?.fields?.nodes ?? []).filter(Boolean).map((f: any) => ({
    name: f.name,
    type: f.dataType ?? f.__typename,
    options: Array.isArray(f.options) ? f.options.map((o: any) => o.name) : undefined,
  }));
  if (ctx.global?.json !== true) {
    console.error(`Project ${ref.owner}/${ref.number} — ${meta.title} (${meta.ownerType})`);
    console.error(`  ${meta.url}`);
    console.error(`  Status field: ${meta.statusField ? meta.statusField.options.map((o) => o.name).join(" | ") : "(none — pushes cannot set status)"}`);
    console.error("  Fields:");
    for (const f of fields) {
      console.error(`    ${f.name} (${f.type})${f.options ? `: ${f.options.join(", ")}` : ""}`);
    }
  }
  return { project: meta, fields };
}

// --- project import --------------------------------------------------------

async function runProjectImport(ctx: any) {
  const options = ctx.options || {};
  const ref = parseProjectRef(optionString(options, "project") || (ctx.args?.[0] as string | undefined));
  if (!ref) {
    throw new CommandError(
      "Usage: pm github project import <owner/number> [--dry-run] [--status-map pm=Option,...] [--type <type>]",
      EXIT_CODE.USAGE,
    );
  }
  const dryRun = optionEnabled(options, "dry-run", "dryRun");
  const itemType = optionString(options, "type") || "Task";
  const statusMap = parseStatusMap(optionCsv(options, "status-map", "statusMap"));
  const token = resolveGitHubToken();

  const meta = await resolveProject(ref, token);
  const projectItems = await fetchProjectItems(meta.id, token);
  console.error(`Found ${projectItems.length} item(s) on ${ref.owner}/${ref.number} — ${meta.title}.`);

  // Reading the local store is non-mutating and keeps dry-run faithful: linked
  // project items must preview as updates, not misleading duplicate creates.
  const pmItems = readPmItems(ctx.pm_root);
  const plan = buildProjectImportPlan(projectItems, ref, pmItems, statusMap);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const entry of plan) {
    const description = projectItemDescription(ref, entry.content);
    if (dryRun) {
      console.error(`  [dry-run] ${entry.action} "${entry.title}" (${entry.status})`);
      if (entry.action === "create") imported++;
      else updated++;
      continue;
    }
    if (entry.action === "update" && entry.pmId) {
      const updArgs = [
        "--path", ctx.pm_root, "update", entry.pmId,
        "--title", entry.title,
        "--description", description,
        "--tags", entry.tags.join(","),
        "--message", `Re-imported from GitHub project ${ref.owner}/${ref.number}`,
      ];
      if (entry.body) updArgs.push("--body", entry.body);
      // Refresh the mapped pm status alongside the other fields — but ONLY when
      // the board Status mapped to a known pm status. An unknown mapping is
      // skipped (no --status) so we never overwrite a real pm state with a guess
      // (no data loss). `entry.status` carries a fallback for the create path;
      // `entry.mappedStatus` is set only for an explicit, resolvable mapping.
      if (entry.mappedStatus) updArgs.push("--status", entry.mappedStatus);
      const upd = pmRun(updArgs);
      if (!upd.ok) { console.error(`  ${entry.title}: update failed — ${upd.stderr}`); skipped++; continue; }
      updated++;
      continue;
    }
    const createArgs = [
      "--path", ctx.pm_root, "create",
      "--title", entry.title,
      "--type", itemType,
      "--status", entry.status,
      "--description", description,
      "--tags", entry.tags.join(","),
      "--message", `Imported from GitHub project ${ref.owner}/${ref.number}`,
    ];
    if (entry.body) createArgs.push("--body", entry.body);
    const created = pmRun(createArgs);
    if (!created.ok) { console.error(`  ${entry.title}: create failed — ${created.stderr}`); skipped++; continue; }
    imported++;
  }

  if (dryRun) {
    console.error(`[dry-run] Would import ${imported}, update ${updated}.`);
    return { dryRun: true, project: `${ref.owner}/${ref.number}`, wouldImport: imported, wouldUpdate: updated, planned: plan.length };
  }
  console.error(`Imported ${imported} new, updated ${updated}, skipped ${skipped}.`);
  if (imported === 0 && updated === 0 && skipped > 0) {
    throw new CommandError(`Imported 0 project item(s); ${skipped} failed.`);
  }
  return { imported, updated, skipped, project: `${ref.owner}/${ref.number}`, planned: plan.length };
}

// --- project sync (bidirectional) ------------------------------------------

// Push a pm item's status onto its (existing) board item, tolerating a missing
// target option. Returns true on a real change.
async function applyPushEntry(
  entry: ReturnType<typeof buildProjectPushPlan>["entries"][number],
  meta: ProjectMeta,
  ref: ProjectRef,
  pmById: Map<string, PmItem>,
  pmRoot: string,
  token: string | undefined,
): Promise<{ changed: boolean; error?: string }> {
  try {
    let itemId = entry.itemId;
    if (entry.action === "add-draft") {
      const pm = pmById.get(entry.pmId);
      itemId = await gqlAddDraft(meta.id, entry.title, pm?.body || pm?.description, token);
    } else if (entry.action === "add-issue") {
      if (!entry.issueRepo || typeof entry.issueNumber !== "number") {
        return { changed: false, error: "add-issue entry missing issue coordinates" };
      }
      const contentId = await gqlResolveIssueNodeId(entry.issueRepo, entry.issueNumber, token);
      if (!contentId) return { changed: false, error: `could not resolve node id for ${entry.issueRepo}#${entry.issueNumber}` };
      itemId = await gqlAddIssue(meta.id, contentId, token);
    }
    if (!itemId) return { changed: false, error: "no project item id to act on" };

    if (entry.targetOptionId && meta.statusField) {
      await gqlSetStatus(meta.id, itemId, meta.statusField.id, entry.targetOptionId, token);
    }
    // Ensure the pm item carries the project provenance tag so future syncs are
    // idempotent (never strips existing tags; only adds the missing one).
    const pm = pmById.get(entry.pmId);
    if (pm?.id) {
      const tag = projectItemTag(ref, itemId);
      const existingTags = pm.tags ?? [];
      if (!existingTags.includes(tag)) {
        const upd = pmRun([
          "--path", pmRoot, "update", pm.id,
          "--tags", [...existingTags, tag].join(","),
          "--message", `Linked to GitHub project ${ref.owner}/${ref.number}`,
        ]);
        if (!upd.ok) return { changed: true, error: `linked but tag write failed — ${upd.stderr}` };
      }
    }
    return { changed: true };
  } catch (err: unknown) {
    return { changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Build the pm CLI argv that applies one pull (project → pm) status transition.
// Pure so the lifecycle contract is unit-testable without spawning `pm`.
//
// pm CLI contracts (verified against pm 2026.7.11):
//   - `pm close` records `closed_at` + `close_reason` and moves the item to the
//     terminal `closed` state, but REFUSES on already-terminal items ("use
//     --force to close again"). It only ever produces `closed`, never `canceled`.
//   - `canceled` is a DISTINCT terminal state set via `pm update --status
//     canceled`; `pm update --status canceled` is permitted on both active and
//     terminal items, and `--close-reason` records the lifecycle rationale.
//     `pm list-canceled` projects `close_reason` (not `closed_at`), so the close
//     reason is the lifecycle metadata that must be recorded for `canceled`.
//
// Routing `canceled` through `pm close` (as one review suggestion proposed)
// would conflate `canceled` with `closed`, lose the distinct terminal state,
// and fail for terminal→canceled transitions. Recording `--close-reason` on the
// `pm update` keeps the distinction AND the lifecycle metadata, and works for
// active→canceled and terminal→canceled alike.
export function buildPullEntryArgs(entry: PullPlanEntryLike, pmRoot: string): string[] {
  const reason = `GitHub project status → ${entry.toStatus}`;
  if (entry.toStatus === "closed") {
    return ["--path", pmRoot, "close", entry.pmId, "--reason", reason];
  }
  if (entry.toStatus === "canceled") {
    return [
      "--path", pmRoot, "update", entry.pmId,
      "--status", "canceled",
      "--close-reason", reason,
      "--message", reason,
    ];
  }
  return [
    "--path", pmRoot, "update", entry.pmId,
    "--status", entry.toStatus,
    "--message", reason,
  ];
}

// Pull a board status onto its pm item. `closed` goes through `pm close`
// (records closed_at + close_reason); `canceled` keeps its distinct terminal
// state via `pm update` while recording `--close-reason`; everything else is a
// plain `pm update --status`.
function applyPullEntry(entry: PullPlanEntryLike, pmRoot: string): { changed: boolean; error?: string } {
  const res = pmRun(buildPullEntryArgs(entry, pmRoot));
  return res.ok ? { changed: true } : { changed: false, error: res.stderr };
}

interface PullPlanEntryLike {
  itemId: string;
  pmId: string;
  title: string;
  fromStatus: string;
  toStatus: string;
}

// Command handler for `pm github project sync`: preview (default) or apply the
// bidirectional Projects v2 sync plan, honoring --push/--pull/--apply/--ids.
async function runProjectSync(ctx: any) {
  const options = ctx.options || {};
  const ref = parseProjectRef(optionString(options, "project") || (ctx.args?.[0] as string | undefined));
  if (!ref) {
    throw new CommandError(
      "Usage: pm github project sync <owner/number> [--push|--pull] [--apply] [--ids pm-1,..] [--status-map pm=Option,..] [--no-add-missing] [--prefer pm|github]",
      EXIT_CODE.USAGE,
    );
  }

  const wantPush = optionEnabled(options, "push");
  const wantPull = optionEnabled(options, "pull");
  const dryRunFlag = optionEnabled(options, "dry-run", "dryRun");
  const apply = optionEnabled(options, "apply") && !dryRunFlag;
  const addMissing = !optionEnabled(options, "no-add-missing", "noAddMissing");
  const prefer = (optionString(options, "prefer") || "pm").toLowerCase() === "github" ? "github" : "pm";
  const statusMap = parseStatusMap(optionCsv(options, "status-map", "statusMap"));

  const idsProvided = optionProvided(options, "ids");
  const scopedIds = optionCsv(options, "ids");
  if (idsProvided && scopedIds.length === 0) {
    throw new CommandError("--ids requires at least one pm item id (comma-separated).", EXIT_CODE.USAGE);
  }

  // Direction resolution. Preview (no --apply) shows BOTH plans unless one is
  // explicitly requested. --apply defaults to push (never mutates pm silently).
  const previewBoth = !wantPush && !wantPull;
  const doPush = previewBoth || wantPush;
  const doPull = previewBoth || wantPull;
  const applyPush = apply && (wantPush || (!wantPush && !wantPull));
  const applyPull = apply && wantPull;

  const token = resolveGitHubToken();
  if (!token) {
    throw new CommandError(
      "pm github project sync needs a GitHub token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).",
      EXIT_CODE.USAGE,
    );
  }

  const meta = await resolveProject(ref, token);
  const projectItems = await fetchProjectItems(meta.id, token);
  const allPm = readPmItems(ctx.pm_root);
  const scoped = scopeItemsByIds(allPm, scopedIds.length > 0 ? scopedIds : undefined);
  if (scoped.missing.length > 0) {
    throw new CommandError(`--ids included unknown pm item id(s): ${scoped.missing.join(", ")}`, EXIT_CODE.NOT_FOUND);
  }
  const pmById = new Map<string, PmItem>();
  for (const it of scoped.selected) if (it.id) pmById.set(it.id, it);

  const pushPlan = doPush
    ? buildProjectPushPlan(scoped.selected, ref, projectItems, meta.statusField, { addMissing, statusMap })
    : undefined;
  const pullPlan = doPull
    ? buildProjectPullPlan(scoped.selected, ref, projectItems, statusMap)
    : undefined;

  // Conflict resolution when applying BOTH directions: a linked item can appear
  // in both plans. `--prefer pm` (default) lets push win (skip its pull entry);
  // `--prefer github` lets pull win (skip its push set-status entry). Adds are
  // always safe (new items are never in the pull plan).
  const pushItemIds = new Set((pushPlan?.entries ?? []).filter((e) => e.action === "set-status").map((e) => e.itemId));
  const pullItemIds = new Set((pullPlan?.entries ?? []).map((e) => e.itemId));

  const pushActionable = (pushPlan?.entries ?? []).filter((e) => e.action !== "noop");
  const pullActionable = pullPlan?.entries ?? [];

  if (!apply) {
    if (pushPlan) {
      console.error(`[dry-run] push (pm → project ${ref.owner}/${ref.number}):`);
      for (const e of pushActionable) {
        const detail =
          e.action === "set-status" ? `${e.currentOptionName ?? "(none)"} → ${e.targetOptionName}`
          : e.action === "add-draft" ? `add draft${e.targetOptionName ? ` @ ${e.targetOptionName}` : ""}`
          : `add issue ${e.issueRepo}#${e.issueNumber}${e.targetOptionName ? ` @ ${e.targetOptionName}` : ""}`;
        console.error(`  ${e.pmId} "${e.title}": ${detail}`);
      }
      for (const s of pushPlan.statusSkipped) {
        console.error(`  [skip] ${s.pmId} "${s.title}": pm status "${s.status}" maps to no board option`);
      }
      if (pushActionable.length === 0) console.error("  (nothing to push)");
    }
    if (pullPlan) {
      console.error(`[dry-run] pull (project ${ref.owner}/${ref.number} → pm):`);
      for (const e of pullActionable) console.error(`  ${e.pmId} "${e.title}": ${e.fromStatus} → ${e.toStatus}`);
      for (const s of pullPlan.statusSkipped) {
        console.error(`  [skip] item ${s.itemId}: board status "${s.optionName ?? "(none)"}" maps to no pm status`);
      }
      if (pullActionable.length === 0) console.error("  (nothing to pull)");
    }
    console.error("Preview only — pass --apply with --push and/or --pull to write.");
    return {
      dryRun: true,
      project: `${ref.owner}/${ref.number}`,
      push: pushPlan ? { actionable: pushActionable.length, statusSkipped: pushPlan.statusSkipped.length } : undefined,
      pull: pullPlan ? { actionable: pullActionable.length, statusSkipped: pullPlan.statusSkipped.length } : undefined,
    };
  }

  let pushed = 0;
  let pushFailed = 0;
  if (applyPush && pushPlan) {
    for (const e of pushActionable) {
      if (prefer === "github" && e.action === "set-status" && pullItemIds.has(e.itemId ?? "")) {
        continue; // pull wins for this linked item
      }
      const r = await applyPushEntry(e, meta, ref, pmById, ctx.pm_root, token);
      if (r.error && !r.changed) { console.error(`  push ${e.pmId} "${e.title}": ${r.error}`); pushFailed++; continue; }
      if (r.error) console.error(`  push ${e.pmId}: ${r.error}`);
      pushed++;
    }
  }

  let pulled = 0;
  let pullFailed = 0;
  if (applyPull && pullPlan) {
    for (const e of pullActionable) {
      if (prefer === "pm" && pushItemIds.has(e.itemId)) continue; // push wins
      const r = applyPullEntry(e, ctx.pm_root);
      if (!r.changed) { console.error(`  pull ${e.pmId} "${e.title}": ${r.error}`); pullFailed++; continue; }
      pulled++;
    }
  }

  console.error(
    `Sync complete on ${ref.owner}/${ref.number}: pushed ${pushed}${pushFailed ? ` (${pushFailed} failed)` : ""}, ` +
      `pulled ${pulled}${pullFailed ? ` (${pullFailed} failed)` : ""}.`,
  );
  const result = { project: `${ref.owner}/${ref.number}`, pushed, pushFailed, pulled, pullFailed, prefer };
  if (pushFailed + pullFailed > 0 && pushed + pulled === 0) {
    throw new CommandError(`Sync wrote nothing; ${pushFailed + pullFailed} operation(s) failed.`);
  }
  return result;
}

// Report whether a github subcommand mutates GitHub (for the host CLI's
// "mutating command" guard), accounting for --dry-run / --apply overrides.
export function isMutatingGithubCommand(command: string, options: Record<string, unknown>): boolean {
  const cmd = (command || "").toLowerCase();
  const dryRun = optionEnabled(options, "dry-run", "dryRun");
  if (cmd === "github sync") return !dryRun;
  // Export is dry-run by default; it only mutates with an explicit apply
  // (--apply / --no-dry-run / legacy --push) AND no --dry-run override.
  if (cmd === "github export") return exportWillApply(options);
  if (cmd === "github import" || cmd === "gh-issues import") return !dryRun;
  if (cmd === "github project import") return !dryRun;
  // Project sync is dry-run by default; it only mutates with --apply (and no
  // --dry-run override).
  if (cmd === "github project sync") return optionEnabled(options, "apply") && !dryRun;
  return false;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const IMPORT_FLAGS = [
  { long: "--all", description: "Include closed issues (shorthand for --state all)" },
  { long: "--state", value_name: "state", description: "Issue state: open | closed | all (default: open)" },
  { long: "--labels", value_name: "labels", description: "Comma-separated label filter" },
  { long: "--since", value_name: "date|relative", description: "Only issues updated after this date (ISO 8601 or relative like 7d/12h/1w/30m — incremental sync)" },
  { long: "--assignee", value_name: "login", description: "Filter by assignee login" },
  { long: "--milestone", value_name: "name", description: "Filter by milestone title" },
  { long: "--include-prs", description: "Include pull requests (default: skip PRs)" },
  { long: "--skip-drafts", description: "Exclude draft pull requests (only meaningful with --include-prs)" },
  { long: "--with-comments", description: "Fetch issue comments and append them to the item body" },
  { long: "--include-comments", description: "Alias for --with-comments" },
  { long: "--comments-mode", value_name: "body|annotations|both", description: "How to persist fetched GitHub comments: `body` (default, embed in item body), `annotations` (sync to the pm item's native comments collection), or `both`. `annotations`/`both` are idempotent on re-import (dedupe by GitHub comment id)" },
  { long: "--atomic", description: "Commit the complete import as one workspace-writer-locked, crash-resumable transaction (pm-cli >=2026.7.20); compensate every applied mutation on failure" },
  { long: "--dry-run", description: "Preview without writing" },
  { long: "--type", value_name: "type", description: "Override pm item type (default: Issue)" },
];

const EXPORT_FLAGS = [
  { long: "--repo", value_name: "owner/repo", description: "Target GitHub repo (required for --apply; enables upsert of linked issues)" },
  { long: "--ids", value_name: "pm-1,pm-2", description: "Only export these pm item IDs (comma-separated)" },
  { long: "--apply", description: "Write to GitHub (default is a safe dry-run preview)" },
  { long: "--no-dry-run", description: "Alias for --apply" },
  { long: "--push", description: "Legacy alias for --apply" },
  { long: "--dry-run", description: "Preview only (default; always wins over --apply)" },
  { long: "--label-map", value_name: "from=to,...", description: "Translate pm tags to GitHub labels, e.g. bug=kind/bug,enhancement=kind/enhancement" },
  { long: "--format", value_name: "json|md", description: "Dry-run preview format (default: json)" },
];

const SYNC_FLAGS = [
  { long: "--repo", value_name: "owner/repo", description: "Target GitHub repo (required)" },
  { long: "--ids", value_name: "pm-1,pm-2", description: "Only sync these pm item IDs (comma-separated)" },
  { long: "--dry-run", description: "Preview the close/reopen plan without mutating GitHub" },
];

const VALIDATE_FLAGS = [
  { long: "--repo", value_name: "owner/repo", description: "Also check this repo is accessible with the resolved token" },
];

const PROJECT_LIST_FLAGS = [
  { long: "--owner", value_name: "login", description: "GitHub user or org login (or pass positionally)" },
];

const PROJECT_FIELDS_FLAGS = [
  { long: "--project", value_name: "owner/number", description: "Project reference (or pass positionally, e.g. unbraind/5)" },
];

const PROJECT_IMPORT_FLAGS = [
  { long: "--project", value_name: "owner/number", description: "Project reference (or pass positionally)" },
  { long: "--dry-run", description: "Preview without writing pm items" },
  { long: "--type", value_name: "type", description: "pm item type for created items (default: Task)" },
  { long: "--status-map", value_name: "pm=Option,...", description: "Map board Status options to pm statuses, e.g. in_progress=Doing,closed=Shipped (inverted for import)" },
];

const PROJECT_SYNC_FLAGS = [
  { long: "--project", value_name: "owner/number", description: "Project reference (or pass positionally)" },
  { long: "--push", description: "pm → project: add missing items and set their Status" },
  { long: "--pull", description: "project → pm: update pm item status from the board" },
  { long: "--apply", description: "Write changes (default is a safe dry-run preview of both directions)" },
  { long: "--ids", value_name: "pm-1,pm-2", description: "Only sync these pm item IDs (comma-separated)" },
  { long: "--status-map", value_name: "pm=Option,...", description: "Map pm status to a board Status option, e.g. in_progress=Doing,closed=Shipped" },
  { long: "--no-add-missing", description: "Push: only reconcile status of already-linked items; never add new board items" },
  { long: "--prefer", value_name: "pm|github", description: "Conflict winner when applying both directions (default: pm)" },
  { long: "--dry-run", description: "Preview only (always wins over --apply)" },
];

export default defineExtension({
  name: "pm-github",
  version: "2026.7.18-1",

  activate(api: any) {
    // -----------------------------------------------------------------------
    // schema — declare the GitHub provenance fields so the workspace knows them
    // -----------------------------------------------------------------------
    api.registerItemFields([
      { name: "github_url", type: "string", optional: true },
      { name: "github_number", type: "number", optional: true },
      { name: "github_state", type: "string", optional: true },
      { name: "github_author", type: "string", optional: true },
      { name: "github_created_at", type: "string", optional: true },
      { name: "github_updated_at", type: "string", optional: true },
    ]);

    // -----------------------------------------------------------------------
    // preflight — safe, local guard for mutating github commands.
    // Runs before pm core commands; it does NOT make network calls (that would
    // be a surprise side effect on every command) and cannot hard-block (the
    // runtime swallows preflight throws). It only surfaces a clear, early
    // warning when a github mutation is requested without a resolvable token;
    // the authoritative validation + non-zero exit lives in the handlers.
    // -----------------------------------------------------------------------
    api.registerPreflight((ctx: any) => {
      if (isMutatingGithubCommand(ctx.command, ctx.options || {})) {
        if (!resolveGitHubToken()) {
          console.error(
            "[pm-github preflight] this github command mutates remote state but no GitHub " +
              "token is resolvable (GITHUB_TOKEN/GH_TOKEN or `gh auth login`). It will fail.",
          );
        }
      }
      return {};
    });

    // -----------------------------------------------------------------------
    // importer — `pm github import <owner/repo>` (idempotent native pipeline)
    // -----------------------------------------------------------------------
    api.registerImporter("github", async (ctx: any) => {
      return runImport(ctx.args?.[0], ctx.pm_root, parseImportOptions(ctx.options || {}));
    }, {
      description:
        "Fetch GitHub issues from a repo and create/update pm items (idempotent " +
        "on re-import via the `gh:owner/repo#N` provenance tag). Skips pull " +
        "requests by default.",
      intent: "import GitHub issues as pm items",
      arguments: [
        { name: "owner/repo", required: true, description: "GitHub repository to import" },
      ],
      examples: [
        "pm github import unbraind/pm-cli",
        "pm github import owner/repo --since 7d",
        "pm github import owner/repo --include-comments",
        "pm github import owner/repo --comments-mode annotations",
        "pm github import owner/repo --atomic",
        "pm github import owner/repo --dry-run",
      ],
      flags: IMPORT_FLAGS,
      failure_hints: [
        "Pass <owner/repo>, e.g. `pm github import unbraind/pm-cli`.",
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for private repos / 5000 req/hr.",
        "Re-running is safe: existing items are updated, not duplicated.",
        "Use --atomic to prevent partial tracker state when a bulk import is interrupted or fails.",
      ],
    });

    // -----------------------------------------------------------------------
    // exporter — `pm github export` (pm items → GitHub issues)
    // SAFE BY DEFAULT: previews the create/update plan and writes NOTHING.
    // Real writes happen only with --apply (or --no-dry-run / legacy --push)
    // AND a token AND --repo <owner/repo>. With --repo, items already linked to
    // an issue in that repo (via the `gh:repo#N` provenance tag) are UPDATEd
    // (upsert) rather than duplicated. --json returns the plan object; we never
    // write our own stdout in JSON mode (pm renders the return value).
    // -----------------------------------------------------------------------
    api.registerExporter("github", async (ctx: any) => runExport(ctx), {
      description:
        "Export pm items as GitHub issues. SAFE BY DEFAULT: prints a create/update " +
        "plan and writes NOTHING. Use --apply --repo <owner/repo> to write to " +
        "GitHub; linked items are updated instead of duplicated.",
      intent: "export pm items as GitHub issues",
      examples: [
        "pm github export --repo unbraind/pm-cli",
        "pm github export --repo unbraind/pm-cli --dry-run",
        "pm github export --repo unbraind/pm-cli --apply",
        "pm github export --label-map bug=kind/bug,enhancement=kind/enhancement",
        "pm github export --ids pm-1,pm-2 --repo unbraind/pm-cli --dry-run",
      ],
      flags: EXPORT_FLAGS,
      failure_hints: [
        "Export is dry-run by default; pass --apply --repo <owner/repo> to write.",
        "--apply requires a GitHub token (GITHUB_TOKEN/GH_TOKEN or `gh auth login`).",
        "--label-map takes from=to pairs, e.g. --label-map bug=kind/bug,enhancement=kind/enhancement.",
        "Use --ids <pm-1,pm-2> to scope export; unknown IDs fail fast.",
      ],
    });

    // -----------------------------------------------------------------------
    // search — reach GitHub from `pm search` for imported items.
    // Guarded by a capability check so it is a no-op on runtimes that predate
    // search providers. The provider asks GitHub which issues in the configured
    // repo match the query, then returns hits for the LOCAL pm items imported
    // from those issues (the runtime drops hits that aren't local documents).
    // Activates in semantic/hybrid mode: `pm search "<q>" --semantic`.
    // -----------------------------------------------------------------------
    if (typeof api.registerSearchProvider === "function") {
      api.registerSearchProvider({
        name: "github",
        async query(qctx: any) {
          const repo = resolveSearchRepo(qctx.options || {});
          if (!repo) return [];
          const token = resolveGitHubToken();
          let matchedNumbers: number[];
          try {
            const { body } = await fetchJSON(buildSearchUrl(repo, qctx.query), token);
            const parsed = JSON.parse(body) as GhSearchResponse;
            matchedNumbers = (parsed.items ?? [])
              .map((i) => i.number)
              .filter((n): n is number => typeof n === "number");
          } catch {
            // Network/parse failure → no remote hits; pm degrades to keyword.
            return [];
          }
          // Map remote matches back to local items via provenance tags. Prefer
          // the runtime-provided documents (already the current corpus); fall
          // back to a fresh read if absent.
          const docs: PmItem[] = Array.isArray(qctx.documents)
            ? qctx.documents.map((d: any) => (d?.metadata ? d.metadata : d))
            : readPmItems(qctx.pm_root || ".agents/pm");
          const index = indexByProvenance(docs);
          return mapSearchHits(matchedNumbers, repo, index);
        },
      });
    }

    // -----------------------------------------------------------------------
    // hooks — actionable sync reminder for github-linked items.
    // Safe + no network: only emits a hint, gated on PM_GITHUB_SYNC, and names
    // the exact command to run. Triggers only when a github-linked item (one
    // carrying a `gh:owner/repo#N` provenance tag) is closed/reopened.
    // -----------------------------------------------------------------------
    api.hooks.afterCommand((ctx: any) => {
      if (!process.env.PM_GITHUB_SYNC) return;
      if (!ctx.ok) return;
      if (ctx.command !== "close" && ctx.command !== "update") return;
      // Only nudge for items that are actually linked to GitHub.
      const id = ctx.args?.[0];
      if (!id || !ctx.pm_root) return;
      const res = spawnSync(
        "pm",
        ["--path", ctx.pm_root, "--json", "show", id],
        { encoding: "utf-8" },
      );
      if (res.status !== 0) return;
      let repo: string | undefined;
      try {
        const item = JSON.parse(res.stdout);
        for (const tag of item?.tags ?? []) {
          const p = parseProvenanceTag(String(tag));
          if (p) { repo = p.repo; break; }
        }
      } catch {
        return;
      }
      if (!repo) return;
      console.error(
        `[pm-github] ${id} is linked to ${repo}; run \`pm github sync --repo ${repo}\` ` +
          "to push this status change upstream (or --dry-run to preview).",
      );
    });

    // -----------------------------------------------------------------------
    // command — `pm github sync` (push pm status → GitHub close/reopen)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github sync",
      description:
        "Push pm item status changes back to GitHub: close/reopen the linked " +
        "issue (matched by the `gh:owner/repo#N` provenance tag) to match the pm " +
        "item's status. Requires a GitHub token and explicit --repo. Use --dry-run " +
        "to preview the plan without mutating anything.",
      intent: "sync pm item status to the linked GitHub issue state",
      examples: [
        "pm github sync --repo unbraind/pm-cli --dry-run",
        "pm github sync --repo unbraind/pm-cli --ids pm-123,pm-456 --dry-run",
        "pm github sync --repo unbraind/pm-cli",
      ],
      flags: SYNC_FLAGS,
      failure_hints: [
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (sync mutates remote issues).",
        "Pass --repo <owner/repo> explicitly; sync never guesses the target repo.",
        "Use --ids <pm-1,pm-2> to scope sync; unknown IDs fail fast to avoid silent misses.",
        "Items must carry a `gh:owner/repo#N` tag — import with `pm github import` first.",
        "Use --dry-run to preview the close/reopen plan before pushing.",
      ],
      async run(ctx: any) {
        return runSync(ctx);
      },
    });

    // -----------------------------------------------------------------------
    // command — legacy `pm gh-issues import <owner/repo>` (delegates to core)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "gh-issues import",
      description:
        "Fetch GitHub issues from a repo and create/update pm items (idempotent " +
        "on re-import via the `gh:owner/repo#N` provenance tag). Skips pull " +
        "requests by default. Uses GITHUB_TOKEN/GH_TOKEN (or the authenticated " +
        "gh CLI) when available for 5000 req/hr and private repos; falls back to " +
        "the unauthenticated API (60 req/hr). Equivalent to `pm github import`.",
      intent: "import GitHub issues as pm items",
      arguments: [
        { name: "owner/repo", required: true, description: "GitHub repository to import" },
      ],
      examples: [
        "pm gh-issues import unbraind/pm-cli",
        "pm gh-issues import unbraind/pm-cli --all",
        "pm gh-issues import unbraind/pm-cli --labels bug,enhancement",
        "pm gh-issues import unbraind/pm-cli --since 2026-01-01T00:00:00Z",
        "pm github import owner/repo --with-comments",
        "pm github import owner/repo --comments-mode annotations",
        "pm github import owner/repo --atomic",
        "pm github import owner/repo --dry-run",
      ],
      flags: IMPORT_FLAGS,
      failure_hints: [
        "Pass <owner/repo>, e.g. `pm gh-issues import unbraind/pm-cli`.",
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for private repos / 5000 req/hr.",
        "Re-running is safe: existing items are updated, not duplicated.",
        "Use --atomic to prevent partial tracker state when a bulk import is interrupted or fails.",
      ],
      async run(ctx: any) {
        return runImport(ctx.args[0], ctx.pm_root, parseImportOptions(ctx.options));
      },
    });

    // -----------------------------------------------------------------------
    // command — `pm github validate` (diagnostics: gh/token/repo reachability)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github validate",
      description:
        "Diagnose the GitHub integration: whether the `gh` CLI is present, " +
        "whether a token is resolvable (and from where), and—if --repo is " +
        "given—whether that repo is accessible with the resolved token. " +
        "Read-only; never mutates anything. Use --json for machine output.",
      intent: "check gh/token availability and repo accessibility",
      examples: [
        "pm github validate",
        "pm github validate --repo unbraind/pm-cli",
        "pm github validate --repo unbraind/pm-cli --json",
      ],
      flags: VALIDATE_FLAGS,
      failure_hints: [
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise the rate limit and reach private repos.",
        "Pass --repo <owner/repo> to verify a specific repo is reachable.",
      ],
      async run(ctx: any) {
        const report = await runValidate(ctx);
        const jsonMode = ctx.global?.json === true;
        if (!jsonMode) {
          for (const line of report.messages) console.error(line);
        }
        if (!report.ok) {
          // Surface a non-zero exit for scripts; the report still returns so
          // --json consumers get structured detail.
          throw new CommandError(
            report.messages.join(" "),
            report.repo && report.repo_accessible === false ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE,
          );
        }
        return report;
      },
    });

    // -----------------------------------------------------------------------
    // command — `pm github project list <owner>` (discover ProjectsV2)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github project list",
      description:
        "List the GitHub Projects v2 owned by a user or org (number, title, url, " +
        "closed state). Read-only. Use --json for machine output. Needs a token " +
        "with `project`/`read:project` scope for private projects.",
      intent: "discover GitHub Projects v2 for an owner",
      arguments: [{ name: "owner", required: false, description: "GitHub user or org login" }],
      examples: ["pm github project list unbraind", "pm github project list unbraind --json"],
      flags: PROJECT_LIST_FLAGS,
      failure_hints: [
        "Pass an owner login, e.g. `pm github project list unbraind`.",
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (private projects need `project` scope).",
      ],
      async run(ctx: any) {
        return runProjectList(ctx);
      },
    });

    // -----------------------------------------------------------------------
    // command — `pm github project fields <owner/number>` (introspect schema)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github project fields",
      description:
        "Introspect a GitHub Project v2: its fields and, crucially, the Status " +
        "single-select options that push/pull map pm statuses to. Read-only. Use " +
        "this to design a --status-map. Use --json for machine output.",
      intent: "introspect Project v2 fields and Status options",
      arguments: [{ name: "owner/number", required: false, description: "Project reference, e.g. unbraind/5" }],
      examples: ["pm github project fields unbraind/5", "pm github project fields unbraind/5 --json"],
      flags: PROJECT_FIELDS_FLAGS,
      failure_hints: [
        "Pass <owner/number>, e.g. `pm github project fields unbraind/5`.",
        "A project without a Status field cannot receive pushed statuses (items are still added).",
      ],
      async run(ctx: any) {
        return runProjectFields(ctx);
      },
    });

    // -----------------------------------------------------------------------
    // command — `pm github project import <owner/number>` (board → pm items)
    // Idempotent via the `gh-project:owner/number#itemId` provenance tag; draft
    // issues import too. Maps the board Status option → pm status.
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github project import",
      description:
        "Import every item on a GitHub Project v2 board as pm items (draft issues " +
        "included). Idempotent on re-import via the `gh-project:owner/number#itemId` " +
        "provenance tag; items that wrap a real issue also carry the `gh:repo#N` tag " +
        "so issue- and project-import stay linked. The board's Status option maps to " +
        "the pm status. Safe: --dry-run previews without writing.",
      intent: "import GitHub Project v2 board items as pm items",
      arguments: [{ name: "owner/number", required: false, description: "Project reference, e.g. unbraind/5" }],
      examples: [
        "pm github project import unbraind/5",
        "pm github project import unbraind/5 --dry-run",
        "pm github project import unbraind/5 --status-map in_progress=Doing,closed=Shipped",
      ],
      flags: PROJECT_IMPORT_FLAGS,
      failure_hints: [
        "Pass <owner/number>, e.g. `pm github project import unbraind/5`.",
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (needs `project`/`read:project`).",
        "Re-running is safe: linked items are updated, not duplicated.",
      ],
      async run(ctx: any) {
        return runProjectImport(ctx);
      },
    });

    // -----------------------------------------------------------------------
    // command — `pm github project sync <owner/number>` (bidirectional)
    // SAFE BY DEFAULT: previews both directions and writes NOTHING. --apply
    // writes; direction chosen by --push/--pull (default --apply = push).
    // NEVER deletes/archives board items or pm items (no data loss).
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github project sync",
      description:
        "Bidirectionally sync pm items and a GitHub Project v2 board. --push adds " +
        "missing pm items to the board (linking existing issues where possible, else " +
        "as draft issues) and sets each item's Status from its pm status. --pull " +
        "updates pm item status from the board. SAFE BY DEFAULT: with no --apply it " +
        "previews both directions and writes nothing. Unmapped statuses are SKIPPED, " +
        "never guessed. Never deletes or archives anything on either side.",
      intent: "bidirectionally sync pm items with a GitHub Project v2 board",
      arguments: [{ name: "owner/number", required: false, description: "Project reference, e.g. unbraind/5" }],
      examples: [
        "pm github project sync unbraind/5",
        "pm github project sync unbraind/5 --push --apply",
        "pm github project sync unbraind/5 --pull --apply",
        "pm github project sync unbraind/5 --push --pull --apply --prefer pm",
        "pm github project sync unbraind/5 --push --apply --ids pm-1,pm-2",
      ],
      flags: PROJECT_SYNC_FLAGS,
      failure_hints: [
        "Preview is default; pass --apply with --push and/or --pull to write.",
        "--apply requires a GitHub token (GITHUB_TOKEN/GH_TOKEN or `gh auth login`).",
        "Design a --status-map with `pm github project fields <owner/number>` first.",
        "Use --ids <pm-1,pm-2> to scope; unknown IDs fail fast.",
      ],
      async run(ctx: any) {
        return runProjectSync(ctx);
      },
    });
  },
});

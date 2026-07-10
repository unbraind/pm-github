// pm-github — GitHub Issues sync (importer / exporter / sync) for pm-cli
//
// Capabilities (see manifest.json):
//   commands   — `pm gh-issues import` (legacy) + `pm github sync`
//   importers  — `pm github import <owner/repo>` (idempotent native import)
//   exporters  — `pm github export` (render pm items as a GitHub-issues payload)
//   schema     — declares github_url / github_number / github_state /
//                github_author / github_created_at / github_updated_at item fields
//   hooks      — afterCommand: actionable sync hint for github-linked items
//   preflight  — local guard for mutating github commands (token presence)

import https from "node:https";
import { spawnSync } from "node:child_process";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GhIssue {
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

interface GhComment {
  user: { login: string } | null;
  created_at: string;
  body: string | null;
}

interface ImportOptions {
  state: "open" | "closed" | "all";
  labels?: string;
  since?: string;
  assignee?: string;
  milestone?: string;
  includePrs: boolean;
  skipDrafts: boolean;
  withComments: boolean;
  itemType: string;
  dryRun: boolean;
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

// One low-level request, no retry/backoff (that lives in `request`).
function requestOnce(
  method: string,
  url: string,
  token: string | undefined,
  payload?: string,
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
        requestOnce(method, res.headers.location, token, payload).then(resolve, reject);
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
    return new Date(nowMs - ms).toISOString();
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

interface PmItem {
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
  return {
    state,
    labels: optionString(options, "labels"),
    since,
    assignee: optionString(options, "assignee"),
    milestone: optionString(options, "milestone"),
    includePrs: optionEnabled(options, "include-prs", "includePrs"),
    skipDrafts: optionEnabled(options, "skip-drafts", "skipDrafts"),
    withComments: optionEnabled(options, "with-comments", "withComments", "include-comments", "includeComments"),
    itemType: optionString(options, "type") || "Issue",
    dryRun: optionEnabled(options, "dry-run", "dryRun"),
  };
}

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
        "[--milestone <name>] [--include-prs] [--skip-drafts] [--with-comments]",
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

    let comments: GhComment[] = [];
    if (opts.withComments) {
      try {
        comments = await fetchComments(issue, repo, token);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`#${issue.number}: failed to fetch comments — ${msg}`);
      }
    }
    const body = composeBody(issue, comments);

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
    const created = pmRun(createArgs);
    if (!created.ok) {
      console.error(`#${issue.number}: create failed — ${created.stderr}`);
      skipped++;
      continue;
    }
    imported++;
  }

  if (opts.dryRun) {
    console.error(`[dry-run] Would import ${imported}, skip ${skipped}.`);
    return { dryRun: true, wouldImport: imported, wouldSkip: skipped };
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

function itemToGithubPayload(item: PmItem, labelMap?: Map<string, string>): GithubExportPayload {
  // Drop our internal provenance tags from exported labels, then apply any
  // user-supplied label mapping (pm tag → GitHub label).
  const labels = (item.tags ?? []).filter((t) => !parseProvenanceTag(t));
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
        console.log(md);
      } else {
        console.log(JSON.stringify(plan, null, 2));
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

function detectGhCli(): boolean {
  try {
    const r = spawnSync("gh", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function detectTokenSource(): "env" | "gh" | "none" {
  if ((process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim()) return "env";
  const token = resolveGitHubToken();
  return token ? "gh" : "none";
}

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
export function isMutatingGithubCommand(command: string, options: Record<string, unknown>): boolean {
  const cmd = (command || "").toLowerCase();
  const dryRun = optionEnabled(options, "dry-run", "dryRun");
  if (cmd === "github sync") return !dryRun;
  // Export is dry-run by default; it only mutates with an explicit apply
  // (--apply / --no-dry-run / legacy --push) AND no --dry-run override.
  if (cmd === "github export") return exportWillApply(options);
  if (cmd === "github import" || cmd === "gh-issues import") return !dryRun;
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

export default defineExtension({
  name: "pm-github",
  version: "2026.7.6",

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
    });

    // The native importer capability exposes `pm github import`, but current pm
    // runtimes synthesize that command without the importer's positional/flag
    // contract. Register the command explicitly as well so a real installation
    // can accept <owner/repo> and all importer options.
    api.registerCommand({
      name: "github import",
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
        "pm github import owner/repo --dry-run",
      ],
      flags: IMPORT_FLAGS,
      failure_hints: [
        "Pass <owner/repo>, e.g. `pm github import unbraind/pm-cli`.",
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for private repos / 5000 req/hr.",
        "Re-running is safe: existing items are updated, not duplicated.",
      ],
      async run(ctx: any) {
        return runImport(ctx.args[0], ctx.pm_root, parseImportOptions(ctx.options));
      },
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
    api.registerExporter("github", async (ctx: any) => runExport(ctx));

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
    // command — `pm github export` (pm items → GitHub issues)
    // Surfaces the exporter as a discoverable command with explicit flags so
    // `--label-map`, `--dry-run`, `--apply` and `--ids` are self-documenting.
    // Delegates to the same `runExport` core the exporter entry point uses.
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "github export",
      description:
        "Export pm items as GitHub issues. SAFE BY DEFAULT: prints a create/update " +
        "plan and writes NOTHING. Use --apply --repo <owner/repo> to write to " +
        "GitHub; items already linked to an issue in that repo (via the " +
        "`gh:owner/repo#N` provenance tag) are updated (upsert) instead of " +
        "duplicated. --label-map translates pm tags to GitHub labels.",
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
      async run(ctx: any) {
        return runExport(ctx);
      },
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
        "pm github import owner/repo --dry-run",
      ],
      flags: IMPORT_FLAGS,
      failure_hints: [
        "Pass <owner/repo>, e.g. `pm gh-issues import unbraind/pm-cli`.",
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for private repos / 5000 req/hr.",
        "Re-running is safe: existing items are updated, not duplicated.",
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
  },
});

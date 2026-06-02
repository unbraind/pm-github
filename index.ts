// pm-github — GitHub Issues sync (importer / exporter / sync) for pm-cli
//
// Capabilities (see manifest.json):
//   commands   — `pm gh-issues import` (legacy) + `pm github sync`
//   importers  — `pm github import <owner/repo>` (idempotent native import)
//   exporters  — `pm github export` (render pm items as a GitHub-issues payload)
//   schema     — declares github_url / github_number / github_state item fields
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
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments?: number;
  comments_url?: string;
  pull_request?: unknown;
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

function mapState(state: string): string {
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

function readPmItems(pmRoot: string): PmItem[] {
  // `--full --include-body` so tags and body survive the read instead of the
  // brief projection (which omits them).
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list", "--full", "--include-body", "--limit", "10000"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list failed");
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
    return items as PmItem[];
  } catch {
    throw new CommandError("Could not parse `pm list --json` output.");
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

// Apply the client-side filters (PRs, milestone-by-title).
export function applyClientFilters(issues: GhIssue[], opts: ImportOptions): GhIssue[] {
  let result = issues;
  if (!opts.includePrs) result = result.filter((i) => !i.pull_request);
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
  return {
    state,
    labels: optionString(options, "labels"),
    since: optionString(options, "since"),
    assignee: optionString(options, "assignee"),
    milestone: optionString(options, "milestone"),
    includePrs: optionEnabled(options, "include-prs", "includePrs"),
    withComments: optionEnabled(options, "with-comments", "withComments"),
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
        "[--milestone <name>] [--include-prs] [--with-comments]",
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
    const tags = [...labels, tag];
    const status = mapState(issue.state);
    const assignee = issue.assignee?.login;
    const milestone = issue.milestone?.title;
    const key = `${repo.toLowerCase()}#${issue.number}`;
    const match = existing.get(key);

    // GitHub provenance lives in the description (human-readable) and the
    // declared schema fields (github_url/github_number/github_state).
    const description = `GH ${kind} #${issue.number}: ${issue.html_url}`;

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

  if (!repo || !repo.includes("/")) {
    throw new CommandError(
      "Usage: pm github sync --repo <owner/repo> [--dry-run]  " +
        "(pushes pm item status to the linked GitHub issue: close/reopen)",
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

  const items = readPmItems(ctx.pm_root);
  const plan = planSync(items, repo);

  if (plan.length === 0) {
    console.error(`No pm items linked to ${repo} (no \`gh:${repo.toLowerCase()}#N\` provenance tags).`);
    return { synced: 0, skipped: 0, planned: 0 };
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
    return { dryRun: true, wouldSync: synced, skipped, planned: plan.length };
  }
  console.error(`Synced ${synced} issue(s) on ${repo}; skipped ${skipped}.`);
  return { synced, skipped, planned: plan.length };
}

// ---------------------------------------------------------------------------
// Export core — render pm items as a GitHub-issues payload
// ---------------------------------------------------------------------------

function itemToGithubPayload(item: PmItem) {
  return {
    title: item.title ?? "(untitled)",
    body: item.body || item.description || "",
    // Drop our internal provenance tags from exported labels.
    labels: (item.tags ?? []).filter((t) => !parseProvenanceTag(t)),
    state: item.status === "closed" || item.status === "canceled" ? "closed" : "open",
  };
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
  if (cmd === "github export") return optionEnabled(options, "push");
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
  { long: "--since", value_name: "iso", description: "Only issues updated after this ISO timestamp (incremental sync)" },
  { long: "--assignee", value_name: "login", description: "Filter by assignee login" },
  { long: "--milestone", value_name: "name", description: "Filter by milestone title" },
  { long: "--include-prs", description: "Include pull requests (default: skip PRs)" },
  { long: "--with-comments", description: "Fetch issue comments and append them to the item body" },
  { long: "--dry-run", description: "Preview without writing" },
  { long: "--type", value_name: "type", description: "Override pm item type (default: Issue)" },
];

const SYNC_FLAGS = [
  { long: "--repo", value_name: "owner/repo", description: "Target GitHub repo (required)" },
  { long: "--dry-run", description: "Preview the close/reopen plan without mutating GitHub" },
];

export default defineExtension({
  name: "pm-github",
  version: "2026.6.2",

  activate(api: any) {
    // -----------------------------------------------------------------------
    // schema — declare the GitHub provenance fields so the workspace knows them
    // -----------------------------------------------------------------------
    api.registerItemFields([
      { name: "github_url", type: "string", optional: true },
      { name: "github_number", type: "number", optional: true },
      { name: "github_state", type: "string", optional: true },
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

    // -----------------------------------------------------------------------
    // exporter — `pm github export` (render pm items as a GitHub-issues payload)
    // Default: print JSON payload (or markdown with --format md). With --push
    // AND a token AND --repo <owner/repo>, create the issues on GitHub.
    // -----------------------------------------------------------------------
    api.registerExporter("github", async (ctx: any) => {
      const options = ctx.options || {};
      const format = optionString(options, "format") || "json";
      const items = readPmItems(ctx.pm_root);
      const payloads = items.map(itemToGithubPayload);

      const push = optionEnabled(options, "push");
      const repo = optionString(options, "repo") || ctx.args?.[0];

      if (push) {
        const token = resolveGitHubToken();
        if (!token) {
          throw new CommandError(
            "--push requires a GitHub token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).",
            EXIT_CODE.USAGE,
          );
        }
        if (!repo || !repo.includes("/")) {
          throw new CommandError("--push requires --repo <owner/repo>.", EXIT_CODE.USAGE);
        }
        let created = 0;
        for (const payload of payloads) {
          await request(
            "POST",
            `https://api.github.com/repos/${repo}/issues`,
            token,
            JSON.stringify({ title: payload.title, body: payload.body, labels: payload.labels }),
          );
          created++;
        }
        console.error(`Created ${created} issue(s) on ${repo}.`);
        return { pushed: true, created };
      }

      if (format === "md" || format === "markdown") {
        const md = payloads
          .map((p) => `## ${p.title}\n\n${p.body}\n\n_labels: ${p.labels.join(", ")} · state: ${p.state}_\n`)
          .join("\n");
        console.log(md);
        return { exported: payloads.length, format: "markdown" };
      }

      console.log(JSON.stringify(payloads, null, 2));
      return { exported: payloads.length, format: "json" };
    });

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
        "pm github sync --repo unbraind/pm-cli",
      ],
      flags: SYNC_FLAGS,
      failure_hints: [
        "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (sync mutates remote issues).",
        "Pass --repo <owner/repo> explicitly; sync never guesses the target repo.",
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
  },
});

// pm-github — GitHub Issues importer/exporter for pm-cli
//
// Capabilities (see manifest.json):
//   commands  — `pm gh-issues import` (legacy, full-featured)
//   importers — `pm github import <owner/repo>` (native import pipeline)
//   exporters — `pm github export` (render pm items as a GitHub-issues payload)
//   schema    — declares github_url / github_number / github_state item fields
//   hooks     — afterCommand: opt-in sync hints for github-linked items

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
  pull_request?: unknown;
}

interface ImportOptions {
  state: "open" | "closed" | "all";
  labels?: string;
  since?: string;
  assignee?: string;
  milestone?: string;
  includePrs: boolean;
  itemType: string;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchResult {
  body: string;
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

function request(
  method: string,
  url: string,
  token: string | undefined,
  payload?: string,
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "pm-github",
      Accept: "application/vnd.github+json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = https.request(url, { method, headers }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        request(method, res.headers.location, token, payload).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (status < 200 || status >= 300) {
          reject(new Error(`GitHub API returned HTTP ${status}`));
          return;
        }
        resolve({
          body,
          linkHeader: typeof res.headers.link === "string" ? res.headers.link : undefined,
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
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
    itemType: optionString(options, "type") || "Issue",
    dryRun: optionEnabled(options, "dry-run", "dryRun"),
  };
}

// Run the full import flow. Returns a structured result; throws CommandError
// (with a semantic exitCode) on failure so the CLI exits non-zero exactly once.
async function runImport(repoArg: string | undefined, pmRoot: string, opts: ImportOptions) {
  if (!repoArg || !repoArg.includes("/")) {
    throw new CommandError(
      "Usage: pm github import <owner/repo> [--all|--state open|closed|all] " +
        "[--labels bug,enhancement] [--since <iso>] [--assignee <login>] " +
        "[--milestone <name>] [--include-prs]",
      EXIT_CODE.USAGE,
    );
  }

  const token = resolveGitHubToken();
  console.error(
    `Fetching issues from ${repoArg}…${token ? "" : " (unauthenticated — 60 req/hr)"}`,
  );

  let fetched: GhIssue[];
  try {
    fetched = await fetchAllIssues(repoArg, opts, token);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = !token && /HTTP 403/.test(msg)
      ? " — set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise the rate limit (60→5000/hr) and reach private repos"
      : "";
    const exitCode = /HTTP 404/.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to fetch issues from ${repoArg}: ${msg}${hint}`, exitCode);
  }

  const filtered = applyClientFilters(fetched, opts);

  if (filtered.length === 0) {
    console.error("No issues found.");
    return { imported: 0, skipped: 0 };
  }

  console.error(`Found ${filtered.length} issue(s).`);

  let imported = 0;
  let skipped = 0;

  for (const issue of filtered) {
    const title = issue.title.trim();
    if (!title) {
      skipped++;
      continue;
    }

    const kind = issue.pull_request ? "PR" : "issue";
    const tags = issue.labels.map((l) => l.name);
    const status = mapState(issue.state);
    const body = issue.body || "";
    // Persist GitHub provenance in the description so it survives round-trips
    // and powers `pm github export` + the afterCommand sync hint.
    const description = `GH ${kind} #${issue.number}: ${issue.html_url}`;
    const assignee = issue.assignee?.login;
    const milestone = issue.milestone?.title;

    if (opts.dryRun) {
      console.error(`  [dry-run] #${issue.number} ${title} (${status}, ${tags.join(",")})`);
      imported++;
      continue;
    }

    try {
      const spawnArgs = [
        "--path", pmRoot,
        "create",
        "--title", title,
        "--type", opts.itemType,
        "--status", status,
        "--description", description,
        "--body", body,
        "--tags", tags.join(","),
        "--message", `Imported from GitHub #${issue.number}`,
      ];
      if (assignee) spawnArgs.push("--assignee", assignee);
      if (milestone) spawnArgs.push("--sprint", milestone);

      const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || "pm create failed");
      }
      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`#${issue.number}: create failed — ${msg}`);
      skipped++;
    }
  }

  if (opts.dryRun) {
    console.error(`[dry-run] Would import ${imported}, skip ${skipped}.`);
    return { dryRun: true, wouldImport: imported, wouldSkip: skipped };
  }

  console.error(`Imported ${imported} issue(s), skipped ${skipped}.`);
  if (imported === 0 && skipped > 0) {
    throw new CommandError(`Imported 0 issue(s); ${skipped} failed.`);
  }
  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Export core — render pm items as a GitHub-issues payload
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
  // `--full --include-body` so tags and body survive the export instead of the
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

function itemToGithubPayload(item: PmItem) {
  return {
    title: item.title ?? "(untitled)",
    body: item.body || item.description || "",
    labels: item.tags ?? [],
    state: item.status === "closed" || item.status === "canceled" ? "closed" : "open",
  };
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
  { long: "--dry-run", description: "Preview without writing" },
  { long: "--type", value_name: "type", description: "Override pm item type (default: Issue)" },
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
    // importer — `pm github import <owner/repo>` (native import pipeline)
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
    // hooks — opt-in sync reminder for github-linked items
    // Safe + no network: only emits a hint, and only when PM_GITHUB_SYNC is set.
    // -----------------------------------------------------------------------
    api.hooks.afterCommand((ctx: any) => {
      if (!process.env.PM_GITHUB_SYNC) return;
      if (!ctx.ok) return;
      if (ctx.command === "close" || ctx.command === "update") {
        console.error(
          "[pm-github] item changed — if it is linked to a GitHub issue, " +
            "remember to sync the upstream issue (PM_GITHUB_SYNC hint).",
        );
      }
    });

    // -----------------------------------------------------------------------
    // command — legacy `pm gh-issues import <owner/repo>` (delegates to core)
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "gh-issues import",
      description:
        "Fetch GitHub issues from a repo and create pm items. " +
        "Skips pull requests by default. Uses GITHUB_TOKEN/GH_TOKEN (or the " +
        "authenticated gh CLI) when available for 5000 req/hr and private repos; " +
        "falls back to the unauthenticated API (60 req/hr). " +
        "Equivalent to `pm github import`.",
      intent: "import GitHub issues as pm items",
      examples: [
        "pm gh-issues import unbraind/pm-cli",
        "pm gh-issues import unbraind/pm-cli --all",
        "pm gh-issues import unbraind/pm-cli --labels bug,enhancement",
        "pm gh-issues import unbraind/pm-cli --since 2026-01-01T00:00:00Z",
        "pm github import owner/repo --dry-run",
      ],
      flags: IMPORT_FLAGS,
      async run(ctx: any) {
        return runImport(ctx.args[0], ctx.pm_root, parseImportOptions(ctx.options));
      },
    });
  },
});

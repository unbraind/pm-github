// pm-github — GitHub Issues importer for pm-cli

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchJSON(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "pm-github",
        Accept: "application/vnd.github.v3+json",
      },
    }, (res) => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location) {
        fetchJSON(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function mapState(state: string): string {
  return state === "closed" ? "closed" : "open";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-github",
  version: "0.1.0",

  activate(api: any) {
    // -----------------------------------------------------------------------
    // Command: pm gh-issues import <owner/repo>
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "gh-issues import",
      description:
        "Fetch GitHub issues from a repo and create pm items. " +
        "Skips pull requests by default. Uses unauthenticated API (rate-limited to 60 req/hr).",
      intent: "import GitHub issues as pm items",
      examples: [
        "pm gh-issues import unbraind/pm-cli",
        "pm gh-issues import unbraind/pm-cli --all",
        "pm gh-issues import unbraind/pm-cli --labels bug,enhancement",
        "pm gh-issues import owner/repo --dry-run",
      ],
      flags: [
        { long: "--all", description: "Include closed issues (default: open only)" },
        { long: "--labels", value_name: "labels", description: "Comma-separated label filter" },
        { long: "--dry-run", description: "Preview without writing" },
        { long: "--type", value_name: "type", description: "Override pm item type (default: Issue)" },
      ],
      async run(ctx: any) {
        const repoArg = ctx.args[0] as string | undefined;
        if (!repoArg || !repoArg.includes("/")) {
          console.error("Usage: pm gh-issues import <owner/repo> [--all] [--labels bug,enhancement]");
          return { error: "Expected owner/repo argument" };
        }

        const includeAll = Boolean(ctx.options["all"]);
        const labelsFilter = ctx.options["labels"] as string | undefined;
        const dryRun = Boolean(ctx.options["dry-run"]);
        const itemType = (ctx.options["type"] as string) || "Issue";

        const state = includeAll ? "all" : "open";
        let url = `https://api.github.com/repos/${repoArg}/issues?state=${state}&per_page=100`;
        if (labelsFilter) {
          url += `&labels=${encodeURIComponent(labelsFilter)}`;
        }

        console.error(`Fetching issues from ${repoArg}…`);

        let raw: string;
        try {
          raw = await fetchJSON(url);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to fetch: ${msg}`);
          return { error: msg };
        }

        let issues: GhIssue[];
        try {
          issues = JSON.parse(raw);
        } catch {
          console.error("Invalid JSON response from GitHub.");
          return { error: "Invalid GitHub API response" };
        }

        // Filter out PRs
        const filtered = issues.filter((i) => !i.pull_request);

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

          const tags = issue.labels.map((l) => l.name);
          const status = mapState(issue.state);
          const body = issue.body || "";
          const description = `GH #${issue.number}: ${issue.html_url}`;
          const assignee = issue.assignee?.login;
          const milestone = issue.milestone?.title;

          if (dryRun) {
            console.error(`  [dry-run] #${issue.number} ${title} (${status}, ${tags.join(",")})`);
            imported++;
            continue;
          }

          try {
            const spawnArgs = [
              "--path", ctx.pm_root,
              "create",
              "--title", title,
              "--type", itemType,
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

        if (dryRun) {
          console.error(`[dry-run] Would import ${imported}, skip ${skipped}.`);
          return { dryRun: true, wouldImport: imported, wouldSkip: skipped };
        }

        console.error(`Imported ${imported} issue(s), skipped ${skipped}.`);
        return { imported, skipped };
      },
    });
  },
});

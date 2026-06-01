// pm-github — GitHub Issues importer for pm-cli
import https from "node:https";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
// Resolve a GitHub token so the importer is not stuck on the 60 req/hr
// unauthenticated quota and can read private repos. Order: explicit env vars,
// then the locally authenticated `gh` CLI if present.
export function resolveGitHubToken() {
    const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (envToken && envToken.trim())
        return envToken.trim();
    try {
        const result = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
        if (result.status === 0) {
            const token = result.stdout.trim();
            if (token)
                return token;
        }
    }
    catch {
        // gh not installed — fall back to unauthenticated requests.
    }
    return undefined;
}
function fetchJSON(url, token) {
    return new Promise((resolve, reject) => {
        const headers = {
            "User-Agent": "pm-github",
            Accept: "application/vnd.github+json",
        };
        if (token)
            headers.Authorization = `Bearer ${token}`;
        const req = https.get(url, { headers }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                fetchJSON(res.headers.location, token).then(resolve, reject);
                return;
            }
            if (status !== 200) {
                res.resume();
                reject(new Error(`GitHub API returned HTTP ${status}`));
                return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({
                body: Buffer.concat(chunks).toString("utf-8"),
                linkHeader: typeof res.headers.link === "string" ? res.headers.link : undefined,
            }));
        });
        req.on("error", reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error("timeout")); });
    });
}
// Follow GitHub's RFC 5988 Link header so repos with more than one page of
// issues are fully imported instead of silently truncated at per_page.
export function parseNextLink(linkHeader) {
    if (!linkHeader)
        return undefined;
    for (const part of linkHeader.split(",")) {
        const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
        if (match)
            return match[1];
    }
    return undefined;
}
function mapState(state) {
    return state === "closed" ? "closed" : "open";
}
// Flags may arrive under their kebab-case (`dry-run`) or camelCase (`dryRun`)
// key depending on runtime normalization, so check every candidate.
export function optionEnabled(options, ...keys) {
    return keys.some((k) => {
        const v = options[k];
        return v === true || v === "true" || v === "1";
    });
}
export function optionString(options, ...keys) {
    for (const k of keys) {
        const v = options[k];
        if (typeof v === "string" && v.trim().length > 0)
            return v.trim();
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
};
export class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-github",
    version: "2026.6.1",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm gh-issues import <owner/repo>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "gh-issues import",
            description: "Fetch GitHub issues from a repo and create pm items. " +
                "Skips pull requests by default. Uses GITHUB_TOKEN/GH_TOKEN (or the " +
                "authenticated gh CLI) when available for 5000 req/hr and private repos; " +
                "falls back to the unauthenticated API (60 req/hr).",
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
            async run(ctx) {
                const repoArg = ctx.args[0];
                if (!repoArg || !repoArg.includes("/")) {
                    // Throw with a USAGE exit code so the CLI exits non-zero AND the
                    // runtime treats the command as handled (a returned { error } reads
                    // as success; a plain Error triggers a second handler invocation).
                    throw new CommandError("Usage: pm gh-issues import <owner/repo> [--all] [--labels bug,enhancement]", EXIT_CODE.USAGE);
                }
                const includeAll = optionEnabled(ctx.options, "all");
                const labelsFilter = optionString(ctx.options, "labels");
                // Read both kebab and camelCase keys — the runtime may normalize
                // "--dry-run" to "dryRun", and reading only "dry-run" silently ignored
                // the flag (writing items even in preview mode).
                const dryRun = optionEnabled(ctx.options, "dry-run", "dryRun");
                const itemType = optionString(ctx.options, "type") || "Issue";
                const state = includeAll ? "all" : "open";
                let url = `https://api.github.com/repos/${repoArg}/issues?state=${state}&per_page=100`;
                if (labelsFilter) {
                    url += `&labels=${encodeURIComponent(labelsFilter)}`;
                }
                const token = resolveGitHubToken();
                console.error(`Fetching issues from ${repoArg}…${token ? "" : " (unauthenticated — 60 req/hr)"}`);
                const issues = [];
                let nextUrl = url;
                try {
                    while (nextUrl) {
                        const { body, linkHeader } = await fetchJSON(nextUrl, token);
                        let page;
                        try {
                            page = JSON.parse(body);
                        }
                        catch {
                            throw new Error("Invalid JSON response from GitHub.");
                        }
                        if (!Array.isArray(page)) {
                            throw new Error("Unexpected GitHub API response (expected an array of issues).");
                        }
                        issues.push(...page);
                        nextUrl = parseNextLink(linkHeader);
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const hint = !token && /HTTP 403/.test(msg)
                        ? " — set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise the rate limit (60→5000/hr) and reach private repos"
                        : "";
                    // Throw so the CLI exits non-zero on a failed fetch. A 404 maps to
                    // NOT_FOUND; everything else (403, 5xx, timeouts) is a generic failure.
                    const exitCode = /HTTP 404/.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
                    throw new CommandError(`Failed to fetch issues from ${repoArg}: ${msg}${hint}`, exitCode);
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
                        if (assignee)
                            spawnArgs.push("--assignee", assignee);
                        if (milestone)
                            spawnArgs.push("--sprint", milestone);
                        const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                        if (result.status !== 0) {
                            throw new Error(result.stderr || "pm create failed");
                        }
                        imported++;
                    }
                    catch (err) {
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
                if (imported === 0 && skipped > 0) {
                    // Every create failed — surface as a non-zero exit for automation.
                    throw new CommandError(`Imported 0 issue(s); ${skipped} failed.`);
                }
                return { imported, skipped };
            },
        });
    },
});
//# sourceMappingURL=index.js.map
interface GhIssue {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    labels: Array<{
        name: string;
    }>;
    user?: {
        login: string;
    } | null;
    assignee: {
        login: string;
    } | null;
    milestone: {
        title: string;
    } | null;
    created_at: string;
    updated_at: string;
    html_url: string;
    comments?: number;
    comments_url?: string;
    pull_request?: unknown;
    draft?: boolean;
}
interface GhComment {
    user: {
        login: string;
    } | null;
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
export declare function resolveGitHubToken(): string | undefined;
export declare function computeBackoffMs(headers: Record<string, string | string[] | undefined>, attempt: number, nowMs?: number): number;
export interface RateLimitInfo {
    remaining?: number;
    limit?: number;
    reset?: number;
    /** True when the remaining quota is at/under the low-water mark. */
    low: boolean;
}
export declare function parseRateLimit(headers: Record<string, string | string[] | undefined>, lowThreshold?: number): RateLimitInfo;
export declare function formatRateLimit(info: RateLimitInfo): string | undefined;
export declare function parseNextLink(linkHeader?: string): string | undefined;
export declare function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean;
export declare function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined;
export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
};
export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
export declare function provenanceTag(repo: string, issueNumber: number): string;
export declare function parseProvenanceTag(tag: string): {
    repo: string;
    number: number;
} | undefined;
export declare function authorTag(issue: GhIssue): string | undefined;
interface PmItem {
    id?: string;
    title?: string;
    status?: string;
    body?: string;
    description?: string;
    tags?: string[];
}
export declare function indexByProvenance(items: PmItem[]): Map<string, PmItem>;
export declare function buildIssuesUrl(repo: string, opts: ImportOptions): string;
export declare function composeBody(issue: GhIssue, comments: GhComment[]): string;
export declare function isDraftPr(issue: GhIssue): boolean;
export declare function applyClientFilters(issues: GhIssue[], opts: ImportOptions): GhIssue[];
export declare function parseImportOptions(options: Record<string, unknown>): ImportOptions;
export interface SyncPlanEntry {
    id: string;
    number: number;
    title: string;
    from: "open" | "closed";
    to: "open" | "closed";
}
export declare function planSync(items: PmItem[], repo: string): SyncPlanEntry[];
export interface GithubExportPayload {
    title: string;
    body: string;
    labels: string[];
    state: "open" | "closed";
}
export interface ExportPlanEntry {
    id?: string;
    action: "create" | "update";
    number?: number;
    payload: GithubExportPayload;
}
export declare function buildExportPlan(items: PmItem[], repo: string | undefined): ExportPlanEntry[];
export declare function exportWillApply(options: Record<string, unknown>): boolean;
export declare function buildSearchUrl(repo: string, query: string): string;
export declare function mapSearchHits(matchedNumbers: number[], repo: string, itemsByProvenance: Map<string, PmItem>): Array<{
    id: string;
    score: number;
    matched_fields: string[];
}>;
export declare function resolveSearchRepo(options: Record<string, unknown>): string | undefined;
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
export declare function isMutatingGithubCommand(command: string, options: Record<string, unknown>): boolean;
declare const _default: {
    name: string;
    version: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map
interface GhIssue {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    labels: Array<{
        name: string;
    }>;
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
    withComments: boolean;
    itemType: string;
    dryRun: boolean;
}
export declare function resolveGitHubToken(): string | undefined;
export declare function computeBackoffMs(headers: Record<string, string | string[] | undefined>, attempt: number, nowMs?: number): number;
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
export declare function isMutatingGithubCommand(command: string, options: Record<string, unknown>): boolean;
declare const _default: {
    name: string;
    version: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map
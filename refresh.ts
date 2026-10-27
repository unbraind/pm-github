import { ownValue } from "./own-record.ts";
import { importTagValues } from "./import-tags.ts";
/** Refresh an explicit local GitHub mirror through the importer's existing mapping and transaction. */
import { mkdtemp, cp, rm, chmod, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { listAllComplete, certifyCompleteListResult, previewItemMutations } from "@unbrained/pm-cli/sdk";
import {
  CommandError, EXIT_CODE, decodeCompletePmItems, githubGraphQLResponse, importGithubAtomic,
  listUnfinishedGithubImports, parseImportOptions, parseProvenanceTag, prepareGithubImport, readGithubImportPlan,
  resolveGitHubToken, resumeGithubImport, validateGithubImportFidelity, validateGithubImportPlan,
  type GhIssue, type PmItem, type PreparedGithubImport,
} from "./index.ts";
import { fetchImportTimeline, importFidelityFields, normalizeImportValue, readImportReleases } from "./import-fidelity.ts";

/** An existing item and its unique linked issue number. */
export interface RefreshTarget { id: string; number: number; item: PmItem }
/** A machine-readable field delta; null means absent. */
export interface RefreshChange { field: string; old: unknown; new: unknown }
/** Per-item result, including non-destructive failures. */
export interface RefreshEntry {
  id: string;
  number: number;
  changes: RefreshChange[];
  reason?: "not_found_or_inaccessible" | "inaccessible" | "transferred" | "api_error" | "incomplete_response" | "invalid_issue";
}

/** Select only explicit provenance, refusing conflicting links and duplicate local owners. */
export function selectRefreshTargets(items: readonly PmItem[], repo: string): RefreshTarget[] {
  const targets = new Map<number, RefreshTarget>();
  for (const item of items) {
    if (!item.id) continue;
    const numbers = new Set<number>();
    for (const tag of item.tags ?? []) {
      const parsed = parseProvenanceTag(tag);
      if (parsed?.repo === repo) numbers.add(parsed.number);
    }
    if (typeof item.github_url === "string") {
      // Only /issues/ locators are refreshable: the batch query reads issue(...)
      // nodes, so accepting /pull/ links would report every PR-linked item as
      // missing on each run.
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/i.exec(item.github_url);
      if (url?.[1]!.toLowerCase() === repo) numbers.add(Number(url[2]));
    }
    if (typeof item.github_repo === "string" && item.github_repo.toLowerCase() === repo && typeof item.github_number === "number") numbers.add(item.github_number);
    if (numbers.size > 1) throw new CommandError(`Refresh found conflicting GitHub identities for ${item.id}.`);
    for (const number of numbers) {
      if (!Number.isSafeInteger(number) || number < 1) throw new CommandError(`Refresh found an invalid issue number for ${item.id}.`);
      if (targets.has(number)) throw new CommandError(`Refresh found multiple existing owners for issue #${number}.`);
      targets.set(number, { id: item.id, number, item });
    }
  }
  return [...targets.values()].sort((a, b) => a.number - b.number);
}

/** Requested issue fields, projected to the REST-shaped shared import planner. */
interface RefreshNode {
  number: number; title: string; body: string; state: string; stateReason: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null; url: string;
  author: { login: string; __typename?: string } | null;
  labels: { nodes: Array<{ name: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

const ISSUE_FIELDS = `number title body state stateReason createdAt updatedAt closedAt url author { __typename login }
  labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } }`;

/** Fetch only the selected numbers, preserving partial failures and every label page. */
async function fetchRefreshBatch(repo: string, targets: readonly RefreshTarget[], token: string | undefined) {
  const [owner, name] = repo.split("/");
  const fields = targets.map(target => `i${target.number}: issue(number:${target.number}) { ${ISSUE_FIELDS} }`).join("\n");
  const response = await githubGraphQLResponse<{ repository: Record<string, RefreshNode | null> | null }>(token,
    `query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${fields} } }`, { owner, name });
  const results: Array<{ target: RefreshTarget; issue?: GhIssue; reason?: RefreshEntry["reason"] }> = [];
  for (const target of targets) {
    const alias = `i${target.number}`;
    const error = response.errors?.find(error => !error.path || (error.path[0] === "repository" && (error.path.length === 1 || error.path[1] === alias)));
    let reason: RefreshEntry["reason"];
    const node = ownValue(response.data!.repository, alias);
    if (error && error.type !== "NOT_FOUND") reason = error.type === "FORBIDDEN" ? "inaccessible" : "api_error";
    else if (response.data!.repository === null || node === null) reason = "not_found_or_inaccessible";
    else if (node === undefined) reason = "incomplete_response";
    else if (node.url.toLowerCase() !== `https://github.com/${repo}/issues/${target.number}`) reason = "transferred";
    else if (node.number !== target.number || !node.title.trim() || !["OPEN", "CLOSED"].includes(node.state)) reason = "invalid_issue";
    if (reason) { results.push({ target, reason }); continue; }
    const issue = node!;
    const labels = [...issue.labels.nodes];
    let page = issue.labels.pageInfo;
    const cursors = new Set<string>();
    while (page.hasNextPage) {
      if (!page.endCursor || cursors.has(page.endCursor)) throw new CommandError(`Refresh labels for issue #${target.number} have an invalid cursor.`);
      cursors.add(page.endCursor);
      const next = await githubGraphQLResponse<{ repository: { issue: { labels: RefreshNode["labels"] } | null } | null }>(token,
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String!) { repository(owner:$owner,name:$name) { issue(number:$number) { labels(first:100,after:$cursor) { nodes { name } pageInfo { hasNextPage endCursor } } } } }`,
        { owner, name, number: target.number, cursor: page.endCursor });
      // A repository or issue can vanish between requests (transfer or delete);
      // guard the connection so the host sees a CommandError, not a TypeError.
      const connection = next.data?.repository?.issue?.labels ?? null;
      if (next.errors?.length || connection === null) throw new CommandError(`Refresh could not read every label for issue #${target.number}.`);
      labels.push(...connection.nodes);
      page = connection.pageInfo;
    }
    results.push({ target, issue: {
      number: issue.number, title: issue.title, body: issue.body, state: issue.state.toLowerCase() as GhIssue["state"],
      state_reason: issue.stateReason?.toLowerCase() as GhIssue["state_reason"], labels,
      created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt,
      html_url: issue.url, user: issue.author ? { login: issue.author.__typename === "Bot" ? `${issue.author.login.replace(/\[bot\]$/i, "")}[bot]` : issue.author.login } : null,
      assignee: null, milestone: null,
    } });
  }
  return results;
}

/** Compare only refresh-owned fields; use the same source lifecycle projection as import finalization. */
export function refreshChanges(entry: PreparedGithubImport): RefreshChange[] {
  const desired = { ...importFidelityFields(entry.fidelity!, Boolean(entry.linkOnly)),
    ...(entry.linkOnly ? {} : { title: entry.title, status: entry.status }), tags: importTagValues(entry) };
  return Object.entries(desired).flatMap(([field, value]) => {
    const old = ownValue(entry.match, field) ?? null;
    const next = value ?? null;
    const equal = JSON.stringify(normalizeImportValue(field, old)) === JSON.stringify(normalizeImportValue(field, next));
    return equal ? [] : [{ field, old, new: next }];
  });
}

/** Isolate SDK-derived cache writes for offline diagnostics, previews and no-op applies. @internal */
export async function readRefreshItems(pmRoot: string): Promise<PmItem[]> {
  const scratch = await mkdtemp(join(tmpdir(), "pm-github-refresh-read-"));
  try {
    if (!(await lstat(pmRoot)).isDirectory()) throw new CommandError("Offline tracker reads need an ordinary tracker directory; replace a linked root with a regular copy.");
    const root = join(scratch, "pm");
    await cp(pmRoot, root, { recursive: true, filter: source => !["runtime", "locks", "github-webhooks", "extensions"].includes(basename(source)) });
    // Source permissions are retained by cp; only the disposable copy may host SDK caches.
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) throw new CommandError("Offline tracker reads refuse linked or special files; use an ordinary tracker copy.");
      await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
    }
    return decodeCompletePmItems(certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: root, noExtensions: true })));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Build a zero-create refresh plan, then commit changed existing targets with import transactions. */
export async function runRefresh(repoArg: string | undefined, pmRoot: string, options: Record<string, unknown>, scope?: { numbers: readonly number[] }) {
  if (!repoArg || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoArg)) throw new CommandError("Usage: pm github refresh <owner/repo> [--dry-run] [--since <date|relative>] [--limit N] [--atomic]", EXIT_CODE.USAGE);
  const repo = repoArg.toLowerCase();
  const opts = parseImportOptions(options);
  /** Selected targets bounded by the caller's --limit, in ascending order. */
  const bounded = (candidates: readonly RefreshTarget[]): RefreshTarget[] =>
    (opts.limit === undefined ? [...candidates] : candidates.slice(0, opts.limit)).filter(target => scope === undefined || scope.numbers.includes(target.number));
  let items = await readRefreshItems(pmRoot);
  let all = selectRefreshTargets(items, repo);
  let targets = bounded(all);
  const token = resolveGitHubToken();
  // Resume interrupted transactions for the selected targets BEFORE the
  // unchanged filter: a crash after finalization leaves linked items already
  // matching the source, so the pending journal would otherwise hide behind an
  // ordinary no-op report and never commit.
  const pending = (await listUnfinishedGithubImports(pmRoot))
    .filter(journal => !journal.itemIds.length || journal.itemIds.some(id => targets.some(target => target.id === id)));
  let resumed = 0;
  if (pending.length) {
    if (opts.dryRun) {
      throw new CommandError(`Refresh cannot preview while GitHub transaction ${pending.map(journal => journal.transactionId).join(", ")} is unfinished for selected linked items. Re-run without --dry-run to complete it.`);
    }
    // Validate the complete recovery set before the first transaction can write.
    const records = [];
    for (const journal of pending) {
      const record = await readGithubImportPlan(pmRoot, journal.transactionId);
      if (!record || record.transactionId !== journal.transactionId) {
        throw new CommandError(
          `Refresh found unfinished GitHub transaction ${journal.transactionId} (status ${journal.status}) for selected linked items, but its original plan is missing or mismatched. If it came from \`pm github import --atomic\`, re-run that import to resume it; otherwise resolve the durable journal at ${join(pmRoot, "transactions", "sdk", `${journal.transactionId}.json`)} manually; nothing was refreshed.`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      validateGithubImportPlan(record, items);
      if (record.repo.toLowerCase() !== repo) {
        throw new CommandError(`Refresh cannot replay GitHub transaction ${journal.transactionId} for ${record.repo} while refreshing ${repo}. Re-run refresh for ${record.repo} first; nothing was refreshed.`);
      }
      try {
        await previewItemMutations({ pmRoot, transactionId: record.transactionId, author: "pm-github", mutations: record.mutations });
      } catch {
        throw new CommandError(`Refresh cannot replay unfinished GitHub transaction ${journal.transactionId}: its persisted plan cannot resume the durable journal; nothing was refreshed.`);
      }
      records.push(record);
    }
    for (const record of records) {
      await resumeGithubImport(pmRoot, record);
      resumed++;
    }
    // The replay finalized the interrupted targets; re-read so this run
    // compares the committed state instead of the pre-replay snapshot.
    items = await readRefreshItems(pmRoot);
    all = selectRefreshTargets(items, repo);
    targets = bounded(all);
  }
  const plan: RefreshEntry[] = [];
  const prepared: PreparedGithubImport[] = [];
  let unchanged = 0;
  let missing = 0;
  let filtered = 0;
  const context = { items, releases: readImportReleases(pmRoot), timeline: fetchImportTimeline };
  for (let offset = 0; offset < targets.length; offset += 100) {
    const batch = await fetchRefreshBatch(repo, targets.slice(offset, offset + 100), token);
    for (const result of batch) {
      const row: RefreshEntry = { id: result.target.id, number: result.target.number, changes: [] };
      if (result.reason) { row.reason = result.reason; missing++; }
      else {
        const issue = result.issue!;
        if (opts.since && Date.parse(issue.updated_at) < Date.parse(opts.since)) { filtered++; continue; }
        const entry = (await prepareGithubImport(issue, repo, opts, token, result.target.item, undefined, context))!;
        row.changes = refreshChanges(entry);
        if (row.changes.length) prepared.push(entry);
        else unchanged++;
      }
      plan.push(row);
    }
  }
  // Validate all finalization projections even when applying one item at a time.
  for (const entry of prepared) validateGithubImportFidelity(entry, repo, `Refresh issue #${entry.issueNumber}`, items);
  if (!opts.dryRun && prepared.length) {
    if (opts.atomic) await importGithubAtomic(pmRoot, repo, prepared, { updateOnly: true });
    else for (const entry of prepared) await importGithubAtomic(pmRoot, repo, [entry], { updateOnly: true });
  }
  return { repo, dryRun: opts.dryRun, atomic: opts.atomic, selected: targets.length, filtered,
    unchanged, updated: prepared.length, missing, created: 0, resumed, plan };
}

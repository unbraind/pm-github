/** Close delivered tracker items using merged pull requests and head-check evidence. */
import { close, listAllComplete, certifyCompleteListResult, PmCliError } from "@unbrained/pm-cli/sdk";

/** Existing GitHub REST transport, supplied by the extension entry point. */
export interface CloseoutApi {
  base: string;
  get(url: string): Promise<{ body: string; linkHeader?: string }>;
  next(link?: string): string | undefined;
}

/** Stable machine-readable decision; reasons never quote pull-request prose. */
export interface CloseoutRow {
  item: string;
  pr: number;
  action: "close" | "skip";
  reason: string;
  code: CloseoutCode;
}

/** Stable decisions used by automation and compact skip counts. */
export type CloseoutCode = "already_terminal" | "other_repository" | "duplicate_selection" | "explicit_skip"
  | "unknown_item" | "epic" | "active_children" | "not_delivery" | "close_failed"
  | "head_checks_passed" | "head_checks_failed" | "head_evidence_unavailable" | "required_checks_unverified" | "incomplete_merge";

/** Which head-check policy was evaluated for one selected pull request. */
interface CheckGate {
  pr: number;
  code: CloseoutCode;
  rule: "required" | "declared" | "fallback" | "unavailable";
  reason: string;
  passed: string[];
  ok: boolean;
}

/** Fields retained from a pull request; its body is used only for extraction. */
interface PullRequest {
  number: number;
  body: string | null;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  head: { sha: string };
  base: { ref: string; repo: { full_name: string } };
}

/** A required context may be bound to a particular GitHub App. */
interface RequiredCheck { name: string; app: number | null }
/** Preserve readable requirements while recording a metadata gap or an empty policy. */
interface RequiredPolicy { checks: RequiredCheck[]; fallback: boolean; unavailable: boolean }
/** Only check-run facts used to decide whether a head passed. */
interface CheckRun { name: string; head_sha: string; status: string; conclusion: string | null; app: { id: number } }
/** Legacy commit statuses are newest first; only the latest per context counts. */
interface CommitStatus { context: string; state: string }

/** Reject non-object API payloads before reading safety-critical fields. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub evidence object.");
  return value as Record<string, unknown>;
}

/** Require nonempty API strings without coercing arbitrary values. */
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing GitHub evidence field.");
  return value;
}

/** Accept ISO dates or timestamps with a timezone, rejecting rolled calendar dates. */
function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error("--since and merge times must be valid ISO dates or timestamps with a timezone.");
  }
  return new Date(value).toISOString();
}

/** Normalize repeatable flags without silently dropping malformed members. */
function repeated(options: Record<string, unknown>, key: string): string[] {
  if (options[key] === undefined) return [];
  const values = Array.isArray(options[key]) ? options[key] : [options[key]];
  if (values.length === 0 || values.some(value => typeof value !== "string" || value.trim() === "")) throw new Error(`--${key} requires a value.`);
  return [...new Set((values as string[]).map(value => value.trim()))];
}

/** Parse one literal context per line, preserving spaces and ignoring blank lines. */
function requiredContexts(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some(entry => typeof entry !== "string")) throw new Error("--required-checks requires newline-separated context names.");
  return (values as string[]).flatMap(entry => entry.split("\n")).map(line => line.trim()).filter(Boolean);
}

/** Read one payload with the shared authenticated retry/redirect transport. */
async function payload(api: CloseoutApi, endpoint: string): Promise<unknown> {
  return JSON.parse((await api.get(`${api.base}${endpoint}`)).body) as unknown;
}

/** Drain same-endpoint pagination; reject cycles, foreign links and truncated totals. */
async function pages(api: CloseoutApi, endpoint: string, checks = false, done?: (row: unknown) => boolean): Promise<unknown[]> {
  let next: string | undefined = `${api.base}${endpoint}`;
  const initial = new URL(next);
  const seen = new Set<string>();
  const rows: unknown[] = [];
  let total: number | undefined;
  while (next) {
    const url = new URL(next);
    if (url.origin !== initial.origin || url.pathname !== initial.pathname || seen.has(next)) throw new Error("Unverifiable GitHub pagination.");
    seen.add(next);
    const response = await api.get(next);
    const value: unknown = JSON.parse(response.body);
    let page = value;
    if (checks) {
      const envelope = record(value);
      if (!Number.isSafeInteger(envelope.total_count) || Number(envelope.total_count) < 0) throw new Error("Missing check-run count.");
      if (total !== undefined && total !== envelope.total_count) throw new Error("Check-run count changed during pagination.");
      total = Number(envelope.total_count);
      page = envelope.check_runs;
    }
    if (!Array.isArray(page)) throw new Error("Incomplete GitHub evidence page.");
    rows.push(...page);
    // A caller-proven ordered listing can stop once a page reaches rows that can no longer match.
    next = done !== undefined && page.some(done) ? undefined : api.next(response.linkHeader);
  }
  if (total !== undefined && rows.length !== total) throw new Error("Incomplete check-run evidence.");
  return rows;
}

/** Decode the base-repository identity and retain only selected PR evidence. */
function pullRequest(value: unknown, repo: string, number: number): PullRequest {
  const raw = record(value);
  const base = record(raw.base);
  const baseRepo = record(base.repo);
  const head = record(raw.head);
  if (raw.number !== number || text(baseRepo.full_name).toLowerCase() !== repo.toLowerCase()
    || text(raw.html_url).toLowerCase() !== `https://github.com/${repo}/pull/${number}`.toLowerCase()
    || (raw.body !== null && typeof raw.body !== "string")) throw new Error("Pull-request identity or body is unverifiable.");
  return {
    number, body: raw.body as string | null, merged: raw.merged === true,
    merged_at: raw.merged_at as string | null, merge_commit_sha: raw.merge_commit_sha as string | null,
    html_url: raw.html_url as string, head: { sha: text(head.sha) },
    base: { ref: text(base.ref), repo: { full_name: baseRepo.full_name as string } },
  };
}

/** Require complete, well-formed merge facts before any check queries or writes. */
function mergeEvidence(pr: PullRequest): boolean {
  return pr.merged && typeof pr.merged_at === "string" && isoDate(pr.merged_at).length > 0
    && typeof pr.merge_commit_sha === "string" && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha)
    && /^[a-f0-9]{40}$/.test(pr.head.sha);
}

/** Treat only permission and not-found responses as protection metadata gaps. */
async function readProtectionSource<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (error: unknown) {
    if (error instanceof Error && /HTTP (403|404)$/.test(error.message)) return null;
    throw error;
  }
}

/** Combine all readable app-bound contexts without discarding known requirements. */
async function requirements(api: CloseoutApi, repo: string, branch: string): Promise<RequiredPolicy> {
  const classic = await readProtectionSource(async () => record(await payload(api, `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`)));
  const rules = await readProtectionSource(() => pages(api, `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`));
  const checks: RequiredCheck[] = [];
  if (classic !== null) {
    if (!Array.isArray(classic.contexts) || !Array.isArray(classic.checks)) throw new Error("Missing required-check definitions.");
    checks.push(...classic.checks.map(value => {
      const check = record(value);
      const app = check.app_id;
      if (app !== null && app !== undefined && (!Number.isSafeInteger(app) || Number(app) < -1)) throw new Error("Invalid required-check app.");
      return { name: text(check.context), app: typeof app === "number" && app >= 0 ? app : null };
    }));
    for (const context of classic.contexts) {
      const name = text(context);
      if (!checks.some(check => check.name === name)) checks.push({ name, app: null });
    }
  }
  for (const value of rules ?? []) {
    const rule = record(value);
    if (rule.type !== "required_status_checks") continue;
    const parameters = record(rule.parameters);
    if (!Array.isArray(parameters.required_status_checks)) throw new Error("Missing ruleset checks.");
    for (const value of parameters.required_status_checks) {
      const check = record(value);
      const app = check.integration_id;
      if (app !== null && app !== undefined && (!Number.isSafeInteger(app) || Number(app) < 0)) throw new Error("Invalid ruleset app.");
      checks.push({ name: text(check.context), app: typeof app === "number" ? app : null });
    }
  }
  return { checks, fallback: checks.length === 0, unavailable: classic === null || rules === null };
}

/** Verify metadata-backed or caller-declared requirements before considering observed head runs. */
export async function checkCloseoutHead(api: CloseoutApi, repo: string, pr: PullRequest, declared: string[] = []): Promise<CheckGate> {
  const result: CheckGate = { pr: pr.number, code: "head_evidence_unavailable", rule: "unavailable", reason: "Head check evidence unavailable or incomplete.", passed: [], ok: false };
  try {
    const policy = await requirements(api, repo, pr.base.ref);
    if (policy.unavailable) {
      if (declared.length === 0) {
        result.code = "required_checks_unverified";
        result.reason = "Required-check metadata unavailable; declare --required-checks to verify the required contexts.";
        return result;
      }
      policy.checks.push(...declared.map(name => ({ name, app: null })));
      policy.fallback = false;
    }
    result.rule = policy.unavailable ? "declared" : policy.fallback ? "fallback" : "required";
    const runs: CheckRun[] = (await pages(api, `/repos/${repo}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100`, true)).map(value => {
      const run = record(value);
      const app = record(run.app);
      if (run.head_sha !== pr.head.sha || !Number.isSafeInteger(app.id)
        || (run.conclusion !== null && typeof run.conclusion !== "string")) throw new Error("Invalid head check run.");
      return { name: text(run.name), head_sha: run.head_sha as string, status: text(run.status), conclusion: run.conclusion as string | null, app: { id: Number(app.id) } };
    });
    const statuses = new Map<string, CommitStatus>();
    for (const value of await pages(api, `/repos/${repo}/commits/${pr.head.sha}/statuses?per_page=100`)) {
      const status = record(value);
      const context = text(status.context);
      if (!statuses.has(context)) statuses.set(context, { context, state: text(status.state) });
    }
    result.code = "head_checks_failed";
    for (const check of policy.checks) {
      const matching = runs.filter(run => run.name === check.name && (check.app === null || run.app.id === check.app));
      const legacy = statuses.get(check.name);
      if (matching.length === 0 && (!legacy || check.app !== null)) { result.reason = `Required check missing at head: ${check.name}`; return result; }
      if (matching.some(run => run.status !== "completed" || run.conclusion !== "success") || (legacy && legacy.state !== "success")) {
        result.reason = `Required check did not conclude success at head: ${check.name}`;
        return result;
      }
    }
    if (!policy.fallback) {
      result.reason = policy.unavailable ? "Caller-declared checks concluded success; repository required-check metadata was unavailable."
        : "Required head checks concluded success (branch-protection and ruleset rule).";
    } else {
      if (runs.length === 0) { result.reason = "Fallback rule: no check runs at head; evidence missing."; return result; }
      if (runs.some(run => run.status !== "completed" || !["success", "neutral", "skipped"].includes(String(run.conclusion)))
        || [...statuses.values()].some(status => status.state !== "success")) {
        result.reason = "Fallback rule: every head run must be completed with success, neutral or skipped, and head statuses must succeed.";
        return result;
      }
      result.reason = "Fallback rule: protection metadata is readable with no required contexts; every head run completed with success, neutral or skipped; head statuses succeeded.";
    }
    result.passed = [...new Set([...runs.filter(run => run.status === "completed" && run.conclusion === "success").map(run => run.name),
      ...[...statuses.values()].filter(status => status.state === "success").map(status => status.context)])].sort();
    result.code = "head_checks_passed";
    result.ok = true;
  } catch {
    result.code = "head_evidence_unavailable";
    // Never echo an API body, exception payload, PR body or comment into the report.
  }
  return result;
}

/** Statuses that already ended an item's lifecycle. */
const TERMINAL_STATUSES: readonly string[] = ["closed", "canceled"];

/** GitHub-style closing keywords that declare delivery of the link they directly precede. */
const CLOSING_KEYWORDS = new Set(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "deliver", "delivers", "delivered"]);

/**
 * Whether a closing keyword directly precedes a link, given the line text before the link.
 *
 * Only earlier links (markdown or bare), commas and "and" may sit between the keyword and the link, so
 * `Delivers [a](…) and [b](…)` declares both while `Not fixed here; see <link>` declares nothing.
 * Scans backwards with plain string operations; no backtracking pattern touches PR text.
 */
export function declaresDelivery(prefix: string): boolean {
  let rest = prefix;
  // The link may be the target of a markdown label: `Closes [pm-x](`.
  if (rest.endsWith("](")) rest = rest.slice(0, Math.max(0, rest.lastIndexOf("[")));
  for (;;) {
    rest = rest.trimEnd();
    if (rest.endsWith(",")) { rest = rest.slice(0, -1); continue; }
    if (rest.endsWith(")")) {
      // Skip one earlier markdown link `[label](url)`; any other parenthetical ends the scan.
      const target = rest.lastIndexOf("](");
      const label = target < 0 ? -1 : rest.lastIndexOf("[", target);
      if (label < 0 || /\s/.test(rest.slice(target + 2, -1))) return false;
      rest = rest.slice(0, label);
      continue;
    }
    const cut = Math.max(rest.lastIndexOf(" "), rest.lastIndexOf("\t")) + 1;
    const word = rest.slice(cut);
    if (word.toLowerCase() === "and" || word.startsWith("https://")) { rest = rest.slice(0, cut); continue; }
    let bare = word;
    while (bare.endsWith(":") || bare.endsWith("*") || bare.endsWith("_")) bare = bare.slice(0, -1);
    while (bare.startsWith("*") || bare.startsWith("_")) bare = bare.slice(1);
    return CLOSING_KEYWORDS.has(bare.toLowerCase());
  }
}

/** Extract only canonical tracker links, retaining foreign references solely for skip rows. */
export function extractCloseoutItems(body: string): { item: string; repo: string; declared: boolean }[] {
  const links = body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/blob\/main\/\.agents\/pm\/((?:[^/\s?#<>)\]"']+\/)+)([^/\s?#<>)\]"']+)\.toon(?=$|[\s?#<>)\]"'])/g);
  const seen = new Set<string>();
  const refs: { key: string; repo: string; item: string; declared: boolean }[] = [];
  return [...links].flatMap(match => {
    let components: string[];
    try {
      components = [...match[2]!.slice(0, -1).split("/"), match[3]!].map(decodeURIComponent);
    } catch { return []; }
    if (components.some(component => /^\.{1,2}$|[/\\\0]/.test(component))) return [];
    const item = components.at(-1)!;
    const key = `${match[1]!.toLowerCase()}/${item}`;
    const declared = declaresDelivery(body.slice(body.lastIndexOf("\n", match.index) + 1, match.index));
    if (seen.has(key)) {
      // A later "Closes <link>" line still declares an item an earlier line only mentioned.
      if (declared) for (const entry of refs) if (entry.key === key) entry.declared = true;
      return [];
    }
    seen.add(key);
    const entry = { key, repo: match[1]!, item, declared };
    refs.push(entry);
    return [entry];
  }).map(({ repo, item, declared }) => ({ repo, item, declared }));
}

/** Render only the allowed GitHub facts; never include body, title or comment text. */
function closeReason(pr: PullRequest, passed: string[]): string {
  return JSON.stringify({ pr: pr.number, url: pr.html_url, merge_commit_sha: pr.merge_commit_sha,
    head_sha: pr.head.sha, merged_at: pr.merged_at, checks: passed });
}

/** Report SDK refusal codes without exposing paths, identities or arbitrary error prose. */
export function closeoutFailureReason(error: unknown): string {
  if (error instanceof PmCliError) {
    const code = error.code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code)) return `SDK close refused: ${code}.`;
    return `SDK close refused (exit ${error.exitCode}).`;
  }
  return "SDK close failed (unclassified error).";
}

/** Invalid selectors or repository input: the caller must change the command, so the host maps it to a usage exit. */
export class CloseoutUsageError extends Error {}

/** Re-throw a selector parser's failure as a usage error. */
function usage<T>(parse: () => T): T {
  try { return parse(); } catch (error) { throw new CloseoutUsageError((error as Error).message); }
}

/**
 * Describe the verified check evidence for a passed gate without overstating it.
 *
 * The required rule reports required-check success; the declared rule reports caller-declared success
 * and unavailable repository metadata. Both list every successful head check (optional ones included).
 * The fallback rule (fully readable metadata with no required contexts)
 * may pass on neutral or skipped runs alone, so it states that policy and lists successful checks only when any exist.
 */
export function checkEvidence(gate: CheckGate): string {
  // gate.passed holds every successful head check, optional ones included, so it is never labelled as the required set.
  if (gate.rule === "declared") return `caller-declared checks concluded success; repository required-check metadata was unavailable; successful head checks: ${gate.passed.join(", ")}`;
  if (gate.rule === "required") return `required checks satisfied; successful head checks: ${gate.passed.join(", ")}`;
  const successes = gate.passed.length > 0 ? `successful checks: ${gate.passed.join(", ")}` : "no check reported success";
  return `no readable required checks, so every completed head check run had to succeed, be neutral or be skipped; ${successes}`;
}

/** Plan all selected PRs before closing eligible items through the real SDK. */
export async function runCloseout(pmRoot: string, repo: string | undefined, options: Record<string, unknown>, api: CloseoutApi) {
  if (!repo || !/^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(repo)) throw new CloseoutUsageError("closeout requires --repo owner/repo or PM_GITHUB_REPO.");
  const numbers = usage(() => repeated(options, "pr")).map(value => {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CloseoutUsageError("--pr requires positive pull-request numbers.");
    return Number(value);
  });
  const since = options.since === undefined ? undefined : usage(() => isoDate(text(options.since)));
  if ((numbers.length === 0) === (since === undefined)) throw new CloseoutUsageError("Select either repeatable --pr <n> or --since <ISO date>.");
  const declared = usage(() => requiredContexts(options["required-checks"] ?? options.requiredChecks));
  const skip = new Set(usage(() => repeated(options, "skip")));
  const apply = options.apply === true && options["dry-run"] !== true && options.dryRun !== true;
  if (since !== undefined) {
    // Rows arrive newest-updated first and a merge never postdates its PR's update, so a row updated
    // before the cutoff proves no later row can have merged at or after it.
    const cutoff = Date.parse(since);
    const older = (row: unknown) => typeof row === "object" && row !== null && Date.parse(String((row as { updated_at?: unknown }).updated_at)) < cutoff;
    for (const value of await pages(api, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, false, older)) {
      const pr = record(value);
      if (pr.merged_at !== null && Date.parse(isoDate(text(pr.merged_at))) >= Date.parse(since)) {
        if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1) throw new Error("Invalid selected pull-request number.");
        numbers.push(Number(pr.number));
      }
    }
  }
  const corpus = certifyCompleteListResult(await listAllComplete({}, { pmRoot, noExtensions: true }));
  const items = new Map(corpus.items.map(item => [item.id, item]));
  // Containers close when their children are done, never because a pull request mentions them.
  const activeChildren = new Map<string, number>();
  for (const item of corpus.items) {
    const parent = (item as { parent?: unknown }).parent;
    if (typeof parent === "string" && !TERMINAL_STATUSES.includes(item.status)) activeChildren.set(parent, (activeChildren.get(parent) ?? 0) + 1);
  }
  const selected = new Set<string>();
  const plan: CloseoutRow[] = [];
  const checks: CheckGate[] = [];
  const closures: { row: CloseoutRow; reason: string; at: string; resolution: string; expectedResult: string; actualResult: string }[] = [];
  for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
    const pr = pullRequest(await payload(api, `/repos/${repo}/pulls/${number}`), repo, number);
    let gate: CheckGate = { pr: number, code: "incomplete_merge", rule: "unavailable", ok: false, passed: [], reason: "Pull request is not merged or merge evidence is incomplete." };
    if (mergeEvidence(pr)) gate = await checkCloseoutHead(api, repo, pr, declared);
    checks.push(gate);
    for (const ref of extractCloseoutItems(pr.body ?? "")) {
      let reason: string;
      let code: CloseoutCode;
      if (ref.repo.toLowerCase() !== repo.toLowerCase()) { code = "other_repository"; reason = "Link points to another repository."; }
      else if (!items.has(ref.item)) { code = "unknown_item"; reason = "Item does not exist in the tracker."; }
      else if (skip.has(ref.item)) { code = "explicit_skip"; reason = "Explicitly excluded by --skip."; }
      else if (TERMINAL_STATUSES.includes(items.get(ref.item)!.status)) { code = "already_terminal"; reason = "Item is already closed or canceled."; }
      else if (!gate.ok) { code = gate.code; reason = gate.reason; }
      else if (items.get(ref.item)!.type === "Epic") { code = "epic"; reason = "Epics close when their children are done, not by a pull request."; }
      else if (activeChildren.has(ref.item)) { code = "active_children"; reason = `Item has ${activeChildren.get(ref.item)} non-terminal child item(s).`; }
      else if (items.get(ref.item)!.status !== "in_progress" && !ref.declared) {
        code = "not_delivery";
        reason = `Item is ${items.get(ref.item)!.status}, not in progress; a mention is not delivery. Prefix its link with Closes, Fixes, Resolves or Delivers to close it.`;
      }
      else if (selected.has(ref.item)) { code = "duplicate_selection"; reason = "Item already selected by another pull request."; }
      else {
        reason = gate.reason;
        selected.add(ref.item);
        const row: CloseoutRow = { item: ref.item, pr: number, action: "close", code: gate.code, reason };
        const criteria = items.get(ref.item)!.acceptance_criteria;
        closures.push({ row, reason: closeReason(pr, gate.passed), at: pr.merged_at!,
          resolution: `Delivered by ${pr.html_url} (merge ${pr.merge_commit_sha!.slice(0, 12)}, head ${pr.head.sha.slice(0, 12)})`,
          expectedResult: typeof criteria === "string" && criteria.trim().length > 0 ? criteria
            : "Delivered by the linked pull request, merged after its head check gate passed.",
          actualResult: `Merged at ${pr.merged_at!}; ${checkEvidence(gate)}`,
        });
        plan.push(row);
        continue;
      }
      plan.push({ item: ref.item, pr: number, action: "skip", code, reason });
    }
  }
  let closed = 0;
  let failed = 0;
  if (apply) {
    for (const entry of closures) {
      try {
        await close(entry.row.item, entry.reason, { author: "pm-github", completedAt: entry.at,
          resolution: entry.resolution, expectedResult: entry.expectedResult, actualResult: entry.actualResult,
        }, { pmRoot, noExtensions: true });
        closed++;
      } catch (error: unknown) {
        failed++;
        entry.row.action = "skip";
        entry.row.code = "close_failed";
        entry.row.reason = closeoutFailureReason(error);
      }
    }
  }
  return { command: "github closeout", repo, dry_run: !apply, plan, checks, closed, failed };
}

/** Keep actionable decisions and their checks while counting routine skips by stable code. */
export function compactCloseoutReport(report: Awaited<ReturnType<typeof runCloseout>>) {
  const skipped: Partial<Record<CloseoutCode, number>> = {};
  const plan = report.plan.flatMap(row => {
    if (["already_terminal", "other_repository", "duplicate_selection", "explicit_skip"].includes(row.code)) {
      skipped[row.code] = (skipped[row.code] ?? 0) + 1;
      return [];
    }
    return [{ ...row, action: row.action === "close" ? "close" : "refuse" }];
  });
  const prs = new Set(plan.map(row => row.pr));
  return { ...report, plan, skipped, checks: report.checks.filter(gate => prs.has(gate.pr)) };
}

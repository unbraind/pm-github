/** Close delivered tracker items using merged pull requests and head-check evidence. */
import { close, listAllComplete, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";

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
}

/** Which head-check policy was evaluated for one selected pull request. */
interface CheckGate {
  pr: number;
  rule: "required" | "fallback" | "unavailable";
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
interface RequiredPolicy { checks: RequiredCheck[]; fallback: boolean }
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

/** Read one payload with the shared authenticated retry/redirect transport. */
async function payload(api: CloseoutApi, endpoint: string): Promise<unknown> {
  return JSON.parse((await api.get(`${api.base}${endpoint}`)).body) as unknown;
}

/** Drain same-endpoint pagination; reject cycles, foreign links and truncated totals. */
async function pages(api: CloseoutApi, endpoint: string, checks = false): Promise<unknown[]> {
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
    next = api.next(response.linkHeader);
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
  return { checks, fallback: classic === null || rules === null || checks.length === 0 };
}

/** Verify required checks or the explicitly reported conservative fallback at the PR head. */
export async function checkCloseoutHead(api: CloseoutApi, repo: string, pr: PullRequest): Promise<CheckGate> {
  const result: CheckGate = { pr: pr.number, rule: "unavailable", reason: "Head check evidence unavailable or incomplete.", passed: [], ok: false };
  try {
    const policy = await requirements(api, repo, pr.base.ref);
    result.rule = policy.fallback ? "fallback" : "required";
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
      result.reason = "Required head checks concluded success (branch-protection and ruleset rule).";
    } else {
      if (runs.length === 0) { result.reason = "Fallback rule: no check runs at head; evidence missing."; return result; }
      if (runs.some(run => run.status !== "completed" || !["success", "neutral", "skipped"].includes(String(run.conclusion)))
        || [...statuses.values()].some(status => status.state !== "success")) {
        result.reason = "Fallback rule: every head run must be completed with success, neutral or skipped, and head statuses must succeed.";
        return result;
      }
      result.reason = "Fallback rule: readable required checks succeeded; protection unavailable or no required contexts; every head run completed with success, neutral or skipped; head statuses succeeded.";
    }
    result.passed = [...new Set([...runs.filter(run => run.status === "completed" && run.conclusion === "success").map(run => run.name),
      ...[...statuses.values()].filter(status => status.state === "success").map(status => status.context)])].sort();
    result.ok = true;
  } catch {
    // Never echo an API body, exception payload, PR body or comment into the report.
  }
  return result;
}

/** Extract only canonical tracker links, retaining foreign references solely for skip rows. */
export function extractCloseoutItems(body: string): { item: string; repo: string }[] {
  const links = body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/blob\/main\/\.agents\/pm\/((?:[^/\s?#<>)\]"']+\/)+)([^/\s?#<>)\]"']+)\.toon(?=$|[\s?#<>)\]"'])/g);
  const seen = new Set<string>();
  return [...links].flatMap(match => {
    let components: string[];
    try {
      components = [...match[2]!.slice(0, -1).split("/"), match[3]!].map(decodeURIComponent);
    } catch { return []; }
    if (components.some(component => /^\.{1,2}$|[/\\\0]/.test(component))) return [];
    const item = components.at(-1)!;
    const key = `${match[1]!.toLowerCase()}/${item}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ repo: match[1]!, item }];
  });
}

/** Render only the allowed GitHub facts; never include body, title or comment text. */
function closeReason(pr: PullRequest, passed: string[]): string {
  return JSON.stringify({ pr: pr.number, url: pr.html_url, merge_commit_sha: pr.merge_commit_sha,
    head_sha: pr.head.sha, merged_at: pr.merged_at, checks: passed });
}

/** Plan all selected PRs before closing eligible items through the real SDK. */
export async function runCloseout(pmRoot: string, repo: string | undefined, options: Record<string, unknown>, api: CloseoutApi) {
  if (!repo || !/^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("closeout requires --repo owner/repo or PM_GITHUB_REPO.");
  const numbers = repeated(options, "pr").map(value => {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--pr requires positive pull-request numbers.");
    return Number(value);
  });
  const since = options.since === undefined ? undefined : isoDate(text(options.since));
  if ((numbers.length === 0) === (since === undefined)) throw new Error("Select either repeatable --pr <n> or --since <ISO date>.");
  const skip = new Set(repeated(options, "skip"));
  const apply = options.apply === true && options["dry-run"] !== true && options.dryRun !== true;
  if (since !== undefined) {
    for (const value of await pages(api, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`)) {
      const pr = record(value);
      if (pr.merged_at !== null && Date.parse(isoDate(text(pr.merged_at))) >= Date.parse(since)) {
        if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1) throw new Error("Invalid selected pull-request number.");
        numbers.push(Number(pr.number));
      }
    }
  }
  const corpus = certifyCompleteListResult(await listAllComplete({}, { pmRoot, noExtensions: true }));
  const items = new Map(corpus.items.map(item => [item.id, item.status]));
  const selected = new Set<string>();
  const plan: CloseoutRow[] = [];
  const checks: CheckGate[] = [];
  const closures: { item: string; reason: string; at: string }[] = [];
  for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
    const pr = pullRequest(await payload(api, `/repos/${repo}/pulls/${number}`), repo, number);
    let gate: CheckGate = { pr: number, rule: "unavailable", ok: false, passed: [], reason: "Pull request is not merged or merge evidence is incomplete." };
    if (mergeEvidence(pr)) gate = await checkCloseoutHead(api, repo, pr);
    checks.push(gate);
    for (const ref of extractCloseoutItems(pr.body ?? "")) {
      let reason: string;
      if (ref.repo.toLowerCase() !== repo.toLowerCase()) reason = "Link points to another repository.";
      else if (!items.has(ref.item)) reason = "Item does not exist in the tracker.";
      else if (skip.has(ref.item)) reason = "Explicitly excluded by --skip.";
      else if (["closed", "canceled"].includes(items.get(ref.item)!)) reason = "Item is already closed or canceled.";
      else if (!gate.ok) reason = gate.reason;
      else if (selected.has(ref.item)) reason = "Item already selected by another pull request.";
      else {
        reason = gate.reason;
        selected.add(ref.item);
        closures.push({ item: ref.item, reason: closeReason(pr, gate.passed), at: pr.merged_at! });
        plan.push({ item: ref.item, pr: number, action: "close", reason });
        continue;
      }
      plan.push({ item: ref.item, pr: number, action: "skip", reason });
    }
  }
  if (apply) {
    for (const entry of closures) await close(entry.item, entry.reason, { author: "pm-github", completedAt: entry.at }, { pmRoot, noExtensions: true });
  }
  return { command: "github closeout", repo, dry_run: !apply, plan, checks, closed: apply ? closures.length : 0 };
}

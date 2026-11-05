/** Standalone policy loaded from the reusable workflow SHA, never from a PR. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

/** Minimal GitHub PR fields needed to prove a stable, complete snapshot. */
interface PullRequest {
  state: string;
  user: { login: string };
  head: { sha: string };
  commits: number;
}

/** API-linked accounts and signature verification, never Git display names. */
interface Commit {
  sha: string;
  author: { login: string } | null;
  committer: { login: string } | null;
  commit: { verification: { verified: boolean; reason: string } };
}

/** Event and metadata values enter through bindings, never shell source. */
export interface MergeInput {
  repository: string;
  number: string;
  event: string;
  actor: string;
  triggeringActor: string;
  author: string;
  head: string;
  phase: string;
  metadataOutcome: string;
  group: string;
  updateType: string;
  extraGroups: string;
}

/** Safe report containing policy reasons and short SHA/account pairs only. */
export interface MergeResult {
  armed: boolean;
  message: string;
}

/** Execute one bounded child; injectable so tests can observe actual kill receipts. */
export type GithubCommandRunner = (executable: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

/** Read the trusted runtime deadline; invalid overrides fail before starting a child. */
export function githubCallTimeout(seconds = process.env.DEPENDABOT_GH_TIMEOUT_SECONDS ?? "60"): number {
  if (!/^[1-9][0-9]*$/.test(seconds) || Number(seconds) > 60) {
    throw new Error("GitHub CLI timeout must be an integer from 1 to 60 seconds.");
  }
  return Number(seconds) * 1000;
}

/** Bound each CLI attempt, discard failed output, and retry at most three times without a shell. */
export function githubCli(args: readonly string[], executable = "gh", timeout = githubCallTimeout(), execute: GithubCommandRunner = execFileSync): string {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Invalid GitHub CLI timeout.");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execute(executable, args, { encoding: "utf8", env: { ...process.env }, maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL" });
    } catch { /* A timeout or failed attempt must never expose partial output. */ }
  }
  throw new Error("GitHub CLI failed or timed out after 3 bounded attempts.");
}

const bot = "dependabot[bot]";
const shaPattern = /^[a-f0-9]{40}$/;

/** Reduce untrusted API account values to a safe single-line login. */
function login(value: string | undefined): string {
  return typeof value === "string" && /^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(value) ? value : "unknown";
}

/**
 * Revoke before arming and independently re-read provenance for a head-bound arm.
 * Audit-only calls preserve verified requests and never arm a new request.
 * Every refusal revokes even after an API failure. Inability to revoke throws:
 * the job must not claim success with an unsafe request potentially still armed.
 */
export function runDependabotMerge(input: MergeInput, gh: (args: readonly string[]) => string = githubCli): MergeResult {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository) || !/^[1-9][0-9]*$/.test(input.number)) {
    throw new Error("Invalid caller repository or PR number; cannot safely address auto-merge.");
  }
  const target = [input.number, "--repo", input.repository];
  const endpoint = `repos/${input.repository}/pulls/${input.number}`;
  /** Clear active requests, attempting revocation even when state cannot be read. */
  const revoke = () => {
    let armed = true;
    try {
      const current = JSON.parse(gh(["api", endpoint])) as { state?: string; auto_merge: unknown };
      // Merged PRs retain historical auto_merge metadata; it is no longer armed.
      armed = current.state !== "closed" && current.auto_merge !== null;
    } catch { /* Unreadable state still owes revocation. */ }
    if (armed) {
      try { gh(["pr", "merge", ...target, "--disable-auto"]); }
      catch { throw new Error("Auto-merge revocation denied or unavailable after bounded retries; request may still be armed. Check token write permissions and retry immediately."); }
    }
  };
  const audit = input.phase === "audit";
  if (!audit) revoke();
  if (input.phase === "revoke") return { armed: false, message: "Previous auto-merge request revoked before metadata." };
  let message: string;
  try {
    /** Obtain independent snapshots around pagination and the arm request. */
    const read = () => JSON.parse(gh(["api", endpoint])) as PullRequest;
    const before = read();
    // One JSON object per line works with both older and current gh releases.
    // A nonzero status on any later page throws before any partial list is used.
    const receipt = gh(["api", `${endpoint}/commits?per_page=100`, "--paginate", "--jq", ".[] | @json"]).trim();
    const commits = receipt === "" ? [] : receipt.split("\n").map(line => JSON.parse(line) as Commit);
    const after = read();
    if (!Number.isInteger(before.commits) || before.commits < 1 || commits.length !== before.commits ||
        !commits.every(commit => shaPattern.test(commit?.sha)) || new Set(commits.map(commit => commit.sha)).size !== commits.length ||
        commits.at(-1)!.sha !== before.head.sha || after.head.sha !== before.head.sha || after.commits !== before.commits) {
      throw new Error("Incomplete or changing PR snapshot");
    }
    const foreign = commits.filter(commit => commit.author?.login !== bot ||
      !(commit.committer?.login === bot || commit.committer?.login === "web-flow") ||
      commit.commit?.verification?.verified !== true || commit.commit.verification.reason !== "valid");
    const identities = foreign.map(commit => `${commit.sha.slice(0, 12)} ${login(commit.author?.login)}`);
    const allowedGroups = ["pm-toolchain", ...input.extraGroups.split(/[\s,]+/).filter(Boolean)];
    if (foreign.length > 0) message = `Foreign or unverified commits: ${identities.join(", ")}.`;
    else if (audit && before.state === "open" && after.state === "open" && before.user.login === bot && after.user.login === bot) {
      return { armed: false, message: `Verified Dependabot head ${after.head.sha.slice(0, 12)} retained; audit never arms auto-merge.` };
    }
    else if (input.event !== "pull_request_target" || audit) message = "Only trusted pull_request_target callers can arm auto-merge.";
    else if (input.actor !== bot || input.triggeringActor !== bot || input.author !== bot || before.user.login !== bot || after.user.login !== bot) message = "PR author and event/re-run actors must all be dependabot[bot].";
    else if (before.state !== "open" || after.state !== "open" || !shaPattern.test(input.head) || input.head !== after.head.sha) message = "PR is closed or the event head is stale.";
    else if (input.metadataOutcome !== "success") message = "Dependabot metadata unavailable or failed; auto-merge not armed.";
    else if (!(input.group !== "" && allowedGroups.includes(input.group)) &&
      !["version-update:semver-minor", "version-update:semver-patch"].includes(input.updateType)) message = "Update is outside the allowed groups and semver minor/patch policy.";
    else {
      gh(["pr", "merge", ...target, "--auto", "--squash", "--match-head-commit", after.head.sha]);
      const final = read();
      if (final.head.sha !== after.head.sha || final.commits !== after.commits || final.user.login !== bot) throw new Error("PR changed while arming");
      return { armed: true, message: `Squash auto-merge requested for verified Dependabot head ${after.head.sha.slice(0, 12)} (${commits.length} commits).` };
    }
  } catch {
    message = "API/provenance or merge request failed (including incomplete pagination or a changing head); auto-merge not armed. Check token permissions and retry.";
  }
  revoke();
  return { armed: false, message };
}

/** Audit every armed Dependabot PR independently of suppressed push events; never arm a request. */
export function auditDependabotMerges(repository: string, gh: (args: readonly string[]) => string = githubCli): MergeResult {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error("Invalid audit repository.");
  let pulls: { number: number; user: { login: string }; auto_merge: unknown }[];
  try {
    const receipt = gh(["api", `repos/${repository}/pulls?state=open&per_page=100`, "--paginate", "--jq", ".[] | @json"]).trim();
    pulls = receipt === "" ? [] : receipt.split("\n").map(line => JSON.parse(line));
  } catch { throw new Error("Cannot read complete PR audit listing; retry immediately."); }
  if (!pulls.every(pr => pr && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.user?.login === "string" && Object.hasOwn(pr, "auto_merge"))) {
    throw new Error("Incomplete PR audit listing; retry immediately.");
  }
  const results: string[] = [];
  const failed: number[] = [];
  for (const pr of pulls.filter(pr => pr.user.login === bot && pr.auto_merge !== null)) {
    try {
      const result = runDependabotMerge({ repository, number: String(pr.number), phase: "audit", event: "schedule",
        actor: "", triggeringActor: "", author: bot, head: "", metadataOutcome: "", group: "", updateType: "", extraGroups: "" }, gh);
      results.push(`#${pr.number}: ${result.message}`);
    } catch { failed.push(pr.number); }
  }
  if (failed.length > 0) {
    const numbers = failed.slice(0, 20).map(number => `#${number}`).join(", ");
    const remaining = failed.length > 20 ? `, plus ${failed.length - 20} more` : "";
    throw new Error(`Cannot complete ${failed.length} auto-merge revocations (${numbers}${remaining}); requests may still be armed. Retry immediately.`);
  }
  return { armed: false, message: results.join("\n") || "No armed Dependabot requests to audit." };
}

/** Measured CI waits and conservative release-base refresh guards. */
import { execFileSync, spawnSync } from "node:child_process";

/** Minimal successful-job timing fields returned by the GitHub Actions API. */
export interface ReleaseTimingJob {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** Derive a nearest-rank p95 wait with queue/review margin and explicit bounds. */
export function deriveReleaseMergeWait(jobs: readonly ReleaseTimingJob[]) {
  const samples = jobs.filter(job => ["test (22)", "test (26)"].includes(job.name) && job.conclusion === "success")
    .map(job => (Date.parse(job.completed_at ?? "") - Date.parse(job.started_at ?? "")) / 1000)
    .filter(seconds => Number.isFinite(seconds) && seconds > 0).sort((a, b) => a - b);
  const p95Seconds = samples.length === 0 ? 0 : Math.ceil(samples[Math.ceil(samples.length * 0.95) - 1]!);
  const marginSeconds = Math.max(900, Math.ceil(p95Seconds * 0.25));
  const waitSeconds = Math.min(7200, Math.max(3600, p95Seconds + marginSeconds));
  return { sample_count: samples.length, p95_seconds: p95Seconds, margin_seconds: marginSeconds, wait_seconds: waitSeconds };
}

/** Read a repository fact without invoking a shell or accepting option-shaped refs. */
function gitFact(directory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Refuse metadata changes in every new commit, including changes later reverted. */
export function assertSafeReleaseAdvance(base: string, main: string, directory = process.cwd()): void {
  const repository = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory, encoding: "utf8" });
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    throw new Error("Release branch refresh needs a git repository; the tracker can still be used without git.");
  }
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(main)) throw new Error("Release refresh requires full commit SHAs.");
  if (spawnSync("git", ["merge-base", "--is-ancestor", base, main], { cwd: directory }).status !== 0) {
    throw new Error("Release base is not an ancestor of main; retry release preparation.");
  }
  const commits = gitFact(directory, ["rev-list", `${base}..${main}`]).split("\n").filter(Boolean);
  for (const commit of commits) {
    const parent = gitFact(directory, ["rev-parse", `${commit}^`]);
    const paths = gitFact(directory, ["diff", "--name-only", "--no-renames", parent, commit, "--"]).split("\n");
    if (paths.some(path => ["CHANGELOG.md", "manifest.json", "RELEASE_NOTES.md"].includes(path))) {
      throw new Error("Main changed release metadata; retry release preparation.");
    }
    for (const path of ["package.json", "package-lock.json"]) {
      if (!paths.includes(path)) continue;
      const previous = JSON.parse(gitFact(directory, ["show", `${parent}:${path}`])) as { version?: string; packages?: Record<string, { version?: string }> };
      const next = JSON.parse(gitFact(directory, ["show", `${commit}:${path}`])) as typeof previous;
      if (previous.version !== next.version || previous.packages?.[""]?.version !== next.packages?.[""]?.version) {
        throw new Error("Main changed the package release version; retry release preparation.");
      }
    }
  }
}

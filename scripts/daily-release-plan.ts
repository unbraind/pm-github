/** Facts needed to rebuild a protected release PR without a second daily publication. */
export interface DailyReleaseInput {
  existingPrs: { number: number; headRefName: string; isCrossRepository: boolean; author: { login: string } }[];
  mainSha: string;
  lastRelease: { tag: string; sha: string } | null;
  today: string;
}

/** Strip zero padding from each numeric component of a date-shaped version,
 * preserving an optional -N suffix, so a release tag's version (v2026.11.02)
 * equals the npm version this plan publishes (2026.11.2). */
export function normalizeReleaseVersion(version: string): string {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9]+)?$/.exec(version);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ?? ""}` : version;
}

/** Rebuild from current main on every eligible run, reusing even yesterday's open PR. */
export function decideDailyRelease(input: DailyReleaseInput) {
  // gh represents the GITHUB_TOKEN author as app/github-actions.
  const candidates = input.existingPrs.filter(pr => pr.isCrossRepository === false
    && pr.author.login === "app/github-actions"
    && /^release\/\d{4}\.\d{1,2}\.\d{1,2}$/.test(pr.headRefName))
    .sort((a, b) => releaseDate(b.headRefName) - releaseDate(a.headRefName) || b.number - a.number);
  const existingPr = candidates[0];
  const version = normalizeReleaseVersion(input.today);
  const releasedVersion = input.lastRelease
    ? normalizeReleaseVersion(input.lastRelease.tag.replace(/^v/, "").split("-")[0]!)
    : undefined;
  const shouldRelease = releasedVersion !== version.split("-")[0] && input.lastRelease?.sha !== input.mainSha;
  return {
    should_release: shouldRelease,
    action: !shouldRelease ? "skip" : existingPr ? "refresh" : "create",
    tag: `v${input.today}`,
    npm_version: version,
    base_sha: input.mainSha,
    release_branch: existingPr?.headRefName ?? `release/${input.today}`,
    pr_number: existingPr?.number ?? "",
    superseded_pr_numbers: candidates.slice(1).map(pr => pr.number).join(" "),
  };
}

/** Compare date-shaped release branches numerically, including unpadded dates. */
function releaseDate(branch: string): number {
  return branch.slice("release/".length).split(".").reduce((date, part) => date * 100 + Number(part), 0);
}

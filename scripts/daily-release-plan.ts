/** Facts needed to rebuild a protected release PR without a second daily publication. */
export interface DailyReleaseInput {
  existingPrs: { number: number; headRefName: string; isCrossRepository: boolean; author: { login: string } }[];
  mainSha: string;
  lastRelease: { tag: string; sha: string } | null;
  today: string;
}

/** Rebuild from current main on every eligible run, reusing even yesterday's open PR. */
export function decideDailyRelease(input: DailyReleaseInput) {
  // gh represents the GITHUB_TOKEN author as app/github-actions.
  const candidates = input.existingPrs.filter(pr => pr.isCrossRepository === false
    && pr.author.login === "app/github-actions"
    && /^release\/\d{4}\.\d{1,2}\.\d{1,2}$/.test(pr.headRefName))
    .sort((a, b) => releaseDate(b.headRefName) - releaseDate(a.headRefName) || b.number - a.number);
  const existingPr = candidates[0];
  const version = input.today.split(".").map(Number).join(".");
  const releasedVersion = input.lastRelease?.tag.replace(/^v/, "").split("-")[0]?.split(".").map(Number).join(".");
  const shouldRelease = releasedVersion !== version && input.lastRelease?.sha !== input.mainSha;
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

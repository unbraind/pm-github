/** Facts needed to rebuild a protected release PR without a second daily publication. */
export interface DailyReleaseInput {
  existingPr: { number: number; branch: string } | null;
  mainSha: string;
  lastRelease: { tag: string; sha: string } | null;
  today: string;
}

/** Rebuild from current main on every eligible run, reusing even yesterday's open PR. */
export function decideDailyRelease(input: DailyReleaseInput) {
  const version = input.today.split(".").map(Number).join(".");
  const releasedVersion = input.lastRelease?.tag.replace(/^v/, "").split("-")[0]?.split(".").map(Number).join(".");
  const shouldRelease = releasedVersion !== version && input.lastRelease?.sha !== input.mainSha;
  return {
    should_release: shouldRelease,
    action: !shouldRelease ? "skip" : input.existingPr ? "refresh" : "create",
    tag: `v${input.today}`,
    npm_version: version,
    base_sha: input.mainSha,
    release_branch: input.existingPr?.branch ?? `release/${input.today}`,
  };
}

/** Package-owned release planning remains independently tested; execution delegates to pm-ops. */
import assert from "node:assert/strict";
import test from "node:test";
import { decideDailyRelease, normalizeReleaseVersion, type DailyReleaseInput } from "../scripts/daily-release-plan.ts";

const input: DailyReleaseInput = { existingPrs: [], mainSha: "new-main", lastRelease: null, today: "2026.10.18" };
const workflowPr = { number: 144, headRefName: "release/2026.10.17", isCrossRepository: false,
  author: { login: "app/github-actions" } };


test("first release uses today's stable npm version and current main", () => {
  assert.deepEqual(decideDailyRelease(input), { should_release: true, action: "create", tag: "v2026.10.18",
    npm_version: "2026.10.18", base_sha: "new-main", release_branch: "release/2026.10.18", pr_number: "", superseded_pr_numbers: "" });
  assert.equal(decideDailyRelease({ ...input, today: "2026.01.02" }).npm_version, "2026.1.2");
  const rescheduled = decideDailyRelease({ ...input, today: "2027.01.01-2" });
  assert.equal(rescheduled.tag, "v2027.01.01-2");
  assert.equal(rescheduled.npm_version, "2027.1.1-2");
});

test("an existing stale PR is rebuilt from current main and today's date", () => {
  const plan = decideDailyRelease({ ...input, existingPrs: [workflowPr],
    lastRelease: { tag: "v2026.10.16", sha: "released-main" } });
  assert.equal(plan.action, "refresh");
  assert.equal(plan.should_release, true);
  assert.equal(plan.base_sha, "new-main");
  assert.equal(plan.release_branch, "release/2026.10.17");
  assert.equal(plan.tag, "v2026.10.18");
  assert.equal(plan.pr_number, 144);
});

test("a cross-repository release PR is ignored and a fresh PR is planned", () => {
  const plan = decideDailyRelease({ ...input, existingPrs: [{ ...workflowPr, isCrossRepository: true }] });
  assert.equal(plan.action, "create");
  assert.equal(plan.pr_number, "");
  assert.equal(plan.release_branch, "release/2026.10.18");
});

test("a foreign author's release PR is ignored and a fresh PR is planned", () => {
  const plan = decideDailyRelease({ ...input, existingPrs: [{ ...workflowPr, author: { login: "app/other-bot" } }] });
  assert.equal(plan.action, "create");
  assert.equal(plan.pr_number, "");
  assert.equal(plan.release_branch, "release/2026.10.18");
});

test("a non-date release branch is ignored and a fresh PR is planned", () => {
  for (const headRefName of ["release/v2-notes", "release/2026.10.17-notes", "release/2026.100.17", "release/2026.10.17\n"]) {
    const plan = decideDailyRelease({ ...input, existingPrs: [{ ...workflowPr, headRefName }] });
    assert.equal(plan.action, "create", headRefName);
    assert.equal(plan.pr_number, "");
    assert.equal(plan.release_branch, "release/2026.10.18");
  }
});

test("selection skips untrusted candidates and accepts the workflow's unpadded date branches", () => {
  const plan = decideDailyRelease({ ...input, existingPrs: [
    { ...workflowPr, isCrossRepository: true },
    { ...workflowPr, number: 155, headRefName: "release/2026.1.2" },
  ] });
  assert.equal(plan.action, "refresh");
  assert.equal(plan.pr_number, 155);
  assert.equal(plan.release_branch, "release/2026.1.2");
});

test("an unchanged release or a publication already dated today skips, even after new main changes", () => {
  for (const tag of ["v2026.10.18", "v2026.10.18-1", "v2026.010.018"]) {
    assert.equal(decideDailyRelease({ ...input, lastRelease: { tag, sha: "earlier-main" } }).should_release, false);
  }
  assert.equal(decideDailyRelease({ ...input, lastRelease: { tag: "v2026.10.17", sha: input.mainSha } }).action, "skip");
});

test("newest branch date wins independently of input order and PR creation order", () => {
  const candidates = [
    { ...workflowPr, number: 300, headRefName: "release/2026.9.30" },
    { ...workflowPr, number: 100, headRefName: "release/2026.10.1" },
    { ...workflowPr, number: 200, headRefName: "release/2025.12.31" },
    { ...workflowPr, number: 400, headRefName: "release/2026.10.01" },
  ];
  for (const existingPrs of [candidates, [...candidates].reverse(), [...candidates.slice(2), ...candidates.slice(0, 2)]]) {
    const plan = decideDailyRelease({ ...input, existingPrs });
    assert.equal(plan.pr_number, 400);
    assert.equal(plan.release_branch, "release/2026.10.01");
    assert.equal(plan.superseded_pr_numbers, "100 300 200");
    assert.equal(plan.should_release, true);
  }
  assert.deepEqual(candidates.map(pr => pr.number), [300, 100, 200, 400], "planning does not mutate its input");
});

test("only eligible older release PRs are reported as superseded by number", () => {
  const plan = decideDailyRelease({ ...input, existingPrs: [workflowPr,
    { ...workflowPr, number: 145, headRefName: "release/2026.10.18" },
    { ...workflowPr, number: 999, isCrossRepository: true },
    { ...workflowPr, number: 998, author: { login: "maintainer" } },
    { ...workflowPr, number: 997, headRefName: "release/v2-notes" },
  ] });
  assert.equal(plan.pr_number, 145);
  assert.equal(plan.superseded_pr_numbers, "144");
});

test("normalizeReleaseVersion strips padding as text and leaves other shapes unchanged", () => {
  assert.equal(normalizeReleaseVersion("2026.11.02"), "2026.11.2");
  assert.equal(normalizeReleaseVersion("2027.01.01-2"), "2027.1.1-2");
  assert.equal(normalizeReleaseVersion("2026.00.000"), "2026.0.0");
  // Number() would round this to 18446744073709552000; the workflows keep every digit.
  assert.equal(normalizeReleaseVersion("18446744073709551616.11.02"), "18446744073709551616.11.2");
  assert.equal(normalizeReleaseVersion("latest"), "latest");
  assert.equal(normalizeReleaseVersion("2026.11"), "2026.11");
});

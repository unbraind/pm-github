/** Daily release policy is independent of GitHub and the wall clock. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideDailyRelease, type DailyReleaseInput } from "../scripts/daily-release-plan.ts";

const input: DailyReleaseInput = { existingPrs: [], mainSha: "new-main", lastRelease: null, today: "2026.10.18" };
const workflowPr = { number: 144, headRefName: "release/2026.10.17", isCrossRepository: false,
  author: { login: "app/github-actions" } };

test("first release uses today's stable npm version and current main", () => {
  assert.deepEqual(decideDailyRelease(input), { should_release: true, action: "create", tag: "v2026.10.18",
    npm_version: "2026.10.18", base_sha: "new-main", release_branch: "release/2026.10.18", pr_number: "" });
  assert.equal(decideDailyRelease({ ...input, today: "2026.01.02" }).npm_version, "2026.1.2");
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

test("workflow rebuilds before preparation and runs the canonical generator before checks and leased PR refresh", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /import \{ decideDailyRelease \} from "\.\/scripts\/daily-release-plan\.ts"/);
  assert.ok(workflow.indexOf("git checkout --detach origin/main") < workflow.indexOf("- name: Install dependencies"));
  const generation = workflow.slice(workflow.indexOf("- name: Generate changelog"), workflow.indexOf("- name: Run release checks"));
  assert.match(generation, /npm run changelog:full/);
  assert.match(generation, /npm run changelog:check/);
  assert.match(generation, /npm run --silent release:notes/);
  assert.doesNotMatch(generation, /npx pm-changelog/);
  assert.match(workflow, /release_branch="\$RELEASE_BRANCH"/);
  assert.match(workflow, /--force-with-lease=/);
  assert.match(workflow, /gh pr edit "\$pr_number"/);
  assert.match(workflow, /pr_number="\$RELEASE_PR_NUMBER"/);
  assert.match(workflow, /RELEASE_PR_NUMBER: \$\{\{ steps.decide.outputs.pr_number \}\}/);
  assert.equal(workflow.match(/gh pr list/g)?.length, 1);
  assert.match(workflow, /--json number,headRefName,isCrossRepository,author/);
  assert.doesNotMatch(workflow, /export RELEASE_EXISTING_PRS=/);
  assert.ok(workflow.indexOf("Refusing to overwrite a release branch") < workflow.indexOf('origin ":refs/heads/${release_branch}"'));
});

test("a failed GitHub candidate lookup aborts instead of exporting an empty success", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const lookup = workflow.slice(workflow.indexOf('          RELEASE_EXISTING_PRS="$('), workflow.indexOf("          node --input-type=module -e '"));
  const result = spawnSync("bash", ["-c", `set -eu; gh() { return 47; }; ${lookup}\nprintf continued`],
    { encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "example/package" } });
  assert.equal(result.status, 47);
  assert.equal(result.stdout, "");
});

test("the push and cleanup boundary refuses an existing ref without a selected workflow PR", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const guard = workflow.slice(workflow.indexOf('          release_branch="$RELEASE_BRANCH"'), workflow.indexOf('          release_commit="$(git rev-parse HEAD)"'));
  for (const [prNumber, ref, status] of [["", "existing-sha", 1], ["144", "existing-sha", 0], ["", "", 0]] as const) {
    const result = spawnSync("bash", ["-c", `set -eu; git() { printf '%s' "$TEST_REF"; }; ${guard}`],
      { encoding: "utf8", env: { ...process.env, RELEASE_BRANCH: "release/2026.10.18", RELEASE_PR_NUMBER: prNumber, TEST_REF: ref } });
    assert.equal(result.status, status, result.stderr);
    if (status === 1) assert.match(result.stdout, /Refusing to overwrite/);
  }
});

/** Daily release policy is independent of GitHub and the wall clock. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideDailyRelease, type DailyReleaseInput } from "../scripts/daily-release-plan.ts";

const input: DailyReleaseInput = { existingPr: null, mainSha: "new-main", lastRelease: null, today: "2026.10.18" };

test("first release uses today's stable npm version and current main", () => {
  assert.deepEqual(decideDailyRelease(input), { should_release: true, action: "create", tag: "v2026.10.18",
    npm_version: "2026.10.18", base_sha: "new-main", release_branch: "release/2026.10.18" });
  assert.equal(decideDailyRelease({ ...input, today: "2026.01.02" }).npm_version, "2026.1.2");
});

test("an existing stale PR is rebuilt from current main and today's date", () => {
  const plan = decideDailyRelease({ ...input, existingPr: { number: 144, branch: "release/2026.10.17" },
    lastRelease: { tag: "v2026.10.16", sha: "released-main" } });
  assert.equal(plan.action, "refresh");
  assert.equal(plan.should_release, true);
  assert.equal(plan.base_sha, "new-main");
  assert.equal(plan.release_branch, "release/2026.10.17");
  assert.equal(plan.tag, "v2026.10.18");
});

test("an unchanged release or a publication already dated today skips, even after new main changes", () => {
  for (const tag of ["v2026.10.18", "v2026.10.18-1", "v2026.010.018"]) {
    assert.equal(decideDailyRelease({ ...input, lastRelease: { tag, sha: "earlier-main" } }).should_release, false);
  }
  assert.equal(decideDailyRelease({ ...input, lastRelease: { tag: "v2026.10.17", sha: input.mainSha } }).action, "skip");
});

test("workflow rebuilds before preparation and runs the canonical generator before checks and leased PR refresh", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /import \{ decideDailyRelease \} from '\.\/scripts\/daily-release-plan\.ts'/);
  assert.ok(workflow.indexOf("git checkout --detach origin/main") < workflow.indexOf("- name: Install dependencies"));
  const generation = workflow.slice(workflow.indexOf("- name: Generate changelog"), workflow.indexOf("- name: Run release checks"));
  assert.match(generation, /npm run changelog:full/);
  assert.match(generation, /npm run changelog:check/);
  assert.match(generation, /npm run --silent release:notes/);
  assert.doesNotMatch(generation, /npx pm-changelog/);
  assert.match(workflow, /release_branch="\$RELEASE_BRANCH"/);
  assert.match(workflow, /--force-with-lease=/);
  assert.match(workflow, /gh pr edit "\$pr_number"/);
});

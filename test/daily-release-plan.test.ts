/** Daily release policy is independent of GitHub and the wall clock. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decideDailyRelease, type DailyReleaseInput } from "../scripts/daily-release-plan.ts";

const input: DailyReleaseInput = { existingPrs: [], mainSha: "new-main", lastRelease: null, today: "2026.10.18" };
const workflowPr = { number: 144, headRefName: "release/2026.10.17", isCrossRepository: false,
  author: { login: "app/github-actions" } };

test("first release uses today's stable npm version and current main", () => {
  assert.deepEqual(decideDailyRelease(input), { should_release: true, action: "create", tag: "v2026.10.18",
    npm_version: "2026.10.18", base_sha: "new-main", release_branch: "release/2026.10.18", pr_number: "", superseded_pr_numbers: "" });
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

/** Workflow fields exercised by the shell and configuration regressions. */
interface WorkflowStep { name: string; run?: string; env?: Record<string, string>; if?: string }
/** Resolve the YAML parser already bundled with the pinned SDK. */
const { parse }: { parse: (source: string) => { jobs: { release: { steps: WorkflowStep[] } } } } =
  createRequire(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"))("yaml");
const steps = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).jobs.release.steps;

/** Fail clearly when a named shell step disappears or loses its script. */
function step(name: string): WorkflowStep & { run: string } {
  const found = steps.find(candidate => candidate.name === name);
  assert.ok(found, `Missing workflow step: ${name}`);
  assert.equal(typeof found.run, "string", `${name} must contain a shell script`);
  return found as WorkflowStep & { run: string };
}

/** Execute the complete decision step against bounded synthetic GitHub responses. */
function runDecision(prs: DailyReleaseInput["existingPrs"], failedLookup = false): SpawnSyncReturns<string> {
  const root = mkdtempSync(join(tmpdir(), "pm-github-release-plan-"));
  try {
    return spawnSync("bash", ["-c", `
      git() { if [[ "$1" == rev-parse ]]; then printf new-main; fi; }
      date() { printf 2026.10.18; }
      gh() {
        if [[ "$FAILED_LOOKUP" == true ]]; then return 47; fi
        local limit=30
        while (( $# )); do
          if [[ "$1" == --limit ]]; then limit="$2"; shift; fi
          shift
        done
        node --input-type=module -e 'console.log(JSON.stringify(JSON.parse(process.env.TEST_PRS).slice(0, Number(process.argv[1]))))' "$limit"
      }
      ${step("Decide release").run}
      cat "$GITHUB_OUTPUT"
    `], { encoding: "utf8", env: { ...process.env, RELEASE_TIMEZONE: "UTC", GITHUB_REPOSITORY: "example/package",
      GITHUB_OUTPUT: join(root, "outputs"), TEST_PRS: JSON.stringify(prs), FAILED_LOOKUP: String(failedLookup) } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("the complete workflow decision finds an eligible PR beyond the default first 30", () => {
  const prs = Array.from({ length: 30 }, (_, index) => ({ ...workflowPr, number: index + 1, headRefName: `feature/${index}` }));
  const result = runDecision([...prs, workflowPr]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^pr_number=144$/m);
  assert.match(result.stdout, /^action=refresh$/m);
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

test("only eligible older release PRs are reported and closed as superseded by number", () => {
  const plan = decideDailyRelease({ ...input, existingPrs: [workflowPr,
    { ...workflowPr, number: 145, headRefName: "release/2026.10.18" },
    { ...workflowPr, number: 999, isCrossRepository: true },
    { ...workflowPr, number: 998, author: { login: "maintainer" } },
    { ...workflowPr, number: 997, headRefName: "release/v2-notes" },
  ] });
  assert.equal(plan.pr_number, 145);
  assert.equal(plan.superseded_pr_numbers, "144");
  const cleanup = step("Close superseded release PRs");
  assert.equal(cleanup.env?.SUPERSEDED_PR_NUMBERS, "${{ steps.decide.outputs.superseded_pr_numbers }}");
  assert.equal(cleanup.env?.RELEASE_PR_NUMBER, "${{ steps.decide.outputs.pr_number }}");
  assert.equal(cleanup.env?.GH_TOKEN, "${{ github.token }}");
  assert.equal(cleanup.if, "steps.decide.outputs.should_release == 'true'");
  for (const superseded of [plan.superseded_pr_numbers, ""]) {
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", `gh() { printf '%s\\n' "$*"; }; ${cleanup.run}`], {
      encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "example/package",
        RELEASE_PR_NUMBER: String(plan.pr_number), SUPERSEDED_PR_NUMBERS: superseded },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), superseded ? "pr close 144 --repo example/package --comment Superseded by release PR #145." : "");
  }
});

test("workflow rebuilds before preparation and runs the canonical generator before checks and leased PR refresh", () => {
  const decision = step("Decide release");
  const generation = step("Generate changelog and release notes");
  const refresh = step("Merge release metadata through protected PR");
  assert.match(decision.run, /import \{ decideDailyRelease \} from "\.\/scripts\/daily-release-plan\.ts"/);
  assert.ok(steps.indexOf(step("Refresh release base")) < steps.indexOf(step("Install dependencies")));
  assert.match(step("Refresh release base").run, /git checkout --detach origin\/main/);
  assert.ok(steps.indexOf(generation) < steps.indexOf(step("Run release checks")));
  assert.match(generation.run, /npm run changelog:full/);
  assert.match(generation.run, /npm run changelog:check/);
  assert.match(generation.run, /npm run --silent release:notes/);
  assert.doesNotMatch(generation.run, /npx pm-changelog/);
  assert.match(refresh.run, /release_branch="\$RELEASE_BRANCH"/);
  assert.match(refresh.run, /--force-with-lease=/);
  assert.match(refresh.run, /gh pr edit "\$pr_number"/);
  assert.match(refresh.run, /pr_number="\$RELEASE_PR_NUMBER"/);
  assert.equal(refresh.env?.RELEASE_PR_NUMBER, "${{ steps.decide.outputs.pr_number }}");
  assert.equal(steps.filter(candidate => candidate.run?.includes("gh pr list")).length, 1);
  assert.match(decision.run, /--json number,headRefName,isCrossRepository,author/);
  assert.doesNotMatch(decision.run, /export RELEASE_EXISTING_PRS=/);
  assert.ok(steps.indexOf(step("Close superseded release PRs")) > steps.indexOf(step("Run release checks")));
});

test("a failed GitHub candidate lookup aborts instead of exporting an empty success", () => {
  const result = runDecision([], true);
  assert.equal(result.status, 47);
  assert.equal(result.stdout, "");
});

test("the push and cleanup boundary refuses an existing ref without a selected workflow PR", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-release-guard-"));
  try {
    for (const [prNumber, ref, status] of [["", "existing-sha", 1], ["144", "existing-sha", 0], ["", "", 0]] as const) {
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", `
        git() {
          case "$1" in
            rev-parse) printf new-main ;;
            ls-remote) printf '%s' "$TEST_REF" ;;
          esac
        }
        gh() { printf 'Unexpected GitHub mutation' >&2; return 99; }
        ${step("Merge release metadata through protected PR").run}
      `], { encoding: "utf8", env: { ...process.env, RELEASE_BRANCH: "release/2026.10.18", RELEASE_PR_NUMBER: prNumber,
        RELEASE_BASE_SHA: "new-main", GITHUB_OUTPUT: join(root, "outputs"), TEST_REF: ref } });
      assert.equal(result.status, status, result.stderr);
      if (status === 1) assert.match(result.stdout, /Refusing to overwrite/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

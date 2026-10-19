/** Daily release policy is independent of GitHub and the wall clock. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
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
interface WorkflowStep { name: string; run?: string; env?: Record<string, string>; if?: string; "continue-on-error"?: boolean }
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
  assert.ok(steps.indexOf(step("Close superseded release PRs")) > steps.indexOf(refresh));
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

/** Execute a complete named step with isolated files and synthetic command transports. */
function runReleaseStep(name: string, commands: string, extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> & { outputs: string; summary: string } {
  const root = mkdtempSync(join(tmpdir(), "pm-github-release-cleanup-"));
  const output = join(root, "outputs");
  const summary = join(root, "summary");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "example-package" }));
  writeFileSync(join(root, "CHANGELOG.md"), "Canonical changelog\n");
  writeFileSync(join(root, "RELEASE_NOTES.md"), "Release notes\n");
  try {
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", `${commands}\n${step(name).run}\nprintf 'release continues\n'`], {
      encoding: "utf8", cwd: root, env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
        GITHUB_REPOSITORY: "example/package", GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: extraEnv.TEST_SUMMARY_FAILURE ? join(root, "missing", "summary") : summary,
        RELEASE_BRANCH: "release/2026.10.18", RELEASE_PR_NUMBER: "145", RELEASE_BASE_SHA: "base-main",
        RELEASE_TAG: "v2026.10.19", NPM_VERSION: "2026.10.19", MERGED_SHA: "merged-main", ...extraEnv },
    });
    return { ...result, outputs: existsSync(output) ? readFileSync(output, "utf8") : "",
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** GitHub and Git command responses for a verified merge, including optional failures. */
const mergedReleaseCommands = `
  git() {
    case "$1" in
      rev-parse) if [[ "$2" == origin/main ]]; then printf base-main; else printf release-commit; fi ;;
      ls-remote) printf remote-sha ;;
    esac
  }
  gh() {
    case "$1 $2" in
      "pr edit") printf 'metadata edit denied' >&2; return 47 ;;
      "pr view") printf '{"merge_state":"CLEAN","unsettled":[],"failing":[]}' ;;
      "api graphql") return 0 ;;
      "api --method") printf '{"sha":"merged-main"}' ;;
      *) printf 'Unexpected GitHub command' >&2; return 99 ;;
    esac
  }
  rm() { printf 'diagnostic cleanup denied' >&2; return 48; }
`;

test("superseded close failures warn per PR and still try later PRs before continuing the release", () => {
  const result = runReleaseStep("Close superseded release PRs", `
    gh() {
      if [[ "$3" == 144 ]]; then printf 'close denied\\nsecond line 50%% unavailable\\r' >&2; return 47; fi
      printf 'closed PR #%s\\n' "$3"
    }
  `, { SUPERSEDED_PR_NUMBERS: "144 143" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::Could not close superseded release PR #144: close denied second line 50%25 unavailable/);
  assert.equal((result.stdout.match(/::warning::/g) ?? []).length, 1);
  assert.match(result.stdout, /closed PR #143/);
  assert.match(result.stdout, /release continues/);
});

test("optional branch lookup or leased deletion failures warn and cannot stop the release", () => {
  const cleanup = step("Clean up merged release branch");
  assert.ok(steps.indexOf(cleanup) > steps.indexOf(step("Merge release metadata through protected PR")));
  for (const failure of ["lookup", "delete", "none", "absent"]) {
    const result = runReleaseStep(cleanup.name, `
      git() {
        if [[ "$1" == ls-remote ]]; then
          if [[ "$TEST_FAILURE" == lookup ]]; then printf 'lookup denied' >&2; return 47; fi
          if [[ "$TEST_FAILURE" != absent ]]; then printf 'remote-sha\\trefs/heads/release/2026.10.18'; fi
        elif [[ "$1" == push ]]; then
          [[ "$*" == 'push --force-with-lease=refs/heads/release/2026.10.18:remote-sha origin :refs/heads/release/2026.10.18' ]] || return 99
          if [[ "$TEST_FAILURE" == delete ]]; then printf 'delete denied' >&2; return 48; fi
        fi
      }
    `, { TEST_FAILURE: failure });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release continues/);
    if (failure === "lookup" || failure === "delete") assert.match(result.stdout, new RegExp(`::warning::.*release/2026\\.10\\.18.*${failure} denied`));
    else assert.doesNotMatch(result.stdout, /::warning::/);
  }
});

test("metadata edit and diagnostic cleanup failures preserve the verified merged output", () => {
  const result = runReleaseStep("Merge release metadata through protected PR", mergedReleaseCommands);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::Could not refresh title\/body of release PR #145: metadata edit denied/);
  assert.match(result.stdout, /::warning::Could not remove release merge diagnostic files: diagnostic cleanup denied/);
  assert.match(result.stdout, /release continues/);
  assert.equal(result.outputs, "merged_sha=merged-main\npr_number=145\n");
});

test("resuming existing main metadata does not perform branch cleanup before publishing", () => {
  const result = runReleaseStep("Merge release metadata through protected PR", `
    git() {
      if [[ "$1" == rev-parse ]]; then printf base-main;
      elif [[ "$1" == ls-remote ]]; then printf remote-sha;
      elif [[ "$1" == push ]]; then printf 'unexpected branch deletion' >&2; return 47; fi
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, "merged_sha=base-main\npr_number=\n");
  assert.doesNotMatch(result.stderr, /unexpected branch deletion/);
});

test("summary failure only warns and artifact generation has no implicit summary writes", () => {
  const generation = step("Generate changelog and release notes");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.doesNotMatch(generation.run, /--github-step-summary/);
  assert.doesNotMatch(manifest.scripts["release:notes"]!, /--github-step-summary/);
  assert.doesNotMatch(step("Merge release metadata through protected PR").run, /GITHUB_STEP_SUMMARY/);
  for (const failure of ["", "true"]) {
    const result = runReleaseStep("Write release summary", "", { TEST_SUMMARY_FAILURE: failure });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release continues/);
    if (failure) assert.match(result.stdout, /::warning::Could not write release summary: .*/);
    else assert.equal(result.summary, "Release metadata at merged-main.\n\nCanonical changelog\nRelease notes\n");
  }
});

test("publication still fails closed when the registry never confirms an attested publish", () => {
  const publish = step("Publish npm package");
  assert.notEqual(publish["continue-on-error"], true);
  const result = runReleaseStep(publish.name, `
    npm() {
      if [[ "$1" == --version ]]; then printf 11.19.0;
      elif [[ "$1" == config ]]; then return 0;
      else printf 'registry unavailable' >&2; return 47; fi
    }
    sleep() { :; }
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Refusing to downgrade supply-chain attestations/);
  assert.doesNotMatch(result.stdout, /release continues/);
});

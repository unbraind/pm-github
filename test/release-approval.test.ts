/** Run the actual protected release wait loop against synthetic GitHub transport. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Resolve workflow structure using the parser already bundled with the pinned SDK. */
const { parse }: { parse: (source: string) => { jobs: { release: { steps: { name: string; run?: string }[] } } } } =
  createRequire(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"))("yaml");

/** Execute the complete protected merge step against synthetic Git/GitHub transports. */
function waiting(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), "release-approval-"));
  try {
    const source = readFileSync(join(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
    const merge = parse(source).jobs.release.steps.find(step => step.name === "Merge release metadata through protected PR");
    assert.ok(merge, "Missing protected release merge step");
    assert.equal(typeof merge.run, "string", "Protected release merge step must contain its script");
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin/gh"), `#!/usr/bin/env bash
set -eu
poll=0; [[ ! -f "$POLL" ]] || read -r poll < "$POLL"
case "$*" in
  'pr edit '*) ;;
  'pr view '*) printf '{"merge_state":"BLOCKED","unsettled":["test (22)"],"failing":[]}' ;;
  *'/merge '*)
    if [[ "$SCENARIO" == merged && "$poll" == 2 ]]; then printf '{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'; else exit 1; fi ;;
  *'actions/runs?head_sha='*)
    poll=$((poll+1)); printf '%s\\n' "$poll" > "$POLL"
    if [[ "$poll" == 1 || "$SCENARIO" == pending ]]; then printf '123\\n';
    elif [[ "$SCENARIO" == unavailable ]]; then echo 'API unavailable' >&2; exit 1; fi ;;
  *'/approve'*) exit 1 ;;
  'api graphql '*) ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const script = `
      git() {
        case "$1" in
          fetch | push) return 0 ;;
          rev-parse) if [[ "$2" == origin/main ]]; then printf base-main; else printf aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi ;;
          ls-remote) printf remote-sha ;;
          *) printf 'Unexpected Git command' >&2; return 99 ;;
        esac
      }
      sleep() { SECONDS=$((SECONDS + 900)); }
      ${merge.run}
    `;
    const output = join(directory, "outputs");
    const result = spawnSync("bash", ["-c", script], { cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: directory, TMPDIR: directory, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
        PATH: join(directory, "bin") + ":" + process.env.PATH, POLL: join(directory, "poll"), SCENARIO: scenario,
        GITHUB_REPOSITORY: "fixture/project", GITHUB_SERVER_URL: "https://github.com", GITHUB_OUTPUT: output,
        RELEASE_BRANCH: "release/2026.10.19", RELEASE_PR_NUMBER: "42", RELEASE_BASE_SHA: "base-main",
        RELEASE_TAG: "v2026.10.19", NPM_VERSION: "2026.10.19" } });
    return { ...result, outputs: existsSync(output) ? readFileSync(output, "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("release approval transitions to running checks before timeout", () => {
  const result = waiting("running");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /still settling: test \(22\)/);
  assert.doesNotMatch(result.stdout, /did not merge[^\n]*awaiting workflow approval/);
});

test("release approval still pending at timeout names the actual run", () => {
  const result = waiting("pending");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /actions\/runs\/123/);
  assert.match(result.stdout, /did not merge[^\n]*awaiting workflow approval/);
});

test("release approval read failure is distinct from a verified empty result", () => {
  const result = waiting("unavailable");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /workflow approval state is unavailable/);
  assert.doesNotMatch(result.stdout, /did not merge[^\n]*awaiting workflow approval/);
});

test("release approval history does not block a subsequent verified merge", () => {
  const result = waiting("merged");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Merged release PR #42 via merge API/);
  assert.doesNotMatch(result.stdout, /::error::/);
  assert.equal(result.outputs, "merged_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\npr_number=42\n");
});

/** Run the actual protected release wait loop against synthetic GitHub transport. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Execute only the merge-wait loop; no publication, Git pushes or live requests are possible. */
function waiting(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), "release-approval-"));
  try {
    const source = readFileSync(join(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");
    const loop = source.slice(source.indexOf("          deadline=$(( SECONDS + 1800 ))"), source.indexOf('          rm -f "$merge_err" "$pr_view_err"'))
      .split("\n").map(line => line.slice(10)).join("\n");
    assert.ok(loop.startsWith("deadline="));
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin/gh"), `#!/usr/bin/env bash
set -eu
poll=0; [[ ! -f "$POLL" ]] || read -r poll < "$POLL"
case "$*" in
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
    const script = 'set -euo pipefail\npr_number=42; release_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; owner=fixture; repo=project\nsleep() { SECONDS=$((SECONDS + 900)); }\n' + loop;
    return spawnSync("bash", ["-c", script], { cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: join(directory, "bin") + ":" + process.env.PATH, POLL: join(directory, "poll"), SCENARIO: scenario,
        GITHUB_REPOSITORY: "fixture/project", GITHUB_SERVER_URL: "https://github.com" } });
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
});

/** Exercise bounded registration discovery and exported receipts from the reusable workflow shell. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const handoffName = "Confirm caller CI registration and summarize handoff";
interface Workflow {
  on: { workflow_call?: { outputs?: Record<string, { value: string }> } };
  jobs: Record<string, { outputs?: Record<string, string>; steps?: { name?: string; run?: string; id?: string; "timeout-minutes"?: number }[] }>;
}

/** Parse the actual reusable workflow, retaining its executable bash. */
function workflow(kind: string): Workflow {
  return parse(readFileSync(join(root, `.github/workflows/pm-github-${kind}.yml`), "utf8")) as Workflow;
}

/** Run discovery against a real Git head and receipt-only GitHub responses without wall-clock sleeps. */
function fixture(kind: string, overrides: NodeJS.ProcessEnv, verify: (result: { status: number | null; stdout: string; stderr: string; output: Record<string, string>; summary: string; calls: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ci-handoff-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com",
    REPOSITORY: "acme/widgets", SYNC_PR_NUMBER: "7", SYNC_BRANCH: "automation/proposal", GITHUB_SERVER_URL: "https://github.com",
    DISPATCHED_CI_WORKFLOWS: "ci.yml codeql.yml", CI_DISPATCH_STARTED_AT: "2026-11-14T00:00:00Z",
    PARKED_CI_RUN_URLS: '["https://github.com/acme/widgets/actions/runs/99"]',
    GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"), RECEIPTS: join(dir, "receipts"),
    ...overrides, PATH: join(dir, "bin") + ":" + process.env.PATH };
  try {
    mkdirSync(join(dir, "bin"));
    for (const args of [["init", "-q"], ["commit", "--allow-empty", "-qm", "Head"]]) {
      const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    writeFileSync(join(dir, "bin/gh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RECEIPTS"
[[ "$1 $2" == 'run list' ]] || exit 99
[[ "$*" != *--status* && "$*" != *conclusion* ]] || exit 98
if [[ "\${LOOKUP:-}" == denied ]]; then printf 'partial output'; exit 1; fi
if [[ "\${LOOKUP:-}" == timeout ]]; then exit 124; fi
if [[ "\${LOOKUP:-}" == absent ]]; then exit 0; fi
if [[ "\${LOOKUP:-}" == partial && "$*" == *'--workflow codeql.yml'* ]]; then exit 0; fi
if [[ "\${LOOKUP:-}" == delayed && ! -f "$RECEIPTS.seen" ]]; then touch "$RECEIPTS.seen"; exit 0; fi
if [[ "$*" == *'--workflow ci.yml'* ]]; then printf 'https://github.com/acme/widgets/actions/runs/11\\n';
else printf 'https://github.com/acme/widgets/actions/runs/12\\n'; fi
`, { mode: 0o755 });
    writeFileSync(join(dir, "bin/sleep"), '#!/usr/bin/env bash\nprintf "sleep %s\\n" "$*" >> "$RECEIPTS"\n', { mode: 0o755 });
    writeFileSync(join(dir, "bin/timeout"), '#!/usr/bin/env bash\nprintf "budget %s\\n" "$2" >> "$RECEIPTS"\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const shell = workflow(kind).jobs[`gated-${kind}`]!.steps!.find(step => step.name === handoffName)!.run!;
    const result = spawnSync("bash", ["-c", shell], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
    const optionalRead = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
    const output = Object.fromEntries(optionalRead(env.GITHUB_OUTPUT).trim().split("\n").map(line => {
      const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
    }));
    verify({ status: result.status, stdout: result.stdout, stderr: result.stderr, output,
      summary: optionalRead(env.GITHUB_STEP_SUMMARY), calls: optionalRead(env.RECEIPTS) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const kind of ["sync", "closeout"]) {
  test(`${kind}: registration accepts queued runs immediately and exports PR, CI and parked URLs`, () => fixture(kind, {}, r => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output["pr-url"], "https://github.com/acme/widgets/pull/7");
    assert.equal(r.output["ci-confirmation"], "confirmed");
    assert.deepEqual(JSON.parse(r.output["ci-run-urls"]!), ["https://github.com/acme/widgets/actions/runs/11", "https://github.com/acme/widgets/actions/runs/12"]);
    assert.deepEqual(JSON.parse(r.output["parked-run-urls"]!), ["https://github.com/acme/widgets/actions/runs/99"]);
    for (const url of [r.output["pr-url"]!, ...JSON.parse(r.output["ci-run-urls"]!), ...JSON.parse(r.output["parked-run-urls"]!)]) assert.ok(r.summary.includes(url));
    assert.match(r.summary, /hourly approval sweep/);
    assert.doesNotMatch(r.calls, /sleep|--status|conclusion|watch|pr merge/);
    assert.equal(r.calls.split("\n").filter(line => line.startsWith("run list")).length, 2);
    assert.match(r.calls, /--branch automation\/proposal --commit [a-f0-9]{40} --event workflow_dispatch --created >=2026-11-14T00:00:00Z/);
  }));
  test(`${kind}: delayed registration retries only a missing workflow and exits before completion`, () => fixture(kind, { LOOKUP: "delayed" }, r => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output["ci-confirmation"], "confirmed");
    assert.equal(r.calls.split("\n").filter(line => line.includes("--workflow ci.yml")).length, 2);
    assert.equal(r.calls.split("\n").filter(line => line.includes("--workflow codeql.yml")).length, 1);
    assert.equal(r.calls.split("\n").filter(line => line.startsWith("sleep")).length, 1);
  }));
  for (const lookup of ["absent", "denied", "timeout", "partial"]) {
    test(`${kind}: bounded ${lookup} registration reports without failing sync or changing auto-merge`, () => fixture(kind, { LOOKUP: lookup }, r => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.output["ci-confirmation"], "timed_out");
      assert.match(r.stdout, /registration not confirmed within 60 seconds/);
      assert.match(r.summary, /timed_out/);
      assert.doesNotMatch(r.calls, /pr merge|watch|--status|conclusion/);
      assert.doesNotMatch(r.output["ci-run-urls"]!, /partial output/);
      assert.ok(r.calls.split("\n").filter(line => line.startsWith("run list")).length <= 24);
      assert.equal(r.calls.split("\n").filter(line => line.startsWith("sleep")).length, 11);
      if (lookup === "partial") assert.deepEqual(JSON.parse(r.output["ci-run-urls"]!), ["https://github.com/acme/widgets/actions/runs/11"]);
    }));
  }
  test(`${kind}: explicitly disabled dispatch reports the PR without querying or waiting`, () => fixture(kind, { DISPATCHED_CI_WORKFLOWS: "", PARKED_CI_RUN_URLS: undefined }, r => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output["ci-confirmation"], "disabled");
    assert.equal(r.output["ci-run-urls"], "[]");
    assert.equal(r.output["parked-run-urls"], "[]");
    assert.equal(r.calls, "");
  }));
  test(`${kind}: caller outputs are wired through job and workflow without new inputs`, () => {
    const source = workflow(kind);
    const job = source.jobs[`gated-${kind}`]!;
    for (const key of ["pr-url", "ci-run-urls", "parked-run-urls", "ci-confirmation"]) {
      assert.equal(source.on.workflow_call!.outputs![key]!.value, `\${{ jobs.gated-${kind}.outputs.${key} }}`);
      assert.equal(job.outputs![key], `\${{ steps.ci_handoff.outputs.${key} }}`);
    }
    const dispatch = job.steps!.find(step => step.name === "Dispatch caller CI and report parked runs")!.run!;
    assert.ok(dispatch.indexOf("CI_DISPATCH_STARTED_AT=") < dispatch.indexOf("\ndispatch_checks\n"));
    assert.match(dispatch, /PARKED_CI_RUN_URLS=/);
    if (kind === "closeout") assert.match(dispatch, /if \[\[ "\$\{CLOSEOUT_REVIEW:-0\}" == 0 \]\]; then\n  enable_auto_merge/);
  });
}

test("every reusable step forbids completion waits; only registration has a bounded appearance loop", () => {
  for (const file of readdirSync(join(root, ".github/workflows")).filter(file => /\.ya?ml$/.test(file))) {
    const source = parse(readFileSync(join(root, ".github/workflows", file), "utf8")) as Workflow;
    if (!source.on?.workflow_call) continue;
    for (const job of Object.values(source.jobs)) for (const step of job.steps ?? []) {
      const shell = step.run ?? "";
      assert.doesNotMatch(shell, /\bgh\s+(?:[^;\n]*?\s)?run\s+watch\b|\bgh\s+pr\s+checks\b[^\n]*--watch/, `${file}: completion watch forbidden`);
      if (step.name === handoffName) {
        assert.equal(step["timeout-minutes"], 2);
        assert.match(shell, /deadline=\$\(\(SECONDS \+ 60\)\)/);
        assert.match(shell, /for round in \{1\.\.12\}/);
        assert.match(shell, /\[\[ \$\{remaining\} -ge 10 \]\] \|\| break/);
        assert.match(shell, /timeout --signal=KILL 10s gh run list/);
        assert.match(shell, /--event workflow_dispatch --created/);
        assert.doesNotMatch(shell, /--status|conclusion|check-runs|check-suites|\bgh\s+run\s+view/);
        assert.equal((shell.match(/\bsleep\b/g) ?? []).length, 1);
      } else {
        assert.doesNotMatch(shell, /\bsleep\s+\S+/, `${file} ${step.name}: runner cannot sleep waiting for another run`);
      }
    }
  }
});

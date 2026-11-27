/** Run both reusable workflow preflights against installed caller launchers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface Step { name: string; run?: string; if?: string }

const name = "Check pm CLI host compatibility";
const minimum = "2026.10.23";
const maximum = "2026.11.6";
const release = "2026.11.15";
const prerelease = "2026.11.25-1";
const newer = "2026.11.23";
const declaredFrom = "2026.11.30";
const inheritedHoldEnv = { ...process.env, REQUESTED_PM_GITHUB_VERSION: release };

/** One outcome per preflight case, for both reusable workflows. */
interface Scenario {
  readonly name: string;
  readonly version: string | null;
  readonly case?: "below_minimum" | "newer_untested" | "declared_incompatible" | "unreadable";
  readonly hold?: string;
  readonly failure?: boolean;
  readonly termTrap?: boolean;
  readonly metadata?: string;
  readonly maximum?: string;
  readonly declared?: string;
}

const scenarios: readonly Scenario[] = [
  { name: "older host", version: "2026.10.22", case: "below_minimum" },
  { name: "older host with an explicit hold", version: "2026.10.22", hold: release, case: "below_minimum" },
  { name: "minimum host", version: minimum },
  { name: "supported host", version: "2026.11.5" },
  { name: "maximum host", version: maximum },
  { name: "newer untested host", version: newer, case: "newer_untested" },
  { name: "newer untested host with an explicit hold", version: newer, hold: release, case: "newer_untested" },
  { name: "newer untested host with a prerelease hold", version: newer, hold: prerelease, case: "newer_untested" },
  { name: "newer host below the declared known-incompatible version", version: newer, declared: declaredFrom, case: "newer_untested" },
  { name: "declared known-incompatible host", version: "2026.12.1", declared: declaredFrom, case: "declared_incompatible" },
  { name: "prerelease host", version: "2026.11.6-1", case: "unreadable" },
  { name: "prerelease host with an explicit hold", version: "2026.11.6-1", hold: release, case: "unreadable" },
  { name: "prerelease host with an unreadable range", version: "2026.11.6-1", metadata: "{}", case: "unreadable" },
  { name: "missing local launcher", version: null, case: "unreadable" },
  { name: "missing local launcher with an explicit hold", version: null, hold: release, case: "unreadable" },
  { name: "failing launcher", version: maximum, failure: true, case: "unreadable" },
  { name: "launcher ignoring SIGTERM", version: maximum, termTrap: true, case: "unreadable" },
  { name: "unreadable version", version: "malformed\n::error::fixture value", case: "unreadable" },
  { name: "missing range", version: maximum, metadata: "{}", case: "unreadable" },
  { name: "unreadable metadata", version: maximum, metadata: "[", case: "unreadable" },
  { name: "unbounded range", version: maximum, maximum: ">=2026.11.6", case: "unreadable" },
  { name: "inverted range", version: maximum, maximum: "2026.10.22", case: "unreadable" },
  { name: "declaration at the tested ceiling", version: newer, declared: maximum, case: "unreadable" },
  { name: "prerelease declaration", version: newer, declared: `${declaredFrom}-1`, case: "unreadable" },
];

/** The canonical grammar both preflights enforce; zero-padded components are refused. */
const canonicalStable = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}$/;
const canonicalVersion = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}(?:-[0-9]+)?$/;
const isStableText = (value: string) => canonicalStable.test(value);
const compareVersions = (left: string, right: string) => {
  const delta = left.split(".").map(Number).map((part, index) => part - Number(right.split(".")[index]));
  return delta.find(part => part !== 0) ?? 0;
};

/** Every recorded release metadata field the preflight may read. */
function releaseMetadata(scenario: Scenario): string {
  return scenario.metadata ?? JSON.stringify({
    name: "pm-github", version: scenario.hold ?? release,
    peerDependencies: { "@unbrained/pm-cli": `>=${minimum}` },
    devDependencies: { "@unbrained/pm-cli": scenario.maximum ?? maximum },
    ...(scenario.declared !== undefined ? { pmCliIncompatibleFrom: scenario.declared } : {}),
  });
}

/** Reproduce the preflight's own reasoning so the fixture pins exact behaviour. */
function expectedOutcome(scenario: Scenario) {
  const declaredStable = scenario.declared !== undefined && isStableText(scenario.declared);
  const ceiling = scenario.maximum ?? maximum;
  const rangeValid = !scenario.metadata && isStableText(minimum) && isStableText(ceiling)
    && compareVersions(minimum, ceiling) <= 0
    && (scenario.declared === undefined || declaredStable && compareVersions(scenario.declared, ceiling) > 0);
  const installed = scenario.version === null || scenario.failure || scenario.termTrap
    || (scenario.version !== null && !canonicalVersion.test(scenario.version))
    ? null : scenario.version;
  if (scenario.case === undefined) return { range: { minimum, maximum: ceiling }, installed, reason: "" };
  if (scenario.case === "newer_untested") {
    const reason = `pm CLI ${installed} is newer than the newest host this pm-github release was tested with (${ceiling}); continuing. `
      + (scenario.hold !== undefined
        ? `If the apply step fails, remove or update the pm-github-version hold that selected pm-github ${scenario.hold}, or move the workflow pin to a newer pm-github release.`
        : "If the apply step fails, move the workflow pin to a newer pm-github release.");
    return { range: { minimum, maximum: ceiling }, installed, reason };
  }
  const evidence = rangeValid
    ? scenario.case === "declared_incompatible"
      ? `pm-github ${release} was tested with pm CLI ${minimum} through ${ceiling} and declares pm CLI ${scenario.declared} or newer known-incompatible.`
      : `pm-github ${release} was tested with pm CLI ${minimum} through ${ceiling}.`
    : `The tested host range for pm-github ${release} could not be verified.`;
  const host = installed === null
    ? "The installed pm CLI version is unreadable."
    : isStableText(installed) ? `This repository installs pm CLI ${installed}.`
      : `This repository installs pm CLI ${installed}, which is not a stable release.`;
  const remedy = installed === null
    ? "Restore a working caller pm CLI install, then rerun with the current pm-github release."
    // No extension selection can support a prerelease host; only a stable CLI fixes it.
    : !isStableText(installed)
      ? (rangeValid
        ? `Install a stable pm CLI release within the tested range ${minimum} through ${ceiling}.`
        : "Install a stable pm CLI release, then retry with a release whose tested host range is readable.")
      : (scenario.hold !== undefined
        ? `Remove or update the pm-github-version hold that selected pm-github ${release}, or move the workflow pin to a release that supports ${installed}.`
        : `Move the workflow pin to a release that supports ${installed}.`);
  return { range: rangeValid ? { minimum, maximum: ceiling } : null, installed, reason: `${evidence} ${host} ${remedy}` };
}

for (const kind of ["sync", "closeout"]) {
  const file = new URL(`../.github/workflows/pm-github-${kind}.yml`, import.meta.url);
  const { jobs } = parse(readFileSync(file, "utf8")) as { jobs: Record<string, { steps: Step[] }> };
  const steps = jobs[`gated-${kind}`]!.steps;
  const preflight = steps.find(step => step.name === name);

  test(`${kind} checks compatibility after npm ci and before tracker commands`, () => {
    const index = steps.findIndex(step => step.name === name);
    assert.equal(steps[index - 1]?.name, "Install dependencies");
    assert.equal(steps[index + 1]?.name, "Resolve sync commit scope");
    assert.equal(preflight?.if, undefined);
    assert.ok(steps.findIndex(step => step.name === (kind === "sync" ? "Preview GitHub to pm plan" : "Close delivered tracker items")) > index);
  });

  for (const scenario of scenarios) test(`${kind} compatibility preflight: ${scenario.name}`, t => {
    const root = mkdtempSync(join(tmpdir(), "workflow-host-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "nested caller");
    const bin = join(project, "node_modules/.bin");
    const summary = join(root, "job-summary");
    const output = join(root, "step-output");
    const goal = join(root, "preview-ran");
    const selectedRelease = scenario.hold ?? release;
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "pm-github-release.json"), releaseMetadata(scenario));
    if (scenario.version !== null) {
      writeFileSync(join(bin, "pm"), `#!/bin/bash
${scenario.termTrap ? 'trap "" TERM' + "\n" : ""}[[ "$*" == --version ]] || exit 91
printf '%s\\n' '${scenario.version}'
${scenario.termTrap ? "sleep 30" : scenario.failure ? "exit 1" : ""}
`, { mode: 0o755 });
    }

    assert.ok(preflight?.run);
    const child = spawnSync("bash", ["-c", preflight.run + '\nprintf ran > "$PREVIEW_MARKER"'], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...inheritedHoldEnv, PM_GITHUB_VERSION: selectedRelease, NPM_PROJECT_PATH: project, RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, PREVIEW_MARKER: goal,
        REQUESTED_PM_GITHUB_VERSION: scenario.hold ?? "" },
    });
    assert.ifError(child.error);
    const { range, installed, reason } = expectedOutcome(scenario);
    if (scenario.case === undefined) {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout + child.stderr, "");
      assert.equal(existsSync(summary), false);
      assert.equal(existsSync(goal), true);
      assert.equal(existsSync(output), false, "a supported host exports no hint");
      return;
    }
    const report = { case: scenario.case, pm_github_version: selectedRelease, pm_cli_version: installed, tested_host_range: range, reason,
      ...(scenario.case === "declared_incompatible" ? { declared_incompatible_from: scenario.declared } : {}) };
    if (scenario.case === "newer_untested") {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(existsSync(goal), true, "a newer-than-tested host must continue to the tracker commands");
      assert.deepEqual(JSON.parse(child.stdout), report);
      assert.equal(child.stderr, `::warning::${reason}\n`);
      assert.equal(readFileSync(summary, "utf8"), `### pm CLI host compatibility (pm-github ${selectedRelease})\n\n${reason}\n`);
      assert.equal(readFileSync(join(root, "pm-cli-host-compatibility-hint"), "utf8"), `${reason}\n`);
      assert.equal(readFileSync(output, "utf8"), `hint=${reason}\n`);
      return;
    }
    assert.equal(child.status, 1, child.stderr);
    assert.equal(existsSync(goal), false);
    assert.deepEqual(JSON.parse(child.stdout), report);
    assert.equal(child.stderr, `::error::${reason}\n`);
    assert.equal(readFileSync(summary, "utf8"), `### pm CLI host compatibility\n\n${reason}\n`);
    assert.equal(existsSync(join(root, "pm-cli-host-compatibility-hint")), false, "a stopped host exports no hint");
    assert.equal(existsSync(output), false, "a stopped host exports no hint");
  });
}

test("the real fleet pair follows this release's recorded compatibility policy", t => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    peerDependencies: Record<string, string>; devDependencies: Record<string, string>; pmCliIncompatibleFrom?: string;
  };
  const cli = "@unbrained/pm-cli";
  const peerFloor = manifest.peerDependencies[cli]!;
  assert.ok(peerFloor.startsWith(">="), "the peer dependency must declare a canonical floor");
  const floor = peerFloor.slice(2);
  assert.match(floor, canonicalStable);
  const ceiling = manifest.devDependencies[cli]!;
  const declared = manifest.pmCliIncompatibleFrom;
  const host = "2026.11.24";
  // The expected outcome follows the recorded policy, so a pin advance or a new
  // declared cutoff changes the assertion instead of breaking the fixture.
  const expected = compareVersions(host, floor) < 0 ? "below_minimum"
    : declared !== undefined && compareVersions(host, declared) >= 0 ? "declared_incompatible"
    : compareVersions(host, ceiling) > 0 ? "newer_untested" : "supported";
  for (const kind of ["sync", "closeout"]) {
    const root = mkdtempSync(join(tmpdir(), "workflow-host-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "nested caller");
    const bin = join(project, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pm"), `#!/bin/bash
printf '%s\\n' '${host}'
`, { mode: 0o755 });
    writeFileSync(join(root, "pm-github-release.json"), JSON.stringify({
      name: "pm-github", version: release,
      peerDependencies: { [cli]: `>=${floor}` },
      devDependencies: { [cli]: ceiling },
      ...(declared !== undefined ? { pmCliIncompatibleFrom: declared } : {}),
    }));
    const { jobs } = parse(readFileSync(new URL(`../.github/workflows/pm-github-${kind}.yml`, import.meta.url), "utf8")) as { jobs: Record<string, { steps: Step[] }> };
    const preflight = jobs[`gated-${kind}`]!.steps.find(step => step.name === name)!;
    const child = spawnSync("bash", ["-c", preflight.run! + '\nprintf ran > "$PREVIEW_MARKER"'], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...inheritedHoldEnv, PM_GITHUB_VERSION: release, NPM_PROJECT_PATH: project, RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: join(root, "job-summary"), GITHUB_OUTPUT: join(root, "step-output"), PREVIEW_MARKER: join(root, "preview-ran"),
        REQUESTED_PM_GITHUB_VERSION: "" },
    });
    assert.ifError(child.error);
    if (expected === "supported") {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout + child.stderr, "", "the fleet host is inside the tested range: silent pass");
      continue;
    }
    if (expected === "newer_untested") {
      const hint = `pm CLI ${host} is newer than the newest host this pm-github release was tested with (${ceiling}); continuing. If the apply step fails, move the workflow pin to a newer pm-github release.`;
      assert.equal(child.status, 0, child.stderr);
      assert.equal(existsSync(join(root, "preview-ran")), true);
      assert.deepEqual(JSON.parse(child.stdout), { case: "newer_untested", pm_github_version: release, pm_cli_version: host, tested_host_range: { minimum: floor, maximum: ceiling }, reason: hint });
      assert.equal(child.stderr, `::warning::${hint}\n`);
      // The no-hold warning summary must name the selected release, per the acceptance criteria.
      assert.equal(readFileSync(join(root, "job-summary"), "utf8"), `### pm CLI host compatibility (pm-github ${release})\n\n${hint}\n`);
      continue;
    }
    const evidence = expected === "declared_incompatible"
      ? `pm-github ${release} was tested with pm CLI ${floor} through ${ceiling} and declares pm CLI ${declared} or newer known-incompatible.`
      : `pm-github ${release} was tested with pm CLI ${floor} through ${ceiling}.`;
    assert.equal(child.status, 1, child.stderr);
    assert.equal(existsSync(join(root, "preview-ran")), false);
    assert.deepEqual(JSON.parse(child.stdout), { case: expected, pm_github_version: release, pm_cli_version: host,
      tested_host_range: { minimum: floor, maximum: ceiling },
      ...(expected === "declared_incompatible" ? { declared_incompatible_from: declared } : {}),
      reason: `${evidence} This repository installs pm CLI ${host}. Move the workflow pin to a release that supports ${host}.` });
  }
});


for (const kind of ["sync", "closeout"]) {
  test(`${kind} apply failures preserve the newer-host hint even when the diagnostic renderer fails`, t => {
    const underlying = "Extension mutation guard github-import-owner failed before import";
    const hint = `pm CLI ${newer} is newer than the newest host this pm-github release was tested with (${maximum}); continuing. If the apply step fails, move the workflow pin to a newer pm-github release.`;
    const { jobs } = parse(readFileSync(new URL(`../.github/workflows/pm-github-${kind}.yml`, import.meta.url), "utf8")) as { jobs: Record<string, { steps: Step[] }> };
    const scope = jobs[`gated-${kind}`]!.steps.find(step => step.name === "Resolve sync commit scope")!.run!
      .split("<<'SCOPE'\n")[1]!.split("\nSCOPE")[0]! + "\n";
    const root = mkdtempSync(join(tmpdir(), "workflow-hint-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const binDir = join(root, "bin");
    const runnerTemp = join(root, "runner-temp");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "pm"), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "github workflow-diagnostic")
    case "$RENDERER_MODE" in
      unavailable)
        printf '%s\\n' "private partial stdout"
        printf '%s\\n' "::error::private renderer stderr" >&2
        exit 23 ;;
      malformed) printf '%s\\n' "private malformed diagnostic" ;;
      multiple) printf '%s\\n' '{"reason":"private first diagnostic"}' '{"reason":"private second diagnostic"}' ;;
      *) printf '%s\\n' '{"reason":"${underlying}"}' ;;
    esac ;;
  "github gate") [[ -z "\${GATE_BLOCK:-}" ]] || exit 1; printf '%s\\n' '{}' ;;
  *) exit 23 ;;
esac
`, { mode: 0o755 });
    const scopeFile = join(root, "scope.sh");
    writeFileSync(scopeFile, scope);
    const reportFile = join(root, "report.json");
    const errorFile = join(root, "error.log");

    const reportFailure = (hintText: string | null, gateBlock = false, rendererMode = "valid") => {
      rmSync(runnerTemp, { recursive: true, force: true });
      mkdirSync(runnerTemp, { recursive: true });
      writeFileSync(reportFile, '{"reason":"private raw receipt"}');
      writeFileSync(errorFile, "private raw error");
      if (hintText !== null) writeFileSync(join(runnerTemp, "pm-cli-host-compatibility-hint"), `${hintText}\n`);
      const child = spawnSync("bash", ["-c", `set -euo pipefail\nsource "${scopeFile}"\nreport_workflow_failure "${reportFile}" "${errorFile}"`], {
        cwd: root, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, PATH: binDir + delimiter + process.env.PATH, RUNNER_TEMP: runnerTemp,
          GATE_BLOCK: gateBlock ? "1" : "", RENDERER_MODE: rendererMode, REQUESTED_PM_GITHUB_VERSION: "" },
      });
      assert.ifError(child.error);
      return child;
    };

    const withHint = reportFailure(hint);
    assert.equal(withHint.status, 0, withHint.stdout + withHint.stderr);
    assert.equal(withHint.stdout, `::error::${hint} ${underlying}\n`);
    // The privacy gate scans only the untrusted reason; the hint is workflow-built text.
    assert.equal(readFileSync(join(runnerTemp, "pm-github-diagnostic.patch"), "utf8"),
      `--- /dev/null\n+++ b/workflow-diagnostic.txt\n@@ -0,0 +1 @@\n+${underlying}\n`);

    const withoutHint = reportFailure(null);
    assert.equal(withoutHint.status, 0, withoutHint.stdout + withoutHint.stderr);
    assert.equal(withoutHint.stdout, `::error::${underlying}\n`);

    const blocked = reportFailure(hint, true);
    assert.equal(blocked.status, 0, blocked.stdout + blocked.stderr);
    assert.equal(blocked.stdout, `::error::${hint} Failure diagnostic blocked by the privacy gate; review source content before retrying. No branch was published.\n`);

    const holdHint = hint.replace("move the workflow pin", `remove or update the pm-github-version hold that selected pm-github ${prerelease}, or move the workflow pin`);
    const withPrereleaseHold = reportFailure(holdHint);
    assert.equal(withPrereleaseHold.status, 0, withPrereleaseHold.stdout + withPrereleaseHold.stderr);
    assert.equal(withPrereleaseHold.stdout, `::error::${holdHint} ${underlying}\n`);
    const blockedWithPrereleaseHold = reportFailure(holdHint, true);
    assert.equal(blockedWithPrereleaseHold.status, 0, blockedWithPrereleaseHold.stdout + blockedWithPrereleaseHold.stderr);
    assert.equal(blockedWithPrereleaseHold.stdout, `::error::${holdHint} Failure diagnostic blocked by the privacy gate; review source content before retrying. No branch was published.\n`);

    // A replaced hint file never reaches either annotation branch.
    const secret = "ghp_" + "A".repeat(36);
    for (const replaced of [
      `${hint} Untrusted suffix.`, `Untrusted diagnostic ${secret}`, hint.replace(`(${maximum})`, "(2026.11.006)"),
      holdHint.replace(prerelease, "2026.11.25-beta"), holdHint.replace(`pm CLI ${newer}`, `pm CLI ${newer}-1`),
      holdHint.replace(`(${maximum})`, `(${maximum}-1)`),
    ]) {
      const poisoned = reportFailure(replaced);
      assert.equal(poisoned.status, 0, poisoned.stdout + poisoned.stderr);
      assert.equal(poisoned.stdout, `::error::${underlying}\n`, "replaced hint text must never reach the annotation");
      const poisonedBlocked = reportFailure(replaced, true);
      assert.equal(poisonedBlocked.status, 0, poisonedBlocked.stdout + poisonedBlocked.stderr);
      assert.equal(poisonedBlocked.stdout, "::error::Failure diagnostic blocked by the privacy gate; review source content before retrying. No branch was published.\n",
        "the gate-blocked branch never prints an unverified hint");
      assert.ok(!poisonedBlocked.stdout.includes(secret));
    }

    for (const rendererMode of ["unavailable", "malformed", "multiple"]) {
      for (const hintText of [null, hint, holdHint, `${hint} Untrusted suffix.`]) {
        const failed = reportFailure(hintText, false, rendererMode);
        const prefix = hintText === hint || hintText === holdHint ? `${hintText} ` : "";
        assert.equal(failed.status, 0, failed.stdout + failed.stderr);
        assert.equal(failed.stderr, "");
        assert.equal(failed.stdout, `::error::${prefix}Failure diagnostic unavailable. Review the failed step before retrying. No branch was published.\n`);
        assert.equal(existsSync(join(runnerTemp, "pm-github-diagnostic.patch")), false);
      }
    }
  });
}

test("caller documentation ties CLI upgrades to both pins and explains the tested range and unreadable version", () => {
  for (const file of ["README.md", "docs/sync-workflow-caller.yml", "docs/closeout-workflow-caller.yml", "docs/daily-sync-recovery.md"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(text, /upgrade the pm CLI and both workflow pins together/i, file);
    assert.match(text, /tested host\s+range/i, file);
  }
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /upper\s+endpoint is the release's exact pm CLI development dependency/);
  assert.match(readme, /unreadable\s+version, restore the caller's local CLI installation first/);
  assert.match(readme, /newer\s+than\s+the\s+newest\s+host\s+this\s+pm-github\s+release\s+was\s+tested\s+with/);
  assert.match(readme, /remove or update the `pm-github-version` hold/);
  assert.match(readme, /pmCliIncompatibleFrom/);
  for (const file of ["docs/sync-workflow-caller.yml", "docs/closeout-workflow-caller.yml"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(text, /newer-than-tested host warns once and continues/);
    assert.match(text, /leads? with that hint and its workflow-pin remedy/);
  }
  const recovery = readFileSync(new URL("../docs/daily-sync-recovery.md", import.meta.url), "utf8");
  assert.match(recovery, /newer-than-tested\s+host\s+does\s+not\s+stop\s+the\s+run/);
  assert.match(recovery, /lead with that hint/);
  assert.match(recovery, /`pm-github-version` hold/);
});

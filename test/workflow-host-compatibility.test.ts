/** Run both reusable workflow preflights against installed caller launchers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface Step { name: string; run?: string; if?: string }

const name = "Check pm CLI host compatibility";
const minimum = "2026.10.23";
const maximum = "2026.11.6";
const release = "2026.11.15";
const outside = "pm_cli_outside_tested_range";
const unreadable = "pm_cli_version_unreadable";
const invalidRange = "pm_github_host_range_unreadable";

const scenarios = [
  { name: "older host", version: "2026.10.22", code: outside },
  { name: "minimum host", version: minimum },
  { name: "supported host", version: "2026.11.5" },
  { name: "maximum host", version: maximum },
  { name: "newer untested host", version: "2026.11.23", code: outside },
  { name: "prerelease host", version: "2026.11.6-1", code: outside },
  { name: "missing local launcher", version: null, code: unreadable },
  { name: "failing launcher", version: maximum, failure: true, code: unreadable },
  { name: "unreadable version", version: "malformed\n::error::fixture value", code: unreadable },
  { name: "missing range", version: maximum, metadata: "{}", code: invalidRange },
  { name: "unreadable metadata", version: maximum, metadata: "[", code: invalidRange },
  { name: "unbounded range", version: maximum, maximum: ">=2026.11.6", code: invalidRange },
  { name: "inverted range", version: maximum, maximum: "2026.10.22", code: invalidRange },
];

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
    const goal = join(root, "preview-ran");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "pm-github-release.json"), scenario.metadata ?? JSON.stringify({
      name: "pm-github", version: release,
      peerDependencies: { "@unbrained/pm-cli": `>=${minimum}` },
      devDependencies: { "@unbrained/pm-cli": scenario.maximum ?? maximum },
    }));
    if (scenario.version !== null) {
      writeFileSync(join(bin, "pm"), `#!/bin/bash
[[ "$*" == --version ]] || exit 91
printf '%s\\n' '${scenario.version}'
${scenario.failure ? "exit 1" : ""}
`, { mode: 0o755 });
    }

    assert.ok(preflight?.run);
    const child = spawnSync("bash", ["-c", preflight.run + '\nprintf ran > "$PREVIEW_MARKER"'], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PM_GITHUB_VERSION: release, NPM_PROJECT_PATH: project, RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: summary, PREVIEW_MARKER: goal },
    });
    assert.ifError(child.error);
    if (!scenario.code) {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout + child.stderr, "");
      assert.equal(existsSync(summary), false);
      assert.equal(existsSync(goal), true);
      return;
    }
    assert.equal(child.status, 1, child.stderr);
    assert.equal(existsSync(goal), false);
    const expectedVersion = scenario.code === unreadable ? null : scenario.version;
    const range = scenario.code === invalidRange ? null : { minimum, maximum };
    const report: unknown = JSON.parse(child.stdout);
    const evidence = range ? `pm-github ${release} was tested with pm CLI ${minimum} through ${maximum}.`
      : `The tested host range for pm-github ${release} could not be verified.`;
    const host = expectedVersion ? `This repository installs pm CLI ${expectedVersion}.` : "The installed pm CLI version is unreadable.";
    const remedy = expectedVersion ? `Move the workflow pin to a release that supports ${expectedVersion}.`
      : "Restore a working caller pm CLI install, then move the workflow pin to a release that supports it.";
    const reason = `${evidence} ${host} ${remedy}`;
    assert.deepEqual(report, { code: scenario.code, pm_github_version: release, pm_cli_version: expectedVersion, tested_host_range: range, reason });
    assert.equal(child.stderr, `::error::${reason}\n`);
    assert.equal(readFileSync(summary, "utf8"), `### pm CLI host compatibility\n\n${reason}\n`);
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
  assert.match(readme, /unreadable version, restore the caller's local CLI installation first/);
});

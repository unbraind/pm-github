/** Execute release-tag resolution and exact installation from the real workflows. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const files = [".github/workflows/pm-github-sync.yml", ".github/workflows/pm-github-closeout.yml"];
const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const workflowSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const version = "2027.1.2-3";

/** Extract one named step's real bash without executing adjacent steps. */
function shell(source: string, name: string): string {
  const step = source.split("      - name: ").find(part => part.startsWith(name + "\n"));
  assert.ok(step, name);
  const block = /        run: \|\n([\s\S]*)/.exec(step);
  assert.ok(block, name);
  return block[1].split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
}

/** Dispose isolated caller files even when a contract assertion fails. */
function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-version-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

/** Execute real bash steps with an explicit environment and bounded runtime. */
function bash(cwd: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", script], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 });
}

/** Inject only remote transport and package installation, retaining real resolver bash. */
function setup(cwd: string): NodeJS.ProcessEnv {
  mkdirSync(join(cwd, "bin"));
  mkdirSync(join(cwd, ".agents/pm/extensions/pm-github"), { recursive: true });
  writeFileSync(join(cwd, "bin/git"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 4 && "$1" == ls-remote && "$2" == --tags && "$3" == https://github.com/unbraind/pm-github && "$4" == 'refs/tags/v*' ]] || exit 95
printf '%s\\n' "$REMOTE_TAGS"
exit "\${REMOTE_STATUS:-0}"
`, { mode: 0o755 });
  writeFileSync(join(cwd, "bin/pm"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == package && "$2" == install && "$4" == --project ]]
printf '%s\\n' "$3" > receipt
printf '{"version":"%s"}' "\${INSTALLED_VERSION:-\${3#npm:pm-github@}}" > "$PM_SYNC_TRACKER/extensions/pm-github/package.json"
`, { mode: 0o755 });
  return { WORKFLOW_SHA: workflowSha, REMOTE_TAGS: "", REMOTE_STATUS: "0", INSTALLED_VERSION: "",
    REQUESTED_PM_GITHUB_VERSION: "", GITHUB_ENV: join(cwd, "github-env"),
    PM_SYNC_TRACKER: ".agents/pm", PATH: join(cwd, "bin") + ":" + process.env.PATH };
}

for (const file of files) {
  const source = readFileSync(join(root, file), "utf8");
  const kind = file.includes("closeout") ? "closeout" : "sync";
  const scenarios = [
    { name: "lightweight tag", tags: `${workflowSha}\trefs/tags/v${version}`, expected: version },
    { name: "peeled annotated tag", tags: `${otherSha}\trefs/tags/v${version}\n${workflowSha}\trefs/tags/v${version}^{}`, expected: version },
    { name: "peeled tag before object", tags: `${workflowSha}\trefs/tags/v${version}^{}\n${otherSha}\trefs/tags/v${version}`, expected: version },
    { name: "unrelated and malformed tags ignored", tags: `${otherSha}\trefs/tags/v2020.1.1\n${workflowSha}\trefs/tags/vlatest\n${workflowSha}\trefs/tags/v${version}`, expected: version },
    { name: "numeric version without suffix", tags: `${workflowSha}\trefs/tags/v2027.1.2`, expected: "2027.1.2" },
    { name: "no match with legacy input", tags: `${otherSha}\trefs/tags/v2020.1.1`, input: "2020.1.1", expected: "2020.1.1", warning: true },
    { name: "tag overrides mismatched input", tags: `${workflowSha}\trefs/tags/v${version}`, input: "2020.1.1", expected: version, warning: true },
    { name: "tag overrides malicious input safely", tags: `${workflowSha}\trefs/tags/v${version}`, input: "$(touch injected)\n::error::injected", expected: version, warning: true },
    { name: "matching legacy input", tags: `${workflowSha}\trefs/tags/v${version}`, input: version, expected: version },
    { name: "no match without input", tags: `${otherSha}\trefs/tags/v${version}`, error: /Pin a release SHA/ },
    { name: "tag object is not a commit match", tags: `${workflowSha}\trefs/tags/v${version}\n${otherSha}\trefs/tags/v${version}^{}`, error: /Pin a release SHA/ },
    { name: "floating fallback refused", tags: "", input: "latest", error: /exact numeric version/ },
    { name: "malicious fallback refused safely", tags: "", input: "$(touch injected)\n::error::injected", error: /exact numeric version/ },
    { name: "remote failure cannot use fallback", tags: "", input: "2020.1.1", remoteStatus: "128", error: /Cannot read pm-github release tags/ },
    { name: "missing workflow identity refused", tags: "", sha: "", input: "2020.1.1", error: /job.workflow_sha/ },
    { name: "ambiguous release versions refused", tags: `${workflowSha}\trefs/tags/v2020.1.1\n${workflowSha}\trefs/tags/v${version}`, error: /Multiple release versions/ },
  ];
  for (const scenario of scenarios) {
    test(`${kind} resolves ${scenario.name}`, () => fixture(cwd => {
      const env: NodeJS.ProcessEnv = { ...setup(cwd), REMOTE_TAGS: scenario.tags, REQUESTED_PM_GITHUB_VERSION: scenario.input ?? "",
        WORKFLOW_SHA: scenario.sha ?? workflowSha, REMOTE_STATUS: scenario.remoteStatus ?? "0" };
      const script = shell(source, "Resolve pm-github release version");
      const result = bash(cwd, script, env);
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /::error::injected/);
      assert.notEqual(bash(cwd, "test -e injected").status, 0);
      if (scenario.error) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, scenario.error);
        assert.notEqual(bash(cwd, 'test -s "$GITHUB_ENV"', env).status, 0);
      } else {
        assert.equal(result.status, 0, output);
        assert.equal(readFileSync(env.GITHUB_ENV!, "utf8"), `PM_GITHUB_VERSION=${scenario.expected}\n`);
        assert.equal(output.includes("::warning::pm-github-version is deprecated"), !!scenario.warning, output);
        // Consume the real GITHUB_ENV file as the runner does for the install step.
        const install = 'set -a; source "$GITHUB_ENV"; set +a\n' + shell(source, "Install pinned pm-github extension");
        const installed = bash(cwd, install, env);
        assert.equal(installed.status, 0, installed.stderr + installed.stdout);
        assert.equal(readFileSync(join(cwd, "receipt"), "utf8").trim(), `npm:pm-github@${scenario.expected}`);
        const wrong = bash(cwd, install, { ...env, INSTALLED_VERSION: "1999.1.1" });
        assert.notEqual(wrong.status, 0, "installed-version verification remains fail closed");
      }
    }));
  }
  test(`${kind} binds documented job identity and omits deprecated template input`, () => {
    assert.match(source, /WORKFLOW_SHA: \$\{\{ job.workflow_sha \}\}/);
    assert.match(source, /REQUESTED_PM_GITHUB_VERSION: \$\{\{ inputs.pm-github-version \}\}/);
    assert.match(source, /pm-github-version:\n        description: [^\n]+\n        type: string\n        required: false\n        default: ""/);
    assert.doesNotMatch(shell(source, "Resolve pm-github release version"), /\$\{\{/);
    const caller = readFileSync(join(root, `docs/${kind}-workflow-caller.yml`), "utf8");
    assert.doesNotMatch(caller, /pm-github-version/);
    assert.match(caller, /@RELEASE_COMMIT_SHA # vRELEASE_VERSION/);
  });
}

test("both reusable workflows execute identical version resolution", () => {
  assert.equal(shell(readFileSync(join(root, files[0]), "utf8"), "Resolve pm-github release version"),
    shell(readFileSync(join(root, files[1]), "utf8"), "Resolve pm-github release version"));
});

test("release retains token behavior and never stamps or commits reusable workflows", () => {
  assert.doesNotMatch(release, /release_token|RELEASE_APP_|release-stamped|Stamp the workflow/);
  assert.match(release, /GH_TOKEN: \$\{\{ github.token \}\}/);
  for (const step of ["Update release version", "Commit release files", "Verify merged release"]) {
    assert.doesNotMatch(shell(release, step), /pm-github-(?:sync|closeout)\.yml/);
  }
});

/** Keep the two independent version-discovery requirements explicit in caller documentation. */
test("version discovery documents App-free lookup and no release-time stamping", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /Release version discovery needs no GitHub App, and no release-time workflow stamping is required\./);
  assert.match(readme, /The release workflow keeps its existing token behavior\./);
});

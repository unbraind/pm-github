/** Execute version selection and release stamping from the real workflow files. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const files = [".github/workflows/pm-github-sync.yml", ".github/workflows/pm-github-closeout.yml"];
const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

/** Extract one named step's real bash without executing adjacent steps. */
function shell(source: string, name: string): string {
  const step = source.split("      - name: ").find(part => part.startsWith(name + "\n"));
  assert.ok(step, name);
  const block = /        run: \|\n([\s\S]*)/.exec(step);
  assert.ok(block, name);
  return block[1].split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
}

/** Dispose isolated release/caller files even when a contract assertion fails. */
function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-version-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

/** Execute real bash steps with an explicit environment and bounded runtime. */
function bash(cwd: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", script], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000 });
}

/** Read the published default from the actual workflow_call input declaration. */
function defaultVersion(source: string): string {
  const match = /      pm-github-version:\n        description: [^\n]+\n        type: string\n        required: false\n        default: "([^"\n]+)"/.exec(source);
  assert.ok(match, "legacy input remains optional with an embedded default");
  return match[1];
}

/** Prepare real release inputs; npm performs its own version and lockfile update. */
function prepare(cwd: string): void {
  mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
  for (const file of files) writeFileSync(join(cwd, file), readFileSync(join(root, file)));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "workflow-fixture", version, scripts: { build: "node -e ''" } }));
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ name: "workflow-fixture", version, lockfileVersion: 3, packages: { "": { name: "workflow-fixture", version } } }));
  writeFileSync(join(cwd, "manifest.json"), JSON.stringify({ version }));
  writeFileSync(join(cwd, "index.ts"), `export const extension = { version: "${version}" };\n`);
  writeFileSync(join(cwd, "CHANGELOG.md"), "Fixture\n");
}

for (const file of files) {
  const source = readFileSync(join(root, file), "utf8");
  const kind = file.includes("closeout") ? "closeout" : "sync";
  for (const requested of [undefined, "", version, "2020.1.1", "latest", "bad\n::error::injected"]) {
    test(`${kind} installs embedded version for legacy input ${JSON.stringify(requested)}`, () => fixture(cwd => {
      const fallback = defaultVersion(source);
      assert.equal(fallback, version);
      const input = requested ?? fallback;
      const binding = /^      PM_GITHUB_VERSION: (.+)$/m.exec(source)?.[1];
      assert.ok(binding);
      // Resolve the real job binding; reverting it to the input changes execution.
      const embedded = binding.startsWith('"') ? JSON.parse(binding.split(" #")[0]) as string : input;
      assert.match(source, /^      REQUESTED_PM_GITHUB_VERSION: \$\{\{ inputs.pm-github-version \}\}$/m);
      const tracker = ".agents/pm";
      mkdirSync(join(cwd, tracker, "extensions/pm-github"), { recursive: true });
      mkdirSync(join(cwd, "bin"));
      writeFileSync(join(cwd, "bin/pm"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == package && "$2" == install && "$4" == --project ]]
printf '%s\\n' "$3" > "$INSTALL_RECEIPT"
printf '{"version":"%s"}' "\${INSTALLED_VERSION:-\${3#npm:pm-github@}}" > "$PM_SYNC_TRACKER/extensions/pm-github/package.json"
`, { mode: 0o755 });
      const env = { PM_GITHUB_VERSION: embedded, REQUESTED_PM_GITHUB_VERSION: input,
        REPOSITORY: "acme/widgets", CALLING_REPOSITORY: "acme/widgets", DEFAULT_BRANCH: "main",
        SYNC_BRANCH: kind === "sync" ? "automation/pm-github-sync" : "pm-github/closeout",
        PM_SYNC_TRACKER: tracker, INSTALL_RECEIPT: join(cwd, "receipt"), PATH: join(cwd, "bin") + ":" + process.env.PATH };
      const script = shell(source, `Validate ${kind} inputs`) + "\n" + shell(source, "Install pinned pm-github extension");
      const result = bash(cwd, script, env);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(readFileSync(join(cwd, "receipt"), "utf8").trim(), `npm:pm-github@${version}`);
      assert.equal(result.stdout.includes("::warning::pm-github-version is deprecated"), input !== version, result.stdout);
      assert.doesNotMatch(result.stdout, /::error::injected/);
      const wrong = bash(cwd, script, { ...env, INSTALLED_VERSION: "2020.1.1" });
      assert.notEqual(wrong.status, 0, "the installed-version verification remains fail closed");
    }));
  }
  test(`${kind} template omits deprecated version input`, () => {
    const caller = readFileSync(join(root, `docs/${kind}-workflow-caller.yml`), "utf8");
    assert.doesNotMatch(caller, /pm-github-version/);
    assert.match(caller, /@RELEASE_COMMIT_SHA # vRELEASE_VERSION/);
  });
}

for (const nextVersion of ["2027.1.1", "2027.1.1-2"]) {
  test(`release preparation stamps and commits both workflows at ${nextVersion}`, () => fixture(cwd => {
    prepare(cwd);
    const env = { NPM_VERSION: nextVersion, REPO_NAME: "workflow-fixture", RELEASE_TAG: `v${nextVersion}` };
    const update = shell(release, "Update release version");
    const result = bash(cwd, update, env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const file of files) {
      const stamped = readFileSync(join(cwd, file), "utf8");
      assert.equal(defaultVersion(stamped), nextVersion);
      assert.match(stamped, new RegExp(`PM_GITHUB_VERSION: "${nextVersion.replaceAll(".", "\\.")}" # release-stamped install version`));
    }
    assert.equal(bash(cwd, update, env).status, 0, "same-version retry remains idempotent");
    assert.equal(bash(cwd, "git init -q").status, 0);
    const commit = bash(cwd, shell(release, "Commit release files"), env);
    assert.equal(commit.status, 0, commit.stderr + commit.stdout);
    for (const file of files) {
      const committed = bash(cwd, `git show HEAD:${file}`);
      assert.equal(committed.status, 0, committed.stderr);
      assert.equal(defaultVersion(committed.stdout), nextVersion);
      assert.match(shell(release, "Verify merged release"), new RegExp(file.replaceAll(".", "\\.")));
    }
    const order = ["Update release version", "Run release checks", "Commit release files", "Merge release metadata through protected PR", "Verify merged release", "Publish npm package"];
    const offsets = order.map(name => release.indexOf(`      - name: ${name}\n`));
    assert.ok(offsets.every((offset, index) => offset >= 0 && (index === 0 || offset > offsets[index - 1])));
  }));
}

for (const damaged of ["missing", "duplicate"]) {
  test(`release preparation refuses a ${damaged} stamp marker`, () => fixture(cwd => {
    prepare(cwd);
    const file = join(cwd, files[1]);
    const source = readFileSync(file, "utf8");
    const marker = /^      PM_GITHUB_VERSION: .+$/m.exec(source)![0];
    writeFileSync(file, source.replace(marker, damaged === "missing" ? "" : marker + "\n" + marker));
    const result = bash(cwd, shell(release, "Update release version"), { NPM_VERSION: "2027.1.1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing or duplicate version stamp/);
  }));
}

test("release app credential is scoped to workflow writes and required before version preparation", () => fixture(cwd => {
  const guard = shell(release, "Require workflow release credential");
  const missing = bash(cwd, guard, { RELEASE_WORKFLOW_TOKEN: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /::error::Configure RELEASE_APP_CLIENT_ID and RELEASE_APP_PRIVATE_KEY/);
  const present = bash(cwd, guard, { RELEASE_WORKFLOW_TOKEN: "synthetic-installation-token" });
  assert.equal(present.status, 0, present.stderr);
  assert.doesNotMatch(present.stdout + present.stderr, /synthetic-installation-token/);
  assert.ok(release.indexOf("      - name: Require workflow release credential\n") < release.indexOf("      - name: Update release version\n"));
  const create = release.split("      - name: Create release workflow token\n")[1]?.split("      - name:")[0];
  assert.ok(create);
  assert.match(create, /uses: actions\/create-github-app-token@[a-f0-9]{40} # v3\.3\.0/);
  for (const permission of ["contents: write", "workflows: write", "pull-requests: write", "actions: write", "checks: read"]) {
    assert.ok(create.includes(`permission-${permission}`), permission);
  }
  assert.doesNotMatch(create, /owner:|repositories:|skip-token-revoke:/);
  assert.match(release, /token: \$\{\{ steps.release_token.outputs.token \|\| github.token \}\}/);
  assert.match(release, /GH_TOKEN: \$\{\{ steps.release_token.outputs.token \}\}/);
}));

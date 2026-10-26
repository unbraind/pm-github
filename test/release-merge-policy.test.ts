/** Exercise the policy consumed by the release workflow, with real commit history. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSafeReleaseAdvance, deriveReleaseMergeWait, type ReleaseTimingJob } from "../scripts/release-merge-policy.ts";

/** Construct an API job with a precise positive duration. */
function job(seconds: number, name = "test (22)"): ReleaseTimingJob {
  return { name, conclusion: "success", started_at: "2026-10-22T00:00:00Z", completed_at: new Date(Date.parse("2026-10-22T00:00:00Z") + seconds * 1000).toISOString() };
}

test("wait uses nearest-rank p95, measured margin, floor and cap", () => {
  assert.deepEqual(deriveReleaseMergeWait([]), { sample_count: 0, p95_seconds: 0, margin_seconds: 900, wait_seconds: 3600 });
  assert.equal(deriveReleaseMergeWait([job(2300, "test (26)")]).wait_seconds, 3600);
  assert.deepEqual(deriveReleaseMergeWait(Array.from({ length: 20 }, (_, i) => job((i + 1) * 200))),
    { sample_count: 20, p95_seconds: 3800, margin_seconds: 950, wait_seconds: 4750 });
  assert.equal(deriveReleaseMergeWait([job(10_000)]).wait_seconds, 7200);
  assert.equal(deriveReleaseMergeWait([job(3000.1)]).p95_seconds, 3001);
});

test("wait ignores unrelated, failed, missing, malformed and nonpositive timings", () => {
  assert.equal(deriveReleaseMergeWait([
    job(9000, "bun-release (22)"), { ...job(9000), conclusion: "failure" },
    { ...job(9000), started_at: null }, { ...job(9000), completed_at: null },
    { ...job(9000), started_at: "bad-date" }, job(0), job(-1), job(100),
  ]).sample_count, 1);
});

/** A git fixture with isolated identity, ordinary dependency data and release metadata. */
class ReleaseRepository {
  root = mkdtempSync(join(tmpdir(), "release-merge-policy-"));
  env: NodeJS.ProcessEnv = { ...process.env, HOME: this.root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: tmpdir() };
  base: string;

  /** Initialize an independent repository so ancestor discovery cannot hide a missing git boundary. */
  constructor() {
    this.git("init", "-b", "main");
    this.git("config", "user.name", "Synthetic Release");
    this.git("config", "user.email", "release@example.invalid");
    for (const path of ["package.json", "package-lock.json"]) this.write(path, JSON.stringify({ version: "1.0.0", dependencies: { example: "1" }, packages: { "": { version: "1.0.0" } } }, null, 2) + "\n");
    this.write("manifest.json", '{"version":"1.0.0"}\n');
    this.write("CHANGELOG.md", "Initial\n");
    this.write("README.md", "Initial\n");
    this.base = this.commit();
  }

  /** Run git using only the fixture's configuration. */
  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  /** Write a synthetic tracked artifact. */
  write(path: string, content: string): void { writeFileSync(join(this.root, path), content); }

  /** Commit explicit fixture paths and return their complete object identity. */
  commit(): string {
    this.git("add", "package.json", "package-lock.json", "manifest.json", "CHANGELOG.md", "README.md");
    this.git("commit", "--allow-empty", "-m", "Synthetic change");
    return this.git("rev-parse", "HEAD");
  }

  /** Remove only the temporary fixture. */
  dispose(): void { rmSync(this.root, { recursive: true, force: true }); }
}

test("release refresh needs a git repository and full, ancestor commit identities", () => {
  const repo = new ReleaseRepository();
  const plain = mkdtempSync(join(tmpdir(), "release-plain-tracker-"));
  const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  try {
    const init = spawnSync(process.execPath, [join(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--pm-path", join(plain, ".agents/pm"), "--prefix", "synthetic", "--defaults", "--agent-guidance", "skip"],
      { cwd: plain, env: { ...repo.env, GIT_CEILING_DIRECTORIES: tmpdir() }, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    assert.throws(() => assertSafeReleaseAdvance(repo.base, repo.base, plain), /needs a git repository/);
    assert.throws(() => assertSafeReleaseAdvance("--help", repo.base, repo.root), /full commit SHAs/);
    assert.throws(() => assertSafeReleaseAdvance(repo.base, "bad-ref", repo.root), /full commit SHAs/);
    const next = repo.commit();
    assert.throws(() => assertSafeReleaseAdvance(next, repo.base, repo.root), /not an ancestor/);
  } finally {
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
    repo.dispose(); rmSync(plain, { recursive: true, force: true });
  }
});

test("dependency updates preserve package versions and are safe with or without lock packages", () => {
  const repo = new ReleaseRepository();
  const originalDirectory = process.cwd();
  try {
    for (const path of ["package.json", "package-lock.json"]) {
      repo.write(path, JSON.stringify({ version: "1.0.0", dependencies: { example: "2" }, packages: { "": { version: "1.0.0" } } }));
    }
    const next = repo.commit();
    assert.doesNotThrow(() => assertSafeReleaseAdvance(repo.base, next, repo.root));
    for (const path of ["package.json", "package-lock.json"]) repo.write(path, JSON.stringify({ version: "1.0.0", dependencies: { example: "3" } }));
    const last = repo.commit();
    // Removing the root lock version is release drift even when the top-level value remains.
    assert.throws(() => assertSafeReleaseAdvance(next, last, repo.root), /package release version/);
    repo.git("reset", "--hard", repo.base);
    for (const path of ["package.json", "package-lock.json"]) repo.write(path, JSON.stringify({ version: "1.0.0", dependencies: { example: "3" } }));
    const withoutPackages = repo.commit();
    for (const path of ["package.json", "package-lock.json"]) repo.write(path, JSON.stringify({ version: "1.0.0", dependencies: { example: "4" } }));
    const dependency = repo.commit();
    process.chdir(repo.root);
    assert.doesNotThrow(() => assertSafeReleaseAdvance(withoutPackages, dependency));
    assert.doesNotThrow(() => assertSafeReleaseAdvance(dependency, dependency));
  } finally { process.chdir(originalDirectory); repo.dispose(); }
});

for (const artifact of ["package.json", "package-lock.json", "manifest.json", "CHANGELOG.md", "RELEASE_NOTES.md", "root lock version"]) {
  test(`release refresh refuses ${artifact} drift even if a later commit restores the original`, () => {
    const repo = new ReleaseRepository();
    try {
      const path = artifact === "root lock version" ? "package-lock.json" : artifact;
      const original = existsSync(join(repo.root, path)) ? readFileSync(join(repo.root, path), "utf8") : null;
      if (artifact === "root lock version") repo.write(path, JSON.stringify({ version: "1.0.0", packages: { "": { version: "2.0.0" } } }));
      else if (path.endsWith(".json")) repo.write(path, '{"version":"2.0.0"}\n');
      else repo.write(path, "New release\n");
      if (path === "RELEASE_NOTES.md") repo.git("add", path);
      const changed = repo.commit();
      assert.throws(() => assertSafeReleaseAdvance(repo.base, changed, repo.root), /release (metadata|version)/);
      if (original === null) repo.git("rm", path);
      else repo.write(path, original);
      const restored = repo.commit();
      assert.throws(() => assertSafeReleaseAdvance(repo.base, restored, repo.root), /release (metadata|version)/);
    } finally { repo.dispose(); }
  });
}

/** Parse the workflow rather than duplicating its executable shell logic. */
const { parse }: { parse: (source: string) => { jobs: { release: { "timeout-minutes": number; steps: { name: string; run?: string; env?: Record<string, string> }[] } } } } =
  createRequire(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"))("yaml");
const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).jobs.release;

/** Load the actual shell block executed by the release job. */
function workflowScript(name: string): string {
  const script = release.steps.find(step => step.name === name)?.run;
  assert.ok(script, `Missing workflow script: ${name}`);
  return script;
}

/** Execute the measurement step with file-backed GitHub API output. */
function measure(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "release-measure-"));
  try {
    const result = spawnSync("bash", ["-c", `
      gh() {
        if [[ "$*" == *workflows/ci.yml/runs* ]]; then
          [[ "$*" == *'branch=main&event=push&status=success&per_page=20'* ]] || return 99
          if [[ "$SCENARIO" == unavailable ]]; then return 1; fi
          printf '11\\n12\\n'
        elif [[ "$*" == *'/11/jobs?'* ]]; then
          if [[ "$SCENARIO" == partial ]]; then return 1; fi
          printf '%s' "$TEST_JOBS"
        elif [[ "$*" == *'/12/jobs?'* ]]; then printf '%s' "$TEST_JOBS"; else return 99; fi
      }
      ${workflowScript("Measure release merge wait")}
    `], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, TMPDIR: root,
      SCENARIO: scenario, TEST_JOBS: JSON.stringify(job(4000)), GITHUB_REPOSITORY: "fixture/package",
      GITHUB_OUTPUT: join(root, "outputs"), GITHUB_STEP_SUMMARY: scenario === "summary-failure" ? join(root, "missing/summary") : join(root, "summary") } });
    return { ...result, outputs: readFileSync(join(root, "outputs"), "utf8"),
      summary: existsSync(join(root, "summary")) ? readFileSync(join(root, "summary"), "utf8") : "" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("workflow measures real API job fields and records its derivation with safe history fallbacks", () => {
  assert.equal(release["timeout-minutes"], 360);
  assert.equal(release.steps.find(step => step.name === "Merge release metadata through protected PR")?.env?.MERGE_WAIT_SECONDS, "${{ steps.merge_wait.outputs.wait_seconds }}");
  for (const scenario of ["success", "partial", "unavailable", "summary-failure"]) {
    const result = measure(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `wait_seconds=${scenario === "unavailable" ? 3600 : 5000}\n`);
    assert.match(result.stdout, /nearest-rank p95: .*floor: 60m; cap: 120m; job timeout: 360m/);
    if (scenario === "summary-failure") assert.match(result.stdout, /Could not write merge wait summary/);
    else assert.match(result.summary, new RegExp(`samples: ${scenario === "success" ? 2 : scenario === "partial" ? 1 : 0}`));
  }
});

/** Run the merge shell with real branches and an isolated origin, never a live mutation. */
function merging(scenario: string) {
  const repo = new ReleaseRepository();
  try {
    mkdirSync(join(repo.root, "scripts"));
    copyFileSync(new URL("../scripts/release-merge-policy.ts", import.meta.url), join(repo.root, "scripts/release-merge-policy.ts"));
    copyFileSync(new URL("../own-record.ts", import.meta.url), join(repo.root, "own-record.ts"));
    const origin = join(repo.root, "origin.git");
    repo.git("init", "--bare", origin);
    repo.git("remote", "add", "origin", origin);
    repo.git("push", "origin", "main");
    repo.git("checkout", "-b", "release/2026.10.23");
    repo.write("CHANGELOG.md", "Prepared release\n");
    for (const path of ["package.json", "package-lock.json"]) repo.write(path, JSON.stringify({ version: "2.0.0", dependencies: { example: "1" }, packages: { "": { version: "2.0.0" } } }, null, 2) + "\n");
    repo.write("manifest.json", '{"version":"2.0.0"}\n');
    if (scenario === "merge-conflict") repo.write("README.md", "Prepared conflicting readme\n");
    const prepared = repo.commit();
    repo.git("checkout", "main");
    if (scenario === "metadata" || scenario === "metadata-wait") repo.write("manifest.json", '{"version":"2.0.0"}\n');
    else if (scenario === "version") repo.write("package.json", '{"version":"2.0.0"}\n');
    else if (scenario === "conflict") repo.write("CHANGELOG.md", "Conflicting release\n");
    else {
      repo.write("README.md", "New main\n");
      for (const path of ["package.json", "package-lock.json"]) repo.write(path, JSON.stringify({ version: "1.0.0", dependencies: { example: "2" }, packages: { "": { version: "1.0.0" } } }, null, 2) + "\n");
    }
    const advanced = repo.commit();
    repo.write("README.md", "Main advanced twice\n");
    const second = repo.commit();
    repo.git("checkout", "--detach", prepared);
    if (["preparation", "metadata", "version", "conflict"].includes(scenario)) repo.git("push", "origin", `${advanced}:refs/heads/main`);
    const output = join(repo.root, "outputs");
    const result = spawnSync("bash", ["-c", `
      gh() {
        case "$1 $2" in
          'pr edit') return 0 ;;
          'pr view')
            poll=0; [[ ! -f "$POLL" ]] || read -r poll < "$POLL"
            poll=$((poll+1)); printf '%s\\n' "$poll" > "$POLL"
            if [[ "$SCENARIO" != preparation && "$SCENARIO" != stale && ( "$SCENARIO" != timeout || "$poll" -gt 1 ) ]]; then
              command git push origin "$ADVANCED:refs/heads/main" >/dev/null 2>&1 || return
            fi
            if [[ "$SCENARIO" == twice && "$poll" -gt 1 ]]; then command git push origin "$SECOND:refs/heads/main" >/dev/null 2>&1 || return; fi
            if [[ "$SCENARIO" == dirty ]]; then printf '{"merge_state":"DIRTY"}';
            elif [[ "$SCENARIO" == clean-advance ]]; then printf '{"merge_state":"CLEAN","unsettled":[],"failing":[]}';
            else printf '{"merge_state":"BEHIND","unsettled":["test (22)"],"failing":[]}'; fi ;;
          'api graphql') return 0 ;;
          'api --method')
            printf '%s\\n' "$*" >> "$MERGES"
            if [[ "$SCENARIO" == timeout ]]; then return 1; fi
            printf '{"sha":"verified-main"}' ;;
          *) return 99 ;;
        esac
      }
      sleep() { SECONDS=$((SECONDS + 3700)); }
      ${workflowScript("Merge release metadata through protected PR")}
    `], { cwd: repo.root, encoding: "utf8", timeout: 30_000, env: { ...repo.env, TMPDIR: repo.root,
      SCENARIO: scenario, ADVANCED: advanced, SECOND: second, POLL: join(repo.root, "poll"), MERGES: join(repo.root, "merges"),
      RELEASE_BRANCH: "release/2026.10.23", RELEASE_PR_NUMBER: "171", RELEASE_BASE_SHA: repo.base,
      RELEASE_TAG: "v2026.10.23", NPM_VERSION: "2026.10.23", GITHUB_REPOSITORY: "fixture/package", GITHUB_OUTPUT: output,
      MERGE_WAIT_SECONDS: scenario === "invalid-wait" ? "1800" : "3600" } });
    const head = repo.git("rev-parse", "HEAD");
    return { ...result, outputs: existsSync(output) ? readFileSync(output, "utf8") : "",
      merges: existsSync(join(repo.root, "merges")) ? readFileSync(join(repo.root, "merges"), "utf8") : "",
      package: JSON.parse(readFileSync(join(repo.root, "package.json"), "utf8")) as { version: string; dependencies?: { example: string } },
      head, prepared, advanced, remote: repo.git("ls-remote", "origin", "refs/heads/release/2026.10.23") };
  } finally { repo.dispose(); }
}

for (const scenario of ["preparation", "waiting", "clean-advance"]) {
  test(`workflow safely refreshes once during ${scenario} and merges only the new head`, () => {
    const result = merging(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.head, result.prepared);
    assert.equal(result.package.version, "2.0.0");
    assert.equal(result.package.dependencies?.example, "2");
    assert.match(result.stdout, /Updated release branch from main once/);
    assert.match(result.merges, new RegExp(`-f sha=${result.head}`));
    assert.doesNotMatch(result.merges, new RegExp(`-f sha=${result.prepared}`));
    assert.match(result.remote, new RegExp(`^${result.head}`));
    assert.equal(result.outputs, "merged_sha=verified-main\npr_number=171\n");
  });
}

for (const scenario of ["metadata", "version", "metadata-wait", "conflict", "twice", "dirty", "invalid-wait", "merge-conflict"]) {
  test(`workflow fails closed for ${scenario} without attempting a merge`, () => {
    const result = merging(scenario);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, "");
    assert.equal(result.merges, "");
    if (scenario === "twice") assert.match(result.stdout, /main advanced again/);
    else if (["metadata", "version", "metadata-wait", "conflict"].includes(scenario)) assert.match(result.stderr, /Main changed/);
  });
}

test("BEHIND without a newly fetched main commit waits without inventing a refresh", () => {
  const result = merging("stale");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.head, result.prepared);
  assert.doesNotMatch(result.stdout, /Updated release branch/);
});

test("a safe refresh restarts the full measured wait instead of expiring on the old deadline", () => {
  const result = merging("timeout");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Updated release branch from main once/);
  assert.match(result.stdout, /did not merge within 60 minutes/);
  assert.ok(result.merges.split("\n").filter(Boolean).length >= 3);
});

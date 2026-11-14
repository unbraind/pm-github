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

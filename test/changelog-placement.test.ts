/** Real tracker and Git regressions for the reusable workflows' changelog policy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, get, runWithReproducibleProcessEnvironment } from "@unbrained/pm-cli/sdk";
import { runCloseout, type CloseoutApi } from "../closeout.ts";
import { parseImportOptions, runImport, type GhIssue } from "../index.ts";

const source = resolve(import.meta.dirname, "..");
const cli = join(source, "node_modules/.bin/pm");
const generator = process.env.PM_GITHUB_TEST_LEGACY_CHANGELOG_BIN ?? join(source, "node_modules/.bin/pm-changelog");
const repo = "fixture/project";
const completed = "2026-10-15T12:00:00Z";

test("placement report retains the final regex-hardening validation snapshot", () => {
  const report = readFileSync(join(source, "docs/changelog-release-placement.md"), "utf8")
    .split("## Release gates\n")[1]!.split("\n## ")[0]!;
  assert.match(report, /f2dcdbe6eade612288cd783208e5904270e44ab7/);
  for (const runtime of ["npm", "bun"]) {
    assert.match(report, new RegExp(`\u0060${runtime} run release:check\u0060 (?:also )?passes 971/971 tests`));
  }
  for (const counter of ["11055/11055 lines", "11055/11055 statements", "302/302 functions", "3526/3526"]) {
    assert.ok(report.includes(counter), `missing validated counter: ${counter}`);
  }
  assert.doesNotMatch(report, /964\/964|11040\/11040|300\/300|3520\/3520/);
});

test("wrapper guidance preserves caller changelog policy", () => {
  const report = readFileSync(join(source, "docs/changelog-release-placement.md"), "utf8").replace(/\s+/g, " ");
  assert.match(report, /wrappers must generate output that agrees with the caller's \x60changelog:check\x60/);
  const readme = readFileSync(join(source, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /remove the \x60changelog:automation\x60 wrapper and its input override only if the wrapper solely delegates to \x60changelog:full\x60 and neither \x60prechangelog:automation\x60 nor \x60postchangelog:automation\x60 is defined/);
  assert.match(readme, /adds flags or sets environment variables, keep the wrapper and override or move that policy into \x60changelog:full\x60/);
});

test("caller templates and migration guidance select automatic changelog handling", () => {
  const readme = readFileSync(join(source, "README.md"), "utf8").replace(/\s+/g, " ");
  assert.match(readme, /explicit \x60changelog:full\x60 override when it only regenerates the changelog/);
  assert.match(readme, /A strict \x60--check-pending\x60 check can reject the proposed changes/);
  for (const [kind, input] of [["sync", "post-import-script"], ["closeout", "post-closeout-script"]]) {
    const documentation = readFileSync(join(source, `docs/${kind}-workflow-caller.yml`), "utf8");
    const contract = readFileSync(join(source, `.github/workflows/pm-github-${kind}.yml`), "utf8");
    assert.ok(documentation.includes(`Omit ${input} for automatic selection`));
    assert.ok(!documentation.split("\n").some(line => line.trimStart().startsWith(`${input}:`)));
    assert.match(contract, /description: "Caller npm post-script\. Omit .*pm-changelog 2026\.11\.28\+.*Empty disables.*named script still runs/);
  }
});

/** Execute the production post-script and caller policy steps with real npm. */
function postScript(kind: string, root: string, script = "@auto") {
  const workflow = readFileSync(join(source, `.github/workflows/pm-github-${kind}.yml`), "utf8");
  const steps = workflow.split("      - name: ");
  const names = ["Resolve sync commit scope", `Run caller post-${kind === "sync" ? "import" : "closeout"} script`, "Check caller changelog policy"];
  const shell = names.map(name => {
    const step = steps.find(candidate => candidate.startsWith(name + "\n"));
    assert.ok(step, name);
    return step.split("        run: |\n")[1]!.split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
  }).join("\n");
  return spawnSync("bash", ["-c", shell], { cwd: root, encoding: "utf8", env: { ...process.env,
    GITHUB_WORKSPACE: root, GITHUB_ENV: join(root, ".git/workflow-env"), RUNNER_TEMP: join(root, ".git"),
    PM_PATH: join(root, ".agents/pm"), NPM_PROJECT_PATH: root, POST_IMPORT_SCRIPT: script,
    POST_CLOSEOUT_SCRIPT: script, CLOSEOUT_CLOSED: "1",
  } });
}

/** GitHub evidence only; every tracker read, close and imported history write is real. */
function evidence(id: string): CloseoutApi {
  const head = "a".repeat(40);
  return { base: "https://api.github.com", next: () => undefined, async get(url) {
    let body: unknown = [];
    if (url.endsWith("/pulls/1")) body = { number: 1, body: `Delivers ${id}`, merged: true, commits: 0,
      merged_at: completed, merge_commit_sha: "b".repeat(40), html_url: `https://github.com/${repo}/pull/1`,
      head: { sha: head }, base: { ref: "main", repo: { full_name: repo } } };
    else if (url.includes("/protection/")) body = { contexts: ["CI"], checks: [] };
    else if (url.includes("/check-runs")) body = { total_count: 1, check_runs: [
      { name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 1 } },
    ] };
    return { body: JSON.stringify(body) };
  } };
}

for (const kind of ["closeout", "sync"]) {
  for (const tagged of [false, true]) {
    test(`${kind}: regenerated output passes the caller policy ${tagged ? "after" : "before"} a release tag`, async () => {
      const root = mkdtempSync(join(tmpdir(), "placement-caller-"));
      const pmRoot = join(root, ".agents/pm");
      const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com",
        GIT_AUTHOR_DATE: "2026-09-02T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-02T12:00:00Z" };
      try {
        assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root }).status, 0);
        assert.equal(spawnSync(cli, ["--pm-path", pmRoot, "init", "--defaults", "--agent-guidance", "skip"], { cwd: root }).status, 0);
        mkdirSync(join(root, "node_modules/@unbrained"), { recursive: true });
        symlinkSync(join(source, "node_modules/@unbrained/pm-cli"), join(root, "node_modules/@unbrained/pm-cli"), "junction");
        mkdirSync(join(root, "node_modules/.bin"));
        symlinkSync(generator, join(root, "node_modules/.bin/pm-changelog"));
        writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.9.2", scripts: {
          "changelog:full": `node ${JSON.stringify(generator)} --stdin --pm-root .agents/pm --mode replace --output CHANGELOG.md --all-release-tags --include-empty --release-version-from-package --date-from-version`,
          "changelog:check": "npm run changelog:full -- --check",
          "changelog:automation": "npm run changelog:full",
          custom: 'node -e "require(\'node:fs\').writeFileSync(\'custom.txt\', JSON.stringify(process.argv.slice(1)))"',
        } }));
        // The CLI's stdin mode avoids spawning an unrelated pm installation.
        const item = await runWithReproducibleProcessEnvironment({ PM_CLOCK: "2026-09-01T00:00:00Z", PM_SEED: "placement" }, () =>
          create({ title: kind === "closeout" ? "October delivery" : "Unrelated native item", type: "Issue" }, { pmRoot, noExtensions: true }));
        assert.equal(spawnSync("git", ["add", ".agents/pm", "package.json"], { cwd: root, env }).status, 0);
        assert.equal(spawnSync("git", ["commit", "-qm", "September release"], { cwd: root, env }).status, 0);
        if (tagged) assert.equal(spawnSync("git", ["tag", "v2026.9.2"], { cwd: root, env }).status, 0);
        if (kind === "closeout") {
          const result = await runCloseout(pmRoot, repo, { pr: "1", apply: true }, evidence(item.item.id));
          assert.equal(result.closed, 1);
        } else {
          const issue: GhIssue = { number: 1, title: "October delivery", state: "closed", state_reason: "completed",
            created_at: "2026-08-01T00:00:00Z", updated_at: completed, closed_at: completed,
            html_url: `https://github.com/${repo}/issues/1`, body: null, labels: [], assignee: null, milestone: null };
          const result = await runImport(repo, pmRoot, parseImportOptions({ atomic: true }), { fetchIssues: async () => [issue], resolveToken: () => undefined });
          assert.ok("imported" in result);
          assert.equal(result.imported, 1);
        }
        // Use the actual SDK corpus via the caller's real CLI, as fleet scripts do.
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
        pkg.scripts["changelog:full"] = pkg.scripts["changelog:full"]!.replace("--stdin", `--pm-bin ${JSON.stringify(cli)} --pm-arg=--output-limit --pm-arg=unbounded --pm-arg=--output-budget --pm-arg=unbounded`);
        writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
        // The workflow privacy gate stages the tracker before the caller check.
        assert.equal(spawnSync("git", ["add", "--", ".agents/pm"], { cwd: root, env }).status, 0);
        const result = postScript(kind, root);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /> changelog:check/);
        assert.equal(result.stdout.match(/::notice::Keeping legacy changelog behavior.*2026\.11\.28/g)?.length, 1);
        const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
        const sections = changelog.split(/^## /m).slice(1);
        const releases = sections.filter(section => /^\d{4}\.\d+\.\d+\b/.test(section));
        const release = releases.find(section => section.startsWith("2026.9.2")) ?? "";
        if (tagged) {
          assert.match(sections.find(section => section.startsWith("Unreleased")) ?? "", /October delivery/);
          assert.equal(releases.length, 1, "the fixture has exactly one historical release");
          for (const section of releases) assert.doesNotMatch(section, /October delivery/);
          assert.match(release, /No changes\./);
        } else assert.match(release, /October delivery/);
        assert.equal((await get(item.item.id, {}, { pmRoot, noExtensions: true })).item.status, kind === "closeout" ? "closed" : "open");
        if (!tagged) {
          const wrapper = postScript(kind, root, "changelog:automation");
          assert.equal(wrapper.status, 0, wrapper.stdout + wrapper.stderr);
          assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), changelog);
          delete pkg.scripts["changelog:check"];
          writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
          assert.equal(postScript(kind, root, "custom").status, 0);
          assert.equal(readFileSync(join(root, "custom.txt"), "utf8"), "[]");
          assert.equal(postScript(kind, root, "").status, 0);
          assert.equal(postScript(kind, root, "missing").status, 0);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const kind of ["sync", "closeout"]) {
  test(`${kind}: pending policy skips the automatic hook and preserves explicit npm lifecycle hooks`, () => {
    const root = mkdtempSync(join(tmpdir(), "placement-explicit-"));
    const changelog = join(root, "CHANGELOG.md");
    const scripts = {
      "changelog:full": "printf 'regenerated\\n' > CHANGELOG.md && git add -- CHANGELOG.md",
      "prechangelog:full": "echo 'pre hook ran'",
      "postchangelog:full": "echo 'post hook ran'",
    };
    const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com" };
    try {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
      mkdirSync(join(root, "node_modules/@unbrained"), { recursive: true });
      symlinkSync(join(source, "node_modules/@unbrained/pm-cli"), join(root, "node_modules/@unbrained/pm-cli"));
      mkdirSync(join(root, "node_modules/.bin"));
      const launcher = join(root, "node_modules/.bin/pm-changelog");
      const installed = process.env.PM_GITHUB_TEST_PENDING_CHANGELOG_BIN;
      if (installed) symlinkSync(installed, launcher);
      else writeFileSync(launcher, "#!/usr/bin/env bash\nprintf '  --check-pending  Strict check\\n'\n", { mode: 0o755 });
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
      writeFileSync(changelog, "Original\n");
      assert.equal(spawnSync("git", ["add", "--", "CHANGELOG.md", "package.json"], { cwd: root }).status, 0);
      assert.equal(spawnSync("git", ["commit", "-qm", "Caller input"], { cwd: root, env }).status, 0);

      for (const input of ["@auto", "", "changelog:full"]) {
        const result = postScript(kind, root, input);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        if (input === "changelog:full") {
          assert.match(result.stdout, /pre hook ran/);
          assert.match(result.stdout, /post hook ran/);
          assert.equal(result.stdout.match(/::notice::Explicit changelog:full is deprecated/g)?.length, 1);
        } else assert.doesNotMatch(result.stdout, /hook ran|regenerated/);
        assert.equal(readFileSync(changelog, "utf8"), "Original\n");
        assert.equal(spawnSync("git", ["diff", "--cached", "--exit-code"], { cwd: root }).status, 0);
      }
      writeFileSync(changelog, "Unsaved caller edit\n");
      const result = postScript(kind, root, "changelog:full");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /Changed path outside sync commit scope: CHANGELOG\.md/);
      assert.doesNotMatch(result.stdout, /hook ran/);
      assert.equal(readFileSync(changelog, "utf8"), "Unsaved caller edit\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

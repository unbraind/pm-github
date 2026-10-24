/** Real tracker and Git regressions for the reusable workflows' changelog policy. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { create, get, runWithReproducibleProcessEnvironment } from "@unbrained/pm-cli/sdk";
import { runCloseout, type CloseoutApi } from "../closeout.ts";
import { parseImportOptions, runImport, type GhIssue } from "../index.ts";

const source = resolve(import.meta.dirname, "..");
const cli = join(source, "node_modules/.bin/pm");
const generator = join(source, "node_modules/pm-changelog/dist/cli.js");
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

/** Execute the production post-script block, preserving npm's argument forwarding. */
function postScript(kind: string, root: string, script = "changelog:full") {
  const workflow = readFileSync(join(source, `.github/workflows/pm-github-${kind}.yml`), "utf8");
  const step = workflow.split(`      - name: Run caller post-${kind === "sync" ? "import" : "closeout"} script\n`)[1]!.split("      - name: ")[0]!;
  const shell = step.split("        run: |\n")[1]!.split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
  return spawnSync("bash", ["-c", shell], { cwd: root, encoding: "utf8", env: { ...process.env,
    NPM_PROJECT_PATH: root, POST_IMPORT_SCRIPT: script, POST_CLOSEOUT_SCRIPT: script,
  } });
}

/** GitHub evidence only; every tracker read, close and imported history write is real. */
function evidence(id: string): CloseoutApi {
  const head = "a".repeat(40);
  return { base: "https://api.github.com", next: () => undefined, async get(url) {
    let body: unknown = [];
    if (url.endsWith("/pulls/1")) body = { number: 1, body: `Delivers ${id}`, merged: true,
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
    test(`${kind}: post-release delivery stays Unreleased with ${tagged ? "a real release tag" : "an untagged old package version"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "placement-caller-"));
      const pmRoot = join(root, ".agents/pm");
      const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com",
        GIT_AUTHOR_DATE: "2026-09-02T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-02T12:00:00Z" };
      try {
        assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root }).status, 0);
        assert.equal(spawnSync(cli, ["--pm-path", pmRoot, "init", "--defaults", "--agent-guidance", "skip"], { cwd: root }).status, 0);
        mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
        writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.9.2", scripts: {
          "changelog:full": `node ${JSON.stringify(generator)} --stdin --pm-root .agents/pm --mode replace --output CHANGELOG.md --all-release-tags --release-version-from-package --date-from-version`,
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
        const result = postScript(kind, root);
        assert.equal(result.status, 0, result.stderr);
        const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
        assert.match(changelog.split(/^## /m).find(section => section.startsWith("Unreleased")) ?? "", /October delivery/);
        for (const section of changelog.split(/^## /m).filter(section => section.startsWith("2026.9.2"))) assert.doesNotMatch(section, /October delivery/);
        assert.equal((await get(item.item.id, {}, { pmRoot, noExtensions: true })).item.status, kind === "closeout" ? "closed" : "open");
        assert.equal(postScript(kind, root, "custom").status, 0);
        assert.equal(readFileSync(join(root, "custom.txt"), "utf8"), "[]");
        assert.equal(postScript(kind, root, "").status, 0);
        assert.equal(postScript(kind, root, "missing").status, 0);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

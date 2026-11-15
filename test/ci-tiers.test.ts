/** Exercise the actual workflow change detector against adversarial Git paths. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type Workflow = { jobs: { test: { steps: { id?: string; run?: string }[] } } };
const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as Workflow;
const detector = workflow.jobs.test.steps.find(step => step.id === "changes")!.run!;

test("PR detector keeps docs cheap and source deletions, renames and unusual names gated", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-ci-changes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), "fixture\n"); };
  try {
    git("init", "-q");
    write("source.ts");
    git("add", "source.ts");
    git("-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-qm", "Fixture");
    const base = git("rev-parse", "HEAD");
    for (const [name, paths, remove, expected, event] of [
      ["docs", ["README.md", "docs/nested/spec.json", ".agents/pm/tasks/a.toon", "LICENSE"], false, false, "pull_request"],
      ["code", ["test/new.test.ts"], false, true, "pull_request"],
      ["lock", ["package-lock.json"], false, true, "pull_request"],
      ["workflow", [".github/workflows/ci.yml"], false, true, "pull_request"],
      ["unusual", ["docs/a\nb.md", "source\nfile.ts"], false, true, "pull_request"],
      ["delete", [], true, true, "pull_request"],
      ["source-to-docs", ["docs/source.md"], true, true, "pull_request"],
      ["dispatch", ["README.md"], false, true, "workflow_dispatch"],
    ] as const) {
      git("reset", "--hard", base);
      git("clean", "-fdq");
      for (const file of paths) write(file);
      if (remove) rmSync(join(root, "source.ts"));
      git("add", ".");
      git("-c", "user.name=SteveBot", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-qm", name);
      const output = join(root, "output");
      const result = spawnSync("bash", ["-c", detector], { cwd: root, encoding: "utf8", env: { ...process.env,
        GITHUB_EVENT_NAME: event, BASE_SHA: base, HEAD_SHA: git("rev-parse", "HEAD"), RUNNER_TEMP: root, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8").trim(), `code=${expected}`, name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

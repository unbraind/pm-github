/** Exercise the actual workflow change detector against adversarial Git paths. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { nodeToolingExecutable } from "../scripts/main-invocation.ts";
import { workflowCorpus } from "./support/corpus.ts";

type Workflow = { jobs: { test: { steps: { id?: string; name?: string; if?: string; run?: string }[] } } };
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
    git("-c", "user.name=unbrained", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-qm", "Fixture");
    const base = git("rev-parse", "HEAD");
    for (const [name, paths, remove, expected, event] of [
      ["docs", ["README.md", "docs/nested/spec.json", ".agents/pm/tasks/a.toon", "LICENSE"], false, false, "pull_request"],
      ["code", ["test/new.test.ts"], false, true, "pull_request"],
      ["tracker-script", [".agents/pm/scripts/check.ts"], false, true, "pull_request"],
      ["tracker-shell", [".agents/pm/scripts/check.sh"], false, true, "pull_request"],
      ["lock", ["package-lock.json"], false, true, "pull_request"],
      ["workflow", [".github/workflows/ci.yml"], false, true, "pull_request"],
      ["unusual", ["docs/a\nb.md", "source\nfile.ts"], false, true, "pull_request"],
      ["delete", [], true, true, "pull_request"],
      ["source-to-docs", ["docs/source.md"], true, true, "pull_request"],
      ["dispatch", ["README.md"], false, true, "workflow_dispatch"],
    ] as const) {
      if (process.platform === "win32" && paths.some(path => /[\r\n]/.test(path))) continue;
      git("reset", "--hard", base);
      git("clean", "-fdq");
      for (const file of paths) write(file);
      if (remove) rmSync(join(root, "source.ts"));
      git("add", ".");
      git("-c", "user.name=unbrained", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-qm", name);
      const output = join(root, "output");
      const result = spawnSync("bash", ["-c", detector], { cwd: root, encoding: "utf8", env: { ...process.env,
        GITHUB_EVENT_NAME: event, BASE_SHA: base, HEAD_SHA: git("rev-parse", "HEAD"), RUNNER_TEMP: root, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8").trim(), `code=${expected}`, name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the actual Node 22 shell supplies local CLI tools; removing PATH setup fails the fixture", { skip: process.platform === "win32" && "The workflow shell runs in Ubuntu Bash" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-ci-path-"));
  try {
    const tools = join(root, "tools");
    mkdirSync(tools);
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(root, "test"));
    const node = execFileSync(nodeToolingExecutable(process.versions), ["-p", "process.execPath"], { encoding: "utf8" }).trim();
    symlinkSync(node, join(tools, "node"));
    writeFileSync(join(tools, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(root, "node_modules/.bin/pm"), "#!/bin/sh\necho fixture-pm\n", { mode: 0o755 });
    writeFileSync(join(root, "test/probe.test.ts"), `import assert from 'node:assert/strict';
import test from 'node:test'; import { spawnSync } from 'node:child_process';
test('local CLI lookup', () => assert.equal(spawnSync('pm', [], { encoding: 'utf8' }).stdout?.trim(), 'fixture-pm'));
`);
    const script = workflow.jobs.test.steps.find(step => step.name === "Engines floor build and tests")!.run!;
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${tools}:/usr/bin:/bin` };
    delete env.NODE_TEST_CONTEXT;
    const run = (shell: string) => spawnSync("/bin/bash", ["-c", shell], { cwd: root, env, encoding: "utf8" });
    const positive = run(script);
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    const negative = run(script.replace('export PATH="$PWD/node_modules/.bin:$PATH"', ""));
    assert.equal(negative.status, 1, "Without npm's local-bin environment, real child CLI lookup must fail.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workflow corpora preserve the default set and quick prefix with original callbacks and options", () => {
  const previous = process.env.PM_TEST_DEPTH;
  try {
    for (const [depth, count] of [[undefined, 50], ["quick", 25], ["unknown", 50]] as const) {
      if (depth === undefined) delete process.env.PM_TEST_DEPTH;
      else process.env.PM_TEST_DEPTH = depth;
      const calls: unknown[][] = [];
      const record = ((...args: unknown[]) => { calls.push(args); }) as typeof test;
      const corpus = workflowCorpus(record, "fixture");
      const callbacks = Array.from({ length: 50 }, () => () => undefined);
      const options = { timeout: 12345 };
      for (let index = 0; index < callbacks.length; index++) corpus.test(`case ${index}`, options, callbacks[index]!);
      assert.equal(calls.length, 0, "Registration is deferred until the corpus is complete.");
      corpus.register();
      assert.deepEqual(calls.map(args => args[0]), Array.from({ length: count }, (_, index) => `case ${index}`));
      for (let index = 0; index < calls.length; index++) {
        assert.equal(calls[index]![1], options, "Keep the exact original test options.");
        assert.equal(calls[index]![2], callbacks[index], "Keep the exact original assertion callback.");
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PM_TEST_DEPTH;
    else process.env.PM_TEST_DEPTH = previous;
  }
});


test("docs and tracker changes retain privacy without running product tests", () => {
  const steps = workflow.jobs.test.steps;
  const privacy = steps.find(step => step.run === "npm run privacy");
  assert.ok(privacy);
  assert.equal(privacy.if, "steps.changes.outputs.code != 'true'");
  for (const name of ["Engines floor build and tests", "Quick npm release gate", "Bun install and bunx smoke"]) {
    assert.match(steps.find(step => step.name === name)!.if!, /code == 'true'/);
  }
});

/** Check literal path operands in the exact helper body shipped by both workflows. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const kind of ["sync", "closeout"]) {
  const source = readFileSync(resolve(import.meta.dirname, `../.github/workflows/pm-github-${kind}.yml`), "utf8");
  const helper = source.split("<<'SCOPE'\n")[1]!.split("\n          SCOPE")[0]!.split("\n").map(line => line.slice(10)).join("\n");
  test(`${kind}: pathspec operands retain literal tracker data and all exclusions`, () => {
    for (const tracker of [".agents/pm", "tracker with spaces/[literal]", "tracker$DATA"]) {
      const result = spawnSync("bash", ["-c", helper + '\nprintf "%s\\0" "${sync_scope[@]}"'], {
        env: { ...process.env, PM_SYNC_TRACKER: tracker }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split("\0").slice(0, -1), [`:(top,literal)${tracker}`, ":(top,literal)CHANGELOG.md",
        ...["extensions", "locks", "checkpoints", "settings.json", "history/_workspace.jsonl"].map(path => `:(top,exclude,literal)${tracker}/${path}`)]);
    }
  });
  test(`${kind}: scope allows only tracker and changelog, refusing runtime data and adjacent prefixes`, () => {
    const tracker = "tracker [literal]";
    for (const [path, status] of [[`${tracker}/issues/item.toon`, 0], ["CHANGELOG.md", 0],
      [`${tracker}/extensions`, 1], [`${tracker}/extensions/data`, 1], [`${tracker}/locks/file`, 1],
      [`${tracker}/checkpoints/file`, 1], [`${tracker}-foreign/item.toon`, 1], ["other.ts", 1]] as const) {
      const result = spawnSync("bash", ["-c", helper + '\ncheck_sync_path "$CANDIDATE"'], {
        env: { ...process.env, PM_SYNC_TRACKER: tracker, CANDIDATE: path }, encoding: "utf8",
      });
      assert.equal(result.status, status, path + result.stderr);
    }
  });
  test(`${kind}: declaring generated artifacts requires a Git checkout`, () => {
    const root = mkdtempSync(join(tmpdir(), "generated-artifact-no-git-"));
    try {
      const pmRoot = join(root, "tracker");
      const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(root, "global") };
      const init = spawnSync(resolve(import.meta.dirname, "../node_modules/.bin/pm"),
        ["--path", pmRoot, "init", "fixture"], { cwd: root, env, encoding: "utf8" });
      assert.equal(init.status, 0, init.stderr);
      const probe = spawnSync("bash", ["-c", helper + "\ncheck_generated_paths_clean"], {
        cwd: root, env: { ...env, PM_SYNC_TRACKER: "tracker", GENERATED_PATHS: "selfhost.bundle" }, encoding: "utf8",
      });
      assert.equal(probe.status, 1, probe.stdout + probe.stderr);
      assert.match(probe.stderr, /not a git repository/i);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
}

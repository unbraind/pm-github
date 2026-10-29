/** Repeat-import properties use real non-git trackers and the production planner. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { create, get } from "@unbrained/pm-cli/sdk";
import { parseImportOptions, runImport, type GhIssue } from "../index.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

const packageRoot = join(import.meta.dirname, "..");
/** Snapshot every durable item and history, excluding derived caches and journals. */
function snapshot(root: string): Map<string, string> {
  return new Map(readdirSync(root, { recursive: true }).map(String).filter(file => /\.toon$|^history\/.*\.jsonl$/.test(file))
    .sort().map(file => [file, readFileSync(join(root, file), "utf8")]));
}
/** Reproducible generated issues cover mixed lifecycles, labels and writer formatting. */
function issues(seed: number): GhIssue[] {
  let state = seed;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  return Array.from({ length: 2 + random() % 3 }, (_, index) => {
    const closed = index === 0 || ((random() >>> 16) & 1) === 0;
    return { number: index + 1, title: `Generated ${random()}`, body: `\n\nBody ${random()}  \n`,
      state: closed ? "closed" : "open", state_reason: closed ? "completed" : null,
      labels: ["plain", "comma,label", "É", "constructor"].filter(() => (random() >>> 16) & 1).map(name => ({ name })),
      assignee: ((random() >>> 16) & 1) ? { login: "none" } : null, milestone: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", closed_at: closed ? "2026-10-02T00:00:00Z" : null,
      html_url: `https://github.com/fixture/project/issues/${index + 1}` };
  });
}

for (const atomic of [false, true]) test(`random issue sets imported twice produce an empty second diff (${atomic ? "atomic" : "plain"})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-sync-property-"));
  try {
    await withEnv({ PATH: join(packageRoot, "node_modules/.bin") + delimiter + process.env.PATH,
      PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: tmpdir() }, async () => {
      for (const seed of [17, 83, 941]) {
        const root = join(directory, String(seed));
        const initialized = spawnSync(join(packageRoot, "node_modules/.bin/pm"), ["--path", root, "init", "fixture"], { encoding: "utf8" });
        assert.equal(initialized.status, 0, initialized.stderr);
        const source = issues(seed);
        // Native existing owners and newly created mirrors share one import batch.
        const owner = (await create({ title: "Old native owner", type: "Issue", tags: "gh:fixture/project#1" }, { pmRoot: root, noExtensions: true })).item;
        const deps = { fetchIssues: async () => source, resolveToken: () => undefined };
        const options = parseImportOptions({ atomic });
        await captureStderr(() => runImport("fixture/project", root, options, deps));
        const before = snapshot(root);
        const second = (await captureStderr(() => runImport("fixture/project", root, options, deps))).result;
        assert.deepEqual(snapshot(root), before, `seed ${seed}: identical issues must not stamp updated_at or append history`);
        // A changed neighbour must not force a write on this unchanged owner.
        source[1] = { ...source[1]!, title: "Changed neighbour" };
        await captureStderr(() => runImport("fixture/project", root, options, deps));
        const after = snapshot(root);
        for (const [file, bytes] of before) if (file.includes(owner.id)) assert.equal(after.get(file), bytes);
        assert.equal((await get(owner.id, {}, { pmRoot: root, noExtensions: true })).item.title, source[0]!.title);
        assert.equal("updated" in second && second.updated, 0);
        const preview = (await captureStderr(() => runImport("fixture/project", root, { ...options, dryRun: true }, deps))).result;
        assert.equal("wouldUpdate" in preview && preview.wouldUpdate, 0, "preview shares the write path's normalized no-op decision");
        assert.deepEqual(snapshot(root), after, "preview writes no durable state");
      }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("gated preview and apply share privacy verdicts for generated non-git source plans", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sync-preview-property-"));
  try {
    for (const seed of [5, 12, 29, 48]) {
      const root = join(directory, String(seed));
      const initialized = spawnSync(join(packageRoot, "node_modules/.bin/pm"), ["--path", root, "init", "fixture"], { encoding: "utf8" });
      assert.equal(initialized.status, 0, initialized.stderr);
      const source = issues(seed);
      const refuses = seed % 3 === 2;
      source[0] = { ...source[0]!, body: refuses ? "contact " + "fixture" + "@example.invalid" : "const re = /private paused = true;/; GET /api/items" };
      const deps = { fetchIssues: async () => source, resolveToken: () => undefined };
      const options = parseImportOptions({ atomic: true, gate: true, "dry-run": true });
      const before = snapshot(root);
      const preview = await captureStderr(async () => {
        try { await runImport("fixture/project", root, options, deps); return true; } catch (error) {
          assert.match((error as Error).message, /email-address/); return false;
        }
      });
      assert.equal(preview.result, !refuses);
      assert.deepEqual(snapshot(root), before);
      // Apply checks the same plan first; establish Git only for its final diff gate.
      assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
      // Match the published tracker's runtime exclusions after adding Git.
      writeFileSync(join(root, ".gitignore"), "transactions/\nruntime/\nsearch/\nlocks/\nextensions/\n");
      const apply = await captureStderr(async () => {
        try { await runImport("fixture/project", root, { ...options, dryRun: false }, deps); return true; } catch (error) {
          assert.match((error as Error).message, /email-address/); return false;
        }
      });
      assert.equal(apply.result, preview.result, `seed ${seed}`);
      if (refuses) assert.deepEqual(snapshot(root), before, "refused plans write no items or history");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

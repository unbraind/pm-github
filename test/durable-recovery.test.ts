/** Recovery publication failures use native filesystem faults and real SDK trackers. */
import assert from "node:assert/strict";
import test from "node:test";
import fs, { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { init, listAllComplete } from "@unbrained/pm-cli/sdk";
import { importGithubAtomic, runImport, parseImportOptions, readGithubImportPlan, type PreparedGithubImport } from "../index.ts";
import { writeGithubStateAtomic } from "../durable-state.ts";
import { withEnv, captureStderr } from "./helpers/mock-github-server.ts";

/** Keep tracker persistence real while excluding inherited extension and global state. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-durable-"));
  const root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Native documents and audit bytes must remain untouched before a plan is published. */
function nativeBytes(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && (entry.name.endsWith(".toon") || entry.parentPath.includes("history")))
    .map(entry => [join(entry.parentPath, entry.name).slice(root.length), readFileSync(join(entry.parentPath, entry.name), "utf8")]).sort();
}
/** A clean source plan shared with the crash fixture. */
function entry(): PreparedGithubImport {
  return { issueNumber: 7, title: "Source issue", itemType: "Issue", status: "open", description: "GH issue #7: https://github.com/fixture/repo/issues/7",
    body: "Source body", tags: ["gh:fixture/repo#7"], comments: [], syncAnnotations: false };
}
/** Zero-source polling must never be poisoned by an unpublished candidate. */
async function emptyImport(root: string) {
  return captureStderr(() => runImport("fixture/repo", root, parseImportOptions({ atomic: true }), { resolveToken: () => undefined, fetchIssues: async () => [] }));
}

test("partial native plan writes do not poison a zero-item retry", async () => tracker(async root => {
  const before = nativeBytes(root);
  let injected = false;
  let error: unknown;
  try {
    await importGithubAtomic(root, "fixture/repo", [entry()], { onPlanStaged: async ({ staged }) => {
      // Real partial bytes plus an injected I/O failure at the publication boundary.
      await fs.promises.writeFile(staged, "{");
      injected = true;
      throw Object.assign(new Error("Injected partial plan write failure"), { code: "EIO" });
    } });
  } catch (caught) { error = caught; }
  assert.equal(injected, true);
  assert.deepEqual(nativeBytes(root), before);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
  await emptyImport(root);
  assert.equal((error as { code: string }).code, "github_import_plan_write_failed");
  await importGithubAtomic(root, "fixture/repo", [entry()]);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}));

test("crash after plan fsync and before publication leaves zero-item imports usable", async () => tracker(async root => {
  const before = nativeBytes(root);
  const child = spawnSync(process.execPath, [join(import.meta.dirname, "fixtures/atomic-plan-crash.ts"), root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, "SIGKILL");
  assert.deepEqual(nativeBytes(root), before);
  const names = readdirSync(join(root, "transactions/pm-github"));
  assert.equal(names.filter(name => !name.startsWith(".") && name.endsWith(".json")).length, 0);
  const staged = names.find(name => name.endsWith(".stage"));
  assert.ok(staged, "the interrupted candidate stays invisible to recovery discovery");
  assert.equal(JSON.parse(readFileSync(join(root, "transactions/pm-github", staged), "utf8")).entries[0].issueNumber, 7);
  await emptyImport(root);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
  await importGithubAtomic(root, "fixture/repo", [entry()]);
  assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
}));

for (const outcome of ["publish", "failure", "interruption"] as const) test(`concurrent state readers see only complete previous or published bytes (${outcome})`, async () => tracker(async root => {
  const file = join(root, "reader-state.json");
  const previous = { sequence: 1, text: "Previous receipt" };
  const next = { sequence: 2, text: "x".repeat(100000) };
  writeFileSync(file, JSON.stringify(previous));
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const publishing = writeGithubStateAtomic(file, JSON.stringify(next), { onStaged: async ({ staged }) => {
    await fs.promises.writeFile(staged, "{");
    entered();
    await proceed;
    if (outcome === "failure") throw Object.assign(new Error("Injected partial state write failure"), { code: "EIO" });
    if (outcome === "interruption") throw new Error("Interrupted before rename");
    await fs.promises.writeFile(staged, JSON.stringify(next));
    const handle = await fs.promises.open(staged, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  } });
  const settled = publishing.then(() => undefined, error => error as Error);
  try {
    await paused;
    const reads = await Promise.all(Array.from({ length: 32 }, () => fs.promises.readFile(file, "utf8")));
    assert.ok(reads.every(text => text === JSON.stringify(previous)), "A concurrent reader observed unpublished or partial state");
  } finally { release(); await settled; }
  const error = await settled;
  assert.equal(Boolean(error), outcome !== "publish");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), outcome === "publish" ? next : previous);
  // An exclusive writer must preserve a peer's published state.
  await assert.rejects(() => writeGithubStateAtomic(file, "{}", { exclusive: true }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), outcome === "publish" ? next : previous);
  await writeGithubStateAtomic(file, JSON.stringify(next));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next);
}));

for (const body of ["", "{", "null", "[]", "{}", '{"transactionId":"github-import-partial"}']) test(`corrupt recovery plan has a typed actionable refusal (${JSON.stringify(body)})`, async () => tracker(async root => {
  const id = "github-import-1234567890abcdef";
  const directory = join(root, "transactions/pm-github");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${id}.json`);
  writeFileSync(file, body);
  const before = nativeBytes(root);
  for (const read of [() => readGithubImportPlan(root, id), () => emptyImport(root)]) await assert.rejects(read, error => {
    assert.equal((error as { code: string }).code, "github_import_plan_corrupt");
    assert.match(String(error), new RegExp(`${id}.*Restore its original plan.*reconcile its SDK journal`));
    return true;
  });
  assert.deepEqual(nativeBytes(root), before);
  assert.equal(readFileSync(file, "utf8"), body);
  rmSync(file);
  await emptyImport(root);
  assert.equal(existsSync(file), false);
}));

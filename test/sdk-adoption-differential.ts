/** Compare two built implementations on disposable copies of public tracker snapshots. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Digest every source file so the proof also verifies that snapshots stay read-only. */
function digest(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? digest(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

const [baseline, ...inputs] = process.argv.slice(2);
assert.ok(baseline && inputs.length > 0 && inputs.length % 2 === 0,
  "Usage: node test/sdk-adoption-differential.ts <baseline-build-root> <snapshot-root> <item-id> [...]");
const current = resolve(import.meta.dirname, "..");
const sdk = import.meta.resolve("@unbrained/pm-cli/sdk");
const issue = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/import-fidelity/pm-beads-85.json"), "utf8")) as Record<string, unknown>;
const scenarios = ["closed", "open", "link", "normalized", "guard", "ownership", "missing"];

/** Run the real built function with a frozen clock and no git executable. */
function replay(build: string, snapshot: string, id: string, scenario: string): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), "pm-sdk-differential-"));
  const pmRoot = join(directory, ".agents/pm");
  cpSync(snapshot, pmRoot, { recursive: true });
  const program = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join, relative } from 'node:path';
    import { mock } from 'node:test';
    import { locateItem, readSettings, mutateItem, getHistoryPath, setActiveExtensionHooks } from ${JSON.stringify(sdk)};
    import { persistImportFidelity, buildImportFidelity } from ${JSON.stringify(pathToFileURL(join(resolve(build), "dist/import-fidelity.js")).href)};
    const { pmRoot, id, scenario, issue } = JSON.parse(process.env.PM_DIFFERENTIAL_INPUT);
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00.000Z') });
    const settings = await readSettings(pmRoot);
    if (scenario === 'ownership') {
      await mutateItem({ pmRoot, settings, id, author: 'fixture', op: 'update', force: true,
        mutate: document => { document.metadata.assignee = 'fixture-owner'; return { changedFields: ['assignee'] }; } });
      const raw = JSON.parse(readFileSync(join(pmRoot, 'settings.json'), 'utf8'));
      raw.governance = { ...raw.governance, preset: 'custom', ownership_enforcement: 'strict' };
      writeFileSync(join(pmRoot, 'settings.json'), JSON.stringify(raw));
    }
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format);
    assert.ok(located);
    const historyPath = getHistoryPath(pmRoot, id);
    const snapshot = () => ({ item: readFileSync(located.itemPath, 'utf8'), history: readFileSync(historyPath, 'utf8') });
    const before = snapshot();
    const writes = [];
    const lockOps = [];
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onIndex: [],
      beforeMutation: scenario === 'guard' ? [{ layer: 'project', name: 'fixture-guard', run: () =>
        ({ allow: false, code: 'fixture_refusal', message: 'Lifecycle import denied', remediation: 'Review source lifecycle' }) }] : [],
      onWrite: [{ layer: 'project', name: 'fixture-observer', run: context => {
        if (context.op.startsWith('lock:')) lockOps.push(context.op);
        else if (context.op === 'import' || context.op === 'import:history') writes.push({ ...context, path: relative(pmRoot, context.path) });
      } }] });
    const fidelity = buildImportFidelity(scenario === 'open' ? { ...issue, state: 'open', closed_at: null } : issue, [], []);
    let error = null;
    try {
      await persistImportFidelity(pmRoot, scenario === 'missing' ? 'missing-fixture' : id.slice(settings.id_prefix.length), fidelity, scenario === 'link');
    } catch (caught) { error = caught.message; }
    const after = snapshot();
    const firstWrites = structuredClone(writes);
    if (error === null) {
      writes.length = 0;
      const retry = scenario === 'normalized' ? { ...fidelity, github_created_at: new Date(fidelity.github_created_at).toISOString() } : fidelity;
      await persistImportFidelity(pmRoot, id, retry, scenario === 'link', scenario === 'normalized');
      assert.deepEqual(snapshot(), after, 'retry must preserve exact item/history bytes');
      assert.equal(writes.length, 0, 'retry must not emit import hooks');
    }
    console.log(JSON.stringify({ before, after, writes: firstWrites, error, lockOps }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: directory, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PM_DIFFERENTIAL_INPUT: JSON.stringify({ pmRoot, id, scenario, issue }),
        PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: tmpdir(), PATH: directory },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

let comparisons = 0;
for (let index = 0; index < inputs.length; index += 2) {
  const snapshot = resolve(inputs[index]!);
  const id = inputs[index + 1]!;
  const beforeDigest = digest(snapshot);
  for (const scenario of scenarios) {
    const before = replay(baseline, snapshot, id, scenario);
    const after = replay(current, snapshot, id, scenario);
    // SDK index maintenance adds its own lock observations; import hook payloads
    // and the durable output are compared separately from these runtime locks.
    delete before.lockOps;
    delete after.lockOps;
    if (scenario === "guard" || scenario === "ownership") {
      assert.equal(before.error, null);
      assert.match(String(after.error), scenario === "guard" ? /Lifecycle import denied/ : /assigned to fixture-owner/);
      assert.deepEqual(after.after, after.before, "SDK refusals must precede item/history writes");
      assert.deepEqual(after.writes, []);
      console.log(`${id} ${scenario}: intentional SDK policy refusal; zero durable writes`);
    } else if (scenario === "missing") {
      assert.match(String(before.error), /missing during lifecycle/);
      assert.match(String(after.error), /not found/);
      assert.deepEqual(before.after, before.before);
      assert.deepEqual(after.after, after.before);
      console.log(`${id} missing: intentional SDK not-found diagnostic; zero durable writes`);
    } else {
      assert.deepEqual(after, before, `${id} ${scenario}: exact durable bytes and import hook payloads`);
      console.log(`${id} ${scenario}: identical item/history bytes, import hook payloads and no-op retry`);
    }
    comparisons++;
  }
  assert.equal(digest(snapshot), beforeDigest, "public source snapshot must remain unchanged");
}
console.log(`${comparisons} differential scenarios passed; source snapshots unchanged; all replays ran without git.`);

/** Lifecycle finalization uses real SDK guards and hooks in a tracker without git. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  create, getHistoryPath, getItemPath, readHistorySnapshot,
  setActiveExtensionHooks, type ExtensionHookRegistry,
} from "@unbrained/pm-cli/sdk";
import { buildImportFidelity, persistImportFidelity } from "../import-fidelity.ts";
import type { GhIssue } from "../index.ts";
import { withEnv } from "./helpers/mock-github-server.ts";

const cli = join(import.meta.dirname, "../node_modules/.bin/pm");
const issue = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/import-fidelity/pm-beads-85.json"), "utf8")) as GhIssue;
const fidelity = buildImportFidelity(issue, [], []);

/** Initialize a real plain tracker, then remove git from the command path. */
async function tracker(run: (pmRoot: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pm-sdk-adoption-"));
  const pmRoot = join(directory, ".agents/pm");
  try {
    const result = spawnSync(cli, ["--path", pmRoot, "init", "fixture"], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 0, result.stderr);
    await withEnv({ PATH: directory, GIT_CEILING_DIRECTORIES: tmpdir(), PM_AUTHOR: "fixture" }, () => run(pmRoot));
  } finally {
    setActiveExtensionHooks(null);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Build an explicit runtime registry without replacing any SDK operation. */
function hooks(): ExtensionHookRegistry {
  return { beforeCommand: [], beforeMutation: [], afterCommand: [], onWrite: [], onRead: [], onIndex: [] };
}

test("lifecycle finalization honors transactional guards before either durable write", async () => tracker(async pmRoot => {
  const item = (await create({ title: "Guarded lifecycle", type: "Task" }, { pmRoot })).item;
  const itemPath = getItemPath(pmRoot, item.type, item.id);
  const historyPath = getHistoryPath(pmRoot, item.id);
  const before = [readFileSync(itemPath, "utf8"), readFileSync(historyPath, "utf8")];
  const registry = hooks();
  registry.beforeMutation.push({ layer: "project", name: "fixture-guard", run: context => {
    assert.equal(context.operation, "import");
    assert.equal(context.after!.metadata.created_at, issue.created_at);
    return { allow: false, code: "fixture_refusal", message: "Lifecycle import denied", remediation: "Review the proposed source lifecycle" };
  } });
  setActiveExtensionHooks(registry);
  await assert.rejects(persistImportFidelity(pmRoot, item.id, fidelity, false), /Lifecycle import denied/);
  assert.deepEqual([readFileSync(itemPath, "utf8"), readFileSync(historyPath, "utf8")], before);
  setActiveExtensionHooks(null);
  await persistImportFidelity(pmRoot, item.id, fidelity, false);
}));

test("lifecycle finalization respects strict tracker ownership", async () => tracker(async pmRoot => {
  const item = (await create({ title: "Owned lifecycle", type: "Task", assignee: "fixture-owner" }, { pmRoot })).item;
  const settings = JSON.parse(readFileSync(join(pmRoot, "settings.json"), "utf8")) as { governance: Record<string, unknown> };
  settings.governance = { ...settings.governance, preset: "custom", ownership_enforcement: "strict" };
  writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings));
  const itemPath = getItemPath(pmRoot, item.type, item.id);
  const historyPath = getHistoryPath(pmRoot, item.id);
  const before = [readFileSync(itemPath, "utf8"), readFileSync(historyPath, "utf8")];
  await assert.rejects(persistImportFidelity(pmRoot, item.id, fidelity, true), /assigned to fixture-owner/);
  assert.deepEqual([readFileSync(itemPath, "utf8"), readFileSync(historyPath, "utf8")], before);
}));

test("SDK finalization preserves both import write hooks and JSON-pointer fields; retry emits none", async () => tracker(async pmRoot => {
  const item = (await create({ title: "Observed lifecycle", type: "Task" }, { pmRoot })).item;
  const registry = hooks();
  const writes: Parameters<ExtensionHookRegistry["onWrite"][number]["run"]>[0][] = [];
  registry.onWrite.push({ layer: "project", name: "fixture-observer", run: context => {
    if (context.op === "import" || context.op === "import:history") writes.push(context);
  } });
  setActiveExtensionHooks(registry);
  await persistImportFidelity(pmRoot, item.id, fidelity, false);
  assert.deepEqual(writes.map(context => context.op), ["import", "import:history"]);
  assert.deepEqual(writes.map(context => context.path), [getItemPath(pmRoot, item.type, item.id), getHistoryPath(pmRoot, item.id)]);
  const entry = (await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id)).entries.at(-1)!;
  for (const context of writes) {
    assert.equal(context.item_id, item.id);
    assert.equal(context.item_type, "Task");
    assert.equal(context.before!.metadata.created_at, item.created_at);
    assert.equal(context.after!.metadata.created_at, issue.created_at);
    assert.deepEqual(context.changed_fields, entry.patch.map(patch => patch.path));
  }
  const history = readFileSync(getHistoryPath(pmRoot, item.id), "utf8");
  await persistImportFidelity(pmRoot, item.id, fidelity, false);
  assert.equal(writes.length, 2);
  assert.equal(readFileSync(getHistoryPath(pmRoot, item.id), "utf8"), history);
}));

test("import hook fields match the actual history patch when the clock advances after mutation", async () => tracker(async pmRoot => {
  const item = (await create({ title: "Clock-boundary lifecycle", type: "Task" }, { pmRoot })).item;
  const RealDate = Date;
  let clock = Date.parse(item.updated_at!);
  /** Freeze Date until a queued source-read observation advances the clock. */
  class ClockDate extends RealDate {
    /** Preserve explicit date parsing while controlling no-argument clock reads. */
    constructor(value?: string | number) { super(value ?? clock); }
    /** Return the same controlled instant for SDK lock and clock checks. */
    static now(): number { return clock; }
  }
  const registry = hooks();
  const writes: Parameters<ExtensionHookRegistry["onWrite"][number]["run"]>[0][] = [];
  registry.onWrite.push({ layer: "project", name: "clock-observer", run: context => {
    if (context.op === "import" || context.op === "import:history") writes.push(context);
  } });
  setActiveExtensionHooks(registry);
  globalThis.Date = ClockDate as unknown as DateConstructor;
  try {
    const advancing = { ...fidelity, get github_created_at(): string {
      // The source is read synchronously. This tick runs at the next await,
      // between the SDK callback and its final native updated_at assignment.
      queueMicrotask(() => { clock++; });
      return fidelity.github_created_at;
    } };
    await persistImportFidelity(pmRoot, item.id, advancing, false);
    const entry = (await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id)).entries.at(-1)!;
    assert.equal(writes.length, 2);
    for (const context of writes) assert.deepEqual(context.changed_fields, entry.patch.map(patch => patch.path));
  } finally { globalThis.Date = RealDate; }
}));

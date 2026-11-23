import { createImportMirror as create } from "./helpers/import-mirror.ts";
/** Lifecycle finalization uses real SDK guards and hooks in a tracker without git. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commitItemMutations, get, getHistoryPath, getItemPath, mutateItem, previewItemMutations, readHistorySnapshot, readItemTransaction, readSettings,
  setActiveExtensionHooks, type ExtensionHookRegistry,
} from "@unbrained/pm-cli/sdk";
import { buildImportFidelity, persistImportFidelity } from "../import-fidelity.ts";
import { importGithubAtomic, listUnfinishedGithubImports, type GhIssue, type PreparedGithubImport } from "../index.ts";
import { withGithubImportOwners } from "../import-ownership.ts";
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
  const item = (await create({ title: "Guarded lifecycle", type: "Task", tags: "gh:unbraind/pm-beads#85", description: `GH issue #85: ${issue.html_url}` }, { pmRoot })).item;
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
  const item = (await create({ title: "Owned lifecycle", type: "Task", assignee: "fixture-owner", tags: "gh:unbraind/pm-beads#85", description: `GH issue #85: ${issue.html_url}` }, { pmRoot })).item;
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
  const item = (await create({ title: "Observed lifecycle", type: "Task", tags: "gh:unbraind/pm-beads#85", description: `GH issue #85: ${issue.html_url}` }, { pmRoot })).item;
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
  const item = (await create({ title: "Clock-boundary lifecycle", type: "Task", tags: "gh:unbraind/pm-beads#85", description: `GH issue #85: ${issue.html_url}` }, { pmRoot })).item;
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

test("delegated ownership guards judge the same history actor in preview and apply", async () => tracker(async pmRoot => {
  const repo = "unbraind/pm-beads";
  const item = (await create({ title: "Original", type: "Issue", tags: `gh:${repo}#85` }, { pmRoot })).item;
  const historyPath = getHistoryPath(pmRoot, item.id);
  const historyBefore = readFileSync(historyPath, "utf8");
  const observations: { actor: string; dry_run: boolean }[] = [];
  const registry = hooks();
  registry.beforeMutation.push({ layer: "project", name: "actor-guard", run: context => {
    observations.push({ actor: context.actor.author, dry_run: context.dry_run });
    if (context.actor.author !== "fixture-signer") return { allow: false, code: "actor_refused", remediation: "Use the intended author." };
  } });
  setActiveExtensionHooks(registry);
  const target = { id: item.id, repo, number: 85 };
  const plan = { pmRoot, transactionId: "fixture-actor", author: "fixture-signer",
    mutations: [{ op: "update" as const, id: item.id, options: { title: "Changed" } }] };
  await withGithubImportOwners(pmRoot, [target], () => previewItemMutations(plan));
  assert.equal(readFileSync(historyPath, "utf8"), historyBefore);
  await withGithubImportOwners(pmRoot, [target], () => commitItemMutations(plan));
  assert.deepEqual(observations, [
    { actor: "fixture-signer", dry_run: true },
    { actor: "fixture-signer", dry_run: false },
  ]);
  assert.equal((await readHistorySnapshot(historyPath, item.id)).entries.at(-1)!.author, "fixture-signer");
  await assert.rejects(withGithubImportOwners(pmRoot, [target], () => previewItemMutations({ ...plan,
    transactionId: "fixture-wrong-actor", author: "fixture-other",
    mutations: [{ op: "update", id: item.id, options: { title: "Refused change" } }],
  })), { code: "actor_refused" });
  assert.equal((await get(item.id, {}, { pmRoot })).item.title, "Changed");
}));

test("a later row failure compensates source metadata in a tracker without git", async () => tracker(async pmRoot => {
  const repo = "unbraind/pm-beads";
  const first: PreparedGithubImport = {
    issueNumber: 85, title: issue.title, itemType: "Issue", status: "closed",
    description: `GH issue #85: ${issue.html_url}`, body: "", tags: [`gh:${repo}#85`],
    comments: [], syncAnnotations: false, fidelity,
  };
  const initial = await importGithubAtomic(pmRoot, repo, [first]);
  const id = initial.itemIds.get(85)!;
  const before = (await get(id, {}, { pmRoot })).item;
  const changed = { ...first, title: "Changed title", match: before, fidelity: { ...fidelity, github_updated_at: "2026-10-01T00:00:00Z" } };
  const invalid: PreparedGithubImport = {
    ...first, issueNumber: 86, title: "", description: `GH issue #86: https://github.com/${repo}/issues/86`,
    tags: [`gh:${repo}#86`], fidelity: undefined,
  };
  await assert.rejects(importGithubAtomic(pmRoot, repo, [changed, invalid]), /no new partial committed state is expected.*Title cannot be empty/);
  const after = (await get(id, {}, { pmRoot })).item;
  for (const field of ["title", "created_at", "closed_at", "completed_at", "github_updated_at"]) assert.equal(after[field], before[field]);
  const { entries } = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
  const journalEvents = entries.filter(entry => entry.message?.includes("-finalize-"));
  assert.equal(journalEvents.filter(entry => entry.message?.endsWith("apply")).length, 2);
  assert.equal(journalEvents.filter(entry => entry.message?.endsWith("compensate")).length, 1);
}));

for (const changedField of ["created_at", "completed_at"] as const) {
  test(`finalize refuses to overwrite a curated lifecycle changed during the transaction (${changedField})`, async () => tracker(async pmRoot => {
    const repo = "unbraind/pm-beads";
    const item = (await create({ title: "Curated", type: "Issue", tags: `gh:${repo}#85`, description: `GH issue #85: ${issue.html_url}` }, { pmRoot })).item;
    await mutateItem({ pmRoot, settings: await readSettings(pmRoot), id: item.id, author: "fixture", op: "update",
      mutate: document => {
        document.metadata.created_at = "2020-01-01T00:00:00Z";
        return { changedFields: ["created_at"] };
      },
    });
    const match = (await get(item.id, {}, { pmRoot })).item;
    const entry: PreparedGithubImport = { issueNumber: 85, title: item.title, itemType: "Issue", status: "closed",
      description: item.description, body: "", tags: [`gh:${repo}#85`], comments: [], syncAnnotations: false, preserveContent: true, match, fidelity };
    const peerDate = "2027-01-01T00:00:00Z";
    await assert.rejects(importGithubAtomic(pmRoot, repo, [entry], {
      onTransition: async ({ transition }) => {
        if (transition !== "prepared") return;
        await mutateItem({ pmRoot, settings: await readSettings(pmRoot), id: item.id, author: "fixture-peer", op: "update",
          mutate: document => {
            document.metadata[changedField] = peerDate;
            return { changedFields: [changedField] };
          },
        });
      },
    }), /conflicts with its current native dates/);
    const stored = (await get(item.id, {}, { pmRoot })).item;
    assert.equal(stored[changedField], peerDate);
    assert.equal(stored.github_closed_at, undefined);
    assert.deepEqual(await listUnfinishedGithubImports(pmRoot), []);
  }));
}

test("a content-only refresh leaves source metadata touched after planning intact", async () => tracker(async pmRoot => {
  const repo = "unbraind/pm-beads";
  const entry: PreparedGithubImport = { issueNumber: 85, title: issue.title, itemType: "Issue", status: "closed",
    description: `GH issue #85: ${issue.html_url}`, body: "", tags: [`gh:${repo}#85`],
    comments: [], syncAnnotations: false, fidelity };
  const initial = await importGithubAtomic(pmRoot, repo, [entry]);
  const id = initial.itemIds.get(85)!;
  const match = (await get(id, {}, { pmRoot })).item;
  const result = await importGithubAtomic(pmRoot, repo, [{ ...entry, title: "Only the title changed", match }], {
    updateOnly: true,
    onTransition: async ({ transition }) => {
      if (transition !== "committing") return;
      await mutateItem({ pmRoot, settings: await readSettings(pmRoot), id, author: "fixture-peer", op: "update",
        mutate: document => {
          document.metadata.github_state_reason = "peer observation";
          return { changedFields: ["github_state_reason"] };
        },
      });
    },
  });
  const journal = await readItemTransaction(pmRoot, result.transactionId);
  assert.equal(journal?.journal.stepIds.length, 1);
  const stored = (await get(id, {}, { pmRoot })).item;
  assert.equal(stored.title, "Only the title changed");
  assert.equal(stored.github_state_reason, "peer observation");
}));

test("a nested ownership scope enforces stronger curated lifecycle protection", async () => tracker(async pmRoot => {
  const repo = "unbraind/pm-beads";
  const item = (await create({ title: "Curated completion", type: "Issue", tags: `gh:${repo}#85`,
    description: `GH issue #85: ${issue.html_url}` }, { pmRoot })).item;
  const settings = await readSettings(pmRoot);
  const completedAt = "2026-10-01T00:00:00Z";
  await mutateItem({ pmRoot, settings, id: item.id, author: "fixture", op: "update",
    mutate: document => {
      document.metadata.completed_at = completedAt;
      return { changedFields: ["completed_at"] };
    },
  });
  const target = { repo, id: item.id, number: 85 };
  await assert.rejects(withGithubImportOwners(pmRoot, [target], () =>
    withGithubImportOwners(pmRoot, [{ ...target, preserveContent: true }], () =>
      mutateItem({ pmRoot, settings, id: item.id, author: "pm-github", op: "import",
        mutate: document => {
          document.metadata.completed_at = "2026-10-02T00:00:00Z";
          return { changedFields: ["completed_at"] };
        },
      }))), { code: "item_revision_conflict" });
  assert.equal((await get(item.id, {}, { pmRoot })).item.completed_at, completedAt);
}));

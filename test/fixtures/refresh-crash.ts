/**
 * Crash fixture for interrupted-refresh recovery: creates one linked item,
 * starts a real update-only atomic refresh transaction, and kills the process
 * at either a partial apply or the `committing` transition, before the SDK
 * journal commits. Invoked as a child process by
 * test/refresh.test.ts; exits 9 to emulate a hard crash without compensation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitItemMutations, normalizeItemId, readSettings } from "@unbrained/pm-cli/sdk";
import { buildAtomicImportMutations, importGithubAtomic, parseImportOptions, prepareGithubImport, scanGithubImportPreflight } from "../../index.ts";
import { createImportMirror } from "../helpers/import-mirror.ts";

const pmRoot = process.argv[2]!;
const boundary = process.argv[3] ?? "committing";
const number = Number(process.argv[4] ?? "1");
const linked = (await createImportMirror({ title: "Stale", tags: `gh:fixture/repo#${number}` }, { pmRoot })).item;
const issue = { number, title: "New upstream title", body: null, state: "closed" as const, state_reason: "completed" as const, closed_at: "2026-02-02T00:00:00Z", labels: [{ name: "bug" }], user: { login: "fixture" }, assignee: null, milestone: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z", html_url: `https://github.com/fixture/repo/issues/${number}` };
const entry = (await prepareGithubImport(issue, "fixture/repo", parseImportOptions({ atomic: true }), "fixture", linked, undefined,
  { items: [linked], releases: [], timeline: async () => [] }))!;
console.log(`crash fixture: linked ${linked.id}, entering atomic refresh`);
/** Hold a real SDK journal before normal completion, as a process crash would. */
function interrupt({ transition }: { transition: string }): void {
  if (transition === boundary) {
    console.log(`crash fixture: ${boundary} transition reached, exiting 9`);
    process.exit(9);
  }
}

if (process.argv[5] === "legacy-nullable") {
  const repo = "fixture/repo";
  const transactionId = "github-import-legacy-nullable";
  const { mutations } = buildAtomicImportMutations(repo, entry, (await readSettings(pmRoot)).id_prefix, normalizeItemId, true);
  const entries = [{ ...entry, fidelity: { ...entry.fidelity!, github_state_reason: null, github_close_reason: null, github_release: null } }];
  const record = { transactionId, repo, entries, mutations };
  const preflight = scanGithubImportPreflight(pmRoot, entries as unknown as typeof entry[], mutations, record);
  const plans = join(pmRoot, "transactions", "pm-github");
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, `${transactionId}.json`), JSON.stringify({ ...record, preflight }));
  await commitItemMutations({ pmRoot, transactionId, author: "pm-github", mutations, createCompensation: "delete", onTransition: interrupt });
} else {
  await importGithubAtomic(pmRoot, "fixture/repo", [entry], { updateOnly: true, onTransition: interrupt });
}
throw new Error("crash fixture: the interrupted refresh unexpectedly completed");
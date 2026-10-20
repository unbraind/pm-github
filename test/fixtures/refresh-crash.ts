/**
 * Crash fixture for interrupted-refresh recovery: creates one linked item,
 * starts a real update-only atomic refresh transaction, and kills the process
 * at either a partial apply or the `committing` transition, before the SDK
 * journal commits. Invoked as a child process by
 * test/refresh.test.ts; exits 9 to emulate a hard crash without compensation.
 */
import { importGithubAtomic, parseImportOptions, prepareGithubImport } from "../../index.ts";
import { create } from "@unbrained/pm-cli/sdk";

const pmRoot = process.argv[2]!;
const boundary = process.argv[3] ?? "committing";
const number = Number(process.argv[4] ?? "1");
const linked = (await create({ title: "Stale", tags: `gh:fixture/repo#${number}` }, { pmRoot })).item;
const issue = { number, title: "New upstream title", body: null, state: "closed" as const, state_reason: "completed" as const, closed_at: "2026-02-02T00:00:00Z", labels: [{ name: "bug" }], user: { login: "fixture" }, assignee: null, milestone: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T00:00:00Z", html_url: `https://github.com/fixture/repo/issues/${number}` };
const entry = (await prepareGithubImport(issue, "fixture/repo", parseImportOptions({ atomic: true }), "fixture", linked, undefined,
  { items: [linked], releases: [], timeline: async () => [] }))!;
console.log(`crash fixture: linked ${linked.id}, entering atomic refresh`);
await importGithubAtomic(pmRoot, "fixture/repo", [entry], {
  updateOnly: true,
  onTransition: context => {
    if (context.transition === boundary) {
      console.log(`crash fixture: ${boundary} transition reached, exiting 9`);
      process.exit(9);
    }
  },
});
throw new Error("crash fixture: the interrupted refresh unexpectedly completed");
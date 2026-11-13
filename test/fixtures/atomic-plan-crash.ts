/** Crash at the flushed-candidate boundary, before any recovery plan or SDK mutation is published. */
import { importGithubAtomic } from "../../index.ts";

await importGithubAtomic(process.argv[2]!, "fixture/repo", [{ issueNumber: 7, title: "Source issue", itemType: "Issue", status: "open",
  description: "GH issue #7: https://github.com/fixture/repo/issues/7", body: "Source body", tags: ["gh:fixture/repo#7"], comments: [], syncAnnotations: false }], {
  onPlanStaged: () => { process.kill(process.pid, "SIGKILL"); },
});

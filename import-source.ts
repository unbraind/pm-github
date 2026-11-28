/** Compare the evidence used by import without publishing source content in receipts. */
import { createHash } from "node:crypto";
import type { GhIssue, PreparedGithubImport } from "./index.ts";

/** Hash the selected issue set and the source projections used to render it. */
export function importSourceSnapshot(
  repo: string,
  issues: readonly GhIssue[],
  missing: readonly number[],
  prepared: readonly PreparedGithubImport[],
): string {
  const entries = new Map(prepared.map(entry => [entry.issueNumber, entry]));
  const hash = createHash("sha256");
  hash.update(JSON.stringify(["github-import-source-v1", repo.toLowerCase(), [...missing].sort((a, b) => a - b)]));
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const entry = entries.get(issue.number);
    const fidelity = entry?.fidelity;
    hash.update(JSON.stringify([
      issue.number, issue.html_url, issue.title, issue.body, issue.state, issue.state_reason,
      issue.created_at, issue.updated_at, issue.closed_at, Boolean(issue.pull_request),
      issue.user?.login, issue.assignee?.login, issue.milestone?.title, issue.labels.map(label => label.name).sort(), issue.comments ?? 0,
      fidelity?.github_close_reason, fidelity?.github_release,
      entry?.comments.map(comment => [comment.id, comment.user?.login, comment.created_at, comment.body]),
    ]));
  }
  return hash.digest("hex");
}

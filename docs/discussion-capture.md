## Selected GitHub discussion decisions

Copy `docs/discussion-capture-example.json`, select an existing native context item and edit the repository, issue, comment ID and exact span. `marked: true` records an explicit selection by the caller. The adapter never infers decisions from prose, labels, imperative language or an entire unselected thread. Empty selections create nothing. Issue body extraction and PR review findings are outside this feature.

```sh
pm github discussion capture --input selection.json --json
pm github discussion capture --input selection.json --approve REVIEWED_DIGEST --json
```

Review the complete first receipt before supplying its `approval`. Each row exposes the proposed native Decision ID, source author ID/login, canonical comment URL, timestamp, SHA-256 revision and exact quoted span. Routine output contains only selected passages. Default pm rendering is compact TOON; `--json` uses the same typed receipt. `created`, `unchanged`, `skipped` and `refused` count row states. A successful envelope can contain independent refused rows: inspect these counters and remedies. A refusal never permits a dependent write.

Offsets are zero-based, half-open UTF-16 code units, matching JavaScript `body.slice(start, end)`. CRLF, Unicode and whitespace are preserved exactly in the JSON evidence body; the SDK still owns native field normalization. Issue, comment and author IDs are positive safe integers; counters are nonnegative integers bounded by the ten-selection limit. Native item selectors and emitted identifiers are 1..512 code units without NUL, CRLF or path separators; the SDK resolves whitespace aliases and canonical item identifiers. Configured status IDs are 1..512 code units without NUL or CRLF and retain the SDK's own status semantics, including Unicode and slash-bearing names. Author logins accept bounded human and bot identities. Offsets are at most 65536, quotes are 1..4096 code units and at most ten dense selections are accepted. Comments are bounded to 65536 code units. No sparse arrays, unknown request keys, nonfinite numbers or implicit coercion are accepted. Output defaults to 65536 JSON bytes; `--max-output-bytes` accepts an integer 1024..131072. Planning reserves space for retry/refusal rows before any create. Split larger captures. Repeated spans in one request are skipped explicitly.

Source revisions hash the ordered tuple of comment ID, exact full body, API issue URL, comment URL, update timestamp, author ID and login. An edit anywhere in that selected comment invalidates the prior approval, even when the selected quote is unchanged. Each source must belong to the selected issue; the HTTP reader verifies the issue is not a pull request. A supplied SDK reader must provide current issue-comment snapshots under that same contract. GitHub access is read-only: only GET requests are issued.

Each capture creates one native `Decision`, parented explicitly to the selected context item, with empty dependencies and no sprint, release, goal or objective. Native linked docs point to the comment and source revision. Evidence is serialized JSON data, never executable instructions, a prompt, markdown expansion or a shell command. The provider author remains separate from the host's audit author. pm-evidence can cite this native Decision body for its own resolution/review workflows; this adapter does not maintain another citation store.

The SDK surface is `captureGithubDiscussion(pmRoot, input, hostSdk, options)`, exported with `DiscussionCaptureInput`, `DiscussionCaptureReport`, `DiscussionDecisionEvidence`, `DiscussionCaptureOptions`, `DiscussionCommentReader` and `DiscussionRefusalCode`. Pass the host-injected `ExtensionCommandSdk`; standalone callers may construct it through public `createExtensionCommandSdk` and `PmClient`. No executable/symlink traversal or eager SDK client acquisition occurs. Public SDK helpers resolve workspace schema and read native history. `validateDiscussionCaptureReport` validates JSON/TOON-decoded producer receipts through the same shared schema. No import/export/sync route bypasses the common capture path; the existing issue importer/exporter is unchanged.

```ts
import { captureGithubDiscussion, type DiscussionCaptureInput } from "pm-github";
import { PmClient, createExtensionCommandSdk } from "@unbrained/pm-cli/sdk";

const pmRoot = "tracker";
const sdk = createExtensionCommandSdk(pmRoot, new PmClient({ pmRoot, author: "reviewer", noExtensions: true }));
const selection: DiscussionCaptureInput = {
  repo: "example/project", issue: 42, item: "project-context",
  selections: [{ comment: 123456, start: 0, end: 19, quote: "Use the native SDK.", marked: true }],
};
const plan = await captureGithubDiscussion(pmRoot, selection, sdk);
// Review plan.item, plan.status, plan.rows and plan.approval before a separate apply.
```

Semantic planning invokes the SDK's `previewItemMutations` in disposable staging with the same native create options as apply. Configured native create requirements produce an individual `native_refused` row. As documented by that SDK, staging does not validate executable extension hooks, pending migrations or final commit state; those can still yield a retryable `write_failed` row. Planning creates no source tracker journal or items.

Approval binds tracker identity, parent history, schema, selected evidence and existing target revisions. Decision IDs bind canonical parent identity and the entire evidence revision; creation audit markers also bind the expected parent history revision. Retry reads current state and preserves existing or edited records. A normal native edit causes the existing Decision to be skipped with a reason, rather than overwritten or duplicated. A missing document with retained native history is a tombstone, not a fresh target: an old approval becomes stale and a new preview preserves that history without resurrecting the item. A source edit can be captured as a new Decision only after a fresh reviewed preview. Bad source records refuse individually and leave other independent selections reviewable. Completed creates survive later failures, and retry revalidates every remaining target; there is no frozen-plan replay, saved checkpoint, destructive compensation or second observation append.

Immediately before each create the adapter re-reads source, parent history, schema and deterministic target. History length plus exact stream digest detects parent ABA. Peer-created captures are reported as unchanged only when current SDK state and the immutable creation marker agree; foreign or edited targets are skipped. The final read-to-create window remains optimistic: ordinary SDK/CLI writers can change source or parent after the final read. `commitWorkspaceTransaction` does not exclude those writers, so this adapter makes no cross-writer isolation claim. The native SDK's exclusive deterministic create prevents duplicate IDs; it cannot atomically guard a remote comment and a separate parent. All rows are independent, and no dependent evidence is appended after a skipped create.

Typed fatal refusals carry `code` and a bounded `context.required` remedy: `invalid_selection` (fix the strict selection), `host_required` (use a supported injected host), `source_unavailable` (restore issue/comment read access), `source_changed` (reselect exact bytes), `target_unavailable` (restore native history), `stale_plan` (review a fresh preview), and `invalid_output` (fix the budget or split the request). Per-row `write_failed` remedies preserve prior successes and request a tracker health check. Foreign records are retained with `foreign_or_edited` rather than throwing.

## Without git

Discussion preview and capture work in plain directory trackers and invoke no git executable. A GitHub repository identity is a remote source locator; it does not require a local git repository. Existing GitHub operations that inspect a proposed git diff still require git, or their documented explicit diff input.

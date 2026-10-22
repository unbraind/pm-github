# Provider identity collision explorer

`pm github identity` is an offline, read-only graph of exact external references,
GitHub provenance tags and declared GitHub ownership. It needs an initialized
tracker, with no git checkout or provider credentials. The SDK exports the same
operations from `pm-github`: `exploreGithubIdentities`,
`planGithubIdentityRepair` and `applyGithubIdentityRepair`, with typed report,
plan and refusal-code contracts.

```sh
pm github identity --json
pm github identity --limit 10 --offset 0
pm github identity --identity 'gh:example/project#7' --json
```

The default page contains collisions and copied prose mentions. `scanned`,
`identities`, `collisions` and `mentions` count the complete all-status corpus;
`total` and `next` describe the selected identity groups. Pass an exact
`--identity` to inspect an otherwise unremarkable link. All edges of each
selected group are returned together; a large group can exceed the usual page
size. The host's normal output budgets and omission receipts still apply. Use
JSON for tooling and the default compact TOON for agents. Titles, body text,
credentials and provider payloads are absent from the report.

Contradictory GitHub claims on one item also count as collisions. The node
includes the tracker's explicit `source_owner` as `native_owner` when present.

A claim comes from `external_ref`, an exact `gh:owner/repo#N` tag, `github_url`,
or a leading `GitHub issue URL` declaration. GitHub URL case and issue/pull URL
forms normalize to one identity. Other external references remain opaque and
case-sensitive: this command does not reinterpret Jira or Linear identifiers.
URLs elsewhere in prose are `mention` edges and never establish ownership.
A copied example containing a Linear label and an issue URL remains a local
item with a mention. Structured Linear/Jira/ADO id/key/URL fields record real
provider evidence. A provider item with `github_link_only: true` retains
provider ownership; a provider item also claiming native GitHub ownership
without that marker is `mixed` and requires review. These conservative labels
are diagnostic evidence, not a provider migration or a duplicate-close policy.

## Review and apply one repair

Suppose `example-owner` declares `github_url` for issue 7, while
`example-copy` accidentally carries only its GitHub tag:

```sh
pm github identity --identity 'gh:example/project#7' \
  --owner example-owner --detach example-copy --json
# Review changes and copy the full 64-character approval digest from the result.
pm github identity --identity 'gh:example/project#7' \
  --owner example-owner --detach example-copy --approve DIGEST --json
```

Preview validates the mutation through the SDK in a disposable tracker. Apply
removes only the matching GitHub tag on the
one selected duplicate. It preserves other tags, provider identities, content,
status, timestamps and release, except the SDK's normal mutation clock. It
never edits GitHub or closes/deletes an item. A unique owner must independently
declare the matching URL; tags alone cannot establish the rightful owner.
A duplicate with GitHub source metadata or explicit native source ownership, multiple independent owners, another
conflicting claimant or mixed owner evidence refuses apply. Resolve provider
ownership manually before asking for another plan.

Approval binds the exact request, graph and item revisions. Any intervening
edit requires a fresh preview. Apply checks again under the SDK workspace
writer lock. The SDK creates durable transaction receipts and append-only item
history attributed to the supplied author (`PM_AUTHOR` for CLI use). Repeating
a completed approval uses its immutable audit marker and changes no bytes.
Ordinary SDK transaction recovery/compensation semantics remain authoritative.
Keep tracker histories and transaction journals together during recovery.

The pinned SDK does not expose an audited core `external_ref` clear operation.
Those collisions are diagnosed, but repair refuses with `unsupported_repair`;
use the owning provider workflow to correct the reference. The explorer does
not bypass core metadata mutation rules.

Refusals expose the expected SDK error `code` and `context.required` remedy:

| Code | Remedy |
| --- | --- |
| `invalid_options` | Supply valid pagination, complete repair selectors, digest and audit author. |
| `incomplete_read` | Restore a complete readable tracker; omitted items cannot prove ownership. |
| `ambiguous_identity` | Inspect the graph/provider records and resolve competing ownership manually. |
| `unsupported_repair` | Correct core external references through their owning provider workflow. |
| `stale_approval` | Preview again and explicitly review the new digest. |

Core metadata validation, duplicate discovery, lifecycle rules, preview
validation, locks and audited mutations remain SDK-owned. Provider adapters
retain their own identity semantics. This surface diagnoses local evidence;
it does not certify that a remote issue still exists or transfer ownership.

## Typed SDK example

```ts
import {
  exploreGithubIdentities, planGithubIdentityRepair, applyGithubIdentityRepair,
  type IdentityRepairPlan,
} from "pm-github";

const pmRoot = ".agents/pm";
const graph = await exploreGithubIdentities(pmRoot, { limit: 10 });
const preview: IdentityRepairPlan = await planGithubIdentityRepair(
  pmRoot, "gh:example/project#7", "example-owner", "example-copy",
);
// Present preview.changes and preview.approval for explicit review first.
// Invoke apply only when that exact digest has been approved.
const receipt = await applyGithubIdentityRepair(pmRoot, {
  ...preview, author: "repair-reviewer",
});
```

The SDK also accepts an optional `onTransition` observer on apply for transaction
diagnostics. It does not grant permission or replace approval. The mutation
uses the SDK's `updated_at` match guard in addition to the graph recheck. Input
storage must contain ordinary files and directories; symbolic tracker roots
and entries refuse rather than being followed during scratch-copy isolation.

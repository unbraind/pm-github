# Refresh idempotency evidence

The orchestrator review of PR #154 inspected fresh disposable copies of the public companion tracker. Original trackers were never refreshed. The source repository was `unbraind/pm-cli`; all 42 linked issues were selected, with zero creates or missing issues. Five changed terminal disposition (four closed to canceled, one canceled to closed). The other 37 were genuine refreshes, with these overlapping field counts:

| Field | Items changed |
| --- | ---: |
| `github_url`, `github_number`, `github_state`, `github_state_reason` | 37 each |
| `github_created_at`, `github_updated_at`, `github_closed_at` | 37 each |
| `github_close_reason`, `github_release`, `github_link_only` | 37 each |
| `created_at` | 37 |
| `close_reason`, `closed_at`, `completed_at` | 34 each |
| `tags` | 14 initially: 7 bot spelling differences suppressed, 7 real changes |
| `title` | 7 |

Every one of those 37 lacked the source metadata. The local creation times also differed from GitHub's actual issue creation times. The empty release value means that no release tag was available in the scratch project. The metadata and lifecycle changes must be retained. Seven initial tag deltas were representation churn: GraphQL returned a Bot login without the REST `[bot]` suffix. Requesting `author.__typename` and projecting bot logins to the REST spelling suppresses those seven tag writes. The other seven tag deltas change actual membership; the seven title deltas change actual text.

A field-level sample from the copy, issue #450 (unchanged terminal status):

| Field | Before | After |
| --- | --- | --- |
| `github_url` | absent | `https://github.com/unbraind/pm-cli/issues/450` |
| `github_number` | absent | `450` |
| `github_state` | absent | `closed` |
| `github_state_reason` | absent | `not_planned` |
| `github_created_at` | absent | `2026-07-05T16:07:39Z` |
| `github_updated_at` | absent | `2026-08-22T18:43:12Z` |
| `github_closed_at` | absent | `2026-08-22T18:43:12Z` |
| `github_close_reason` | absent | `Closed on GitHub as not_planned on 2026-08-22T18:43:12Z` |
| `github_release` | absent | empty string |
| `github_link_only` | absent | `false` |
| `created_at` | `2026-08-22T17:04:29.745Z` | `2026-07-05T16:07:39Z` |
| `close_reason` | absent | `Closed on GitHub as not_planned on 2026-08-22T18:43:12Z` |
| `closed_at`, `completed_at` | absent | `2026-08-22T18:43:12Z` |

## Interrupted transaction recovery

An update transaction derives its mutation steps from the current item state, so a hard crash after the steps applied and source fields were finalized leaves the linked items already matching the source. A naive retry would then classify every target as unchanged and never touch the durable journal, which would stay in `applying` forever while the command reports `updated: 0` and exits 0. Re-deriving the plan after a partial apply also fingerprints a different transaction id, because both the changed-field set and the selected history context differ.

Update transactions therefore persist their exact pre-commit plan — the derived transaction id, the prepared entries and the ordered mutations — beside the SDK journal in `transactions/pm-github/`, before the SDK writes anything. The next refresh scans `transactions/sdk/` for unfinished `github-import-*` journals whose step targets intersect the selected items and replays each journal from that persisted plan, which commits it without re-applying completed steps (no duplicated audit comment). Only then is the unchanged filter applied against the re-read committed state. A dry run refuses while such a journal is open, and a missing or unusable plan fails closed naming the transaction id; both leave the tracker untouched. The SDK journal itself never stores the mutation list, so the persisted plan is the only replay source.

The command-level regressions spawn a real child process that dies at either `step_applied` or `committing`, removes the crashed writer lock to simulate TTL expiry, then re-runs the refresh: the replayed journal commits, the plan record is removed, the audit comment appears once, and the following refresh is an ordinary byte-stable no-op. Journal inspection is read-only, including orphan plans; unreadable journals and missing or mismatched plans fail closed.

## Comparison and writes

Refresh compares timestamp instants, rather than timestamp spelling, and compares tags as sets. Its existing title preparation trims surrounding whitespace. Absent source metadata remains a real backfill. A later `github_updated_at` instant remains a real update.

Unchanged entries never enter the transaction. On a changed entry, the update mutation omits unchanged title, tags and status options. Metadata-only changes retain their audit comment and source finalization; the finalizer also skips fields with equal normalized values, preserving equivalent timestamp spellings even when another field changes. Link-only owners retain their provider context.

Real initialized tracker regressions apply, immediately reapply, and compare every file byte and the history line count, without an intervening list/cache-priming call. They also replay equivalent UTC/offset/millisecond timestamps, reversed labels and surrounding title whitespace, then confirm that a genuinely later source update is still written. Both plain and atomic modes are covered. Reverting only timestamp normalization makes both regressions fail with `updated: 1` instead of `0`; restoring it passes both.

## SDK cache finding

With the pinned SDK, this exact read writes derived runtime files on a cold/stale tracker:

```ts
await listAllComplete(
  { includeBody: true },
  { pmRoot, cwd: pmRoot, noExtensions: true },
);
```

The observed files were `runtime/metadata-cache.json`, `runtime/metadata-cache-bodies.json`, `runtime/metadata-cache-collections.json`, their context-fingerprint JSON variants, `runtime/metadata-cache-manifest.json`, and `runtime/metadata-query-index.sqlite`, all under `.agents/pm`. The SDK's metadata store persists those caches during complete-list reads. This behavior was reproduced by calling the SDK directly, without the refresh command.

The original implementation already isolated preview reads, and its live 42-item dry run changed zero files. Its second apply reported zero item updates but still changed eight cache files. Planning reads now always use disposable copies, so no-op applies also avoid SDK writes in the selected tracker. No upstream issue was filed. Built CLI dry runs on cold companion-tracker copies changed zero files for both zero matching fixture links and the nonempty production selection (42 selected, 42 planned updates, zero creates/missing). Runtime files were included in both comparisons.

## Fresh-copy apply proof

The final-source live proof selected all 42 linked issues. First atomic apply reported 42 updates, zero creates and zero missing issues. Its plan contained only seven real tag-membership changes; all seven initial bot spelling deltas were gone. The immediate second atomic apply reported zero updates, 42 unchanged, zero creates and zero missing issues. All 2,561 files under the copy's `.agents/pm` compared byte-for-byte equal with `Buffer.equals`; there were no added or removed files. Total history line count remained exactly 6,265. No listing or cache-priming call intervened between the first apply and the before snapshot.

The linked real-tracker suite passed 13/13 tests with zero failures, skips or cancellations. The normalization revert proof produced two intended assertion failures; the independent bot-projection revert produced one intended assertion failure. Original trackers were never written.

A separate fresh-copy proof dispatched both applies through the built pinned CLI, using `pm --path "$PM_PATH" github refresh unbraind/pm-cli --atomic --json` with `PM_PATH` pointing only to the scratch tracker. First apply: 42 selected, 42 updated, zero creates/missing. Immediate second apply: 42 selected, zero updated, 42 unchanged, zero creates/missing. All 2,587 regular files compared byte-for-byte equal, including the installed extension and runtime files; history remained 6,265 lines. This verifies host dispatch as well as the production command function.

## Completed release gates

Both `npm run release:check` and `bun run release:check` exited 0 on the implementation source in commit `facc65b983d1a087a7e957f48864f65e18494b31`, with isolated HOME and Git identity configuration. Each passed 936/936 tests, zero failures, skips, cancellations or TODOs. Both coverage receipts measure all 16 authored modules at exact 100/100/100/100: 10,742/10,742 lines and statements, 286/286 functions and 3,371/3,371 branches, with zero skipped coverage. Thresholds, source inventory, dependency pins and duplication budgets are unchanged. Production audits, privacy, packing, changelog and publish-attestation checks also passed.

The Bun validation directory matched all 112 source, test and configuration files byte-for-byte (combined SHA-256 `e779570b70b85cc26817d501ce7544595e259296c03b72ec989bccfb2ce0668a`). Later receipt changes are limited to this document and the append-only PM evidence. A fresh non-local clone with clean dependency installation passed strict PM health and validation for the implementation commit.


## Review round 1 verification

All four review findings are corrected: refresh preserves a native release when GitHub has no release evidence, issue selection excludes pull-request URLs, disappearing label-page connections raise `CommandError`, and unfinished refresh journals replay their saved complete plan before unchanged entries are filtered. Journal discovery is read-only; unreadable journals/directories, journals without recognizable targets, and missing or mismatched plans fail closed.

The command-level recovery cases crash at both `step_applied` and `committing` with a status-changing issue. Both resume the original journal to `committed`, preserve one audit comment, and leave the following no-op refresh byte-stable. Five isolated revert controls produced seven intended assertion failures: release assignment (one), pull-link selection (one), label connection access (one), original `runRefresh` (both crash boundaries), and omitted original-plan replay (both boundaries, leaving the original journal `applying`). Each control rebuilt the package; production source was never reverted.

Both final isolated-identity commands, `npm run release:check` and `bun run release:check`, exited 0 with 943/943 tests and zero failures, skips, cancellations or TODOs. Each measured all 16 authored modules at exact 100/100/100/100: 10,953/10,953 lines and statements, 296/296 functions, and 3,446/3,446 branches, with zero skipped coverage. Dependency pins, source inventory, thresholds and duplication budgets are unchanged. Audit, privacy, duplication, packing, changelog and publish-attestation checks passed; both pack receipts have shasum `c567e636c4f08c0023933110de75984843e9e206`.

The PM-linked command `node --test test/refresh.test.ts test/import-fidelity.test.ts` passed 72/72 through `pm test pm-github-ullj --run --progress --only-index 2 --timeout 1200`. Its earlier 600-second run timed out without an assertion failure while both coverage gates were active. The independent final recovery selection passed 6/6. PM result tracking is disabled for this project, so explicit receipts are recorded in the item's comments. A clean validation clone matching the implementation passed strict PM health; the package worktree's ignored extension environment separately reported host version skew.

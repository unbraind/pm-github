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

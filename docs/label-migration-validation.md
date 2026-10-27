# Label migration validation

Validation date: 2026-10-27. Final-head release status, receipts and run links are
recorded in [PR 188](https://github.com/unbraind/pm-github/pull/188).

Round 2 source validation is recorded on commit `1054723`.
[CI 40513381730](https://github.com/unbraind/pm-github/actions/runs/40513381730)
had all four npm/Bun Node 22/26 jobs queued at this receipt, and
[CodeQL 40513381833](https://github.com/unbraind/pm-github/actions/runs/40513381833)
was queued. No current-source full release gate had completed. The documentation
receipt adds no product or test change; the PR carries the final-head run.
Local privacy audited 7,369 Git objects with approved identities and no secret
or host-path matches. Changelog generation/check pass. Full-gate acceptance
remains pending under the queue rule's bounded wait.

The round 1 review-fix source run
[40491011369](https://github.com/unbraind/pm-github/actions/runs/40491011369)
had all four npm/Bun jobs queued without assigned runners at handoff. The queue rules cap
waiting after push at 30 minutes. Pending checks are not passing evidence;
the PR records the final-head run and exact pending jobs for the orchestrator.

Review round 1 corrected the provider-name comparison class across policy
filters, mapping destinations, rename collisions, export label maps (including
unmapped exports), form-label contracts, composed previews and POST/PATCH
payloads. Provider names use case-insensitive keys while preserving first-seen
spelling. IDs, local mapping keys and revision bindings remain exact. The
adversarial coverage includes every ASCII spelling of `bug`, paginated hidden
review choices, distinct node IDs with colliding name keys, JSON/TOON command
results, form/export composition, 500 generated export case permutations and
the existing 500 SDK state sequences with replayed mixed-case policies. The
packed five-consumer acceptance uses `BUG` filters and `BuG` mapping destinations.
Full gate test processes are explicitly capped at two workers; native Bun files
remain serial. No thresholds or source exclusions changed.

Review round 2 closes the preview/import normalization class. The import-owned
`githubLabelsToTags` function uses the SDK's CSV parser, shared by prepared
imports, native writes, tag/provenance validation, refresh comparisons and label
plans. The earlier array-parser call preserved embedded commas and could miss
both tags produced by importing `one,two`. Tag rows now expose the raw
destination plus its complete `after_tags` expansion, including zero-tag
destinations and Unicode case expansion. Provider policy-name matching remains
separate from native tag conversion; catalog IDs and expected names stay exact.

The added 500-sequence label-set property test runs the importer's prepared
mutations on a disposable non-git SDK witness and reads actual native state
back through the SDK. It compares source impacts and complete destination
expansions with that state, then proves that the projected tag changes equal
the import write result. Samples include commas, spaces, case variants,
duplicates after normalization, Unicode, prefixes and prototype-like names.
It also verifies JSON/TOON producer validation, replayed raw plans, refresh
no-op comparisons, unresolved approval choices and stale revision refusal.
The packed five-consumer acceptance adds an explicitly synthetic offline CSV
catalog against unchanged public tracker data; no provider label is created.
The new model file passes 2/2 tests, including all 500 random label sets.
Independently reverting each of nine conversion/comparison/emission sites fails
its focused regression. Reverting only the planner source conversion also
makes the 500-sequence property fail on its first mismatching source impact.
All production files were restored byte-for-byte after those proofs.
Packed validation also exposed host TOON null compaction and lossless table
cells. The shared boundary uses declared null defaults and the SDK's own table
decoder, with field names derived from the producer schema. An additional 500
wire permutations cover all row kinds, sparse cells, JSON-looking strings and
extreme metadata; five independent transport reversions fail their regressions.
Missing continuation on an unfinished page and missing native identities still
refuse. Installation setup has a bounded 600-second deadline on the saturated
host; feature commands retain their 180-second deadline and every acceptance
assertion remains enabled. Optional install audit/funding requests are disabled;
the release gate's production audit is unchanged.

The overlap check covered core SDK bulk tag mutations, the existing GitHub
identity explorer, and pm-linear/pm-jira policy/schema mappings. This feature
explains provider label policy changes; it creates no new resolver or
import/export/sync writer. It has no journal, claims, leases, outbox, recovery
mutation or other shared state to interleave. Approval checks always re-read
SDK revisions and catalogs. No saved input is permission to mutate a target.

The non-git synthetic fixture has 1,000 affected native items, one declared
filter and one declared export mapping. Counts are complete: 1,000 items and
1,002 source-label occurrences. The first page retains seven rows; the page at
offset 996 retains the remaining six. Files are read-only and every source byte
is unchanged after both reads. Similar provider names that share a normalized
native tag retain separate explicit source IDs. Deleted/recreated labels,
expected-name drift, catalog drift and same-content SDK revision changes refuse
old approvals. Foreign or malformed issue references cannot invalidate the
affected item or become a claimed issue identity.

The large fixture uses an exact seed ID and a disjoint bulk-ID namespace. An SDK
complete read certifies 1,000 source items before permissions change or planning
starts. The earlier `e9af282` run passed all four release gates and the Node 26
native Bun suite, but Node 22 native Bun exposed overlapping synthetic IDs that
could overwrite the randomly named seed and leave only 999 source items. A
deterministic collision reproduces that failure under Node and Bun; restoring
the disjoint namespace passes under Node and Bun 1.3.5/1.3.14. The planner's
production code is unchanged by this fixture correction. Final-head full CI
receipts are recorded in the PR.

The seeded model runs 500 random operation sequences with SDK-native tag
conversion, native edits, custom statuses, ambient focus, relationships,
whitespace/CRLF, older policy replays and JSON/TOON round trips. It compares
counts to a simple tag/policy reference model and reads complete native item
state back through the SDK before and after planning, including relationships
and every field observed by this feature. No SDK mocks or handwritten native
normalization are used. The feature adds no new provider import/export/sync
path. The review fix also makes existing export/form label outputs follow the
same case-insensitive provider-name semantics. The property scope covers
planning, validation, SDK state preservation and generated export/form case
permutations.

Independently reverting native tag conversion, revision/digest comparison, the
row cap, or malformed-provenance filtering makes its regression fail. Restoring
each function restores the passing behavior. The planner's targeted source
coverage is 100 percent in all four dimensions; the unchanged all-source CI
release gates remain the full-package evidence.

## Public tracker measurements

`node test/label-migration-real-data.ts` verifies the repository is public,
archives only its tracked tracker into a plain scratch directory, makes source
files read-only, and never modifies the source repository or provider labels.

| Measurement | Result |
| --- | --- |
| Public tracker | `unbraind/pm-github` |
| Snapshot revision | `f90f86faa9c976392f1d1262fd0b3204de2007e4` |
| Scanned items, including terminal/custom statuses | 155 |
| Current provider label identities | 12 |
| Affected stored items / tag occurrences | 1 / 1 |
| Declared example filter / export mapping | 1 / 1 |
| Total affected rows / JSON bytes | 3 / 1,146 |
| SDK preview and current approval check | Pass; identical source bytes |

The two policy entries are explicit synthetic inventories. They do not claim
discovery of configuration in external workflows. The source label is the
provider's current `bug` node ID; the proposed rename is never applied.

The packed candidate is installed in isolated npm project-local, npm-global
and Bun-global prefixes. The actual installed artifact is loaded in place
through a physical extension entry, preserving each installer's dependency
layout and real executable symlinks. Each of the five consumers (project-local,
npx, bunx/native Bun, npm-global and Bun-global) passes JSON, TOON and approval
revalidation against an independent non-git read-only public tracker copy.
Every copy retains byte-identical native source files. Acceptance uses host CLI
2026.10.26 and an isolated Bun 1.3.14 matching CI; the repo's SDK pin is unchanged.

Offline validation depends on a fresh, complete caller-provided catalog. A
successful approval check is point-in-time evidence, not a lock held across a
later external mutation. Review automation that is unavailable, quota limited
or skipped supplies no approval evidence.

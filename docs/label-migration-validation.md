# Label migration validation

Validation date: 2026-10-27. Final-head release status, receipts and run links are
recorded in [PR 188](https://github.com/unbraind/pm-github/pull/188).

Round 4 closes declared SDK compatibility across the whole extension. The
published table decoder first appears in 2026.10.9, but the existing transaction
revision `match` contract first appears in 2026.10.17. The enforced manifest floor
and peer/development ranges therefore share **2026.10.17**; the exact development
lock stays on main's integrity-checked 2026.10.23 resolution. The generated
unreleased changelog entry discloses that breaking minimum.

The permanent packed minimum consumer passes **1/1 under Node** and **1/1 under
native Bun 1.3.14**, independently installing the exact minimum from npm. It
links the whole extension, type-checks all 80 named SDK imports across 11
production/operational modules and all shipped declarations, and exercises a
real plain tracker with no git executable. The runtime checks include preview,
approval, SDK-encoded tables, host-compacted empty reports and literal native
comma tags. Vendor declaration skipping cannot hide a missing type in the
package's own emitted declarations. The test is in both unchanged release gate
inventories. Reverting only the floor and matching ranges to 2026.10.5 fails
at whole-extension linking on the missing decoder export; 2026.10.15 fails the
source audit on missing transaction `match`. Restoring 2026.10.17 passes the
same test. These negative proofs run only in disposable copies.
See [the published minimum evidence](sdk-minimum.md).

The round-4 artifact passes all five CLI install modes and standalone Node/Bun
SDK checks on CLI 2026.10.26 and Bun 1.3.14. It is **290,159 bytes**, SHA-256
`e79bc740ffa2daa5e58c3df509161843b21b96d55e65737bcd5731aafffe08c5`.
The fresh public measurement is unchanged: 155 scanned items, 12 provider
labels, one stored tag plus two declared example policies, three affected rows
and 1,146 JSON bytes. All source tracker bytes remain unchanged.

The preceding receipt's full CI later completed: each of the four jobs passed 1,536
tests but failed the unchanged 100% branch threshold at 99.97%, identifying
one duplicated plain-import tag formatter branch. Both plain update paths now
share `importTagArguments`, which consumes `importTagOptions` and handles
replacement, additive and empty inputs at one boundary. Four existing real-SDK
regressions pass with **100/100/100/100** coverage for the import-owned helper.
No regression, source inventory or threshold is removed. Static checks pass
again: 23 files / 237 declarations and 24 authored modules / 12,620 lines,
with zero duplicated lines. The final-head CI remains the complete gate proof.

Round 3 current-pin verification follows main's Dependabot update to SDK
2026.10.23 (`d717d7b`, merged via `ccaf148`). The linked model file passes
3/3 tests: 500 provider-label sets and 500 native-array sequences, with actual
SDK mutation and read-back references. Focused planner/helper/wire tests pass
13/13 with 100/100/100/100 targeted coverage for `labels.ts` and `import-tags.ts`.
Plain/atomic owner regressions pass 2/2; the linked Projects interleaving test
passes 1/1 with 500 retained native atoms and all six response boundaries.
Typecheck, test compilation, lint, docstrings and duplication pass (23 files,
236 declarations; 24 authored modules, 12,613 lines, zero duplicated lines).
All five packed CLI modes and standalone Node/Bun SDK checks pass on host CLI
2026.10.26 and isolated Bun 1.3.14. The single captured artifact is 289,696 bytes,
SHA-256 `a10eaf5857d2e84fdcfcd871c417dcf392d7ae73a59898b817cc8044686be171`.
Twelve independent round-3 site reversions fail their regressions, including
empty-row compaction; disposable copies restore the fixed implementation.
The final-head CI links and pending gate counts are maintained in PR 188;
previous-round run receipts below are historical evidence.

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
imports, provider-derived writes, tag/provenance validation and label plans.
The earlier array-parser call on provider names preserved embedded commas and
could miss both tags produced by importing `one,two`. Round 3 corrects the
round-2 overreach of also CSV-parsing stored native tags; that representation
must remain an SDK-normalized array of individual tag atoms. Tag rows now expose the raw
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
extreme metadata; six independent transport reversions fail their regressions.
The final guard reuses the package's own-entry reader: an inherited null cannot
stand in for a missing padding cell. Reverting only that read accepts the
prototype-padding adversary and fails the property. Standalone Node/Bun SDK
checks, including this adversary, are part of the packed acceptance helper.
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
| Snapshot revision | `d717d7b85e6009c5a4bb803952140e61856dd041` |
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
2026.10.26 and an isolated Bun 1.3.14 matching CI; the dev SDK pin is main's
2026.10.23, adopted through the merge without an independent version bump.

Offline validation depends on a fresh, complete caller-provided catalog. A
successful approval check is point-in-time evidence, not a lock held across a
later external mutation. Review automation that is unavailable, quota limited
or skipped supplies no approval evidence.

Review round 3 separates the operands by their actual field domains. Provider
label names use the shared CSV converter; persisted native tags use the SDK's
array normalizer without comma splitting. Planner rows now name only tag atoms
present in SDK read-back. Refresh compares that native state with the writer's
converted desired state, so `["one,two"]` differs from `["one","two"]`.
Preparation keeps retained owner tags outside label conversion. Atomic and plain
link-only/citation writes add only new provider-derived tags and leave existing
native atoms in place; SDK additive inputs themselves accept CSV, so retained
comma atoms must never be resubmitted as additions either.

The native-tag model adds 500 seeded sequences with literal commas, spaces,
case variants, collisions and partial overlaps. Each seeds native metadata
through the SDK, reads it back, previews migration and refresh, executes the
real full-import mutation independently of the refresh decision, and reads the
result through the SDK. Predicted identities/counts equal the intersection of
the two SDK states; refresh selection/output equals the actual write delta.
The earlier legacy-array fixture is corrected to expect only existing native
identities; no legacy record is refused or rewritten by a read-only preview.

The same native-field audit covers Projects import and push binding. Their
writers add only missing provenance through `nativeTagAdditions`; retained
native arrays never become CSV. A real non-git fixture with no git executable
seeds 500 random comma-containing native atoms. Peer mutations at all six
provider-response boundaries (two import, four push) remain present in final
SDK read-back, and the successful push is reported as successful.

Packed zero-impact reports also exercise host omission of empty `rows`.
The producer-derived schema restores that empty array, while complete-count
and continuation checks still reject missing rows on an unfinished page.
All 500 SDK wire permutations now include compact terminal pages and must-refuse
truncated pages in JSON and TOON. The SDK itself handles undefined legacy tag
fields; no second empty-tag default or CSV conversion is applied to native data.

The final SDK wire fixture physically removes omitted fields before TOON
encoding, matching the host producer. An explicitly undefined property encodes
as null in TOON; explicit null `rows` remains in the must-refuse corpus rather
than being accepted as an empty list. The final 500-wire run passes with both
compact terminal pages and truncated-page refusals.

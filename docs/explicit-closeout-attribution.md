# Closeout delivery attribution

[pm-ado issue 33](https://github.com/unbraind/pm-ado/issues/33) compares the earlier gap-reporting PR 16 with delivery PR 19. PR 16 lists the statement-enforcement item in a `PM:` follow-up list and says enforcement remains open. PR 19 declares its primary work with a standalone `PM item:` line. The retained minimal public fixtures preserve these relevant body shapes.

| PR body or evidence | Matcher result |
| --- | --- |
| Closing keyword before a canonical tracker link | Declares delivery |
| Whole-line closing keyword plus exact item ID | Declares delivery |
| Whole-line `PM item:` plus canonical link or exact ID | Declares delivery |
| Whole-line `pm-github:` plus exact ID | Declares delivery |
| Undeclared canonical body link, including a gap report, follow-up list, or `tracked in` reference, for an otherwise eligible item | `not_delivery`: Mentioned, not delivered |
| Tracker PR URL metadata with no body reference or declaration | No row |
| Closing declaration for a longer ID with the same prefix | Does not deliver the shorter ID |
| Several eligible declarations | Latest merge time wins; equal times use the higher PR number |
| No eligible declaration | No closeout |

Declaration keywords are close, fix, resolve and deliver, including their existing tense forms. Whitespace between declaration and ID is horizontal; a newline cannot join them. Canonical links retain repository, encoding, traversal and exact-ID checks. `PM:` contextual lists do not act as `PM item:` declarations.

The complete selected PR set is evaluated before SDK writes. Only merged PRs with complete merge facts, passing check policy and eligible tracker items enter delivery selection. Failed checks never win. Earlier qualifying rows become `duplicate_selection`; mention-only rows retain `not_delivery`. A single selected closure supplies completed_at, resolution, actual_result, close_reason and the appended close event. The existing epic, child, terminal, explicit-skip, privacy and strict-validation safeguards remain.

## Regression evidence

`node --test test/closeout-attribution.test.ts` uses real SDK trackers initialized by the pinned CLI in temporary directories. The primary scenarios set `GIT_CEILING_DIRECTORIES` to the directory above the tracker and execute closeout with a PATH containing no git executable. They verify:

1. Real-shaped gap PR 16 plus structured delivery PR 19 selects PR 19. Distinct head SHAs, merge SHAs and check names prove that durable fields and the appended close event agree on the selected PR.
2. Mention-only PRs leave the item in progress and append no close event, even when tracker PR URL metadata points at one.
3. A closing keyword for a different ID sharing the item's prefix leaves the mentioned item open.
4. Multiple declarations select the latest passing merge, including a lower-numbered PR merged later and a later PR with failing checks. Equal-time selection is deterministic.
5. Same-line IDs, punctuation, tabs, multiline negatives, case rules, many-item planning and mention-only reporting remain covered. A standalone structured markdown link declares delivery; appended follow-up prose does not. A separate whole-line closing declaration can upgrade an earlier bare link.

Function-only behavioral reversion restores `runCloseout` from `dc86e83`, the actual defective predecessor of the prior attribution fix, while retaining current helpers and tests. Each of the first three regressions fails an assertion with exit 1: the gap PR wins, mention-only closes, and the shared-prefix mention closes. Restoring the current implementation passes. No test-load failure is counted.

A separate function-only reversion to origin/main's attribution implementation makes the latest-merge regression fail: competing delivery claims close zero items. A narrow prefix-broadening mutation in the current function also makes the shared-prefix regression fail directly. Reverting only the structured-link helper to its first implementation also fails the follow-up-prose negative. These controls distinguish the historical mention bug, the remaining selection bug and the exact-ID boundary.

## Validation

Before the review additions, the complete focused closeout suite passed 99/99, zero failures, cancellations or skips. A focused c8 run measured exact 100/100/100/100 for closeout.ts without exclusions. The pm-linked attribution suite passed 9/9 and its compact control passed 1/1; existing project policy disables result storage, so comments preserve these results.

Both `npm run release:check` and `bun run release:check` completed with exit 0 at code/test head `d8683ff37db274b8fcf569baf97f1c230514a12d`, sequentially with isolated git identity. Each passed 960/960 tests with zero failures, cancellations or skips and exact 100/100/100/100 across all 16 authored modules. Both measured lines/statements 11037/11037, functions 299/299 and branches 3511/3511. All other release-check stages passed, including privacy, zero duplication, production audit, pack dry run, canonical changelog and publish-attestation verification. Source inventory, exclusions, dependency pins, thresholds and helper/test budgets remain unchanged. These receipts precede the review regressions below.

## Review reporting contract

Thread `PRRT_kwDOTbN4pM6ub0vv` identified the metadata-only reporting error in this table and README. Candidate rows come from canonical body references or standalone declarations. Tracker PR URL metadata alone never creates a candidate; undeclared body references reach `not_delivery` only after the other eligibility checks pass. The documentation now states both conditions.

The additional non-git SDK regression verifies metadata-only input produces an empty plan, leaves the item in progress and appends no close event. Two documentation contract checks cover both corrected locations. Restoring either document alone from `9c08fc2` makes its check fail with `ERR_ASSERTION` (exit 1). Restoring only `runCloseout` from main at review start (`4e18c93`) makes the new SDK regression fail with `ERR_ASSERTION` (one closure instead of zero, exit 1). All reversions were restored. The full PR diff was reviewed for the same reporting-contract error; no additional runtime correction was needed.

`pm test pm-github-uqjf --run --progress --timeout 600` passed attribution 12/12 and the compact control 1/1 with zero failures, cancellations or skips. The unchanged attribution suite passed in 276 seconds after the default 120-second linked timeout expired under host load. Both restored documentation contract checks also passed separately, 2/2.

Both full release gates passed at review code/test head `2fa4571247b5f86b984c588f32b494538a2f89ee`, sequentially with isolated git identity: `npm run release:check` and `bun run release:check` each exited 0 with 963/963 tests, zero failures, cancellations or skips. Each measured exact 100/100/100/100 across all 16 authored modules: lines/statements 11037/11037, functions 299/299 and branches 3510/3510. All remaining release stages passed with unchanged pins, inventory, exclusions and thresholds. Subsequent changes contain only documentation and append-only pm receipts; runtime source and tests remain identical to this gate head.

The item remains in progress for orchestrator verification; its claim is released at handoff. No pm-ado record or history is edited. No merge or package release is performed.

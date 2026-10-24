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
| Several linked merged PRs | One explicit `delivery-pr:<canonical PR URL>` item tag wins; otherwise require exactly one claim strictly after the last acceptance-criteria edit; unresolved cases become `needs_review` with all candidates |
| No eligible declaration | No closeout |

Declaration keywords are close, fix, resolve and deliver, including their existing tense forms. Whitespace between declaration and ID is horizontal; a newline cannot join them. Canonical links retain repository, encoding, traversal and exact-ID checks. `PM:` contextual lists do not act as `PM item:` declarations.

The complete selected PR set is evaluated before SDK writes. A `delivery-pr:` tag is an explicit item-owned delivery link and can supply attribution without a body declaration. Multiple tags or a tag outside the selected set cannot silently fall back. Generic `pr_url` metadata remains contextual. Without an explicit delivery link, immutable SDK history determines the last acceptance-criteria change (or item creation when no later edit exists). Exactly one linked merged PR must claim the exact item in its description or commit messages and merge strictly after that cutoff. Unrelated later edits do not move it. Unavailable history holds delivery.

Passing checks do not resolve attribution. Competing claims, equal merge times and multiple post-criteria claims require review even if one has failing checks. A uniquely attributed PR must still satisfy the existing merge and check policy. The selected PR supplies completed_at, resolution, actual_result, close_reason and the close event consistently. All candidates appear in `needs_review` plan rows and the compact closeout PR body; the item stays open. For an all-held workflow run, a privacy-gated tracker `closeout-review.json` artifact provides a reviewable diff without changing any item or item history.

`test/closeout-selection.test.ts` uses real SDK trackers, deterministic SDK clocks for creation and criteria edits, synthetic PR/commit metadata, `GIT_CEILING_DIRECTORIES`, and a PATH containing no git. It covers one PR, an earlier claim before changed criteria plus later implementation, ambiguity, explicit overrides, missing history, and commit claims. The historical receipts below describe earlier matcher revisions; their latest-merge behavior is superseded by this policy.

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

## Acceptance-aware selection regression proof

Only `runCloseout` was replaced with its `f4c29e8` implementation while retaining current helpers and tests. `node --test --test-name-pattern='ambiguous linked merged PRs|explicit delivery link selects|a claim before or equal' test/closeout-selection.test.ts` failed all three assertions (exit 1): ambiguity closed, the explicit override was ignored, and a claim at/before changed criteria closed. Restoring the function passed 3/3 (exit 0). These tests import TypeScript source directly. The restored attribution/selection suites passed 25/25; focused c8 measured exact 100/100/100/100 for `closeout.ts` without exclusions. The review-only workflow regression also passed and proved no automatic landing request.

Unreadable commit messages on a linked mention can hide a competing post-criteria claim. Such uncertainty also holds attribution; an explicit delivery link can resolve it, and a PR merged before the criteria cutoff cannot become a qualifying claim. Removing only the unknown-claim selection guard makes `unreadable later commit claims never permit fallback to an earlier description claim` fail an assertion (exit 1, one closure instead of zero). Restoring it passes that regression and the pre-criteria control, 2/2.

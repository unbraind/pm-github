# Closeout delivery attribution

[pm-ado issue 33](https://github.com/unbraind/pm-ado/issues/33) compares the earlier gap-reporting PR 16 with delivery PR 19. PR 16 lists the statement-enforcement item in a `PM:` follow-up list and says enforcement remains open. PR 19 declares its primary work with a standalone `PM item:` line. The retained minimal public fixtures preserve these relevant body shapes.

| PR body or evidence | Matcher result |
| --- | --- |
| Closing keyword before a canonical tracker link | Declares delivery |
| Whole-line closing keyword plus exact item ID | Declares delivery |
| Whole-line `PM item:` plus canonical link or exact ID | Declares delivery |
| Whole-line `pm-github:` plus exact ID | Declares delivery |
| Bare link, gap report, follow-up list, or `tracked in` reference | Mentioned, not delivered |
| Tracker PR URL metadata without a body declaration | Mentioned, not delivered |
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

The complete focused closeout suite passes 99/99, zero failures, cancellations or skips. A focused c8 run measures exact 100/100/100/100 for closeout.ts without exclusions. The pm-linked attribution suite passes 9/9 and its compact control passes 1/1; existing project policy disables result storage, so comments preserve these results.

Full npm and Bun release checks run with isolated git identity and unchanged source scope, dependency pins and four 100 percent thresholds. Completed gate counts and linked-test results are recorded in the tracker and PR. The item remains in progress for orchestrator verification; its claim is released at handoff. No pm-ado record or history is edited.

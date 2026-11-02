# Repeat gated import evidence (#175)

## Version scope and root cause

The reported `pm-github@2026.10.28` failure is reproducible with the real
`@unbrained/pm-cli@2026.10.25` SDK. The synthetic mixed batch contains a
previously linked closed item, new closed issues (including one updated after
closing), and an open issue. Its identical repeat still plans updates and fails
the no-op assertion.
That release classifies a matched provenance target as `update` without comparing
its desired source projection, then passes the complete batch to the transaction.

Current main at `9586643` already includes #198's normalized unchanged-item
filter. Its byte-only repeat succeeds, including a packed pm-slack measurement.
The nine new current-main regressions additionally require truthful closure
history; they fail on fabricated import-time closure instants or journal replay.
The original repeated-write defect and these remaining defects are distinct.

Full atomic imports still forced terminal updates through the SDK close router.
That router performs a content update, then closes even an already-closed item,
replacing its native `closed_at` with the import time. Finalization restores the
source instant, leaving durable churn. The router's content event can omit the
message while retaining `context.item_transaction_step`; treating that event as
external changes transaction identity during recovery. Import-owned content
events were also selected merely because a preceding status remained different
from the desired status, even when the event did not change status.

## Repair

- Retain the existing normalized planner filter and all publication/privacy and
  ownership checks.
- Apply terminal native status, creation/completion dates and closure reason
  together with provider provenance through one SDK fenced item mutation.
  Skip unchanged values and let the SDK assign its truthful native mutation
  clock. Preserve the existing single mutation and write-hook contract.
- Preserve the original status-independent SDK step plan for retries; no forced
  native close is needed for source-fidelity imports. Legacy plans remain
  supported.
- Recognize governed history context even without a message. Select a different
  import-owned lifecycle generation only when its event actually changes status.

## Synthetic and packed regressions

`node --test test/repeat-import-noop.test.ts` passes 9/9. Coverage includes mixed
new/existing closed and open issues, later source edits, exact source dates,
native clocks, title/body/labels/comments/state changes, GitHub reopen, local
reopen followed by GitHub close, and interrupted replay both after a recorded
update and after finalization. Identical repeats compare item and history bytes.

Reverse-applying only the production fix in a disposable copy, retaining every
test, gives **0 passing, 9 failing**. Restoring the fix gives **9 passing, 0
failing**. All nine test names fail; no existing assertion was weakened.
An independent reversal of only `selectImportContextIndex`, retaining the
lifecycle repair, fails the interrupted-replay case (**0/1 passing**,
`recovered=false`); restoring that function passes **1/1**.
The published `2026.10.28` package with host `2026.10.25` also fails all nine,
including the original mixed-batch repeat assertion.

The recorded lifecycle fixtures now consistently cover linked closed owners;
their existing history assertions remain intact. Fresh mirrors have explicit
creation/closure/completion date assertions in the new mixed-batch regression.
The focused atomic, fidelity, refresh, SDK guard/hook and repeat suite passes
113/113. Canceled refresh transitions retain their required native close reason.

Isolated consumers of the packed candidate pass **9/9** on each exact host:
`2026.10.25` and `2026.11.2`. Neither the dependency lock nor the SDK floor changes.

## Three-repository measurement (2026-11-02)

Each disposable clone starts at the real repository's origin/main with complete
Git history and tags, matching `fetch-depth: 0` and `fetch-tags: true`. Retained
tag counts are 71 (pm-slack), 3 (pm-ado), and 0 (pm-review). Dependencies
are installed using `npm ci --ignore-scripts`; the packed candidate uses the
workflow's project-scoped `pm package install` command with an npm tarball source.
The managed registry setup change is restored before scanning. Both imports run:

```sh
pm github import <repo> --state all --atomic --gate --with-comments --json
```

Following the reusable workflow, first-import tracker changes are staged before
the repeat. The repeat must pass `git diff --exit-code -- .agents/pm` and leave
no untracked tracker files. No clone is pushed; all clones are removed afterwards.

| Repository | origin/main | Host SDK | First import | Second import | Second diff / untracked | Privacy scan |
| --- | --- | --- | --- | --- | --- | --- |
| pm-slack | `7df7ac4307a96dde300f98dd553dc80620865126` | 2026.10.27 | 0 new, 1 updated | unchanged, 0 updated | exit 0 / 0 | pass, 2 files, 0 findings |
| pm-ado | `2674c8ad1503d89d9932d489ac583a44ff14bf9f` | 2026.10.28 | 0 new, 3 updated | unchanged, 0 updated | exit 0 / 0 | pass, 6 files, 0 findings |
| pm-review | `43de410863f9843dcbfa22a7026c77dee8f4b8bb` | 2026.10.28 | 0 new, 4 updated | unchanged, 0 updated | exit 0 / 0 | pass, 8 files, 0 findings, 6 existing allowlist matches |

Before runs all failed at **Verify repeat import is a no-op**:

- [pm-slack run 41407900103](https://github.com/unbraind/pm-slack/actions/runs/41407900103)
- [pm-ado run 41407931969](https://github.com/unbraind/pm-ado/actions/runs/41407931969)
- [pm-review run 41408058207](https://github.com/unbraind/pm-review/actions/runs/41408058207)

Initial shared core API budget was 4,441, above the required 1,500 minimum.
Live issue content and origin/main can change after these measurements. The
candidate is neither published nor rolled out to callers by this work.

The post-abort continuation re-measured all three repositories with the rebuilt
artifact. Heads, tags, SDK locks and all first/second-import counts in the table
were unchanged. Each repeat again had zero untracked tracker files and diff
exit zero. Core budgets before the three measurements were 2,464, 2,425 and
2,258; all disposable clones were removed. Both exact packed SDK consumers
again passed 9/9.

Measured tarball SHA-256:
`b030d4945e16239c6d8976b2270d880fd34df9705eee8c8f065a1e34c5e1d783`.

## Coverage aggregation resource boundary

The first complete run reported 1,609 tests: 1,606 passing and three failing.
Those failures exposed the unchanged canceled-refresh and single-finalization
hook contracts and were corrected without changing an assertion. The same
attempt exhausted c8's checked-in 12 GiB aggregation cap. That attempt is not a
release-gate pass. Resource evidence is tracked separately on `pm-github-vhi6`;
the default cap, source inventory, exclusions and all four 100-percent thresholds
remain unchanged.

## Recovery after the disk-full abort

The continuation audited both staged and unstaged changes, parsed both touched
tracker items and their JSONL histories, and compiled production and test
TypeScript successfully. No truncated file was found. `dist/` is ignored rather
than tracked; the packed artifact was rebuilt from the audited source.

The interrupted rerun first failed these existing decision-matrix cases:

- `item decision end to end: claim kinds / failed evidence fetch / none / primary=link-only / competitor=delivery tag`
- `item decision end to end: claim kinds / failed checks / none / primary=link-only / competitor=delivery tag`

The exact two-case selection passes **2/2** on this branch and **2/2** on untouched
baseline `9586643`, with zero failures, skips or cancellations on either. The
failures are not reproducible after free-space recovery; the aborted run cannot
establish a source regression or a release-gate pass. No closeout code or matrix
assertion was changed. Both cases also pass inside the fresh complete coverage
run after recovery.

## Completed continuation gates

`NPM_CONFIG_USERCONFIG=/dev/null npm run release:check` passes all 11 checks
with the operational `NODE_OPTIONS=--max-old-space-size-percentage=60` override
already used before the abort. No checked-in resource setting, threshold,
source exclusion or assertion changed. The fresh test phase passes **1,609/1,609**
with zero failures, skips, cancellations or todos. Coverage includes **28 authored
modules**, with exact counters:

| Dimension | Covered / total |
| --- | --- |
| Lines | 13,197 / 13,197 |
| Statements | 13,197 / 13,197 |
| Functions | 422 / 422 |
| Branches | 5,075 / 5,075 |

The gate also reports 261 documented declarations across 27 files, zero
duplicated lines across 28 modules, zero production dependency vulnerabilities,
and one release publish invocation carrying provenance. The default-cap CI and
bounded-memory follow-up remains open on `pm-github-vhi6`. Free space was checked
before each invoked gate and stayed above the 20 GB stop threshold.
After the final tracker updates, `npm run changelog:full` and
`npm run changelog:check` both passed again. All temporary directories left by
these runs outside the worktree were removed. Raw coverage scratch was removed
after success; the summary, final JSON and LCOV receipts were retained locally.

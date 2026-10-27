# Scheduled closeout and sync refusals

Incident checked on 2026-10-27. Tracker: [pm-github-3it2](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-3it2.toon).

## Run evidence

Both workflows were inspected in four repositories using run metadata and the
job-log API. These are the scheduled runs from 2026-10-26:

| Repository | Closeout run / job | Sync run / job | Observed sync outcome |
| --- | --- | --- | --- |
| pm-beads | [40298977962 / 121491897462](https://github.com/unbraind/pm-beads/actions/runs/40298977962/job/121491897462) | [40288168047 / 121456680882](https://github.com/unbraind/pm-beads/actions/runs/40288168047/job/121456680882) | Success, control case using 2026.10.16 |
| pm-brief | [40298856586 / 121491496493](https://github.com/unbraind/pm-brief/actions/runs/40298856586/job/121491496493) | [40296846099 / 121484867381](https://github.com/unbraind/pm-brief/actions/runs/40296846099/job/121484867381) | Repeat import changes only native `updated_at` |
| pm-changelog | [40299074589 / 121492220507](https://github.com/unbraind/pm-changelog/actions/runs/40299074589/job/121492220507) | [40305700031 / 121514139043](https://github.com/unbraind/pm-changelog/actions/runs/40305700031/job/121514139043) | Pre-write privacy refusal: `absolute-host-path` in bodies for `github-issue-226` and `github-issue-1` |
| pm-vcs | [40298876589 / 121491561782](https://github.com/unbraind/pm-vcs/actions/runs/40298876589/job/121491561782) | [40278487479 / 121426304352](https://github.com/unbraind/pm-vcs/actions/runs/40278487479/job/121426304352) | Repeat import changes only native `updated_at` |

Every closeout job stopped in “Close delivered tracker items” with the generic
“Closeout refused; check token read access…” message. Its stdout and stderr files
were neither printed nor retained as artifacts, so the historical logs alone
cannot distinguish a read error from close validation. The failing sync jobs
used reusable workflow SHA `09412243e2543adedbb73a4f4b2f2b6e2ac0c8a6`
and resolved package 2026.10.19. The deprecated caller version input still said
2026.10.16; release workflows derive their package version from the pinned SHA.

## Exact closeout trigger

Read-only replays of pm-github 2026.10.19 against tracker snapshots from all four
closeout run heads fail with `Unverifiable GitHub pagination.` The first read is
`GET /repos/unbraind/{repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`.
GitHub returns the next-page Link under `/repositories/{numeric-id}/pulls`.
The old guard requires literal pathname equality with `/repos/{owner}/{name}/pulls`,
so it refuses the valid next page before any branch-policy or close-validation
checks. For pm-beads the numeric repository ID is `1234855396`.

The copied heads were:

| Repository | Run head |
| --- | --- |
| pm-beads | `e8e187e200897b41903ecb7950fb1fe0dd6cf1b7` |
| pm-brief | `8113f03b3d9c82f54a9548762d6cda2d9a623bb8` |
| pm-changelog | `ce504e16953a01ea1a9c68951638c94622d20723` |
| pm-vcs | `c7790d45aab22a3a28b4d44955a592dfc06e715e` |

The fix verifies the numeric alias against `GET /repos/{owner}/{name}` using both
the numeric `id` and `full_name`, then follows only the same-origin, same-endpoint
alias. Cycles, foreign repository IDs/names, and endpoint changes still fail.
A bounded replay with the fixed implementation follows the real pm-beads numeric
page and stops before evaluating PRs; it makes no tracker writes.

## Other refusal classes

### Canonical values and lossless tag transport

Re-review found two additional repeat-import cases: `--type issue` is persisted
as `Issue` by the SDK, and a label such as `area,api` was split by CSV mutation
options. Comparisons now resolve both type values through the SDK registry,
including configured aliases. All tag-writing paths share a lossless encoder:
it preserves the existing CSV wire representation where equivalent, and uses
the SDK's JSON-array representation otherwise. Stored arrays remain arrays of
literal tokens during comparison. Raw type inputs and ordinary tag wire bytes
stay stable for existing transaction fingerprints.

The package-wide audit also found the same rules in project import/push,
provider-link updates, refresh, identity repair tag removal, and closeout's
three Epic eligibility checks. Legacy `epic`/`EPIC` metadata remains readable
and cannot be closed as a delivered leaf. Plain import retains its existing
apply-each-time behavior; atomic import and refresh retain their byte-stable
repeat contract.

The class regression suite exercises real SDK writers in non-git trackers,
custom type aliases, adversarial tag pairs, and packed npm/native Bun consumers
with JSON and TOON output. Restoring only the previous type normalizer fails
both the mixed-import and legacy-Epic tests (2/2 failures). Restoring only the
previous CSV transport fails seven of nine class checks, covering import,
refresh, provider links, project push and exact identity removal. No existing
test or acceptance threshold was weakened.

The latest published version at investigation time was **2026.10.26**, published
2026-10-26. It retains the closeout pagination guard and generic workflow error.
It also includes the SDK lifecycle-finalization change from PR #180, but that
change alone does **not** fix the observed mixed-batch timestamp churn.
An isolated one-new-issue import repeats cleanly on both releases; it misses the
incident's trigger. A batch containing one new issue and one existing linked
native item reproduces the timestamp-only repeat diff on both releases. These
package-release replays use the repository-pinned SDK 2026.10.20.

The existing item's first SDK update emits an intermediate history event without
the bulk-import message marker. `selectImportContextIndex` treats that event as
an external edit. On repeat, the batch therefore receives a different transaction
identity and runs SDK updates again, advancing native `updated_at` even though
the source projection matches. The fix compares the complete import-owned
projection and avoids the unnecessary item transaction for an unchanged batch.
Both sides use the same SDK status, tag and assignment normalization and the
SDK's body formatting rules, so formatting-only differences do not restart
the transaction. Meaningful leading body indentation remains content.
It still reconciles native annotations and dependency links and runs the privacy
gate. It never uses the shortcut while a GitHub SDK journal is unfinished.
Real HTTP/SDK regressions cover mixed-batch item/history byte identity, local
body-drift repair, and a genuinely interrupted SDK journal.

Branch protection is a separate policy boundary. GitHub documents
[Administration read permission for branch-protection reads](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection).
The Actions [permissions table](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
does not offer administration permission to `GITHUB_TOKEN`. A 403 is not evidence
that no checks are required. Closeout retains readable ruleset/app bindings and
requires the newline-separated `required-checks` input when policy metadata is
unavailable. It reports the actual failed endpoint and status. It does not infer
historical required-check success from a merged PR's current merge-state label.

SDK close refusals identify the item, PR, stable validation code, and missing
policy fields when supplied by the SDK. A failed JSON closeout preserves its
complete private stdout report before the CLI host formats its error envelope;
the reporter prefers that full report even if stderr is abbreviated.
The workflows select one reason from
private JSON/error receipts, scan that reason with the existing privacy gate,
then emit one escaped error annotation. They do not print raw stderr or a
repeat-import diff. The source-content privacy refusal in pm-changelog remains
enforced; callers must remove the source content or explicitly review a narrow
allowlist entry before retrying.

## Caller adoption

After this fix is released, update the reusable-workflow SHA to a release
containing it. Changing only the deprecated version input does not update the
release-derived package. No caller is edited by this PR.

Current pins checked on the default branches:

| Callers | Current reusable-workflow release |
| --- | --- |
| pm-beads, pm-brief, pm-changelog, pm-context, pm-csv, pm-gantt-chart, pm-jira, pm-linear, pm-ops, pm-rl, pm-slack, pm-slack-standup, pm-starter, pm-swarm, pm-todos, pm-ts-starter, pm-vcs, pm-presets | Closeout 2026.10.19; sync 2026.10.19 except pm-beads sync 2026.10.16 |
| pm-rust | Closeout and sync 2026.10.23 |
| pm-web | Closeout 2026.10.16; sync 2026.10.19 |
| pm-hypothesis | Sync 2026.10.24; no closeout caller found |

The open Dependabot PRs [pm-beads #169](https://github.com/unbraind/pm-beads/pull/169)
and [pm-web #255](https://github.com/unbraind/pm-web/pull/255) propose 2026.10.19.
Those targets predate this fix and do not resolve the pagination refusal.

## Verification handoff

Implementation commit `c989d10` passed focused incident/privacy/comparison tests
44/44, interrupted recovery and clean repeat tests 2/2, and restored-normalizer
verification 1/1. Five behavioral function reverts fail their regressions as
expected. Build, lint, docstrings, privacy and isolated strict health pass.
The earlier full npm gate passed 1540/1540 and exact coverage across 22 modules
before the final normalization adjustment. The full local Bun run was
interrupted on orchestrator instruction; final full gates remain CI-owned.

At 2026-10-27 10:12 UTC, [CI](https://github.com/unbraind/pm-github/actions/runs/40483563492) and [CodeQL](https://github.com/unbraind/pm-github/actions/runs/40483563359)
remain queued for the implementation commit; Semgrep passed. Pending checks
are not approval. The documentation/tracker handoff receipt changes no runtime
code or tests. Caller adoption remains in `pm-github-samq`.

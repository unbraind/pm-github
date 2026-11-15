# Fleet CI v2

Required checks remain `test (22)` and `test (26)`. PRs and dispatch run on
GitHub-hosted Ubuntu with quick depth, cancellation of superseded PRs, and a
30-minute timeout per job. Hosted Node 22 tests use four workers to overlap
IO-heavy CLI fixtures; Node 26 coverage, local/default and full runs retain two. No main push starts this tier. Tracker/docs-only
PRs run only dependency installation, strict tracker health with required merge
drivers, and changelog consistency in both required jobs. The detector compares
PR endpoints with NUL-delimited paths and rename folding disabled, so moving
source into documentation still selects code validation.

| Check / contract | Code PR Node 22 | Code PR Node 26 | Docs/tracker PR (both) | Deep Node 22/26 × npm/Bun |
| --- | --- | --- | --- | --- |
| Dependency install / merge-driver preparation | yes | yes | yes | yes |
| Strict pm health / required merge drivers | — | yes | yes | yes |
| Typecheck | — | yes | — | all four gates |
| Build / test TypeScript compilation | yes | yes | — | all four gates |
| Exhaustive import workflow shell scenarios | first 25/50 | first 25/50 | — | all 50 scenarios |
| Closeout publication workflow scenarios | first 25/49 | first 25/49 | — | all 49 scenarios |
| Closeout decision property matrix | first 25/186 | first 25/186 | — | all 186 cells |
| Tests, including real packed npm and native Bun consumers | quick | quick via coverage | — | full in all four gates |
| Docstrings, lint, zero duplication, privacy | — | yes | — | all four gates |
| Exact all-source coverage, 100% lines/statements/branches/functions | — | quick | — | full in all four gates |
| Production dependency audit | — | yes | — | all four gates |
| Pack dry-run | — | yes | — | all four gates |
| Changelog consistency | — | yes | yes | all four gates |
| Release publish attestation verification | — | yes | — | all four gates |
| Bun package-graph install | — | yes | — | both npm legs |
| bunx installed CLI launcher smoke | — | yes | — | PR smoke contract |
| Native Bun package metadata / fixture lifecycle smoke | — | quick | — | via full native suite |
| Entire native Bun extension suite (`test:bun`) | — | — | — | both npm legs, full |
| CodeQL (separate workflow, not required) | matching paths | matching paths | path-filtered | main matching paths / weekly |

Deep runs on main pushes, daily at **02:11 UTC**, and dispatch. That minute avoids
daily release at 03:23, hourly release recovery at :41, Dependabot at 04:23, and
CodeQL at 03:43 Monday. The four original Node 22/26 × npm/Bun release gates remain,
with distinct `deep (22, npm)`, `deep (22, bun)`, `deep (26, npm)`, and
`deep (26, bun)` names. Each job has a 120-minute cap, full depth, and
`PM_TEST_TIME_SCALE=3`. Its native Bun loop keeps the original file set and
aggregate failure behavior, scaling the per-test harness cap from 10 to 30
minutes and preserving npm's local CLI PATH. Deep concurrency cancels older runs of the same ref.
The local runner expression uses the self-hosted `pm-local` pool unless the
controller sets `PM_LOCAL_DEEP=off`, which selects GitHub-hosted Ubuntu. Busy local
runners queue; this change does not edit that variable or branch protection.

`PM_TEST_DEPTH=quick` runs the same deterministic prefix at one tenth depth,
rounded up and with a minimum of 25 (capped by the original count). Thus 500-case
models use 50, 1000-case numeric fuzz uses 100, and 4096-case citation fuzz uses
410. The generated 186-cell closeout decision property matrix uses its first
25 cells in quick mode; all 186 remain in full mode. Its Cartesian-product
generation, independent oracle and per-cell publication checks remain unchanged.
The expensive import workflow shell scenarios are collected separately from
core import unit tests; quick registers their first 25 scenarios and full/default
registers every original scenario, with unchanged fixtures and assertions. This
moves exhaustive workflow combinations to deep CI while retaining a deterministic
PR prefix and the complete core unit suite. Closeout publication similarly keeps
its first 25 of 49 scenarios in quick mode and all 49 in full/default mode.
The shared test-only collector preserves exact callback and option identities;
its unit controls verify complete default/unknown-depth registration and quick
prefix order using fake registrations, without executing a full product corpus. Unset, `full`, and unrecognized values
retain the original counts. Seed
initialization, generation, per-case assertions and operation order are retained.
Fixed pagination, corpus-size, memory and exhaustive domain fixtures retain their
original sizes. Coverage thresholds and source inventory are unchanged in both
depths. Aggregate diversity assertions scale with the sampled corpus.

Coverage retains its original two-worker implementation, native c8 remapping,
incremental merging, source inventory, and exact four-dimensional thresholds.
Hosted Node 22 uses the same build, test compilation and complete file glob as
`npm test`, with four workers and npm's local-bin PATH restored explicitly;
there is no separate coverage, changelog or pack command. The existing embedded
packed tests remain. No test files or assertions are omitted by worker selection.

Import workflow fixtures pack one immutable candidate per test process, matching
the existing closeout fixture pattern. Every scenario still performs a real
installation into a fresh consumer and tracker. Packed bytes are copied to each
fixture's original unique archive locator, preserving package-manager cache
isolation as well as project isolation. The explicit clone/worktree
packing regression remains uncached and checks those independent paths. The
shared tarball is disposable and removed by the test lifetime hook.

The original native Bun suite is a separate contract: `bun run release:check`
executes the gate's Node scripts, so it cannot replace `test:bun`. The quick gate's
packed tests exercise npm-installed and native Bun consumers in JSON and TOON.
They do **not** prove a fresh bunx install path; PR CI therefore explicitly runs
`bunx --bun --no-install pm --version` after Bun's package-graph install. This
proves the installed launcher, not an ephemeral registry download. The opt-in
`test/discussion-packed-acceptance.ts` additionally covers global Bun and bunx;
it was not part of the old CI gate and remains opt-in.

Latency regression assertions and child watchdog defaults accept
`PM_TEST_TIME_SCALE` (finite values >= 1, default 1). This scales test allowances,
not the production HTTP timeout, lock wait, or dispatch deadline. Lower-bound
assertions still prove real waiting. Synthetic timing replay pins scale 1 so its
positive and negative controls remain independent of machine load. Performance
regression witnesses retain their full adversarial input sizes.

CodeQL keeps its weekly schedule, PR cancellation and a 30-minute job cap. On
push and PR it ignores tracker data, Markdown, docs and the npm lockfile.
No release workflow, reusable `pm-github-*.yml`, or release verifier is changed.

Strict health validates checkout-visible tracker data; its merge-driver check
only verifies installation in the current runner. It cannot certify driver
registrations, runtime caches or merge receipts in another developer checkout,
or establish lossless reconciliation from a fresh clone.

## Measurement receipts

The latest successful main CI when work began was run
[43646546806](https://github.com/unbraind/pm-github/actions/runs/43646546806),
with total wall time **1h29m25s**. Jobs API receipts showed:

| Original check | Created → completed | Queue | Execution |
| --- | --- | --- | --- |
| test (22) | 89m24s | 29m55s | 59m29s |
| test (26) | 74m11s | 18m02s | 56m09s |
| bun-release (22) | 75m20s | 33m23s | 41m57s |
| bun-release (26) | 49m35s | 22m14s | 27m21s |

The Node 26 npm gate's log shows random label import at 50.07s, discussion model
at 49.29s, label replay at 28.07s, native label model at 25.12s, and issue-form model
at 24.70s. The executable reusable-workflow publication tests also cost up to
64.05s each; they remain intact. Several timeout-contract tests deliberately
wait about 30 seconds and are retained.

The most recent completed quick run before the final locator-preserving fixture
change was [43692426506](https://github.com/unbraind/pm-github/actions/runs/43692426506),
at source `0e5ae434d13ec1e0db9866d0575411720ca32678`:

| Required check | Created → completed | Queue | Execution |
| --- | --- | --- | --- |
| test (22) | 21m24s | 9m15s | 12m09s |
| test (26) | 25m05s | 5m21s | 19m44s |

Both passed. Node 26 reported 2,106 passing tests, no failures or cancellations,
the two existing SDK compensation quarantines, and 100% in every coverage
dimension across 32 authored modules. Testing took 892.125s and native coverage
aggregation about 244s. The fastest completed bounded-corpus run was
[43688644393](https://github.com/unbraind/pm-github/actions/runs/43688644393):
12m24s / 15m43s wall for Node 22/26, with two seconds of queueing each.
PR receipts identify the final pushed head separately; these are historical
measurements, not an exact-head attestation for later changes.

Local proof is restricted to typecheck, lint, changed tests, and at most one
20-minute quick coverage attempt on the shared development host. Full depth is
certified by deep CI after merge. Local and PR measurements will be recorded in
the package task and PR; host contention makes direct speedup ratios unreliable.

Tracking: [pm-github-ci-v2](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-ci-v2.toon).
Companion: `pm-cli-website-dyhg`. Existing fixture investigations
`pm-github-r14n` and `pm-github-gaq8` retain their separate scopes.

The 15-minute queue-inclusive budget remains an acceptance gap on measured runs.
Shared hosted queue delay and SDK/coverage execution are reported separately in
the task and PR. Further native receipt/fixture profiling is tracked by
`pm-github-ci-coverage-latency`; its memory-bounded predecessor `pm-github-vhi6`
has a separate completed scope. No source exclusions, remapping shortcuts or
lower coverage thresholds were introduced to hide this gap.

Final implementation receipt:
[43696188386](https://github.com/unbraind/pm-github/actions/runs/43696188386),
head `9a9a1bbff50d9c1834fa3022ba5080803b9c5b42`, passed both required checks:

| Required check | Created → completed | Queue | Execution |
| --- | --- | --- | --- |
| test (22) | 16m43s | 5m33s | 11m10s |
| test (26) | 29m03s | 7m05s | 21m58s |

Both reported 2,106 passes, no failures/cancellations and two pre-existing SDK
compensation skips. Node 26 retained exact 100/100/100/100 across **32** authored
modules; earlier task comments naming 34 modules were a receipt transcription
error, not a change in source inventory. Testing took 1,035.706s and coverage
aggregation about 233s. The installed bunx launcher and eight native Bun smoke
tests passed. The 15-minute budget remains unmet; no full-depth post-merge result
is claimed by these quick-tier receipts.


## Round 2 timing audit

All `testTime(` calls were inspected. Product assertions use fixed limits even
when `PM_TEST_TIME_SCALE=3`; harness watchdogs may scale. Locations below refer
to the pre-fix review head (message interpolations on the same line count too).

| Original location | Decision |
| --- | --- |
| `test/ci-handoff-workflow.test.ts:77` | Keep scaled 30 s subprocess watchdog. |
| `test/ci-handoff-workflow.test.ts:141` | Fixed 25 s lookup assertion. |
| `test/import-lock.test.ts:467` | Keep scaled 180 s test timeout. |
| `test/import-lock.test.ts:556` | Keep scaled 5 s test timeout. |
| `test/import-lock.test.ts:565` | Fixed 2 s lock wait assertion. |
| `test/http-boundary.test.ts:541` | Keep scaled 45 s test timeout around the fixed 30 s request deadline. |
| `test/import-gate.test.ts:1455` | Keep scaled 180 s test timeout. |
| `test/import-gate.test.ts:1475` | Fixed 45 s installed import assertion. |
| `test/import-selection.test.ts:27` | Keep scaled 45 s subprocess watchdog. |
| `test/import-regex.test.ts:75` | Fixed 50 ms ownership assertion and diagnostic (two calls removed). |
| `test/import-regex.test.ts:90` | Fixed 50 ms locator assertion and diagnostic (two calls removed). |
| `test/import-regex.test.ts:105` | Fixed 50 ms citation assertion and diagnostic (two calls removed). |
| `test/import-regex.test.ts:130` | Fixed 50 ms privacy assertion and diagnostic (two calls removed). |
| `test/import-regex.test.ts:148` | Fixed 50 ms API base assertion and diagnostic (two calls removed). |
| `test/import-regex.test.ts:179` | Fixed 50 ms privacy marker assertion and diagnostic (two calls removed). |
| `test/cited-issue-adoption.test.ts:649` | Fixed 1 s backtracking assertion. |
| `test/smoke.test.ts:324` | Fixed 2 s header scan assertion. |
| `test/bounded-cli.test.ts:29` | Fixed 3 s forced cleanup assertion. |
| `test/gate-public-forms.test.ts:150` | Fixed 200 ms bracket scan assertion. |
| `test/gate-public-forms.test.ts:164` | Fixed 200 ms email scan assertion. |
| `test/gate-public-forms.test.ts:211` | Fixed 1 s delimiter scan assertion. |
| `test/helpers/bounded-cli.ts:19` | Keep both scaled harness defaults: 45 s execution and 5 s cleanup. |
| `test/helpers/bounded-cli.ts:47` | Keep scaled 45 s readiness watchdog. |

The helper's longer harness allowance cannot relax the installed import's
separate fixed 45 s product assertion. The helper declaration in
`test/support/time.ts` defines the scaler; it is not a call site.

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
`PM_TEST_TIME_SCALE=3`. Deep concurrency cancels older runs of the same ref.
The local runner expression uses the self-hosted `pm-local` pool unless the
controller sets `PM_LOCAL_DEEP=off`, which selects GitHub-hosted Ubuntu. Busy local
runners queue; this change does not edit that variable or branch protection.

`PM_TEST_DEPTH=quick` runs the same deterministic prefix at one tenth depth,
rounded up and with a minimum of 25 (capped by the original count). Thus 500-case
models use 50, 1000-case numeric fuzz uses 100, and 4096-case citation fuzz uses
410. The generated 186-cell closeout decision property matrix uses its first
25 cells in quick mode; all 186 remain in full mode. Its Cartesian-product
generation, independent oracle and per-cell publication checks remain unchanged.
Unset, `full`, and unrecognized values retain the original counts. Seed
initialization, generation, per-case assertions and operation order are retained.
Fixed pagination, corpus-size, memory and exhaustive domain fixtures retain their
original sizes. Coverage thresholds and source inventory are unchanged in both
depths. Aggregate diversity assertions scale with the sampled corpus.

Coverage retains the original two-worker cap and unmodified gate implementation.
Hosted Node 22 uses the same build, test compilation and complete file glob as
`npm test`, with four workers and npm's local-bin PATH restored explicitly;
there is no separate coverage, changelog or pack command. The existing embedded
packed tests remain. No test files or assertions are omitted by worker selection.

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

Local proof is restricted to typecheck, lint, changed tests, and at most one
20-minute quick coverage attempt on the shared development host. Full depth is
certified by deep CI after merge. Local and PR measurements will be recorded in
the package task and PR; host contention makes direct speedup ratios unreliable.

Tracking: [pm-github-ci-v2](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-ci-v2.toon).
Companion: `pm-cli-website-dyhg`. Existing fixture investigations
`pm-github-r14n` and `pm-github-gaq8` retain their separate scopes.

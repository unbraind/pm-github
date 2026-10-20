# Changelog placement and imported history

Tracking: [pm-github-lfcf](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-lfcf.toon),
related [pm-github-c093](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-c093.toon),
wording follow-up [pm-github-n0mm](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-n0mm.toon).

## Scope and replay method

On 2026-10-20, read all 14 unresolved review threads on the eight reported PRs
with `reviewThreads(first:50)` and the first five comments per thread. Neither
connection had further pages. No finding was dismissed as invalid.

Ran current pm-github main `c651421` against disposable Git clones, using real
trackers, live read-only GitHub issue/timeline/PR/check evidence, atomic imports,
and each consumer's installed `changelog:full`. No consumer branch was published.
Selected imports: pm-brief #84/#135, pm-beads #85, pm-context #81,
pm-csv #72/#86/#134, pm-linear #134, pm-slack-standup #45, pm-rlm #4/#5.
Closeout selected pm-ado PRs #16/#25/#31; current explicit delivery rules close
`pm-ado-m8c1` from #31 while skipping non-delivery references.

Consumer heads: pm-ado `60e82831e38c02e98b314f1443ce427c64456a14`,
pm-brief `bea54fa0d9c990a26a471d2728b625fd1f4880e4`,
pm-beads `38c16662ff3cf4920c2833f08ec7f4e777d06fad`,
pm-context `75d6a105efa0d213ac46095cc54bad2715b57f2f`,
pm-csv `fda9c1fbf5420230cfc7ec6b7dae0796262313f2`,
pm-linear `87b1eb8c94f7e9255119bca015f06e391ed9a059`,
pm-slack-standup `590df328f7163c6f5a7d39ad4b58221e8e53d410`,
pm-rlm `06a51b1949b8d9975ed1e323236240ecd67fac80`.

## Every unresolved finding

A = fixed by the import fidelity shipped in v2026.10.19 / PR #142.
B = remaining pm-github defect fixed here.
C = pm-changelog wording defect, reproduced here and left to that package.
Some threads contain separate placement and wording claims, so carry two classes.

| PR | Thread | Class | Replay evidence |
| --- | --- | --- | --- |
| [pm-ado#32](https://github.com/unbraind/pm-ado/pull/32) | [October work appears in September release](https://github.com/unbraind/pm-ado/pull/32#discussion_r4301991646) | B | No tags; package version 2026.9.2 creates a pending September heading. Current closeout records #31 completion at 2026-10-16T10:56:57Z but renders it in September. Passing `--no-pending-release` places it under Unreleased. |
| [pm-brief#154](https://github.com/unbraind/pm-brief/pull/154) | [Shipped fixes reappear as new](https://github.com/unbraind/pm-brief/pull/154#discussion_r4292403197) | A + C | #135 renders in 2026.10.8; #84 in 2026.9.1. #135 has a closing PR #137; #84 has factual closure wording without an invented repair. The generic Fixed heading remains C. |
| pm-brief#154 | [Historical fixes inflate recent metrics](https://github.com/unbraind/pm-brief/pull/154#discussion_r4292403206) | A | Native created_at/closed_at/completed_at match GitHub exactly; both closures predate the seven-day window on the replay date. Native updated_at remains the local audit clock. |
| [pm-beads#145](https://github.com/unbraind/pm-beads/pull/145) | [Resolved issue appears upcoming](https://github.com/unbraind/pm-beads/pull/145#discussion_r4291876796) | A | #85 closes 2026-09-01T04:51:34Z and renders under 2026.9.1. |
| pm-beads#145 | [Closure reason omits the fix](https://github.com/unbraind/pm-beads/pull/145#discussion_r4291876814) | A + C | Generic “GitHub issue #85 closed” becomes “Closed on GitHub as completed on 2026-09-01T04:51:34Z”. Available source evidence supplies no repair; importer records closure rather than inventing one. Fixed heading still belongs to C. |
| [pm-context#147](https://github.com/unbraind/pm-context/pull/147) | [Historical fix appears unreleased](https://github.com/unbraind/pm-context/pull/147#discussion_r4291406838) | A + C | #81 closes 2026-09-01T04:51:39Z and renders under 2026.9.6. The source date is preserved; generic Fixed wording remains C. |
| [pm-csv#163](https://github.com/unbraind/pm-csv/pull/163) | [Historical fixes appear as new](https://github.com/unbraind/pm-csv/pull/163#discussion_r4291948135) | A + C | #134, #86, #72 render under 2026.9.26, 2026.9.1, 2026.8.28 respectively. Source closure does not establish privacy remediation; Fixed wording remains C. No history rewrite was attempted. |
| pm-csv#163 | [Tracker and GitHub states conflict](https://github.com/unbraind/pm-csv/pull/163#discussion_r4291948151) | A | Existing #72 owner pm-csv-uaq1 has status=closed, github_state=closed and github_updated_at=2026-10-14T11:34:13Z after refresh. |
| pm-csv#163 | [Imported issues have negative lifetimes](https://github.com/unbraind/pm-csv/pull/163#discussion_r4291948167) | A | #134 lifetime is Sep 23–25; #86 Aug 27–Sep 1. Source creation precedes native completion/closure. |
| [pm-linear#150](https://github.com/unbraind/pm-linear/pull/150) | [GitHub mirror creates duplicate Linear issue](https://github.com/unbraind/pm-linear/pull/150#discussion_r4292374050) | B | Main still creates a mirror beside pm-linear-ldqw. Fixed matcher links that existing native owner. Offline export plans for the affected records fall from two creates to one; no Linear write or new Linear provenance is claimed. |
| pm-linear#150 | [Duplicate issue records appear](https://github.com/unbraind/pm-linear/pull/150#discussion_r4292374064) | A + B | Main correctly dates the mirror to 2026.10.8 but still duplicates the owner. Fixed replay creates zero mirrors and preserves the owner's native completion at 2026-10-07T13:09:49.837Z. |
| [pm-slack-standup#127](https://github.com/unbraind/pm-slack-standup/pull/127) | [Privacy exposure appears fixed](https://github.com/unbraind/pm-slack-standup/pull/127#discussion_r4291914306) | C | Source closure wording is factual, but pm-changelog still puts the closed incident under Fixed in 2026.8.28. That heading cannot prove remediation. |
| pm-slack-standup#127 | [Historical completion appears unreleased](https://github.com/unbraind/pm-slack-standup/pull/127#discussion_r4291914311) | A | #45 preserves Aug 21 creation/Aug 27 closure and renders under 2026.8.28. |
| [pm-rlm#9](https://github.com/unbraind/pm-rlm/pull/9) | [Duplicate fixes and conflicting statuses](https://github.com/unbraind/pm-rlm/pull/9#discussion_r4311983239) | B | Main creates two mirrors and assigns Oct 19 closures to the untagged 2026.10.18 pending heading. Fixed matcher updates pm-rlm-sr0b/pm-rlm-k7tv link-only, creates zero mirrors, retains native in_progress, and suppresses the fabricated pending release. |

The API inventory has 14 unresolved thread nodes across eight PRs
(1 + 2 + 2 + 1 + 3 + 2 + 2 + 1). Each node is linked above.

## Regenerated lifecycle and release evidence

Native closed_at and completed_at both equal the closure column for imported
GitHub-owned items. These are source instants, not the import timestamp.

| Source | Native created_at | Native closure | Rendered release |
| --- | --- | --- | --- |
| pm-brief #135 | 2026-10-05T05:06:12Z | 2026-10-07T12:19:04Z | 2026.10.8 |
| pm-brief #84 | 2026-08-25T04:12:33Z | 2026-09-01T04:51:37Z | 2026.9.1 |
| pm-beads #85 | 2026-08-27T14:24:01Z | 2026-09-01T04:51:34Z | 2026.9.1 |
| pm-context #81 | 2026-08-27T14:24:37Z | 2026-09-01T04:51:39Z | 2026.9.6 |
| pm-csv #134 | 2026-09-23T08:54:00Z | 2026-09-25T07:52:12Z | 2026.9.26 |
| pm-csv #86 | 2026-08-27T14:29:39Z | 2026-09-01T04:51:41Z | 2026.9.1 |
| pm-csv #72 | 2026-08-20T19:42:05Z | 2026-08-27T04:12:45Z | 2026.8.28 |
| pm-slack-standup #45 | 2026-08-21T10:35:08Z | 2026-08-27T04:12:50Z | 2026.8.28 |

The v2026.10.19 fidelity implementation assigns the earliest actual tag at or
after source closure and corrects native source lifetimes. Current main retains
those rules, with subsequent linked-refresh normalization and release-preservation
refinements; the module is not byte-identical to the release.
Correct source closure dates make the two pm-brief momentum closures older than
the recent window and preserve their actual positive cycle durations.

## Changes and boundaries

Both reusable workflows pass `-- --no-pending-release` to `changelog:full`.
No package version is bumped, and real released tag windows remain available.
Custom post-script names receive their existing argument list; custom wrappers
must implement the same non-release policy and forward arguments to their
changelog generator. Empty and missing scripts retain their existing behavior.

The importer also recognizes a leading `GitHub issue URL` or `GitHub issue: URL`
in a native owner's description. Such an owner gets GitHub source metadata and
link-only provenance while retaining local status, content, lifecycle and release.
Incidental body/description links, blockers, and copied GitHub-owned examples do
not transfer ownership. Multiple owners still fail closed.

`test/changelog-placement.test.ts` executes the actual workflow shell with temp
Git repos, real trackers, real closeout/import, and the pinned changelog CLI.
It covers both workflows with and without an actual old release tag, plus empty,
missing and custom post scripts. The import regression covers plain and atomic
native-owner reuse, local evidence preservation and repeated-import idempotency.

Original placement validation at `4b6637f` used separate source snapshots:
reverting only the two workflow post-script steps makes both untagged-version
placement tests fail their Unreleased assertion (0/2 pass). Reverting only
`matchImportedIssue` makes both native-owner tests fail with identity `new`
instead of `github-declaration` (0/2 pass). The fixed placement suite passes
4/4 and the fixed native-owner suite passes 2/2; the working source is untouched
by the mutations.

Linked `pm test pm-github-lfcf --run --timeout 2400 --progress` passes both
registered commands (six regressions), with no skipped tests, assertion failures
or timeouts. The default 120-second attempt timed out under concurrent load;
it is not counted as passing evidence. Updating stored timeout metadata is
refused by pinned pm because the project's peer floor cannot safely refuse
guarded item format 2; the supported run-level timeout avoids changing pins.
Automatic test-result tracking is disabled by existing project policy, so the
result is recorded in the item's append-only comments.

At that placement snapshot, strict health on main and the PR reports the same existing
host-version mismatch (`2026.10.15` host versus `2026.10.19` extension) and seven
stale in-progress items. Integrity and history-drift checks pass. Dependency
currency remains with Dependabot; this work makes no clean-health claim.
The existing [pm-github-julo](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-julo.toon)
certification item already records the version-skew finding.

The full gate exposed the already tracked
[pm-github-sah1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-sah1.toon)
synthetic watchdog startup race; its isolated original suite passed 2/2.
The probe now opts into a finite 45-second readiness phase before its unchanged
500 ms operation deadline, 100 ms forced cleanup and three-second operation
assertion. Normal installed-consumer calls retain their original total 45-second
wall-clock deadline. A deliberate 750 ms startup delay makes the regression
deterministic. Fixed suite: 2/2. Reverting only the helper fails the selected
ready assertion (0/1); removing only forced SIGKILL stalls until an independent
12-second guard rejects the test and cleans up both owned descendant processes.
No deadline, cleanup budget, coverage threshold or dependency pin is relaxed.

The subsequent readiness review replaces the probe's console log with
`writeSync(1, 'ready\n')` before its CPU spin. A preloaded deferred console logger
flushes normally for the clean-exit control but cannot flush during the spin,
making the asynchronous-output hazard deterministic. Both Node and native Bun
pass 2/2 watchdog tests. Restoring only `console.log('ready')` fails the selected
regression (0/1) at its readiness assertion after the finite startup guard kills
the child; the fixed source retains the same startup and operation budgets.
The other marker probe waits for parent input before starting its operation,
so its readiness output can flush before any CPU-bound work begins.

## Release gates

At regex-hardening head `f2dcdbe6eade612288cd783208e5904270e44ab7`,
clean-HOME/Git-isolated `npm run release:check` passes 971/971 tests, with zero
failures, cancellations or skips. Across all 16 authored modules, coverage is
11055/11055 lines, 11055/11055 statements, 302/302 functions and 3526/3526
branches. Docstrings cover 176 declarations in 15 files; duplication is zero
at the unchanged threshold. Production audit reports zero vulnerabilities;
package dry-run, changelog check and publish-attestation checks pass.

At the same head, clean-HOME/Git-isolated `bun run release:check` also passes 971/971 tests with
zero failures, cancellations or skips, and the identical four coverage counts.
All remaining release checks pass under both entry points. Source and regression
hashes are unchanged between runs. The refreshed review inventory still contains
the same 14 unresolved threads and comments, without further pages.

## Minimal pm-changelog wording repro

With pm-changelog 2026.10.15 installed, run:

```sh
printf '%s' '{"items":[{"id":"fixture-incident","title":"Historical workflow incident","type":"Issue","status":"closed","created_at":"2026-08-20T00:00:00Z","closed_at":"2026-08-27T00:00:00Z","completed_at":"2026-08-27T00:00:00Z","close_reason":"Closed on GitHub as completed on 2026-08-27T00:00:00Z"}]}' | node node_modules/pm-changelog/dist/cli.js --stdin --stdout
```

The output contains `### Fixed` and the incident title despite the lack of any
repair evidence. Release attribution and lifecycle preservation cannot resolve
this category choice. Follow-up pm-github-n0mm records the package boundary;
this PR does not modify pm-changelog or claim privacy remediation.

## Dependabot pin currency

Yes: a SHA-pinned remote reusable workflow remains an update dependency when its
comment is `# pm-github`. Parsing/resolving the ref does not depend on that comment.
The comment is not recognized as a version annotation and stays unchanged.
Use a real release commit plus its matching version comment for reviewable pins:

```yaml
jobs:
  gated-sync:
    uses: unbraind/pm-github/.github/workflows/pm-github-sync.yml@09412243e2543adedbb73a4f4b2f2b6e2ac0c8a6 # v2026.10.19
```

Use the analogous closeout workflow path and the same matching release SHA/tag.
Configure `package-ecosystem: github-actions`, `directory: /` and an enabled
schedule. A group pattern `unbraind/pm-github*` covers both workflow dependency
names; avoid update-type filters that exclude calendar year changes, and ensure
ignore rules/open PR limits do not prevent updates.

GitHub documents support for remote reusable workflows, SHA references and
[same-line tag comments](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#github-actions).
Its [version updates documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates)
also identifies reusable workflows as supported. An untagged SHA may follow
branch HEAD rather than a release, so the SHA must actually match the comment.

Observed fleet behavior: Dependabot's [pm-web#184](https://github.com/unbraind/pm-web/pull/184)
updates SHA-pinned setup-node in two workflows from `820762786026740c76f36085b0efc47a31fe5020`
to `949feb2413d6458794dcd2491c4babbbce0c15c1`, retaining `# v7`.
[pm-brief#128](https://github.com/unbraind/pm-brief/pull/128) similarly updates both
SHA-pinned CodeQL references retaining `# v4`. These prove real SHA updates;
the generic-comment conclusion additionally follows from Dependabot's
[parser](https://github.com/dependabot/dependabot-core/blob/main/github_actions/lib/dependabot/github_actions/file_parser.rb)
and [version commenter](https://github.com/dependabot/dependabot-core/blob/main/github_actions/lib/dependabot/github_actions/file_updater/workflow_updater/version_commenter.rb),
which resolve a SHA independently and rewrite a comment only when it ends in a
matching version. No consumer configuration was changed here.

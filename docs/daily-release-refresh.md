# Daily release refresh and public import evidence

Unchanged importer source: main `dc86e83be87f915dabef831e720edcf3cdc562e8`. Public API observation: 2026-10-18.

## Release root cause

The release job generates closed-only history by invoking pm-changelog directly. Its changelog:check invokes scripts/generate-changelog.ts, which also includes unfinished items tagged changelog-unreleased. After main gains such tracker changes, a later run fails release:check before reaching the existing lease-protected branch push. Date-derived branch selection also abandons an older open PR on the next day; numeric suffixes permit multiple same-day publications.

The job now fetches current main before preparation and uses the canonical changelog scripts. A pure decision over existing PR, main SHA, last release and today selects the existing release branch for rebuilding, updates its title/version to today and refuses a second version after today has a release tag. A concurrent main update still refuses publication; a subsequent run rebuilds it.

## Public-data method

Temporary clones contain the real caller sync PR heads. The unchanged main build runs runImport with state=all, gate=true, atomic=true and dry-run=true against the live API. Certified complete SDK reads and durable tracker fingerprints prove zero durable tracker writes. pm-context also accounts for two new open issues.

Each historical plan row is projected into real pm-changelog stdin rendering and the actual pm-brief summarizeMomentum export. The renderer must include the item under its explicit containing release and omit it from Unreleased. No importer apply ran. The dry-run schema omits completed_at: below it is explicitly projected from the existing persistImportFidelity assignment, which writes both terminal fields from github_closed_at. Existing real-tracker import-fidelity regressions exercise those durable assignments.

Baseline Unreleased membership comes from the actual caller PR CHANGELOG.md. All projected GitHub states equal closed; the canceled item retains local status canceled. Momentum observes each source closure plus one second with a 3650-day window, to inspect its historical lifetime; baseline momentum is observed on 2026-10-18. This is not a production now-window throughput claim.

| Repository | Caller PR head |
| --- | --- |
| unbraind/pm-csv | `fea199155e101b250e34d3fcb5eebda0544b0c42` |
| unbraind/pm-brief | `25495e6b35572d1d7c9218eb91ace4ed5925c9dd` |
| unbraind/pm-context | `7d9ed21dedcf104ab921bc34dc11fd9019738dd6` |

## Before versus main plan

| Repo / issue | Field | Caller sync PR | Main plan / projection |
| --- | --- | --- | --- |
| unbraind/pm-csv#72 | created_at | `2026-08-20T19:28:52.262Z` | `2026-08-20T19:42:05Z` |
| unbraind/pm-csv#72 | closed_at | `2026-10-18T07:17:46.393Z` | `2026-08-27T04:12:45Z` |
| unbraind/pm-csv#72 | completed_at | `2026-08-27T04:12:45.000Z` | `2026-08-27T04:12:45Z` |
| unbraind/pm-csv#72 | github_state | `open` | `closed` |
| unbraind/pm-csv#72 | github_updated_at | `2026-08-20T19:42:05Z` | `2026-10-14T11:34:13Z` |
| unbraind/pm-csv#72 | release | `absent` | `v2026.08.28` |
| unbraind/pm-csv#134 | created_at | `2026-10-18T07:17:46.545Z` | `2026-09-23T08:54:00Z` |
| unbraind/pm-csv#134 | closed_at | `2026-10-18T07:17:46.631Z` | `2026-09-25T07:52:12Z` |
| unbraind/pm-csv#134 | completed_at | `2026-09-25T07:52:12.000Z` | `2026-09-25T07:52:12Z` |
| unbraind/pm-csv#134 | github_state | `absent` | `closed` |
| unbraind/pm-csv#134 | github_updated_at | `absent` | `2026-09-25T07:52:12Z` |
| unbraind/pm-csv#134 | release | `absent` | `v2026.09.26` |
| unbraind/pm-csv#86 | created_at | `2026-10-18T07:17:46.426Z` | `2026-08-27T14:29:39Z` |
| unbraind/pm-csv#86 | closed_at | `2026-10-18T07:17:46.520Z` | `2026-09-01T04:51:41Z` |
| unbraind/pm-csv#86 | completed_at | `2026-09-01T04:51:41.000Z` | `2026-09-01T04:51:41Z` |
| unbraind/pm-csv#86 | github_state | `absent` | `closed` |
| unbraind/pm-csv#86 | github_updated_at | `absent` | `2026-09-01T04:51:41Z` |
| unbraind/pm-csv#86 | release | `absent` | `v2026.09.01` |
| unbraind/pm-brief#135 | created_at | `2026-10-18T08:08:52.780Z` | `2026-10-05T05:06:12Z` |
| unbraind/pm-brief#135 | closed_at | `2026-10-18T08:08:52.862Z` | `2026-10-07T12:19:04Z` |
| unbraind/pm-brief#135 | completed_at | `2026-10-07T12:19:04.000Z` | `2026-10-07T12:19:04Z` |
| unbraind/pm-brief#135 | github_state | `absent` | `closed` |
| unbraind/pm-brief#135 | github_updated_at | `absent` | `2026-10-09T09:17:10Z` |
| unbraind/pm-brief#135 | release | `absent` | `v2026.10.08` |
| unbraind/pm-brief#84 | created_at | `2026-10-18T08:08:52.630Z` | `2026-08-25T04:12:33Z` |
| unbraind/pm-brief#84 | closed_at | `2026-10-18T08:08:52.752Z` | `2026-09-01T04:51:37Z` |
| unbraind/pm-brief#84 | completed_at | `2026-09-01T04:51:37.000Z` | `2026-09-01T04:51:37Z` |
| unbraind/pm-brief#84 | github_state | `absent` | `closed` |
| unbraind/pm-brief#84 | github_updated_at | `absent` | `2026-09-01T04:51:37Z` |
| unbraind/pm-brief#84 | release | `absent` | `v2026.09.01` |
| unbraind/pm-context#136 | created_at | `2026-10-12T12:44:54.969Z` | `2026-10-11T10:07:01Z` |
| unbraind/pm-context#136 | closed_at | `2026-10-13T22:21:15.749Z` | `2026-10-13T17:54:36Z` |
| unbraind/pm-context#136 | completed_at | `2026-10-13T22:21:15.749Z` | `2026-10-13T17:54:36Z` |
| unbraind/pm-context#136 | github_state | `absent` | `closed` |
| unbraind/pm-context#136 | github_updated_at | `absent` | `2026-10-14T12:32:31Z` |
| unbraind/pm-context#136 | release | `absent` | `v2026.10.14` |
| unbraind/pm-context#81 | created_at | `2026-10-16T05:55:33.608Z` | `2026-08-27T14:24:37Z` |
| unbraind/pm-context#81 | closed_at | `2026-10-16T05:55:33.687Z` | `2026-09-01T04:51:39Z` |
| unbraind/pm-context#81 | completed_at | `2026-09-01T04:51:39.000Z` | `2026-09-01T04:51:39Z` |
| unbraind/pm-context#81 | github_state | `absent` | `closed` |
| unbraind/pm-context#81 | github_updated_at | `absent` | `2026-09-01T04:51:39Z` |
| unbraind/pm-context#81 | release | `absent` | `v2026.09.06` |
| unbraind/pm-context#53 | created_at | `2026-10-16T05:55:33.525Z` | `2026-08-07T16:55:49Z` |
| unbraind/pm-context#53 | closed_at | `absent` | `2026-08-08T22:24:46Z` |
| unbraind/pm-context#53 | completed_at | `absent` | `2026-08-08T22:24:46Z` |
| unbraind/pm-context#53 | github_state | `absent` | `closed` |
| unbraind/pm-context#53 | github_updated_at | `absent` | `2026-10-14T11:34:09Z` |
| unbraind/pm-context#53 | release | `absent` | `v2026.08.09` |

| Repo / issue | Unreleased before → main | Momentum cycle days before → main |
| --- | --- | --- |
| unbraind/pm-csv#72 | yes → no | 58.5 → 6.4 |
| unbraind/pm-csv#134 | yes → no | 0 → 2 |
| unbraind/pm-csv#86 | yes → no | 0 → 4.6 |
| unbraind/pm-brief#135 | yes → no | 0 → 2.3 |
| unbraind/pm-brief#84 | yes → no | 0 → 7 |
| unbraind/pm-context#136 | no → no | 1.4 → 2.3 |
| unbraind/pm-context#81 | yes → no | 0 → 4.6 |
| unbraind/pm-context#53 | no → no | 0 → 1.2 |

## Present-window momentum

The same real pm-brief export was also run at 2026-10-18T19:00:00Z with its normal seven-day window over all eight baseline/projected terminal records. This calculation uses certified complete SDK records, retaining native updated_at for legacy terminal records without closed_at; the selected columns in the comparison table are not its input. The baseline counts all 8 as recent closures and has a 0-day median. Main counts only the genuinely recent pm-context issue 136, using its GitHub closure on 2026-10-13T17:54:36Z and a 2.3-day cycle. The seven older imports leave the recent-throughput window. The importer remains dry-run only.

## Caller adoption

https://github.com/unbraind/pm-beads/pull/145, https://github.com/unbraind/pm-brief/pull/154, https://github.com/unbraind/pm-context/pull/147, https://github.com/unbraind/pm-csv/pull/163, https://github.com/unbraind/pm-linear/pull/150, https://github.com/unbraind/pm-slack-standup/pull/127. Publication alone does not update their pins; adoption remains tracked in pm-github-aiok.

## Copied workflow exposure

The same numeric-suffix block exists in the following 25 sibling workflows. pm-ops has the copied workflow too, but its only tracked executable template is prepare-merge-driver.ts; no shared release workflow template was found. This patch changes pm-github only.

- pm-ado
- pm-beads
- pm-brief
- pm-changelog
- pm-context
- pm-csv
- pm-gantt-chart
- pm-graph
- pm-jev
- pm-jira
- pm-linear
- pm-lint
- pm-ops
- pm-presets
- pm-review
- pm-rl
- pm-rust
- pm-slack
- pm-slack-standup
- pm-starter
- pm-swarm
- pm-todos
- pm-ts-starter
- pm-vcs
- pm-web

## Validation

Function-only behavioral revert restores today-only branch selection and same-day eligibility, retaining the tests. The stale-PR and once-per-day regressions fail (2 failures). The current release decision, workflow and publication-auditor suites pass 21/21.

Both npm run release:check and bun run release:check exited 0 at code head 12601d6d325d6e6ad1264c0729ff70bb18c90feb. Each ran 897/897 tests with zero failures, cancellations or skips. Both measured exact 100/100/100/100 over all 15 authored modules, at unchanged thresholds and pins: 10466/10466 lines and statements, 275/275 functions, and 3171/3171 (npm) or 3172/3172 (Bun invocation) branches. All remaining release-check stages passed. Final tracker/documentation receipts are regenerated and checked separately; final-head CI and fresh-clone strict health are reported in the PR.

GitHub documents that GITHUB_TOKEN-created pull-request runs may require approval; existing bounded approval diagnostics remain: https://docs.github.com/en/actions/concepts/security/github_token. Refresh correctness does not certify GitHub approval or npm publisher policy.

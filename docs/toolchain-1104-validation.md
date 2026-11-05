# Toolchain 2026.11.4 validation

The exact development toolchain is `@unbrained/pm-cli@2026.11.4`, `pm-ops@2026.11.4` and `pm-changelog@2026.10.31`. The minimum consumer remains SDK 2026.10.17.

The completed full run tested source commit `8b117274d7d2460cc942d9a888ee7152044f87f4` using Node 26.13.0. It reported **1646 tests: 1644 passed, 0 failed, 0 cancelled, 2 skipped**, in 5277066 ms. All 186 workflow decision rows and the existing 500-sequence model assertions remain intact. Typecheck and lint passed after the full run.

Commands (npm uses a null user config; suites run serially with `nice -n 10`):

```sh
nice -n 10 env NPM_CONFIG_USERCONFIG=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test
nice -n 10 env NPM_CONFIG_USERCONFIG=/dev/null npm run typecheck
nice -n 10 env NPM_CONFIG_USERCONFIG=/dev/null npm run lint
```

The new plain-writer regression covers literal `none`/`null` assignments and milestones across existing updates, fresh creates and closed sources, then requires zero imported/updated items and identical item/history files on a second import. Reverting the production changes makes it fail on `undefined !== "none"`; restoring them passes. Native close clears assignee, so plain source finalization restores an explicit source identity. Link-only owners retain their assignments.

The independent minimum consumer also tests actual CLI JSON input at 2026.10.17. Its development-tool peer graph stays isolated from the minimum host.

## Classification of the previous 21 failures and 50 cancellations

The previous budget-stopped run reported 648 tests: 577 pass, 21 fail and 50 cancelled. This table preserves its 71 failure-list entries, including file-level boundaries used by Node for cancelled workers. Every original file was selected by the completed 72-file rerun, and all 21 original failed assertion titles now have passing results.

| Entries | Classification | Evidence |
| ---: | --- | --- |
| 2 | Same root cause | pm-changelog 2026.10.31 requires an explicitly requested empty tagged release to opt into `--include-empty`; both placement assertions pass. |
| 18 | Same root cause | Historical-only workflow fixtures pair `--no-pending-release` with `--all-release-tags`; all eighteen assertions pass. |
| 1 | Fixed | GH-1614 plain writer uses JSON document input for literal identities, and finalization restores the source assignee after native close; repeat-import passes. |
| 48 | Fixed | Deliberate budget cancellations cleared by the completed full rerun. |
| 2 | Upstream pm-cli#1656 | Both files completed; each contains one exact SDK-bound skipped case, and every other case passes. |

None of the old cancellations is classified as a host-load timeout: they came from an explicit budget SIGINT. No test failed or cancelled for a timeout in the completed rerun. For the two upstream-labelled file entries, the original cancellation cause remains the budget stop; the current upstream label applies only to the one named quarantined body in each file.

| # | Original location | Original case or file boundary | Classification | Rerun result |
| ---: | --- | --- | --- | --- |
| 1 | `test/changelog-placement.test.ts:59:5` | closeout: post-release delivery stays Unreleased with a real release tag | same root cause | Pass; existing assertions retained |
| 2 | `test/changelog-placement.test.ts:59:5` | sync: post-release delivery stays Unreleased with a real release tag | same root cause | Pass; existing assertions retained |
| 3 | `test/closeout-workflow.test.ts:372:1` | malicious tracker acceptance criteria fails the final privacy gate before any remote write | same root cause | Pass; existing assertions retained |
| 4 | `test/closeout-workflow.test.ts:383:1` | zero closes discards caller drift and creates no remote branch or PR | same root cause | Pass; existing assertions retained |
| 5 | `test/closeout-workflow.test.ts:393:1` | permission-limited read token fails closed with a clear diagnostic | same root cause | Pass; existing assertions retained |
| 6 | `test/closeout-workflow.test.ts:480:1` | zero closes refuses caller-only tracker drift as an empty closeout PR | same root cause | Pass; existing assertions retained |
| 7 | `test/closeout-workflow.test.ts:491:1` | behavioural revert: removing only the staged privacy scan publishes malicious tracker content | same root cause | Pass; existing assertions retained |
| 8 | `test/closeout-workflow.test.ts:505:1` | behavioural revert: removing only the no-op guard opens a PR with zero closes | same root cause | Pass; existing assertions retained |
| 9 | `test/closeout-workflow.test.ts:549:3` | unavailable evidence is scoped to local tracker refusals: unlinked | same root cause | Pass; existing assertions retained |
| 10 | `test/closeout-workflow.test.ts:549:3` | unavailable evidence is scoped to local tracker refusals: foreign | same root cause | Pass; existing assertions retained |
| 11 | `test/closeout-workflow.test.ts:549:3` | unavailable evidence is scoped to local tracker refusals: terminal | same root cause | Pass; existing assertions retained |
| 12 | `test/closeout-workflow.test.ts:549:3` | unavailable evidence is scoped to local tracker refusals: local | same root cause | Pass; existing assertions retained |
| 13 | `test/closeout-workflow.test.ts:549:3` | unavailable evidence is scoped to local tracker refusals: incomplete | same root cause | Pass; existing assertions retained |
| 14 | `test/closeout-workflow.test.ts:549:3` | unavailable evidence is scoped to local tracker refusals: unlinked-incomplete | same root cause | Pass; existing assertions retained |
| 15 | `test/closeout-workflow.test.ts:577:3` | required-check metadata boundary undeclared uses the real workflow and command | same root cause | Pass; existing assertions retained |
| 16 | `test/closeout-workflow.test.ts:577:3` | required-check metadata boundary blank uses the real workflow and command | same root cause | Pass; existing assertions retained |
| 17 | `test/closeout-workflow.test.ts:577:3` | required-check metadata boundary missing uses the real workflow and command | same root cause | Pass; existing assertions retained |
| 18 | `test/closeout-workflow.test.ts:577:3` | required-check metadata boundary neutral uses the real workflow and command | same root cause | Pass; existing assertions retained |
| 19 | `test/closeout-workflow.test.ts:577:3` | required-check metadata boundary skipped uses the real workflow and command | same root cause | Pass; existing assertions retained |
| 20 | `test/closeout-workflow.test.ts:577:3` | required-check metadata boundary pending uses the real workflow and command | same root cause | Pass; existing assertions retained |
| 21 | `test/closeout-workflow.test.ts:1:1` | test/closeout-workflow.test.ts | fixed | File completed; prior budget cancellation cleared |
| 22 | `test/daily-sync-idempotency.test.ts:33:37` | random issue sets imported twice produce an empty second diff (plain) | fixed | Pass; existing assertions retained |
| 23 | `test/discussion-model.test.ts:1:1` | test/discussion-model.test.ts | fixed | File completed; prior budget cancellation cleared |
| 24 | `test/discussions.test.ts:1:1` | test/discussions.test.ts | fixed | File completed; prior budget cancellation cleared |
| 25 | `test/docstring-gate.test.ts:1:1` | test/docstring-gate.test.ts | fixed | File completed; prior budget cancellation cleared |
| 26 | `test/dryrun-preview.test.ts:1:1` | test/dryrun-preview.test.ts | fixed | File completed; prior budget cancellation cleared |
| 27 | `test/duplication-gate.test.ts:1:1` | test/duplication-gate.test.ts | fixed | File completed; prior budget cancellation cleared |
| 28 | `test/gate-inputs.test.ts:1:1` | test/gate-inputs.test.ts | fixed | File completed; prior budget cancellation cleared |
| 29 | `test/gate-paths.test.ts:1:1` | test/gate-paths.test.ts | fixed | File completed; prior budget cancellation cleared |
| 30 | `test/gate-public-forms.test.ts:1:1` | test/gate-public-forms.test.ts | fixed | File completed; prior budget cancellation cleared |
| 31 | `test/gate.test.ts:1:1` | test/gate.test.ts | fixed | File completed; prior budget cancellation cleared |
| 32 | `test/generate-changelog.test.ts:1:1` | test/generate-changelog.test.ts | fixed | File completed; prior budget cancellation cleared |
| 33 | `test/handler-failures.test.ts:1:1` | test/handler-failures.test.ts | fixed | File completed; prior budget cancellation cleared |
| 34 | `test/http-boundary.test.ts:1:1` | test/http-boundary.test.ts | fixed | File completed; prior budget cancellation cleared |
| 35 | `test/identity.test.ts:1:1` | test/identity.test.ts | fixed | File completed; prior budget cancellation cleared |
| 36 | `test/import-errors.test.ts:1:1` | test/import-errors.test.ts | fixed | File completed; prior budget cancellation cleared |
| 37 | `test/import-fidelity.test.ts:1:1` | test/import-fidelity.test.ts | upstream pm-cli#1656 | File completed; one exact SDK-bound skip, other cases pass |
| 38 | `test/import-gate.test.ts:1:1` | test/import-gate.test.ts | fixed | File completed; prior budget cancellation cleared |
| 39 | `test/import-lock.test.ts:1:1` | test/import-lock.test.ts | fixed | File completed; prior budget cancellation cleared |
| 40 | `test/import-projection.test.ts:1:1` | test/import-projection.test.ts | fixed | File completed; prior budget cancellation cleared |
| 41 | `test/import-regex-sampling.test.ts:1:1` | test/import-regex-sampling.test.ts | fixed | File completed; prior budget cancellation cleared |
| 42 | `test/import-regex.test.ts:1:1` | test/import-regex.test.ts | fixed | File completed; prior budget cancellation cleared |
| 43 | `test/import-selection.test.ts:1:1` | test/import-selection.test.ts | fixed | File completed; prior budget cancellation cleared |
| 44 | `test/issue-forms.test.ts:1:1` | test/issue-forms.test.ts | fixed | File completed; prior budget cancellation cleared |
| 45 | `test/label-import-model.test.ts:1:1` | test/label-import-model.test.ts | fixed | File completed; prior budget cancellation cleared |
| 46 | `test/labels.test.ts:1:1` | test/labels.test.ts | fixed | File completed; prior budget cancellation cleared |
| 47 | `test/link-deps.test.ts:1:1` | test/link-deps.test.ts | fixed | File completed; prior budget cancellation cleared |
| 48 | `test/lint-policy.test.ts:1:1` | test/lint-policy.test.ts | fixed | File completed; prior budget cancellation cleared |
| 49 | `test/minimum-sdk-consumer.test.ts:1:1` | test/minimum-sdk-consumer.test.ts | fixed | File completed; prior budget cancellation cleared |
| 50 | `test/own-property.test.ts:1:1` | test/own-property.test.ts | fixed | File completed; prior budget cancellation cleared |
| 51 | `test/package-metadata.test.ts:1:1` | test/package-metadata.test.ts | fixed | File completed; prior budget cancellation cleared |
| 52 | `test/prepare-merge-driver.test.ts:1:1` | test/prepare-merge-driver.test.ts | fixed | File completed; prior budget cancellation cleared |
| 53 | `test/privacy-gate.test.ts:1:1` | test/privacy-gate.test.ts | fixed | File completed; prior budget cancellation cleared |
| 54 | `test/project-sync.test.ts:1:1` | test/project-sync.test.ts | fixed | File completed; prior budget cancellation cleared |
| 55 | `test/projects.test.ts:1:1` | test/projects.test.ts | fixed | File completed; prior budget cancellation cleared |
| 56 | `test/prove-gate-public-forms.test.ts:1:1` | test/prove-gate-public-forms.test.ts | fixed | File completed; prior budget cancellation cleared |
| 57 | `test/refresh.test.ts:1:1` | test/refresh.test.ts | upstream pm-cli#1656 | File completed; one exact SDK-bound skip, other cases pass |
| 58 | `test/release-approval.test.ts:1:1` | test/release-approval.test.ts | fixed | File completed; prior budget cancellation cleared |
| 59 | `test/release-merge-policy.test.ts:1:1` | test/release-merge-policy.test.ts | fixed | File completed; prior budget cancellation cleared |
| 60 | `test/release-workflow.test.ts:1:1` | test/release-workflow.test.ts | fixed | File completed; prior budget cancellation cleared |
| 61 | `test/repeat-import-noop.test.ts:1:1` | test/repeat-import-noop.test.ts | fixed | File completed; prior budget cancellation cleared |
| 62 | `test/review-round1.test.ts:1:1` | test/review-round1.test.ts | fixed | File completed; prior budget cancellation cleared |
| 63 | `test/scheduled-refusals.test.ts:1:1` | test/scheduled-refusals.test.ts | fixed | File completed; prior budget cancellation cleared |
| 64 | `test/sdk-adoption.test.ts:1:1` | test/sdk-adoption.test.ts | fixed | File completed; prior budget cancellation cleared |
| 65 | `test/self-versioned-workflows.test.ts:1:1` | test/self-versioned-workflows.test.ts | fixed | File completed; prior budget cancellation cleared |
| 66 | `test/smoke.test.ts:1:1` | test/smoke.test.ts | fixed | File completed; prior budget cancellation cleared |
| 67 | `test/typed-sentinel-normalization.test.ts:1:1` | test/typed-sentinel-normalization.test.ts | fixed | File completed; prior budget cancellation cleared |
| 68 | `test/verify-release-publish-attestation.test.ts:1:1` | test/verify-release-publish-attestation.test.ts | fixed | File completed; prior budget cancellation cleared |
| 69 | `test/webhooks.test.ts:1:1` | test/webhooks.test.ts | fixed | File completed; prior budget cancellation cleared |
| 70 | `test/workflow-rule-names.test.ts:1:1` | test/workflow-rule-names.test.ts | fixed | File completed; prior budget cancellation cleared |
| 71 | `test/workspace-resolution.test.ts:1:1` | test/workspace-resolution.test.ts | fixed | File completed; prior budget cancellation cleared |

## Upstream

Only these two test bodies are skipped, after a fresh SDK 2026.11.4 run reproduced one passing and two failing cases:

- `real SDK atomic compensation restores an imported source lifecycle and removes new items after finalization` in `test/import-fidelity.test.ts`.
- `terminal failures remove replay plans after real SDK compensation (true)` in `test/refresh.test.ts`.

Both use the existing Node `skip` option with a `pm-cli#1656` reason, conditional on the installed SDK being exactly 2026.11.4. Another SDK version automatically re-enables them. Every compensation assertion remains in its original body; fresh-refresh compensation still executes and passes.

[pm-cli#1656](https://github.com/unbraind/pm-cli/issues/1656) must provide supported transaction ownership, recovery and compensation for source lifecycle finalization. GH-1591 in SDK 2026.10.26 correctly refuses the unowned finalizer event. SDK 2026.11.4 expected-revision guards (GH-1576) do not add a durable raw-document transaction step. The standalone public-SDK shape and expected versus actual state are in [atomic-finalization-sdk.md](atomic-finalization-sdk.md). No forced restoration, forged markers, observer reordering or post-commit finalization is used. A green suite with these explicit skips does not certify the blocked rollback guarantees.

Issues #197 and #199 remain open. PM evidence belongs to `pm-github-quay` and `pm-github-gevp`.

## Coverage gate

`nice -n 10 env NPM_CONFIG_USERCONFIG=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run coverage` completed successfully after the green full suite, typecheck and lint. Its test phase again reports 1646 tests: 1644 passed, 0 failed, 0 cancelled and the same 2 explicit upstream skips (7936886 ms). The existing native incremental merge retained all 3883 raw receipts; no pre-filter or source exemption was added.

| Dimension | Covered / total | Percent |
| --- | ---: | ---: |
| Lines | 14180 / 14180 | 100% |
| Statements | 14180 / 14180 | 100% |
| Functions | 445 / 445 | 100% |
| Branches | 5277 / 5277 | 100% |

The gate validates all 29 authored modules, including operational scripts. Every dimension has zero skipped source entries. The two test skips remain an explicit behavioral gap for atomic finalization; complete source coverage does not certify those rollback guarantees.

The coverage gate alone took about three hours, including its 132-minute test phase and lengthy native merge, so the overall follow-up exceeded the approximate time budget.

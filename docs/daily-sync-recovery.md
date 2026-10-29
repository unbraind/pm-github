# Daily gated sync recovery

The 2026-10-29 audit read the latest `pm-github-sync.yml` run and each job's logs through the GitHub API. Eleven repositories failed repeat-import verification: pm-beads, pm-brief, pm-gantt-chart, pm-hypothesis, pm-linear, pm-presets, pm-review, pm-slack, pm-slack-standup, pm-starter and pm-ts-starter. Sampled caller logs installed pm-github 2026.10.19. pm-csv failed preview because issue #197 has multiple existing owners; that conflict must remain fail-closed until the owner repairs provenance.

The importer compares both stored and desired fields using the shared SDK-aware type, status, assignment, tag, body and timestamp normalization. It omits each unchanged item from fresh atomic batches and from plain updates. Pending transactions retain their complete plan for recovery. Native comment synchronization still runs when item content is unchanged. Gated dry runs now scan the same rendered plan before returning, including in a plain non-git tracker.

The SDK independently resets `closed_at` and `updated_at` on an identical forced closed-state update, through both `update` and `commitItemMutations`. Standalone synthetic non-git reproductions confirmed this on both the pinned SDK 2026.10.25 and current 2026.10.28. The reproduction is recorded in [pm-cli issue #1628](https://github.com/unbraind/pm-cli/issues/1628). The package avoids invoking those mutations for normalized no-ops.

## Source-content triage

No matched values are retained here. No source issue or comment was edited. These are confirmed policy refusals; some are deliberately synthetic examples rather than personal information. The orchestrator owns their source-content remediation.

| Repository | Issue | Field | Rule | Classification |
| --- | --- | --- | --- | --- |
| pm-changelog | #1 | body | absolute-host-path | Absolute paths in command examples |
| pm-changelog | #226 | body | absolute-host-path | Absolute path in an error report |
| pm-ops | #44 | body | absolute-host-path | Absolute paths in reproduction commands |
| pm-swarm | #30 | body | absolute-host-path | Explicit absolute-path scanner examples |
| pm-vcs | #154 | body | absolute-host-path | Absolute paths in an error report |
| pm-context | #154 | body | email-address | Synthetic contact address in a fixture |
| pm-rust | #86 | body | windows-host-path | Windows path in a CI error report |

False positives: pm-web #218 body contains a JavaScript regex; main already distinguished its immediately invoked form. This change also admits stored bare-root regex expressions while continuing to refuse quoted strings and slash-separated host paths. pm-jev #62 body and comment #6473012443 contain an SSH URL's `git` service identity. The email rule now admits that URL form only when a path follows the service host; personal contact identities and bare contact addresses remain refusals. API routes, repository-relative paths, ordinary URL paths and noreply identities are in the must-allow corpus.

## Setup bookkeeping and alerts

Main already isolates workflow-owned attributes and the extension registry before scope checks, and restores the caller's bytes around strict health checks. The installation step now also restores those artifacts if installation fails. Caller edits outside the bounded setup window still refuse publication. Settings and workspace history retain the existing setup handling; successful audit events are not rewritten by this change.

The status job uses an exact stable issue title, updates its body on repeated failure, closes the issue after the next successful sync, and reopens that same issue after a later failure. Failed issue-list reads never establish absence, so they cannot create duplicates. Its body contains only a fixed failing-step name, the current-attempt run URL and enumerated rule names. It never downloads job logs or copies diagnostic content. A separate serialized job follows the fleet release-failure pattern and executes no caller code.

The caller must grant `issues: write` for alert creation, updates and closure. Existing callers granting `issues: read` can still sync, but receive a warning when an alert write is refused. A Dependabot pin change alone cannot raise that grant. The [GitHub reusable-workflow permission contract](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#supported-keywords-for-jobs-that-call-a-reusable-workflow) prohibits permission elevation. The caller template and README show the required grant; editing fleet callers is outside this change's authorization.

Regression commands:

```sh
node --test --test-concurrency=2 test/daily-sync-idempotency.test.ts test/daily-sync-privacy.test.ts test/daily-sync-alert.test.ts
node --test --test-concurrency=2 --test-name-pattern='setup artifacts never|failed extension installation|strict health restores|preexisting setup' test/import-gate.test.ts
npm run release:check
bun run release:check
```

Behavioral reversions run only in disposable copies. The original checkout and its append-only tracker history remain intact.

## Real-data validation

Read-only GitHub API snapshots on 2026-10-29 supplied complete issue/comment/timeline sets and tracker archives for each repository below. Gated dry runs used non-git scratch tracker copies. Both versions made zero durable source writes. Private scratch applies then measured the second import's item/history diff; no branch or source tracker was changed.

| Repository | Issues | Initial create / update plan | 2026.10.19 second diff | Candidate second diff |
| --- | ---: | ---: | ---: | ---: |
| pm-gantt-chart | 10 | 3 / 7 | 18 durable files | 0 |
| pm-web | 9 | 6 / 3 | 12 durable files | 0 |
| pm-rl | 1 | 1 / 0 | 0 | 0 |

The candidate's gated previews passed for all three. The released dry run did not perform the new in-memory plan privacy scan; pm-web's historical actual gated refusal is established by the failed job logs, rather than its dry-run result. The pm-rl import comparison establishes data-path stability; the workflow tests separately prove tracked install-bookkeeping restoration and exact publication scope.

## Audited runs

| Repository | Latest run | Failed step |
| --- | --- | --- |
| pm-beads | [run](https://github.com/unbraind/pm-beads/actions/runs/40842674747) | Verify repeat import is a no-op |
| pm-brief | [run](https://github.com/unbraind/pm-brief/actions/runs/40855163943) | Verify repeat import is a no-op |
| pm-gantt-chart | [run](https://github.com/unbraind/pm-gantt-chart/actions/runs/40833766059) | Verify repeat import is a no-op |
| pm-hypothesis | [run](https://github.com/unbraind/pm-hypothesis/actions/runs/40854614297) | Verify repeat import is a no-op |
| pm-linear | [run](https://github.com/unbraind/pm-linear/actions/runs/40853721208) | Verify repeat import is a no-op |
| pm-presets | [run](https://github.com/unbraind/pm-presets/actions/runs/40860888244) | Verify repeat import is a no-op |
| pm-review | [run](https://github.com/unbraind/pm-review/actions/runs/40833732293) | Verify repeat import is a no-op |
| pm-slack | [run](https://github.com/unbraind/pm-slack/actions/runs/40833190647) | Verify repeat import is a no-op |
| pm-slack-standup | [run](https://github.com/unbraind/pm-slack-standup/actions/runs/40842912682) | Verify repeat import is a no-op |
| pm-starter | [run](https://github.com/unbraind/pm-starter/actions/runs/40842789601) | Verify repeat import is a no-op |
| pm-ts-starter | [run](https://github.com/unbraind/pm-ts-starter/actions/runs/40860964301) | Verify repeat import is a no-op |
| pm-csv | [run](https://github.com/unbraind/pm-csv/actions/runs/40843571121) | Preview GitHub to pm plan |
| pm-changelog | [run](https://github.com/unbraind/pm-changelog/actions/runs/40861447409) | Gated GitHub to pm import |
| pm-ops | [run](https://github.com/unbraind/pm-ops/actions/runs/40833936295) | Gated GitHub to pm import |
| pm-swarm | [run](https://github.com/unbraind/pm-swarm/actions/runs/40854616283) | Gated GitHub to pm import |
| pm-vcs | [run](https://github.com/unbraind/pm-vcs/actions/runs/40833106082) | Gated GitHub to pm import |
| pm-web | [run](https://github.com/unbraind/pm-web/actions/runs/40832784926) | Gated GitHub to pm import |
| pm-context | [run](https://github.com/unbraind/pm-context/actions/runs/40833903750) | Gated GitHub to pm import |
| pm-jev | [run](https://github.com/unbraind/pm-jev/actions/runs/40855060531) | Gated GitHub to pm import |
| pm-rust | [run](https://github.com/unbraind/pm-rust/actions/runs/40833731516) | Gated GitHub to pm import |
| pm-rl | [run](https://github.com/unbraind/pm-rl/actions/runs/40833288273) | Gate tracker and regenerated changelog |

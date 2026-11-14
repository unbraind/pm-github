# Caller CI handoff migration

Sync and closeout must release their runner before caller CI finishes. The
measured historical fleet cost was about 85 runner-minutes per run; one sync
spent 44 seconds doing useful work and then 120 minutes polling caller CI.
The #228/#229 implementation already replaced the completion loop with protected
native auto-merge. This change completes registration receipts and caller outputs.

Bump the reusable workflow pin through the existing #238 fleet sweep. No caller
input, secret, permission, trigger or schedule change is required by this change.
The optional App and existing GITHUB_TOKEN approval paths continue to work.

After publishing the owned PR, dispatch all selected caller workflows for its
head. Capture the dispatch start before dispatching. Request
`gh pr merge --auto --squash --match-head-commit` only through the existing
verified repository, required-check and strict-freshness policy. Closeout review
holds still forbid arming and keep the always-run revocation safeguard.

A separate step then discovers the dispatched runs, matching workflow, branch,
head SHA, `workflow_dispatch` and creation at or after dispatch start. It accepts
any registered run regardless of status or conclusion. All selected workflows
share 60 seconds, including API calls, at most 12 rounds and at most five seconds
between rounds; each call is capped by the remaining budget and ten seconds.
Already discovered workflows are removed from subsequent discovery rounds.
A missing registration, denied lookup or CLI timeout reports `timed_out` and
exits successfully, retaining any URLs already found. It never disables an
armed auto-merge request. Genuine dispatch failures still fail before arming.

The job summary includes the PR URL, registered run URLs and the snapshot of
runs already parked as `action_required`. Additive reusable outputs are:

| Output | Format |
| --- | --- |
| `pr-url` | Owned bot PR URL |
| `ci-run-urls` | JSON array of registered caller run URLs |
| `parked-run-urls` | JSON array from the single parked-run lookup |
| `ci-confirmation` | `confirmed`, `timed_out`, or `disabled` |

No published PR means the receipt step is skipped and outputs are empty.
Explicitly disabled CI reports the PR with empty arrays and `disabled`.
Confirmation is evidence of registration, never proof that CI passed. Runs
parked after the snapshot are handled by the existing hourly approval sweep
or a maintainer; no runner remains assigned to observe them. Required PR checks
control native auto-merge. Missing/loose/unreadable protection or unavailable
auto-merge uses the next scheduled rebuild and retry. An advanced base must be
rebuilt by that scheduled run, or validated by GitHub's configured merge queue.
There is no later in-job step that depends on caller CI completion.

The expected ordinary sync/closeout duration remains under two minutes when
the measured 44-second workload is representative: registration usually appears
on the first lookup, and its additional wait budget is at most 60 seconds.
This is a budget and expectation, not a new live fleet timing measurement.
Installation, import size and API latency can increase total job duration.

Gated import, idempotency, privacy/redaction, sync holds and #230 ownership
selection are unchanged. Other reusable workflows were searched: Dependabot
uses bounded API retries and native auto-merge, with no completion wait. The
separate non-reusable release workflow has a durable publication continuation
requirement tracked by `pm-github-sgyr`; its release-PR wait is outside this
reusable-workflow change.

`test/ci-handoff-workflow.test.ts` executes the actual receipt shell with a real
Git head and synthetic GitHub responses. It covers immediate/queued, delayed,
absent, partial, denied and timed-out registration; summaries and workflow/job
output wiring; and disabled dispatch. A contract scans every reusable step to
reject completion waits while permitting only the bounded appearance loop.
Existing workflow tests keep the protected merge, hold, ownership and revocation
checks. Restoring the historical completion-wait shell must fail that contract.

Controlled-clock cases advance elapsed time across multiple workflow lookups to
exhaust the shared deadline, retain a discovered URL and prevent the next lookup
from starting. Stuck-command cases use real GNU `timeout` to kill a ten-second
lookup, then verify successful informational reporting and retained partial URLs.
Removing the deadline admission guard or shortening the real timeout independently
fails these behavioral regressions in disposable copies.

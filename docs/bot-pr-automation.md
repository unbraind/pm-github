# Automated proposal landing

Both reusable workflows dispatch `ci.yml codeql.yml` by default, filtered to
existing files declaring workflow_dispatch. Explicit `ci-workflows` replaces
that list. Both CI and CodeQL must produce the same required contexts when
manually dispatched as for a pull request. No branch-protection API access is
needed or assumed for selecting workflows.

## Eligible native PR checks and one-time App setup

GitHub excludes job checks triggered by workflow_dispatch from PR checks and
required branch-rule evaluation, even when they pass on the head SHA. This is
why REST check-runs can show green CI while `gh pr checks` omits it. Dispatching
CodeQL alone cannot fix unattended merging. The documented supported path is
publication with a GitHub App installation token, which starts eligible native
pull_request runs without the GITHUB_TOKEN approval prompt.

Install an automation App on the selected callers with Contents, Pull requests
and Actions write, plus Checks and Commit statuses read. Set its client ID as
`PM_GITHUB_APP_CLIENT_ID` and private key as `PM_GITHUB_APP_PRIVATE_KEY` in each
caller's Actions variable/secret settings. Map them once in each reusable caller:

```yaml
    with:
      automation-app-client-id: ${{ vars.PM_GITHUB_APP_CLIENT_ID }}
    secrets:
      automation_app_private_key: ${{ secrets.PM_GITHUB_APP_PRIVATE_KEY }}
```

Existing `with` fields stay in that mapping. This credential boundary makes the
one-time caller opt-in unavoidable: a reusable workflow cannot read its own
provider repository's private secrets while running in a caller. Empty inputs
retain GITHUB_TOKEN and emit a notice; partial credentials or failed token
creation stop before publication. Configuring the App is the step that enables
unattended eligible PR runs; manual check dispatch remains extra head validation.

The official create-github-app-token action is pinned by immutable commit in
both workflows, and Dependabot maintains that pin. Its token is restricted to the current
caller and the listed permissions, and is automatically revoked at job end.
The private key is supplied only to that action after local gates and caller
scripts finish. App-enabled monitoring has forty polls and a forty-minute
absolute deadline recorded immediately after token creation, so publication
time also counts toward the budget. This stays inside the one-hour token lifetime. Legacy
GITHUB_TOKEN monitoring retains the two-hour bound and cannot guarantee landing
without approval. Required checks and conversations stay enforced by GitHub.

Sources: [GitHub token event behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[required-check eligibility](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
and [official App-token action](https://github.com/actions/create-github-app-token).

## Caller audit (2026-10-17)

The following 24 callers all have `.github/workflows/codeql.yml` with a
pull_request trigger and no workflow_dispatch trigger:

`pm-ado`, `pm-beads`, `pm-brief`, `pm-changelog`, `pm-context`, `pm-csv`, `pm-gantt-chart`, `pm-graph`, `pm-jev`, `pm-jira`, `pm-linear`, `pm-lint`, `pm-ops`, `pm-presets`, `pm-review`, `pm-rl`, `pm-slack`, `pm-slack-standup`, `pm-starter`, `pm-swarm`, `pm-todos`, `pm-ts-starter`, `pm-vcs`, `pm-web`.

All 24 callers currently allow repository auto-merge and squash merging.

Every listed caller needs this one-line addition under `on:` in codeql.yml:

```yaml
  workflow_dispatch:
```

All 24 closeout callers also explicitly set `ci-workflows: "ci.yml"`. Remove
that line to inherit the new default, or change its value to `"ci.yml codeql.yml"`.
Preserving explicit overrides makes this a one-time caller configuration change;
a reusable workflow cannot alter its caller's event triggers. No caller was
modified or dispatched during this audit. Missing-trigger warnings name the
workflow, but cannot satisfy its required checks.

The required `codeql` context currently blocks pm-jev, pm-lint, pm-review and
pm-swarm. Other callers do not currently require CodeQL; enabling dispatch still
ensures their security analysis runs on automation heads. Additional required
jobs (including Windows acceptance) are in ci.yml and run on dispatch.

Observed closeout PRs pm-ado#32, pm-jev#23, pm-lint#11 and pm-review#18 have
successful dispatched test (22)/test (26) checks on their head SHA while their
pull_request CI/CodeQL runs are action_required. None has auto-merge enabled.
The named sync PRs also have successful dispatched head checks; several have
base advances. The request names eleven PRs in total, all inspected read-only. Those REST results establish manual head execution; they do not satisfy PR
branch rules. Eligible native PR runs require the App setup described above.

## Existing closeout evidence policy

Current main also fails closed when branch-protection metadata cannot be read
and `required-checks` is empty. The audited closeout callers have no such input,
so adopting this release also needs the one-time newline-separated required
context declaration. This policy comes from PR #140 and is preserved here;
workflow selection is not proof of which checks branch protection requires.
The audit read protection with the operator credential, not GITHUB_TOKEN.

| Caller | Required contexts at audit time |
| --- | --- |
| pm-ado | `test (22)`, `test (26)` |
| pm-beads | `test (22)`, `test (26)` |
| pm-brief | `audit-windows`, `test (22)`, `test (26)` |
| pm-changelog | `test (22)`, `test (26)` |
| pm-context | `test (22)`, `test (26)` |
| pm-csv | `test (22)`, `test (26)` |
| pm-gantt-chart | `test (26)`, `test (22.18.0)` |
| pm-graph | `test (22)`, `test (26)`, `windows-prepare-lifecycle` |
| pm-jev | `test (22)`, `test (26)`, `codeql` |
| pm-jira | `test (22)`, `test (26)` |
| pm-linear | `test (22)`, `test (26)` |
| pm-lint | `test (22)`, `test (26)`, `codeql` |
| pm-ops | `test (22)`, `test (26)` |
| pm-presets | `test (22)`, `test (26)`, `windows-prepare-lifecycle` |
| pm-review | `test (22)`, `test (26)`, `codeql` |
| pm-rl | `test (22)`, `test (26)` |
| pm-slack | `test (22)`, `test (26)` |
| pm-slack-standup | `test (26)`, `test (22.18.0)` |
| pm-starter | `test (22)`, `test (26)` |
| pm-swarm | `test (22)`, `test (26)`, `codeql` |
| pm-todos | `test (26)`, `test (22.18.0)` |
| pm-ts-starter | `test (22)`, `test (26)` |
| pm-vcs | `test (22)`, `test (26)`, `windows-acceptance-launcher (22)`, `windows-acceptance-launcher (26)` |
| pm-web | `test (22)`, `test (26)` |

The declaration must be maintained when protection changes. Reusable workflow
code cannot safely infer unknown required context names from workflow filenames.

## Freshness and protected merging

The proposal is rebuilt on the default branch each daily run. After publication,
a bounded monitor handles a base advance (including the daily release) by
checking compare-API ancestry even when the merge label is BLOCKED or UNKNOWN,
requesting update-branch with expected_head_sha, then redispatching every
selected workflow for the new head. It requests squash auto-merge with a matching
head SHA; GitHub still enforces required checks and conversation resolution.
Disallowed auto-merge is a notice, failed check dispatch is an error. No bypass
or thread resolution is attempted. App mode stops within forty minutes and legacy mode within two hours. A base
change outside that window is handled by the next daily run, so permanent freshness is not claimed.

The existing daily schedules and per-kind concurrency groups are retained. No
push trigger is added: concurrency permits one active run per kind, not one
run per day; manually dispatched runs remain explicit operator requests.
Historical import/changelog review findings are separately owned by PR #142.
The unresolved pm-ado#32 review additionally concerns October closeout delivery
being attributed to its old September package release; follow-up pm-github-lfcf
tracks that distinct caller changelog/release-policy finding. Successful checks
and enabled auto-merge do not resolve that conversation.

## Regression evidence

`test/bot-pr-workflow.test.ts` executes each workflow's actual maintenance shell
against a real local Git remote. It advances the base with a release commit,
performs a real branch merge, and verifies that both workflows are dispatched
again on the changed head. Receipt-only GitHub commands keep caller repositories
untouched. Cases also cover explicit overrides, no dispatchable workflow,
CodeQL without a dispatch trigger, dispatch-denial diagnostics, App credential
pairing, token scope/bindings, token-lifetime bounds, disallowed auto-merge and a blocked PR reaching
the monitor bound. Existing end-to-end import and closeout suites retain the
privacy, scope, ownership, lease and no-op boundaries.

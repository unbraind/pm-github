# Automated proposal landing

Both reusable workflows dispatch `ci.yml codeql.yml` by default, filtered to
existing files declaring workflow_dispatch. Explicit `ci-workflows` replaces
that list. Both CI and CodeQL must produce the same required contexts when
manually dispatched as for a pull request. No branch-protection API access is
needed or assumed for selecting workflows.

## Eligible native PR checks and optional App setup

GitHub excludes job checks triggered by workflow_dispatch from PR checks and
required branch-rule evaluation, even when they pass on the head SHA. This is
why REST check-runs can show green CI while `gh pr checks` omits it. Dispatching
CodeQL alone cannot fix unattended merging. Two supported paths are
maintainer approval of the parked native pull_request runs, or optional
publication with a GitHub App installation token to start those runs without
the GITHUB_TOKEN approval prompt.

### No-App path: approve the native PR runs

Leave the App inputs empty to keep GITHUB_TOKEN publication. After reviewing
the bot PR and its workflow changes, a maintainer can select **Approve workflows
to run** in the PR, or approve each parked native run with an operator credential:

```sh
gh run list -R OWNER/REPO --commit HEAD_SHA --event pull_request \
  --status action_required --json databaseId,url
gh api --method POST repos/OWNER/REPO/actions/runs/RUN_ID/approve
```

Select each RUN_ID from that exact-head list and repeat the POST for each
approval-required run. The orchestrator verified that this endpoint unparks
bot-PR action_required runs without an App. GitHub documents write access for
the PR approval UI and Actions write permission for fine-grained tokens on the
[approval endpoint](https://docs.github.com/en/rest/actions/workflow-runs#approve-a-workflow-run-for-a-fork-pull-request).
Use the maintainer's authorized credential; this reusable workflow does not
approve itself. The workflow arms native auto-merge, which waits for the approved PR checks
to pass and required conversations to be resolved. A maintainer can also merge
through the protected PR using an authorized credential. A new bot head may require
approval again. Manually dispatched checks remain extra head validation.

### App path: unattended native PR runs

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
scripts finish. After dispatch, the workflow arms `gh pr merge --auto --squash`
on the expected head SHA and exits: it performs no in-job wait for caller CI,
which takes runners from the same account pool, so polling could only lengthen
the queue it waits on. GITHUB_TOKEN mode also arms auto-merge;
a maintainer must approve eligible native PR runs first. Its typed
`github_token_requires_approval` notice explains approval and App configuration.
A GITHUB_TOKEN merge still does not trigger default-branch push workflows. A base
advance after publication, or an unavailable auto-merge, waits for the next
scheduled run. Required checks and conversations stay enforced by GitHub.

Sources: [GitHub token event behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
[required-check eligibility](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
[GITHUB_TOKEN PR approval behavior](https://docs.github.com/en/actions/concepts/security/github_token),
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
branch rules. Eligible native PR runs can be unparked through the no-App approval path
above; App setup removes that approval step for unattended operation.

## Existing closeout evidence policy

Current main also fails closed when branch-protection metadata cannot be read
and `required-checks` is empty. Classic required checks are read from the branch
summary when the administration-only endpoint refuses `GITHUB_TOKEN`, so the
audited closeout callers need no declaration. This policy comes from PR #140 and is preserved here;
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

The proposal is rebuilt on the default branch each daily run. After publication the
dispatch step arms squash auto-merge (in either token mode) with a matching head SHA and
exits; GitHub still enforces required checks and conversation resolution. No
runner is held while caller CI queues: it takes runners from the same account
pool, so an in-job wait could only lengthen the queue it waits on. Disallowed
auto-merge is a notice naming the reason; failed check dispatch is an error.
The repository auto-merge setting and protected base are checked once before
calling `gh`, which can otherwise merge immediately even on a protected branch
with no required status checks. The base must require at least one named PR CI
status check, from classic protection (`required_status_checks.contexts` or
`checks`) or an active applicable ruleset. Both the branch metadata and the
paginated branch-rules API are read before arming; reviews or conversations alone
are insufficient. Unreadable APIs (including permission errors, 404s and rate
limits), malformed metadata or absent required checks produce a notice naming
the missing prerequisite and use the scheduled fallback. The stable notice titles
are `required_checks_unconfigured` for absent required checks and
`required_checks_unverified` for an unreadable branch-rules API. A later run retries; a
persistent configuration problem still needs maintainer attention. No bypass or
thread resolution is attempted. A base advance after publication,
or an unavailable auto-merge, is handled by the next scheduled run, which
force-rebuilds the proposal branch from the current default branch, so permanent
freshness is not claimed. Sync and closeout jobs have 60-minute timeouts;
their dispatch steps have five-minute timeouts and no polling. Sync alerts use
10 minutes. The Dependabot reusable job already had a 60-minute timeout;
its bounded API retries do not wait for caller runs. The non-reusable release
workflow is outside this caller-workflow change.

The existing daily schedules and per-kind concurrency groups are retained. No
push trigger is added: concurrency permits one active run per kind, not one
run per day; manually dispatched runs remain explicit operator requests.
Historical import/changelog review findings are separately owned by PR #142.
The unresolved pm-ado#32 review additionally concerns October closeout delivery
being attributed to its old September package release; follow-up pm-github-lfcf
tracks that distinct caller changelog/release-policy finding. Successful checks
and enabled auto-merge do not resolve that conversation.

## Regression evidence

`test/bot-pr-workflow.test.ts` executes each workflow's actual dispatch shell
against a real local Git remote with receipt-only GitHub commands. It advances
the base with a release commit and verifies one dispatch round, one head-guarded
auto-merge request and a parked-run report, with no PR/ancestry polling or branch
update. Cases cover classic contexts/checks, ruleset-only requirements, protected
bases without required checks, unreadable rules APIs, disabled auto-merge, absent
protection, failed/malformed metadata, explicit overrides, no dispatchable
workflow, CodeQL without a dispatch trigger, dispatch denial, App credential
pairing and scoped token bindings.
The timeout contract discovers every reusable workflow and checks every job;
the dispatch-step contract checks the five-minute cap. Existing end-to-end import
and closeout suites retain privacy, scope, ownership, lease, no-op and attribution
revocation boundaries.

The approval-required run listing is informational. Both dispatch steps query it
once after auto-merge preparation; if the lookup fails, they print a notice to
inspect the bot PR and exit successfully without retrying or revoking auto-merge.
Successful lookups still report each parked run URL. Dispatch failures continue
to fail the job before auto-merge can be armed.

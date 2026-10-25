# pm-github

A true **round-trip** GitHub Issues integration for [pm-cli](https://github.com/unbraind/pm-cli): import, export, status-sync, search, and validate.

Import issues from any GitHub repo as pm items, export pm items back to GitHub (safely, dry-run by default), push status changes upstream, reach GitHub from `pm search`, and track GitHub provenance on each item. Works unauthenticated (60 req/hr); set `GITHUB_TOKEN`/`GH_TOKEN` or run `gh auth login` for 5000 req/hr and private repos.

---

## Installation

```bash
pm install npm:pm-github --global
```

> The `npm:` prefix is required. A bare `pm install pm-github` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-github` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

## Close items delivered by merged pull requests

Agents can use `pm github closeout` to replace manual post-merge tracker cleanup.
It resolves `--repo` or `PM_GITHUB_REPO` through the existing
repository resolver, and uses the normal `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth`
token resolution. Use repeatable `--pr` numbers **or** `--since` with an ISO date
or timestamp including a timezone. `--since` selects merge times inclusively,
drains the closed-PR listing, and verifies each selected PR individually.

```sh
# Agent: inspect the plan first. No tracker writes happen by default.
pm github closeout --repo owner/repo --pr 42 --pr 43 --skip pm-deferred --json
# Apply the reviewed selection; repeatable --skip always excludes those ids.
pm github closeout --repo owner/repo --pr 42 --pr 43 --skip pm-deferred --apply
# Incremental sweep, including merges exactly at the cutoff.
PM_GITHUB_REPO=owner/repo pm github closeout --since 2026-10-01T00:00:00Z --json
```

Only `https://github.com/owner/repo/blob/main/.agents/pm/<folder>/<id>.toon`
links in PR bodies are recognized. Percent-encoded names and nested SDK tracker
folders are supported; malformed encodings and traversal segments are ignored. Repository comparisons ignore case. Links to
other repositories, unknown ids, closed/canceled items and `--skip` ids produce
explicit skip rows. A whole-line `Closes <item-id>` or `pm-github: <item-id>`
declaration, a closing keyword before the canonical item link, or a structured
`PM item: <item-id-or-canonical-link>` line declares delivery. Spaces and tabs
are allowed; declarations cannot span lines. Matching uses the complete item ID,
so `Closes pm-x-extra` cannot deliver `pm-x`. Undeclared canonical links in the
PR body, including links in follow-up lists (`PM:`), can produce `not_delivery`
rows for otherwise eligible items with the reason "Mentioned, not delivered".
Tracker PR URL metadata with no body reference or declaration produces no row.

A merged PR is a delivery candidate only when it claims the item through an explicit
`delivery-pr:` tag, a closing declaration, or a commit claim naming the item.
A fully inspected mention-only or link-only PR is context: it remains listed as
`skip` / `not_delivery`, never enters the candidate set, and its merge/check gaps
cannot hold another delivery. Unreadable PR or commit evidence remains unresolved
because it may hide a claim; a known candidate's incomplete evidence still holds.

Closeout never breaks a delivery tie by PR number or merge order. Prefer one explicit
item tag linking the delivery PR, for example:

```sh
pm update pm-x --add-tags delivery-pr:https://github.com/example/project/pull/19
```

The tagged PR must be in the selected PR set and pass the merge and head-check gates.
Ordinary `pr_url` metadata remains contextual. Without an explicit tag, exactly one
linked merged PR must declare the item in its description or commit messages and
merge strictly after the last acceptance-criteria edit in the item's SDK history.
Creation is the cutoff when no later criteria edit exists; comments and unrelated
updates do not move it. Missing or unverifiable history cannot establish chronology.
Unreadable commits on an otherwise qualifying mention also hold selection: they may hide another claim. A failed check on the unique PR never permits fallback to an earlier delivery.

Unresolved attribution produces `needs_review` rows listing every linked candidate
PR number, leaving the item and its history unchanged. Multiple or unmatched explicit
tags also require review. The reusable workflow includes these rows and candidates
in the closeout PR body. An all-held run proposes only the privacy-gated
`closeout-review.json` report in the tracker, so it can still open a review PR.
All completion fields and the appended close event use the selected PR's merge
time, merge SHA, head SHA and check evidence.

**A mention is not delivery.** PR bodies routinely link follow-ups, epics and
related work for context, so a link alone never closes an item. An item is
closed only when:

- its delivery is selected by an explicit item tag or a unique claim after the last criteria edit; a canonical link may be preceded on the same
  line by a GitHub-style closing keyword: `Closes`, `Fixes`, `Resolves` or
  `Delivers` (and their tense forms), for example `- Closes [pm-x](…/pm-x.toon)`;
- it is not an `Epic`; epics close when their children are done;
- it has no non-terminal child items.

Each refused item gets a skip row naming the rule, so the plan shows why
deferred follow-ups stay open. `--skip` still excludes any id unconditionally. Items are read through a certified complete SDK
corpus, including terminal items.

A PR must be merged and have complete merge facts. Required head checks from
classic branch protection and active branch rulesets must conclude **success**;
missing, pending, neutral, skipped, failed or app-mismatched required checks
prevent closure. Required legacy commit-status contexts must succeed too, using their
latest status. Check-run, status and ruleset pages are fully read. Rulesets are
read through GitHub's [effective branch rules API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).
The check policy reflects the rules readable at invocation time.

When either protection source is unreadable (HTTP 403/404), the row is ineligible
with `required_checks_unverified`. Observed green runs cannot prove that every
required context ran. Supply `--required-checks $'test (22)\ntest (26)'` (Bash) to declare a
newline-separated set of required context names when metadata is unavailable.
Every declared context must conclude **success** on the exact head (or have a
successful latest legacy status); missing, pending, neutral or skipped contexts
refuse closure. Readable requirements remain enforced, including app bindings.
This **declared** policy does not require unrelated optional runs to succeed.
When both metadata sources are readable, declarations do not replace their policy.

With fully readable metadata and no required contexts configured, the report
labels the **fallback** rule: at least one head check run must exist, every run
must complete with `success`, `neutral` or `skipped`, and latest legacy statuses
must succeed. Missing, malformed or incomplete evidence and other metadata errors
fail closed. The plan reports which rule was used.

TOON lists actionable `close`/`refuse` rows individually and summarizes routine skips
as counts by stable code, for example `skipped: {already_terminal: 30,
other_repository: 10, duplicate_selection: 5}`. Explicit exclusions use
`explicit_skip`. Only checks for actionable rows are shown. Use `--full` for every
plan row and selected PR check. Global `--json` always returns the full shape
`{command, repo, dry_run, plan, checks, closed, failed}`. Each full plan row is
`{item, pr, action: "close" | "skip", code, reason}`. Codes distinguish
`head_evidence_unavailable`, `incomplete_merge`, `head_checks_failed`, and
`head_checks_passed` without parsing explanations. `checks` reports each PR's rule,
verdict, explanation and successful check names. `head_checks_passed` remains the success
code for all passing policies; `rule: "declared"` proves the caller-declared contexts,
while repository required-check metadata was unavailable. Dry-run rows describe intended
closes; `closed` counts writes only with `--apply`. `--dry-run` overrides
`--apply`. All API planning finishes before the first SDK close. Individual SDK
refusals become skip rows containing a diagnostic code (or a generic failure
class), without raw error prose, paths or lock-owner identities. Remaining
closes continue; `failed` counts refused writes and `closed` counts successful
writes. After processing everything, any failed close produces a `CommandError`
with exit code 1 and the complete JSON report in its message. Eligibility skips
alone do not fail the command. Inspect the report before retrying.

The SDK close reason is a JSON string containing **only** verified facts:
`{pr, url, merge_commit_sha, head_sha, merged_at, checks}`. `checks` contains the
sorted unique names that actually succeeded at that head; neutral/skipped runs
are not described as passed. PR body, title and comments are never persisted.
For both default and strict close validation, the SDK always receives the three
structured close fields it supports, without overriding tracker policy:

- `resolution`: `Delivered by <PR URL> (merge <sha12>, head <sha12>)`.
- `expected_result`: the item's own acceptance criteria verbatim when present;
  otherwise `Delivered by the linked pull request, merged after its head check gate passed.`
- `actual_result`: `Merged at <time>; required checks satisfied; successful head checks:
  <names>` when branch protection or rulesets name required checks (the list holds every
  successful head check, optional ones included). Under the declared policy it reads
  `Merged at <time>; caller-declared checks concluded success; repository required-check
  metadata was unavailable; successful head checks: <names>`. Under the fallback rule
  (fully readable, empty policy) it reads
  `Merged at <time>; no readable required checks, so every
  completed head check run had to succeed, be neutral or be skipped; successful checks:
  <names>`, or `…; no check reported success` when only neutral or skipped runs exist.
  Only the verified merge time, the applied check policy and sorted successful check
  names are used; no platform, coverage or test-execution claims are made.

Item titles never supply any of these fields. Existing tracker acceptance
criteria remain the only prose source; PR body and comments supply no field text.
Completion time is the GitHub merge time. Repeating a completed selection skips
terminal items and performs zero additional tracker writes. The command edits
only the tracker; commit it with its history and regenerate the caller's
changelog in a closeout PR. The [automated closeout workflow](#automated-closeout-workflow)
performs that daily review-PR preparation for fleet repositories.

## Authenticated webhook reconciliation

`pm github webhook receive <owner/repo> --payload delivery.json --delivery <id>
--event issues --signature <sha256=...>` accepts explicitly supplied deliveries.
Set `PM_GITHUB_WEBHOOK_SECRET` through your secret manager. Exact payload bytes
are authenticated before any write; a durable inbox deduplicates delivery IDs.

`pm github webhook reconcile <owner/repo> --limit 20` reads current GitHub state
for already-linked issues and returns compact proposals with lifecycle deltas.
It never applies the event's lifecycle or changes items. Out-of-order events
therefore cannot reopen a closed item. Output defaults to TOON; add `--json`
for JSON. Signature and storage refusals include typed codes and remedies.

Use `pm github refresh <owner/repo> --dry-run` to review full changes and
`--atomic` to apply a fresh polling read. Polling remains the recovery route
for missed deliveries or unavailable webhooks. Back up the ignored durable
`github-webhooks` directory inside your tracker. See the
[CLI and typed SDK example](docs/webhook-inbox.md) for deployment, crash recovery,
retention and supported-event details.

## Issue-form completion contracts

`pm github form` reads one explicitly selected repository issue form through the
GitHub Contents API. It compiles requirements before export; it never writes to
GitHub or changes an item. Select a revision explicitly (prefer a commit SHA for
reproducibility). Requirements follow [GitHub's form schema](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema).

```sh
pm github form --repo unbraind/pm-cli \
  --form .github/ISSUE_TEMPLATE/feature-request.yml --form-ref main \
  --form-bindings docs/issue-form-bindings.json --compile --json

pm github form --repo unbraind/pm-cli \
  --form .github/ISSUE_TEMPLATE/feature-request.yml --form-ref main \
  --item pm-123 --form-bindings docs/issue-form-bindings.json \
  --form-answers docs/issue-form-answers.json --json

pm github export --repo unbraind/pm-cli --ids pm-123 \
  --form .github/ISSUE_TEMPLATE/feature-request.yml --form-ref main \
  --form-bindings docs/issue-form-bindings.json \
  --form-answers docs/issue-form-answers.json --dry-run --json
```

The [bindings example](docs/issue-form-bindings.json) maps form IDs to current
native item fields; the [answers example](docs/issue-form-answers.json) supplies
the dropdown selection. Explicit answers override bindings. Native text fields
(including custom fields) and string arrays are read through the SDK, without
coercion. Numbers, objects and nested arrays refuse as answers. Status bindings
are literal text; this feature does not infer lifecycle meaning. Required text
must contain non-whitespace content. Text supports `required` and `min_length`
(Unicode code points, after CRLF/CR normalization); dropdowns support `required`,
exact option membership, uniqueness and single/multiple selection. Defaults and
placeholders do not count as confirmed answers. Markdown elements are display
context and are omitted from the issue body. Fields without IDs use `field-N`,
where N is their one-based position in the form body.

Unknown keys, validators or element types refuse explicitly as `unsupported_form`.
This includes checkboxes, uploads, rendered/code textareas, dropdown defaults,
assignees, project routing and issue types. Duplicate IDs, labels or options
also refuse. The supported top-level keys are `name`, `description`, `title`,
`labels`, and `body`; `title` is a UI preset and the native pm title remains the
exported title. Form labels augment exported labels. Missing/invalid answers
produce `incomplete_answers`, exit 2, and **one** checklist of at most 20 repairs
plus an omitted count. A batch validates all selected items before any POST or
PATCH, so one incomplete item yields zero remote writes. Pass the same form
flags to `export --apply` only after reviewing the preview. Without `--form`,
export retains its existing behavior. This does not repair export identity,
retry or idempotency defects, and a form check is not an approval for later use.

Normal form output is compact host-rendered TOON (`--json` selects JSON): contract,
binding names, counts and repair evidence, without item contents or answer values.
`--compile` returns the contract even before answers are supplied. Limits are
128 KiB YAML/JSON files; 100 elements, map entries or choices; 200 characters per
label/choice; 32,768 characters per answer; `min_length` 0..32,768; 64 KiB UTF-8
rendered issue body. Arrays must be dense and numeric validators finite integers.
Input and output size refusals use `invalid_form_input`; inaccessible forms and
items use `form_unavailable` and `item_unavailable`. Remedies use the host SDK's
structured error context (`nextSteps` and `why`).

The typed SDK exports `IssueFormInput`, `IssueFormContract`, `IssueFormReport`,
`IssueFormRefusalCode`, `compileIssueForm(input)`,
`completeIssueForm(pmRoot, input)` and `readRepositoryIssueForm(selection, reader, apiBase)`:

```ts
import { completeIssueForm, type IssueFormInput } from "pm-github";

const input: IssueFormInput = {
  repo: "owner/repo", ref: "commit-sha", path: ".github/ISSUE_TEMPLATE/bug.yml",
  yaml: selectedRepositoryFormYaml,
  item: "pm-123", bindings: { problem: "description" },
  answers: { version: "stable" },
};
const { report, body } = await completeIssueForm(pmRoot, input);
// report.ok is completion evidence for this read; body is the validated export text.
```

There are no saved plans, leases, idempotency keys, or retries in the completion
adapter. Every call re-reads native state, and the semantic form digest is only
a source identifier. Imports and sync do not use this opt-in export adapter.

## Without git

With an explicit repository, GitHub import, export, refresh, sync, project commands,
blocker checks, issue-form compilation/completion, closeout and webhook receive/reconcile work in a plain pm tracker
without a git executable.
`pm github identity` also works there, entirely offline and without credentials.
The provider commands still require their normal GitHub access and credentials. Privacy scanning
with `github gate --diff <file>` also works there. Reading a proposed tracker diff
with `github gate` requires a git repository; otherwise pass an explicit diff.
Gated imports (`github import --gate`, including the scheduled sync workflow)
also require a git repository so the proposed publication can be checked. They
refuse before writing when the tracker is outside one; plain imports still work.

Import lifecycle finalization uses the pm SDK's item mutation boundary, retaining
GitHub source dates and both import write hooks. Tracker ownership, workflow,
history-stream and transactional extension guards now apply to these writes too;
a refusal leaves the item and history unchanged. The SDK supplies missing-item
diagnostics (not-found exit code 3), maintains its derived index, and uses its
native TOON storage format when updating legacy documents.
See [SDK adoption evidence](docs/sdk-adoption-1025.md).

## Revalidate GitHub blockers

**Compatibility:** pm-github now requires PM CLI 2026.10.5 or newer for complete
SDK reads and structured command exit statuses. Older hosts refuse installation
or activation through the matching peer dependency and manifest floor.

`pm github blockers` reads a certified complete tracker and checks every blocked
item, plus non-terminal items with an external GitHub `blocked_by` dependency.
It scans dependency targets, `blocked_reason`, description, and stored comments
(including the latest) for `owner/repo#N`, issue/PR URLs, `#N`, and `GH-N`.
Bare references use the item's `gh:owner/repo#N` provenance repo, then `--repo`.
The extra short form `repo#N` resolves only against a matching repo hint.
References are deduplicated across items and queried in GraphQL batches of 25,
using the existing token resolution and rate-limit handling.

```sh
pm github blockers --repo unbraind/pm-cli
pm github blockers --repo unbraind/pm-cli --json
pm --pm-path fleet/pm-rl/.agents/pm github blockers --repo unbraind/pm-cli --json
pm github blockers --ids pm-123,pm-456 --repo unbraind/pm-cli
# Preview/write annotations only on a scratch tracker:
pm --pm-path scratch/.agents/pm github blockers --repo unbraind/pm-cli --comment --dry-run
pm --pm-path scratch/.agents/pm github blockers --repo unbraind/pm-cli --comment
```

Reports use the host renderer (TOON by default; global `--json`) and include item
id/status, each reference's state, close reason and closed/merged timestamp.
Verdicts are `cleared` (all references closed or merged), `partially_cleared`
(some cleared), `still_blocked` (open blockers, none cleared), and `unresolvable`
(no references or only unknown states). GitHub hides nonexistent and inaccessible
private references alike: both can appear as `not_found`. Explicit permission
errors remain `error` and cannot clear a blocker.

Exit **0** means nothing cleared, **4** means at least one item has a cleared or
partially cleared blocker, **1** means a query/comment failure (takes precedence
over 4), **2** means invalid options or missing authentication, and **3** means
an unknown `--ids` item. Structured reports remain available for query failures.
No run auto-unblocks. `--comment` adds one comment per fully cleared item,
listing newly cleared references as “Blocker X closed on D; revalidate.” Each
reference/state/timestamp carries an idempotency marker; repeats add nothing,
and a subsequent close with a different timestamp gets a fresh annotation.
`--dry-run` previews the annotation counts without appending comments.
The reusable scheduled sync runs this command report-only and emits an Actions
warning for code 4; it stops on other non-zero codes. Callers must pin a release
containing this command before adopting the updated workflow.

## Capabilities

| SDK capability | What it provides |
|---|---|
| `importers` | `pm github import <owner/repo>` — idempotent native import pipeline |
| `importers` (exporter) | `pm github export` — pm items → GitHub issues (dry-run by default; upsert) |
| `commands` | `pm github refresh <owner/repo>` (refresh linked items only), `pm gh-issues import` (legacy import alias), `pm github sync` (push status), `pm github gate` (fail-closed pre-push privacy gate), `pm github validate` (diagnostics), `pm github closeout` (verified merged-PR delivery), `pm github project list\|fields\|import\|sync` (Projects v2) |
| `schema` | declares `github_url`, `github_number`, `github_state`, `github_author`, `github_created_at`, `github_updated_at` item fields |
| `hooks` | `afterCommand` — opt-in sync reminder (`PM_GITHUB_SYNC`) for linked items |
| `preflight` | early warning when a mutating github command lacks a token |
| `search` | `github` search provider — `pm search` reaches GitHub for imported items |

### Whole-workspace read safety

Import idempotency, export, status sync, Projects v2 sync, and search fallback
all depend on seeing every pm item, including closed and canceled work. Before
any of those paths plans or performs a GitHub operation, pm-github requests a
strict, full, unbounded `pm list --all` response and verifies its completeness,
omission, pagination, output-budget, count, identity, and consumed-field
contracts. An incomplete or unverifiable response fails closed; it is never
treated as an empty or partial workspace.

The production subprocess uses the same canonical argument contract as:

```bash
pm --pm-path <tracker> \
  --output-include full \
  --output-limit unbounded \
  --output-budget unbounded \
  list --all --json --include-body --strict-read
```

The output controls precede the command so the host owns the complete-result
contract; `list --all` includes terminal items without invoking the deprecated
`list-all` alias.

The subprocess still has a 64 MiB byte safety cap. Set
`PM_JSON_MAX_BUFFER=<bytes>` to a larger positive safe integer for an unusually
large tracker. Raising that transport cap does not weaken the completeness
checks.

## Import

### Keeping a mirror current

Use `refresh` when your tracker deliberately mirrors only a few issues from a busy
repository. It selects existing `gh:owner/repo#N` tags or explicit `github_url`
links (also `github_repo` with `github_number`), fetches those numbers in GraphQL
batches of at most 100, and **never creates items**. Only `/issues/N` URLs are
refreshable links: the batch query reads issue nodes, so a `/pull/N` URL is not
selected. Ordinary references in text
are not links. Conflicting identities or multiple owners fail before any write.

```sh
pm github refresh owner/repo --dry-run --json
pm github refresh owner/repo --atomic
pm github refresh owner/repo --since 7d --limit 50 --dry-run
```

`--limit` bounds the selected issue numbers, in ascending order, before fetching.
`--since` filters by the fetched upstream update time, including closed issues;
filtered items are counted separately. Omit it for a complete refresh. A GitHub
token is required for GraphQL (`GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth login`).
Closure evidence uses the importer's timeline reader; label pages are fetched in
full. API retries and rate limits use the shared transport.

Refresh reuses import's title, labels and source lifecycle mapping, including
real closure/completion dates and reopening. Body, local item type, assignee and
milestone are preserved. A `release` already present on the item is only replaced
when GitHub supplies calendar-tag attribution for a closure; open issues and
closures without a matching tag keep the existing release, so user- or tool-set
attribution survives. Existing cross-provider link-only owners retain their
native lifecycle and content, as on import. TOON (default) or `--json` returns a
`plan` of `{id, number, changes: [{field, old, new}]}` plus `updated`, `unchanged`,
`missing`, `filtered`, `selected`, `resumed` and `created: 0`. On dry-run, `updated` means
would update; nothing is written. Missing rows carry a typed `reason` and remain
unchanged: `not_found_or_inaccessible` (GitHub cannot distinguish deleted/hidden),
`inaccessible`, `transferred`, `api_error`, `incomplete_response`, or `invalid_issue`.
A request-wide failure aborts before new refresh writes. Recovery of unfinished
transactions happens first and may already have committed earlier writes when
a subsequent request fails.

Each changed item receives an audit comment. `--atomic` applies the batch in one
SDK workspace writer transaction with rollback; otherwise each changed item gets
its own transaction. Every update transaction persists its exact plan beside the
SDK journal before writing. If a run dies mid-transaction, the next refresh
detects unfinished journals for the selected items, validates every saved plan
before any replay, and refuses recovery from another repository. It replays the original
plan — committing the journal without duplicating the audit comment — before
unchanged items are skipped, and reports it in `resumed`. A preview
(`--dry-run`) refuses while such a journal is open; a missing plan fails closed
naming the transaction id instead of silently reporting a no-op. Review the preview before publishing tracker changes and
apply the existing privacy gate to any proposed commit.

For a weekly refresh, run this in a checkout with the extension installed, token
available and `PM_PATH` set to the intended tracker. For example, a cron entry:

```cron
0 6 * * 1 cd "$MIRROR_CHECKOUT" && pm github refresh owner/repo --atomic --json >> "$MIRROR_LOG" 2>&1
```

Configure those environment variables in the crontab. The command updates the
tracker locally; review and commit changes using your normal workflow.

### `pm github import <owner/repo>` (or `pm gh-issues import`)

```bash
pm github import unbraind/pm-cli
pm github import owner/repo --issue 189
pm github import owner/repo --issue '189,#190,owner/repo#191'
pm github import owner/repo --limit 10
pm github import owner/repo --state all
pm github import owner/repo --labels bug,enhancement
pm github import owner/repo --since 2026-01-01T00:00:00Z   # incremental sync
pm github import owner/repo --assignee octocat
pm github import owner/repo --milestone "v1.0"
pm github import owner/repo --include-prs
pm github import owner/repo --atomic
pm github import owner/repo --link-deps    # map issue-body dependencies to pm edges
pm github import owner/repo --dry-run
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--issue <N[,N...]>` | string | Fetch only selected issue endpoints; accepts numbers, `#N`, and same-repo `owner/repo#N` references. Conflicts with `--state`, `--all`, `--labels`, `--since`, `--assignee`, `--milestone`, and `--limit`. |
| `--limit <n>` | positive integer | Cap list-mode imports, newest-updated first. Returns `limit` and `truncated` (true when more matching issues exist). Invalid with `--issue`. |
| `--all` | boolean | Include closed issues (shorthand for `--state all`) |
| `--state <state>` | string | `open` \| `closed` \| `all` (default: open) |
| `--labels <labels>` | string | Comma-separated label filter |
| `--since <iso>` | string | Only issues updated after this ISO timestamp (incremental sync) |
| `--assignee <login>` | string | Filter by assignee login |
| `--milestone <name>` | string | Filter by milestone title |
| `--include-prs` | boolean | Include pull requests (default: skip PRs) |
| `--skip-drafts` | boolean | Exclude draft pull requests (only meaningful with `--include-prs`) |
| `--with-comments` | boolean | Fetch issue comments and append them to the item body |
| `--comments-mode <mode>` | `body`\|`annotations`\|`both` | How fetched GitHub comments are persisted (default `body`). `annotations` syncs comments into the pm item's native comments collection via the SDK; `both` writes the body section AND native comments. `annotations`/`both` are idempotent on re-import (dedupe by GitHub comment id) |
| `--atomic` | boolean | Commit every create, update, close, and reopen in one workspace-writer-locked, crash-resumable transaction (requires pm CLI/SDK >=2026.7.20). Normal failure compensation restores updated/closed items and deletes newly created items; an incomplete compensation is reported explicitly for retry or repair. |
| `--adopt-cited` | boolean | Explicitly opt in to conservative citation adoption (default: off). Tag new items `gh:owner/repo#N` instead. Default imports only report citation candidates. |
| `--link-deps` | boolean | After import, map dependency references in issue **bodies** (`Blocked by #N`, `Depends on owner/repo#N`, `Blocks #N`) to pm dependency edges between the linked items. Idempotent, best-effort, and re-runnable; see [Dependency linking](#dependency-linking---link-deps) below. |
| `--gate` | boolean | Fail-closed privacy gate: verify plan completeness (every fetched issue accounted for exactly once) and provenance idempotency (every re-import lands on exactly one `gh:owner/repo#N`-tagged item) BEFORE the write, then scan the proposed tracker change with [`pm github gate`](#pm-github-gate) AFTER it. Any finding — or any unreadable scan input — exits non-zero so an automated pipeline can never commit or push the change. Embeds `gate` receipts in the result. |
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Override pm item type (default: Issue) |

Each imported item records GitHub provenance: the `gh:owner/repo#N` idempotency tag, a `github_author:<login>` tag, and an enriched description (`author @<login> · state reason <reason> · created <iso> · updated <iso>`). GitHub issues closed as `not_planned` import as pm `canceled` instead of `closed`, preserving the difference between completed work and deliberately dropped work. The integration declares the `github_url`, `github_number`, `github_state`, `github_author`, `github_created_at`, and `github_updated_at` schema fields.

The primary way to prevent duplicate imports is to tag an item
`gh:owner/repo#N` **when it is created**, for example
`pm create issue "Fix widget behavior" --tags "gh:acme/widgets#30"`.
For an existing item, use `pm update <id> --add-tags "gh:acme/widgets#30"`. A prose URL is context, not an
ownership declaration. Existing tag/structured URL/provider matching takes
precedence and is unchanged.

**Citation adoption is off by default.** Manual imports, the legacy alias and
scheduled gated syncs retain normal create behavior when explicit ownership is
absent. They report read-only `citation_candidates` so an agent can tag the
correct item, including when several candidates exist. No candidate is adopted
or ambiguity-blocked by default.

Use `--adopt-cited` on the CLI, `adoptCited: true` in SDK import options, or
`adopt-cited: true` on the reusable sync workflow to enable the fallback. The
fallback deliberately favors refusal over overwriting an unrelated item:

1. **Normalize before checking.** Decode complete named/numeric HTML entities and
   percent-encoded bytes repeatedly until stable, bounded to eight passes.
   Apply NFKC and remove zero-width/bidi control characters. Unwrap Markdown
   link destinations and reference definitions and join soft line breaks for
   intent matching. Retain normalized source as well as the unwrapped view for
   exclusion, so a link label cannot hide a second reference. Joined-line views
   also expose split references. A normalization bound exhaustion is a refusal.
2. **Allowlisted ownership.** A qualified target issue reference must appear in
   the title, directly follow `Fix`, `Fixes`, `Fixed`, `Close`, `Closes`, `Closed`,
   `Resolve`, `Resolves` or `Resolved` at the start of the description, or be a
   URL on a whole body line `Issue: <url>` or `Tracks: <url>`. Matching ignores
   case. Body fix phrases, `Related:` mentions, unanchored phrases and bare
   numbers cannot authorize adoption.
3. **Exclude every other reference.** Across all normalized fields, any other
   `github.com` URL, foreign repository, different `#<digits>` or
   `issues`/`pull` token followed by another number vetoes adoption. Unattributed
   paths/bare hashes also refuse adoption: this item projection has no verified
   owning-repository context. PR URLs, including a same-number PR URL, are other
   URLs. The scan over-counts code and incidental text deliberately. These
   checks reduce risk; they do not make arbitrary prose an ownership contract.

| Existing prose | Default | With `--adopt-cited` |
| --- | --- | --- |
| Description: `Fixes acme/widgets#30` | Create + `adoption_disabled` hint | Eligible if no other reference |
| Body line: `Issue: https://github.com/acme/widgets/issues/30` | Create + hint | Eligible if no other reference |
| Title: `Handle acme/widgets#30` | Create + hint | Eligible if no other reference |
| Body: `Fixes acme/widgets#30` | Create + `missing_intent` hint | Create + hint |
| Body: `Related: acme/widgets#30` | Create + `missing_intent` hint | Create + hint |
| Title cites issues 30 and 31 | Create + `multiple_issues` hint | Create + hint |
| Description fixes issue 30; body has `**https://github.com/other/widgets/issues/30**` | Create + hint | Create + `multiple_issues` hint |
| Description fixes issue 30; body has `[other](https://github.com/other/widgets/issues&sol;31)` or `issues%2F31` | Create + hint | Create + `multiple_issues` hint |

Plans include `citation_candidates: [{id, reason}]`; aggregate dry-run and write
receipts include `citation_candidates: [{issue, id, reason}]`. Reasons are
`adoption_disabled`, `missing_intent`, `multiple_issues`, `normalization_limit` or `structured_owner` (the item already carries a `github_*` field, a core `external_ref` or `source_owner`, a `linear_*`/`jira_*`/`ado_*` identity field, provider provenance, a GitHub issue URL in its links or a native declaration, so prose citing another issue never re-owns it).
Candidate reporting never changes the referenced item's status, content or
fields, including a closed item's completion state.

With explicit opt-in, one eligible untagged candidate produces an `adopt` plan:
its ID receives the provenance tag and `github_*` fields through normal upsert.
Closed/canceled owners remain eligible. Two or more eligible owners refuse the
batch with typed `ambiguous_citation`, IDs and a remedy to tag the correct item.
The default path never applies that fallback ambiguity refusal. Existing
structured-identity collision checks still apply in both modes.

Dry runs show `adopt` and `wouldAdopt`; write receipts report `adopted` separately
from `imported`/`updated`. Gated idempotency counts an opt-in adopt as one landing
item. Status push, export and Projects matching retain their scope. Citation
reporting and opt-in adoption work in non-git trackers; actual `--gate` writes
still require a Git worktree for the proposed-change privacy scan.

`--issue` deduplicates references and fetches each selected issue directly, including closed issues, without listing the repository. Every selected number is fetched and checked before any tracker write. A missing number fails the whole import; `--dry-run` instead reports `missingIssues` and previews the available selection. Pull request numbers require `--include-prs`. Selection combines with comment modes, dependency linking, atomic imports, gates, dry runs, and custom item types, preserving provenance-based re-import idempotency.

`--limit` bounds the matching list after PR, draft, and milestone filters. Pagination stops once one extra matching issue establishes truncation, so at most `n + 1` eligible issues are retained; GitHub pages may also contain excluded entries. Without a limit, existing list ordering is unchanged.

`--atomic` derives its durable transaction identity from the repository, complete rendered issue state, and exact ordered mutation plan (including target item ids), and derives each create id from the stable `owner/repo#number` external key rather than fetch position. Retrying the same response in a different order therefore resumes without duplicates; changed content, workspace prefixes, or resolved targets create a fresh compatible transaction. Native comment annotations run only after the item transaction commits and retain their cross-process deduplication lock.

### Native comment sync (`--comments-mode`)

By default (`--comments-mode body`, or `--with-comments`), fetched GitHub issue comments are flattened into the item body as blockquoted markdown under a `### GitHub comments (N)` heading — the historical behavior, byte-identical across releases.

`--comments-mode annotations` instead syncs each GitHub comment into the pm item's **native comments collection** via the public SDK `comments()` primitive, so agents get structured, queryable comments (`pm comments <id>`) instead of body-embedded text. Each stored comment carries a hidden marker with the GitHub comment id (`<!-- pm-github:comment:N -->`), so re-running import is **idempotent** — already-synced comments are skipped and never duplicated. `--comments-mode both` writes the body section *and* the native comments.

When `--with-comments` is combined with `--comments-mode annotations`, the two are reconciled to `both` (the legacy flag asks for body embedding, the mode asks for native comments → both), so neither is silently dropped.

```bash
pm github import owner/repo --comments-mode annotations   # native comments only
pm github import owner/repo --comments-mode both            # body section + native comments
pm github import owner/repo --with-comments                 # legacy body embedding (default shape)
pm github import owner/repo --with-comments --comments-mode annotations  # same as --comments-mode both
```

### Dependency linking (`--link-deps`)

GitHub issue authors declare cross-issue dependencies in prose — `Blocked by #12`, `Depends on owner/repo#5`, `Blocks #9`. A flat import throws that structure away, leaving pm items with no blocker graph. `--link-deps` runs an opt-in second pass that parses those references from each issue's **body** and materializes them as pm dependency edges between the corresponding pm items, resolved through the same `gh:owner/repo#N` provenance tags the import writes.

The effect is context you can act on: `pm next` and `pm deps` surface the real ready/blocked ordering instead of an undifferentiated list.

```bash
pm github import owner/repo --link-deps
pm github import owner/repo --atomic --link-deps
pm github import owner/repo --link-deps --dry-run   # reports candidate reference count only
```

**Reference grammar** (case-insensitive; `-`/`:` glue tolerated; multiple refs like `#1, #2 and #3`):

| Phrase | pm edge on the source item |
|---|---|
| `Blocked by #N` | `blocked_by` → the referenced item |
| `Depends on #N` | `blocked_by` → the referenced item |
| `Blocks #N` | `blocks` → the referenced item |

Both bare `#N` (resolved against the imported repo) and explicit `owner/repo#N` cross-repo references are supported, the latter only when that issue is also present in the workspace.

**Guarantees**

- **Idempotent** — edges dedupe by id + kind, so re-running import never duplicates them.
- **Path-agnostic** — runs identically after the normal and `--atomic` import.
- **Safe** — references inside fenced/inline code spans are ignored; self-references and references to issues not in the workspace are skipped (the latter counted as `unresolvedDependencyRefs`); a failed individual edge never fails the import (it is reported in `dependencyLinkFailures` and the pass is re-runnable).
- **Cycle-aware, not cycle-blocking** — ordering cycles the mapped edges introduce are reported in `orderingCycleWarnings` (computed via the pm SDK `collectNewOrderingCycleWarnings` advisory over the workspace before/after the pass) rather than rejected, mirroring the SDK's warn-don't-reject contract for legacy graph debt.

The import result gains `linkedDependencies`, `unresolvedDependencyRefs`, `orderingCycleWarnings` (and `dependencyLinkFailures` when non-empty); a `--dry-run --link-deps` result reports `wouldLinkDependencyCandidates`.

## Export (pm → GitHub)

### `pm github export`

**Safe by default.** Export previews the create/update plan and writes *nothing* unless you explicitly opt in with `--apply` **and** name a `--repo`. With a `--repo`, items already linked to an issue in that repo (via the `gh:owner/repo#N` provenance tag) are **updated** (upsert) instead of duplicated.

```bash
pm github export --repo owner/repo            # DRY-RUN: print the create/update plan, write nothing
pm github export --repo owner/repo --format md
pm github export --repo owner/repo --ids pm-12,pm-34
pm --json github export --repo owner/repo     # return the plan as JSON
pm github export --repo owner/repo --apply    # actually create/update issues (requires a token)
pm github export --repo owner/repo --ids pm-12,pm-34 --apply
```

| Flag | Type | Description |
|---|---|---|
| `--repo <owner/repo>` | string | Target repo; decides create-vs-update and is required for `--apply` |
| `--ids <pm-1,pm-2>` | string | Scope export to specific pm item IDs (comma-separated); unknown IDs fail fast |
| `--format <json\|md>` | string | Dry-run output format (default: json) |
| `--apply` | boolean | Perform real GitHub writes (alias: `--no-dry-run`, legacy `--push`). Requires a token + `--repo` |
| `--dry-run` | boolean | Force preview even alongside `--apply` (dry-run always wins) |

## Status sync (pm → GitHub state)

### `pm github sync`

Push pm status changes back to GitHub: close/reopen the linked issue to match the pm item's status. Requires a token and explicit `--repo`.

```bash
pm github sync --repo owner/repo --dry-run    # preview the close/reopen plan
pm github sync --repo owner/repo --ids pm-12,pm-34 --dry-run
pm github sync --repo owner/repo              # push the changes
```

`--ids` scopes sync to specific pm item IDs (comma-separated). Unknown IDs fail fast so agent runs do not silently skip typoed targets.

## GitHub Projects v2 (bidirectional board sync)

GitHub Projects v2 boards are a GraphQL-only surface, distinct from Issues. These commands keep a pm workspace and a Projects v2 board in lockstep — *project management = context management* — **without ever losing data**: nothing is deleted or archived on either side, every action is idempotent via a `gh-project:owner/number#itemId` provenance tag, and a pm status (or board Status) that has no clear counterpart is **skipped, never guessed**.

Needs a token with `project`/`read:project` scope (`GITHUB_TOKEN`/`GH_TOKEN` or `gh auth login`).

### `pm github project list <owner>`

Discover the Projects v2 owned by a user or org (read-only).

```bash
pm github project list unbraind
pm github project list unbraind --json
```

### `pm github project fields <owner/number>`

Introspect a board's fields and — crucially — its **Status** single-select options, so you can design a `--status-map` (read-only).

```bash
pm github project fields unbraind/5
```

### `pm github project import <owner/number>`

Import every board item (draft issues included) as pm items. Idempotent: an item already linked (by project tag, or by the `gh:repo#N` issue it wraps) is **updated, not duplicated**. The board's Status option maps to the pm status.

```bash
pm github project import unbraind/5 --dry-run
pm github project import unbraind/5
pm github project import unbraind/5 --status-map in_progress=Doing,closed=Shipped
```

### `pm github project sync <owner/number>`

Bidirectionally sync pm items and a board. **Safe by default**: with no `--apply` it previews *both* directions and writes nothing.

- `--push` (pm → board): adds missing pm items to the board — attaching the existing GitHub issue when the pm item is issue-linked, otherwise creating a draft issue — and sets each item's **Status** from its pm status.
- `--pull` (board → pm): updates each linked pm item's status from the board's Status column (status only — never touches title/body/tags).
- `--apply` writes; with neither direction flag it defaults to `--push` (so pm is never mutated silently).
- `--prefer pm|github` resolves conflicts when applying both directions (default `pm`).

```bash
pm github project sync unbraind/5                                  # preview both directions
pm github project sync unbraind/5 --push --apply                  # pm → board
pm github project sync unbraind/5 --pull --apply                  # board → pm
pm github project sync unbraind/5 --push --pull --apply --prefer pm
pm github project sync unbraind/5 --push --apply --ids pm-1,pm-2  # scope by id
pm github project sync unbraind/5 --push --apply --no-add-missing # only reconcile linked items
```

> The GitHub Projects v2 item node id is case-sensitive but pm normalizes tag values to lowercase, so the node id is hex-encoded inside the provenance tag to round-trip losslessly. This is what makes re-sync idempotent instead of silently double-adding.

## Search (pm search → GitHub)

### `github` search provider

Registers a `github` search provider so `pm search ... --semantic` can reach GitHub. It asks GitHub which issues in the target repo match your query, then returns hits for the **pm items you've already imported** from those issues (matched by the `gh:owner/repo#N` provenance tag).

```bash
pm config project set ...                      # set search.provider = "github" in .agents/pm/settings.json
export PM_GITHUB_REPO=owner/repo               # or pass the repo another way
pm search "uppercase dashes" --semantic        # hits = imported items whose upstream issue matches
```

Enable it by setting `search.provider` to `"github"` in `.agents/pm/settings.json` and pointing it at a repo via the `PM_GITHUB_REPO` env var.

## Privacy gate

### `pm github gate`

GitHub issue text is untrusted: anyone who can open an issue can put a credential, a personal email, or a host path in it. An automated import writes that text into the pm tracker, and a sync pipeline then pushes the tracker to a public branch — publishing the leak with it. `pm github gate` is the fail-closed step between the write and any push:

```bash
pm github gate                       # scan the proposed tracker change in the working tree
pm github gate --json               # machine-readable report (also via the global --json)
pm github gate --diff sync.patch     # scan an explicit unified diff file instead
pm github gate --allowlist .pm-github-gate-allowlist.json
```

It scans **only the proposed change** — the added lines and their filenames in the staged/working/untracked diff under the resolved pm tracker path (never a hardcoded `.agents/pm`; the SDK-resolved path wins), or an explicit `--diff` file — so pre-existing reviewed content is not re-litigated on every run, and removed content (which cannot publish anything new) is never scanned. A finding in a filename uses `field: "file_path"` and redacts a sensitive item id. It fails closed (non-zero, machine-readable report with `item_id` + `field` + `rule` + the sha256 `hash` of the matched content, **never the matched content itself**) on:

- **credentials** — GitHub (`ghp_/gho_/ghu_/ghs_/ghr_` and fine-grained `github_pat_`), npm, AWS access key ids, Slack (including app and cookie credentials), OpenAI, Anthropic tokens, generic `Authorization: Bearer` values, `-----BEGIN … PRIVATE KEY-----` blocks, and high-entropy assignments to secret-named identifiers (`token = "…"`, `api_key: …`, `accessToken: …`) whose value has high measured entropy. UUID-shaped credential values and values containing dates receive the same checks;
- **personal data** — email addresses other than no-reply identities (`@users.noreply.github.com`, `noreply@…`, `@noreply.…`), phone numbers in international (`+…`) or North-American (`(555) 123-4567`, `555-123-4567`) notation, and unformatted numbers under phone/tel/mobile contact labels;
- **host paths** — absolute local filesystem paths (POSIX home/system directories and Windows drive paths with either separator), and named home-directory references.

Unreadable input, malformed or truncated diffs, binary input, invalid UTF-8, Git failures, malformed allowlists, and scanner errors fail the gate. Untracked operational state in the tracker root (`locks/`, `extensions/`, `checkpoints/`) is excluded. Explicitly staged operational files remain in scope. Staged and unstaged changes are scanned separately, including staged content that the working copy subsequently removed.

**False positives** are allowlisted by *content hash*, not by pattern: put the sha256 from the finding into `.pm-github-gate-allowlist.json` at the repository root (or pass `--allowlist <file>`) with a written justification. An entry suppresses exactly the reviewed content, can never widen to a pattern, and a missing justification fails the gate:

```json
{
  "<sha256 of the reviewed finding content>": { "reason": "Reviewed: public support address in the import docs item." }
}
```

### `pm github import --gate`

`--gate` composes the gate into the import pipeline, in the order a sync workflow needs:

1. **dry-run plan** — every fetched issue is prepared up front;
2. **completeness check** — every fetched issue is accounted for exactly once (planned or explicitly skipped), nothing outside the fetch appears, counts reconcile — all before any mutation;
3. **idempotency check** — no duplicate `gh:owner/repo#N` provenance tags in the existing corpus, every new entry born with its tag, no two plan entries resolving to the same item — so a second run reuses the existing item;
4. **write** — the ordinary (atomic or per-item) import;
5. **gate** — the proposed tracker change is scanned; a finding exits non-zero, so the caller never commits or pushes.

Rendered values are also scanned in memory before mutation, so a known finding cannot be written to disk. After mutation, the importer verifies that every planned provenance tag exists exactly once, then scans the tracker diff. A completed SDK journal cannot substitute for missing item files.

The `gate` receipt reports the verdict, scanned file count, findings, and allowlisted count. Each finding includes `match_offset` (the starting character offset of the hashed match within the scanned field value, or the serialized added line for tracker text) and `excerpt`. Host-path excerpts show only the root initial, such as `/h***/…`; other matches use `[redacted]`. Human-readable workflow diagnostics include the same evidence. Full paths and secrets never appear. Recognizable bare-root JavaScript regex literals immediately used with `.test()` or `.exec()` are distinguished from paths; quoted host paths and slash-separated host paths remain refused, including inside code and regex source. Ambiguous quote contexts remain refused. Whole JSON-serialized fields retain the same distinction after decoding; TOON wrappers are recognized only in tracker text.

With `--json`, successful reports go to stdout; failures use the host CLI's JSON error envelope on stderr, with the redacted gate report serialized in `detail` (`jq ' .detail | fromjson ' gate-error.json`). Unreadable inputs produce a nonzero JSON refusal.

## Self-versioned workflows and Dependabot

Both reusable workflows resolve their own **exact** pm-github release version at
runtime and verify the installed package version. GitHub's documented
[`job.workflow_sha`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
is the commit of the workflow that defines the current job, including a reusable
workflow. `github.job_workflow_sha` is not a documented context property;
`job_workflow_sha` is an OIDC claim. The caller checkout and caller commit are
never used to discover the reusable workflow's version. These workflow identity
context properties are not available on GitHub Enterprise Server.

The resolver uses public `git ls-remote --tags https://github.com/unbraind/pm-github
'refs/tags/v*'`. It matches lightweight tags directly and annotated tags by their
peeled `^{}` commit (never the tag object), strips `v`, and requires an exact
numeric version `N.N.N` or `N.N.N-N`. It reads all matching refs in one request,
without API pagination or new credentials. Lookup errors and multiple release
versions on one commit fail closed. Release version discovery needs no GitHub App, and no release-time workflow
stamping is required. The release workflow keeps its existing token behavior.

Pin **release commit SHAs**, with their matching tag in a same-line comment
(for example `uses: unbraind/pm-github/.github/workflows/pm-github-sync.yml@<40-character-release-sha> # v2026.10.16`).
New callers omit `pm-github-version`. If no release tag matches the workflow
commit, the job fails with instructions to pin a release SHA. For compatibility,
a nonempty deprecated input provides an exact-version fallback with a warning
only when no tag matches. If a tag matches and the input differs, the job warns
and uses the tag version. Untrusted input is passed through `env:`, never inserted
into shell source or warning text. No `latest`, range, or floating install tag is used.

GitHub documents [reusable-workflow updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/auto-update-actions)
and [SHA pins and same-line version comments](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#github-actions).
Dependabot updates SHA-pinned remote `uses:` references and their version comments
when the pinned commit has a matching release tag. GitHub warns that untagged
commits can instead advance to the latest commit, which may differ from the latest
release. A SHA update therefore selects the new runtime-resolved install version without
editing any caller input.

Merge this entry into the caller's `.github/dependabot.yml` (retain other ecosystems
and disjoint groups such as `codeql-action`):

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "daily"
    open-pull-requests-limit: 5
    groups:
      pm-toolchain:
        patterns:
          - "unbraind/pm-github"
        # No update-types filter: calendar-version year changes must also update.
    commit-message:
      prefix: "chore"
      include: "scope"
    labels:
      - "dependencies"
      - "github_actions"
```

The group pattern is the repository name, covering both reusable workflow paths.
Use exactly `pm-toolchain`: the fleet's existing
[dependabot-auto-merge.yml](.github/workflows/dependabot-auto-merge.yml) enables
`gh pr merge --auto --squash` for Dependabot PRs in that group, including calendar
version major changes. The workflow checks the Dependabot author and repository
owner, then the metadata group or minor/patch update type. Commit prefix and
labels do not control merge eligibility; the explicit values above keep PRs
consistent. Ensure the two labels exist (GitHub ignores unknown custom labels).
Repository auto-merge must be enabled and required branch-protection checks must
pass; this configuration does not bypass them. It uses the existing workflow's
`contents: write` and `pull-requests: write` token permissions. See GitHub's
[Dependabot option definitions](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
for schedules, groups, commit messages and labels.

## Automated closeout workflow

[`.github/workflows/pm-github-closeout.yml`](.github/workflows/pm-github-closeout.yml)
is a reusable `workflow_call` that opens or updates **one** PR titled
`chore(pm): close items delivered by merged pull requests` from `pm-github/closeout`.
Copy [the caller template](docs/closeout-workflow-caller.yml) into the caller's
workflows directory and replace `RELEASE_COMMIT_SHA` with a reviewed release
commit and `vRELEASE_VERSION` with its matching release tag containing
`github closeout`. The template schedules a daily run and allows manual dispatch.
Adopting callers is a separate change.

The workflow resolves the caller's default branch through the repository API,
with event metadata as fallback, and refuses other run refs before checkout.
This works for scheduled payloads without a `repository` object and for branches
such as `trunk` or `release/stable`. The caller's pinned PM CLI comes from
`npm ci --ignore-scripts` in `npm-project-dir` (default `.`), which must resolve
inside the workspace and contain `package.json`. The SDK resolves the tracker
from the repository root. The exact release version resolved from the workflow commit is installed and verified.

`required-checks` is an optional workflow input with an empty default. Set it to
all required context names, **one context name per line**, when the token cannot read
branch-protection or ruleset metadata, as is common with `GITHUB_TOKEN`:

```yaml
with:
  required-checks: |
    test (22)
    test (26)
```

Each line is trimmed and empty lines are ignored. Spaces within names such as
`CI / build` are preserved; names are never split on spaces. The workflow passes
the newline-joined list as one quoted command argument for TypeScript to parse.
Without a declaration, unavailable
metadata refuses closeout and prevents publishing a branch or PR. Keep this list
aligned with the caller's required checks; it is a caller-owned policy declaration.

Each run rebuilds the bot branch from the current default branch and invokes
`pm github closeout --since 1970-01-01 --apply --json`. Scanning all merge history
avoids losing deliveries during schedule outages; it costs more API reads for
large repositories. Terminal items are skipped and the command retains its
normal eligibility, child/epic, required-check and strict-close rules. Full
closeout reports stay in runner scratch storage. The PR body lists
actionable rows with item, PR number, action and code, plus skip counts by reason.
This compact summary passes its own privacy scan before publication. The caller's `post-closeout-script` defaults to `changelog:full`,
run through `npm run --if-present` in the npm project; empty disables it.
The script must emit the root `CHANGELOG.md` and remain inside the publication scope.

| Safety boundary | Closeout and sync parity |
| --- | --- |
| Entry and install | Caller default-branch guard, contained npm project, exact package version, SHA-pinned Actions, no persisted checkout credentials |
| Proposed publication | SDK-resolved tracker plus root changelog; setup, extension, lock and checkpoint files excluded; every changed path checked |
| Privacy | Same fail-closed full-context staged-diff scan after the caller script and immediately before commit; unreadable input refuses publication |
| Validation | Strict PM health; explicit item/history scope committed together |
| Branch and PR | Explicit force-with-lease against the observed bot ref; push only bot branch; owned PR lookup excludes forks |
| No-op | Zero closes or no tracker diff creates no remote branch or PR; caller-only drift unpublished; stale owned PR closed |
| CI and landing | Dispatch caller checks after publication and branch refresh; request protected squash auto-merge in App mode; report parked approval-required runs |

`ci-workflows` defaults to `ci.yml codeql.yml`, covering the fleet's CI and
CodeQL workflows without querying branch protection. An explicit list replaces
that inventory (use `ci.yaml` or `codeql.yaml` when appropriate). Missing files
emit a notice; existing files without a recognized `workflow_dispatch` trigger
emit a warning naming the one-line repair. Standard block triggers and compact
`on: workflow_dispatch` / `on: [pull_request, workflow_dispatch]` forms are
supported. Each dispatched workflow must emit its required context names on
that event. Zero dispatchable workflows fails; `""` deliberately disables both
dispatch and automatic landing. Dispatch errors fail the run.

GitHub does not evaluate `workflow_dispatch` job checks for PR branch rules,
even when those checks pass on the head SHA. For unattended landing, configure
`automation-app-client-id` and the optional `automation_app_private_key` secret.
After the local gates, the pinned official App-token action mints a token for
only the caller repository, with contents/pull-requests/actions write and
checks/statuses read. Publication and refresh use that token, so native
`pull_request` workflows run without the GITHUB_TOKEN approval prompt and
provide eligible required checks. Manual head dispatch remains additional
verification. Empty credentials retain GITHUB_TOKEN and emit a setup notice;
partial or failed App credentials stop publication. The private key is passed
only to the token action, after caller scripts have completed.

In App mode, after dispatch the workflow requests `gh pr merge --auto --squash`
with the expected head SHA. A repository that disallows auto-merge emits a notice.
Without an App, maintainers approve native PR runs, wait for required checks and
conversations, and merge with an authorized credential; the workflow does not arm
auto-merge.
GitHub enforces required checks and conversation resolution. The same run
polls once per minute: when the PR is `BEHIND`, it requests a branch update
against the expected head, then dispatches all selected workflows and, in App
mode, requests auto-merge again when the new head appears. App mode stops within
forty minutes, inside its token's one-hour lifetime; legacy mode has a two-hour bound. The
existing daily schedules and separate sync/closeout concurrency groups remain.
A base change after the monitor window waits for the next daily rebuild.
Unresolved conversations continue to block landing.

See [the caller audit and one-time setup](docs/bot-pr-automation.md) for the App
credential mapping, CodeQL trigger changes and explicit CI overrides. GitHub
documents [the token approval behavior](https://docs.github.com/en/actions/concepts/security/github_token)
and [why manual job checks do not satisfy PR branch rules](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

The caller template uses top-level `permissions: {}` and grants its
`gated-closeout` job only `contents: write`, `pull-requests: write`, `checks: read`
and `actions: write`. Closeout uses `checks: read` instead of sync's `issues: read`
to retrieve head-check evidence ([GitHub Checks API permissions](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)).
The reusable workflow cannot elevate the caller's token
permissions ([GitHub reusable workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)).
Repository Actions settings must allow Actions to create PRs. Read denial stops
closeout before push with a diagnostic, including `required_checks_unverified` and
unavailable head-check evidence
reported by the command as a skip when it blocks a local, existing, non-terminal,
non-excluded tracker item. Unlinked PRs and foreign/terminal/excluded links do
not fail the run for unavailable evidence. Incomplete merge facts use a separate
`incomplete_merge` refusal before any head lookup. The pinned extension must
emit plan decision codes; repin to a release containing this contract. A push/PR denial fails publication and
CI dispatch denial fails the job explicitly. A PR creation denial may leave the
gated bot branch pushed, and a dispatch denial leaves the review PR open; neither
case changes the default branch or merges anything. Explicit dispatch is used
for reliable caller CI invocation with `GITHUB_TOKEN`
([GitHub token event behavior](https://docs.github.com/en/actions/concepts/security/github_token)).

## Automated sync workflow

The reusable workflow's first step resolves the caller's default branch using the repository API with the job token, falling back to `github.event.repository.default_branch` only when present. Scheduled payloads need no `repository` object. If neither source provides a valid branch, the job fails closed with a clear error before checkout. It requires `github.ref` to equal `refs/heads/<resolved-default-branch>`. A mismatch fails before checkout or any sync operation with a one-line error naming both refs. Scheduled calls and manual `workflow_dispatch` calls on the default branch are accepted; manual dispatches selecting another branch are refused. Checkout, sync-branch preparation, PR lookup/base and tracker links all use that resolved branch, including defaults such as `trunk` or `release/stable`. Callers need no guard of their own. Repin the reusable workflow to a release commit containing this guard to receive it.

Fleet repos sync their issues into pm through ONE audited implementation: the reusable `workflow_call` workflow at [`.github/workflows/pm-github-sync.yml`](.github/workflows/pm-github-sync.yml). Its safety order is validate → dry-run plan → **gated import** → verify the repeat import is a no-op → caller post-import script → **full changed-path scope check and privacy gate** → strict health → repeat scope check and scan immediately before commit/push/review PR → caller CI dispatch. The default `post-import-script` is `changelog:full`, invoked with `npm run --if-present`: it runs the caller's own generator when present, so imported closed issues and their changelog entries land in the same commit. Actions are pinned by commit SHA. The job requests `contents: write`, `pull-requests: write`, `issues: read`, and `actions: write` for dispatch.

When the tracker has no changes, regenerated `CHANGELOG.md` drift is discarded and the run emits a notice that the caller's own `changelog:check` owns that drift. The sync closes any owned open review PR and exits successfully without pushing or dispatching CI. Changelog changes are published only together with tracker changes.

Before extension and attributes setup, both reusable maintenance workflows require `.gitattributes` and the tracker’s `extensions/.managed-extensions.json` to match the checkout, including the index and ignored untracked files. Immediately after setup they save the runtime artifacts outside the checkout, then restore original tracked bytes or remove setup-created files before any privacy or publication scan. Strict health temporarily uses the saved runtime files after checking that both paths still match the baseline; an exit trap restores the baseline even when health fails. No caller script runs inside either setup window. Preexisting edits and later caller edits to either artifact fail closed and remain untouched, including ignored files. The publication allowlist stays unchanged. Callers receive the fix through their Dependabot workflow pins.

The explicit allowed scope for changed paths is:

- Files beneath the SDK-resolved repository-local pm tracker, excluding its `extensions/`, `locks/`, and `checkpoints/` runtime directories. The extension setup files `settings.json` and `history/_workspace.jsonl` are permitted during setup, then restored before publication and excluded from both the scan and commit.
- The repository-root `CHANGELOG.md`.

After the caller script and again immediately before committing, `git status --porcelain=v1 -z --untracked-files=all` enumerates staged, unstaged, and untracked changes, including both sides of renames. Every path outside this list produces an error and prevents publication. Allowed changes are staged and the privacy gate scans the exact NUL-delimited path list passed to `git commit --only --pathspec-from-file` with literal pathspecs. The final scan is regenerated from current content; any finding, unreadable input, or script failure prevents publication. The restricted commit also excludes unrelated staged content if a scope check is bypassed.

Optional inputs:

| Input | Default | Behavior |
| --- | --- | --- |
| `adopt-cited` | `false` | Explicitly enable conservative normalized citation adoption for preview, import and repeat verification. Primary prevention is creating items with `gh:owner/repo#N` tags. Leave false to retain normal creates with read-only candidate hints. |
| `npm-project-dir` | `.` | Relative npm project directory for `npm ci --ignore-scripts`, the CLI `node_modules/.bin` PATH entry, and `post-import-script`. Must have `package.json`, contain no `..` segments, and resolve inside the workspace (including symlinks); invalid paths fail before caching/install. The tracker and publication scope stay at the repository root. |
| `post-import-script` | `changelog:full` | Caller npm script name invoked with `npm run --if-present` after import and before the final scan. Override for a different package script, or set `""` to disable. Missing scripts are skipped. Raw shell commands are not accepted. Generated `CHANGELOG.md` is staged with the tracker. Changing any file outside the documented scope fails the run, whether staged, unstaged, or untracked. |
| `automation-app-client-id` | `""` | Optional GitHub App client ID, paired with the `automation_app_private_key` workflow-call secret. Enables eligible native PR runs through a fresh repo-scoped token; absent credentials retain GITHUB_TOKEN with a notice. |
| `ci-workflows` | `ci.yml codeql.yml` | Explicit whitespace-separated filename override in the caller's `.github/workflows`. Missing/non-dispatchable workflows are reported; zero dispatchable workflows fails. Empty disables dispatch and auto-merge. See the CI and landing contract above. |

A fleet repo owns the schedule and calls it with a pinned release SHA (see [`docs/sync-workflow-caller.yml`](docs/sync-workflow-caller.yml)):

```yaml
name: Sync GitHub issues into pm
on:
  schedule:
    - cron: "17 2 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: read
  actions: write

jobs:
  gated-sync:
    uses: unbraind/pm-github/.github/workflows/pm-github-sync.yml@RELEASE_COMMIT_SHA # vRELEASE_VERSION
    with:
      automation-app-client-id: ${{ vars.PM_GITHUB_APP_CLIENT_ID }}
      adopt-cited: false # Tag new items gh:owner/repo#N; opt in only for deliberate adoption.
    secrets:
      automation_app_private_key: ${{ secrets.PM_GITHUB_APP_PRIVATE_KEY }}
```

Replace `RELEASE_COMMIT_SHA` with a reviewed release commit containing this change and `vRELEASE_VERSION` with its matching tag. Configure [Dependabot](#self-versioned-workflows-and-dependabot) to maintain future pins automatically. The selected npm project needs a committed npm lockfile (`package-lock.json` or `npm-shrinkwrap.json`) and `@unbrained/pm-cli` as a devDependency (the workflow's `npm ci` provides the CLI) and its pm tracker at `.agents/pm` committed on the caller's default branch. Under **Settings → Actions → General → Workflow permissions** it must allow read and write token permissions and enable **Allow GitHub Actions to create and approve pull requests** (an organization can disable this), or the run pushes the sync branch and then fails to open the review PR. The caller must grant `actions: write`; a reusable workflow cannot elevate its caller's permissions.

For a caller such as `unbraind/pm-rust` with no root `package.json`, add
`npm-project-dir: tests/oracle` under `with:`. Its `tests/oracle/package.json`
provides the CLI and post-import npm script; Git and pm tracker operations still
run from the repository root. A script that regenerates the changelog must write
the repository-root `CHANGELOG.md` to stay within the publication allowlist.

Bot-created PRs using GITHUB_TOKEN may have `pull_request` runs parked in
`action_required`. The optional App token makes publication and branch refresh
start native eligible PR workflows automatically. Configured manual workflows
are also dispatched on the bot head; these jobs are additional verification,
because GitHub excludes manual job checks from PR branch-rule evaluation. Each
manual workflow must support `workflow_dispatch` and produce its intended check
names on that event. Parked-run notices include their URLs. A no-change sync
closes its stale owned review PR and dispatches nothing. See GitHub's
[token event rules](https://docs.github.com/en/actions/concepts/security/github_token)
and [required-check eligibility](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

### Installed CLI timeout acceptance

`node test/helpers/public-acceptance.ts` packs the candidate, installs it beside
its pinned host CLI in a disposable Git project, retrieves a paginated public
issue/comment snapshot, and replays the unchanged responses through the installed
HTTP client. It verifies a nonempty gated Node import, byte-identical Node and
three native Bun repeats, and strict health. No remote is configured.

Each import retains the original 45-second execution deadline. The acceptance
watchdog sends SIGTERM to the process group, then SIGKILL after a five-second
cleanup window; any timeout fails acceptance even if the child later exits zero.
A real spinning-child negative control verifies forced cleanup and unchanged
fixture bytes. The HTTP client also enforces a 30-second wall-clock deadline through redirect
and response-body completion, even when native socket timeouts do not fire.
The comment-lock retry honors its existing wait budget when
an exclusive-create collision cannot be statted, including a dangling symlink.
This reproduced lock defect is separate from the intermittent historical Bun
repeat: recent packed repeats pass, but its original cause is not established.

## Validate / diagnostics

### `pm github validate`

Read-only check of the integration: `gh` CLI presence, token resolvability (and source), and—with `--repo`—repo accessibility. When `--repo` is given it also surfaces the remaining GitHub API quota (`X-RateLimit-Remaining`/`Limit`/`Reset`) and warns when the quota is running low. Never mutates anything.

```bash
pm github validate
pm github validate --repo owner/repo
pm --json github validate --repo owner/repo
```

## License

MIT

## Release Automation

Release checks require type checking, docstrings, ESLint, zero source duplication, exact 100/100/100/100 coverage across authored TypeScript and JavaScript modules including operational scripts, production dependency audit, package packing, Bun behavior, strict PM health, and pm-changelog validation. Unloaded modules count at zero; no source ignores or lowered thresholds are accepted. Coverage shortfalls block release. The shell changelog-date verifier is exercised separately and is outside the V8 percentage denominator. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

`npm run changelog:full` reads the complete tracker through the SDK and feeds pm-changelog. Closed work supplies release history; the explicit `changelog-unreleased` tag includes a pending candidate without closing its PM item. Other open work stays excluded.

Daily Release measures the successful `test (22)` and `test (26)` jobs from the last 20 successful main push CI runs. Its merge wait is the nearest-rank p95 duration plus the larger of 15 minutes or 25%, bounded to 60–120 minutes. Missing history uses the 60-minute floor. The log and job summary record the samples, p95, margin and bounds; the job timeout is 360 minutes.

A main advance during preparation or waiting can update the release branch once. Every intervening commit must preserve `package.json` and lockfile release versions, `CHANGELOG.md`, `manifest.json`, and release notes, including changes later reverted. Dependency-only changes are eligible. A conflict, metadata change, non-ancestor main, or second advance aborts. A successful update uses a head-specific push lease, restarts the full measured wait, and requires protected checks on the new head. Publication still verifies the merged commit and runs the release gate again.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly. The driver definitions live in per-clone Git config; `npm install` /
`npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run
manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

## What an imported issue looks like

An issue owned by the GitHub importer keeps GitHub's creation and closure dates in the native lifecycle fields used by momentum and cycle-time readers. The import records a new, append-only before/after history event at the time of synchronization; it does not rewrite old events. The public SDK's high-level create/update commands reserve these dates, so finalization uses its public item lock, serialization and history primitives.

```yaml
status: closed
created_at: "2026-09-02T10:00:00Z"
updated_at: "2026-10-16T12:00:00Z"
closed_at: "2026-09-04T12:00:00Z"
completed_at: "2026-09-04T12:00:00Z"
close_reason: 'Closed on GitHub as completed on 2026-09-04T12:00:00Z; closing PR https://github.com/example/project/pull/8 ("Restore the parser")'
release: v2026.9.5
github_url: https://github.com/example/project/issues/7
github_number: 7
github_state: closed
github_state_reason: completed
github_created_at: "2026-09-02T10:00:00Z"
github_updated_at: "2026-09-04T12:00:00Z"
github_closed_at: "2026-09-04T12:00:00Z"
github_release: v2026.9.5
github_link_only: false
```

`completed` maps to `closed`; `not_planned` and `duplicate` map to `canceled`. An open or reopened issue maps to `open` and clears old closure evidence and import-assigned release attribution. A closure reason names the closing commit from the REST timeline or closing PR/commit identified by GraphQL `ClosedEvent`, when available. A `ConnectedEvent` supplies a quoted linked PR without claiming that the association caused the closure. Otherwise it says `Closed on GitHub as <reason> on <date>`. Closing a report alone does not establish that its described defect or privacy exposure was repaired.

Release attribution uses the actual dates of locally available calendar tags, including annotated tag dates. A closed issue belongs to the first tag at or after its closure: before the first tag goes to that first release, between two tags goes to the second, and after the latest tag remains pending. Fetch the complete tag history before importing; the reusable sync workflow already does this. Regenerate with pm-changelog's `--respect-item-release` so a historical import stays in its declared release window.

Before creating an item, import checks the complete tracker for its provenance tag, GitHub URLs in provenance or link metadata, and Linear/Jira/ADO links referenced by the GitHub issue body. A unique existing external owner receives the GitHub tag and source metadata; its title, body, provider identity, creation/completion dates and release remain intact. A persisted `github_link_only` marker preserves that ownership on subsequent syncs. Free-text descriptions and bodies do not declare GitHub ownership. Ambiguous matches refuse the import before writes with `--gate` or `--atomic`. A plain multi-issue import may write earlier issues before rejecting a later ambiguous match.

With `--gate` and a nonempty filtered issue list, both preview and apply results include a `plan` with source dates, closure reason, release, target identity, link/create/update action and state-conflict decision. An empty filtered issue list returns without a `plan`, including with `--gate --dry-run`. GitHub wins lifecycle conflicts for GitHub-owned imports. A canceled item that GitHub later reports as completed uses the SDK's explicit repeat-closure transition with the source reason. A linked external owner keeps its local status, and the plan records `preserve-provider-owner`; `github_state` still records the source state. Atomic transaction identity includes the latest external edit or different lifecycle generation in history. Local state edits and repeated state cycles force reconciliation, while staging and compensation keep crash retries on the same journal. Finalization runs before the SDK commits and is compensated with the batch on failure. It is idempotent and runs again after a recovered atomic journal, so an interrupted finalization can be repaired by retrying the same import before the gate permits a push.

SDK limitation: native `updated_at` remains the local mutation clock because the bulk SDK uses it to address rollback history. The GitHub update date is retained exactly in `github_updated_at`, and the gated plan discloses this policy. Backdating native `updated_at` safely requires an SDK import mutation whose version identity is independent of source time. Native creation, closure and completion dates still preserve GitHub lifetimes for momentum and cycle-time readers.

## Provider identity collisions

Use `pm github identity --json` for a bounded offline graph of conflicting
`external_ref`, GitHub provenance tags and native/provider ownership. Copied
prose appears as a weaker mention; genuine provider links retain distinct
ownership evidence. Inspect one group with
`pm github identity --identity 'gh:example/project#7'`.

Preview a narrowly scoped repair with `--identity`, `--owner` and `--detach`;
apply only after reviewing its exact `--approve` digest. Ambiguous identities
refuse with typed remedies. The SDK supplies complete reads, semantic preview,
writer transactions, immutable audit history and idempotent replay. See the
[worked example and SDK contracts](docs/identity-collisions.md).

# Cited issue adoption validation

The importer first resolves established provenance tags, structured URLs and
provider back-links. Only an issue without an established owner reaches exact
title/description/body citation matching. Only a single-target item with explicit
fix/track intent or a title reference is eligible. One eligible candidate is
adopted; multiple eligible candidates refuse the batch before any writes and report `ambiguous_citation`
with candidate IDs and a tagging remedy. Status push, export and Projects
matching retain their existing scope.

Incidental references carry `citation_candidates` hints with item IDs and
`missing_intent` or `multiple_issues` reasons. They never hand status or fields
to the importer; the GitHub issue imports normally into its own item.

## Public tracker dry runs

Validation used GitHub API tracker archives copied into plain directories with
no Git repository. Original archive files were made read-only and every original
file's SHA-256 was checked after the dry run. SDK runtime caches are separate
from those original tracked files. No source repository or tracker was changed.
Live issue and closure-timeline data came from GitHub; no issue payload was
rewritten for the replay.

| Repository and tracker revision | Issues fetched/planned | Create | Update | Adopt | Skip | Original files unchanged |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| pm-review current main `e1fc83a81507ca6a91f1675b74863c050f1a89f1` | 1 / 1 | 0 | 1 | 0 | 0 | 106 / 106 |
| pm-review pre-tag history `f72250e4c5ee8dfafaf57ee8afe20ddd3cbc993e` | 1 / 1 | 0 | 0 | 1 | 0 | 106 / 106 |
| pm-context current main `7d7479ae77c13d01c54b2b4560ad54091ffed788` | 5 / 5 | 2 | 3 | 0 | 0 | 181 / 181 |

The requested pm-review current-main check now correctly plans an **update**:
[PR 33](https://github.com/unbraind/pm-review/pull/33) already added the issue's
provenance tag after the duplicate-import incident. Claiming an adopt on that
untouched snapshot would contradict structured-identity precedence. Replaying
the actual [pre-tag tracker](https://github.com/unbraind/pm-review/tree/f72250e4c5ee8dfafaf57ee8afe20ddd3cbc993e/.agents/pm)
produces this adoption entry:

The pre-tag item's description says `Fix` followed by the issue URL and its body
says `Issue:` followed by the same URL. Those are two references to one distinct
issue with explicit intent, so the tightened ownership rule still adopts it.

```json
{
  "issue": 30,
  "item": "pm-review-withdrawn-lineage",
  "action": "adopt",
  "status": "closed",
  "github_url": "https://github.com/unbraind/pm-review/issues/30",
  "github_number": 30,
  "identity": {
    "via": "citation",
    "conflict": {
      "local": "in_progress",
      "github": "closed",
      "rule": "github-source-wins"
    }
  }
}
```

Its gated idempotency receipt reports `adopted: 1`, `matched_by_provenance: 0`
and `new_entries: 0`. The current-main receipt reports `adopted: 0`,
`matched_by_provenance: 1` and `new_entries: 0`.

Both pm-review runs used `github import unbraind/pm-review --issue 30 --atomic
--gate --dry-run`. The second public repository used `github import
unbraind/pm-context --state all --limit 5 --atomic --gate --dry-run`; it fetched
issues 154, 153, 136, 53 and 81, reported `truncated: false`, and preserved the
`not_planned` issue's canceled status. These were planner dry runs, not
post-write privacy-scan receipts.

## Regression evidence

`test/cited-issue-adoption.test.ts` uses real initialized trackers and real CLI
or SDK writes. Plain and atomic non-git cases run with a PATH containing only
Node and the pinned pm CLI. Gate write cases use disposable Git repositories.
Assertions cover single-candidate adoption, terminal candidates, no duplicate
on retry, ambiguity before any batch write, URL punctuation, repository and
issue-number boundaries, colon-prefixed labels and sentence-ending question marks,
structured ownership precedence, provider link-only behavior, separate adoption
counts and opt-out. Review regressions also prove these ownership boundaries:

| Finding | Fixed behavior and persistence evidence |
| --- | --- |
| A closed item says only `Related: acme/widgets#30` while issue 30 is open | Import creates the issue item and reports `missing_intent`; the original item's entire SDK projection, including status/body/closure fields, is unchanged |
| A roadmap cites issues 30 and 31 | Selecting either issue alone creates its own item and reports `multiple_issues`; the roadmap stays open and unchanged |
| References span repositories or fields | All distinct identities count, including title references and URL query/fragment forms; repeated URL/shorthand for the same identity counts once |
| Intent-bearing single-issue owners compete | Two eligible owners still refuse writes; incidental hints are reported separately and never create ambiguity |

`test/import-selection.test.ts` installs the built package into a disposable
consumer and exercises the actual CLI dispatch, including the advertised
`--no-adopt-cited` flag and its create-versus-adopt behavior.

Review revert proofs used an isolated source copy and restored only
`citesIssue` and `matchImportedIssue` from pre-review head `4220a37`, leaving the
new planner/receipt code and real SDK persistence unchanged. Neither proof
changed the package worktree or rebuilt a stale artifact: tests import live TS.

| Exact test selection | Reverted result | Fixed result |
| --- | --- | --- |
| `node --test --test-name-pattern='closed incidental item' test/cited-issue-adoption.test.ts` | 2 failures, 0 passes, exit 1 | Both plain/atomic cases pass |
| `node --test --test-name-pattern='roadmap never adopts' test/cited-issue-adoption.test.ts` | 2 failures, 0 passes, exit 1 | Both plain/atomic cases pass |

`node --test test/cited-issue-adoption.test.ts test/import-regex.test.ts` passes
28 tests with zero failures/skips. The PM-linked adoption command also passes
21 tests. Typecheck, test typecheck, build, lint, docstrings and strict tracker
health pass locally. Full npm/Bun release-gate evidence is recorded in PR 169
and the final handoff at the exact pushed head; thresholds remain unchanged.

## Reference-parser review follow-up

The second review found that `Fixes acme/widgets#30 and
https://github.com/acme/widgets/issues/31/` could still transfer ownership:
the earlier counting regex skipped the trailing-slash URL. A shared parser now
produces the identities and source positions used by both distinct-target
counting and intent checks. It recognizes qualified shorthand, repository-hinted
bare `#N`, issue and PR URLs, optional trailing slashes, query strings, comment
fragments, prose punctuation and Markdown link boundaries. Foreign and malformed
URLs are consumed as URL tokens so their interior hash text cannot masquerade
as a separate reference. Bare numbers and PR URLs count toward additional
targets but cannot establish issue ownership on their own.

The property-style regression exercises 17 ownership forms against 35 second
reference forms with five punctuation/Markdown wrappers in all three prose
fields: **8,925 disqualification combinations**, plus **51 positive ownership
controls**. The matrix includes issue and PR links, other repositories, slash,
query and fragment combinations, and Markdown links adjacent to following text.
Repeated URL/shorthand/bare references to the same identity remain one target.

Plain and atomic real non-git tracker regressions reproduce the reported
trailing-slash example. They require one create, zero adopts and a
`multiple_issues` candidate hint, then verify that the entire original roadmap
projection remains unchanged after import.

The isolated behavioral revert restores only `citesIssue` from `cce11c4`, leaving
the new parser, planner, receipts and real SDK persistence present. Running
`node --test --test-name-pattern='every accepted second-reference|trailing-slash second reference' test/cited-issue-adoption.test.ts`
then produces **3 failures, 0 passes, 0 skips, exit 1**. The fixed cases pass.
The complete adoption/regex selection passes **32/32**; the linked adoption
command contains **25 tests**. Fresh exact-head npm/Bun release evidence is
recorded in PR 169 when CI completes, without changing coverage thresholds.

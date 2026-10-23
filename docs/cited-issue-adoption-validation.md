# Cited issue adoption validation

The importer first resolves established provenance tags, structured URLs and
provider back-links. Only an issue without an established owner reaches exact
title/description/body citation matching. One candidate is adopted; multiple
candidates refuse the batch before any writes and report `ambiguous_citation`
with candidate IDs and a tagging remedy. Status push, export and Projects
matching retain their existing scope.

## Public tracker dry runs

Validation used GitHub API tracker archives copied into plain directories with
no Git repository. Original archive files were made read-only and every original
file's SHA-256 was checked after the dry run. SDK runtime caches are separate
from those original tracked files. No source repository or tracker was changed.
Live issue and closure-timeline data came from GitHub; no issue payload was
rewritten for the replay.

| Repository and tracker revision | Issues fetched/planned | Create | Update | Adopt | Skip | Original files unchanged |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| pm-review current main `aa16d855df1f7b74afd3453617f77e92c44d493e` | 1 / 1 | 0 | 1 | 0 | 0 | 106 / 106 |
| pm-review pre-tag history `f72250e4c5ee8dfafaf57ee8afe20ddd3cbc993e` | 1 / 1 | 0 | 0 | 1 | 0 | 106 / 106 |
| pm-context current main `8d9576778a3609f156e9444ed659ca7c2e2aa9e7` | 5 / 5 | 2 | 3 | 0 | 0 | 181 / 181 |

The requested pm-review current-main check now correctly plans an **update**:
[PR 33](https://github.com/unbraind/pm-review/pull/33) already added the issue's
provenance tag after the duplicate-import incident. Claiming an adopt on that
untouched snapshot would contradict structured-identity precedence. Replaying
the actual [pre-tag tracker](https://github.com/unbraind/pm-review/tree/f72250e4c5ee8dfafaf57ee8afe20ddd3cbc993e/.agents/pm)
produces this adoption entry:

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
structured ownership precedence, provider link-only
behavior, separate adoption counts, opt-out, and conflicting batch targets.

`test/import-selection.test.ts` installs the built package into a disposable
consumer and exercises the actual CLI dispatch, including the advertised
`--no-adopt-cited` flag and its create-versus-adopt behavior.

Behavioral revert proof copied the current source and test into an isolated
scratch package, then restored **only** `matchImportedIssue` from base main.
`node --test test/cited-issue-adoption.test.ts` exited 1 with 10 failures and
4 passes, versus 14 passes with the fix; neither run skipped tests. The fixed
worktree was untouched. Tests import live TypeScript, so no compiled artifact
could mask the revert.

A focused punctuation revert restored only `citesIssue` to the preceding
implementation while retaining adoption and the expanded regression cases.
The four pure matching checks then produced 1 failure and 3 passes; the fixed
helper passes all four. This specifically proves colon-prefixed labels and
sentence-ending question marks are accepted without admitting URL queries.

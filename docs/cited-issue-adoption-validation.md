# Cited issue adoption validation

The importer first resolves established provenance tags, structured URLs and
provider back-links. Only an issue without an established owner reaches exact
title/description/body citation matching. Only a single-target item with explicit
fix/track intent or a title reference is eligible. One eligible candidate is
adopted; multiple eligible candidates refuse the batch before any writes and report `ambiguous_citation`
with candidate IDs and a tagging remedy. Status push, export and Projects
matching retain their existing scope.

Citation adoption now has a separate conservative exclusion check. Every raw
reference must carry the importing repository and canonical number. The scan
collects GitHub issue/PR paths and qualified shorthand regardless of Markdown;
unqualified `issues/<digits>`, `pull/<digits>` and `#<digits>` have UNKNOWN
repository and veto adoption. The item projection carries no verified owning
repository, so the import argument cannot assign bare hashes to this repository.
Foreign references with the same number also veto adoption. The strict parser
and explicit intent still establish positive ownership; passing the raw veto
alone is insufficient. This intentionally prefers a normal create over taking
another item.

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
38 tests with zero failures/skips. The PM-linked adoption command contains
30 tests and the linked regex/performance command contains eight. Typecheck,
test typecheck, build, lint, docstrings and strict tracker
health pass locally. Full npm/Bun release-gate evidence is recorded in PR 169
and the final handoff at the exact pushed head; thresholds remain unchanged.

## Reference-parser review follow-up

The second review found that `Fixes acme/widgets#30 and
https://github.com/acme/widgets/issues/31/` could still transfer ownership:
the earlier counting regex skipped the trailing-slash URL. A shared strict parser
produces identities and source positions for positive ownership checks. It
recognizes qualified shorthand, repository-hinted
bare `#N`, issue and PR URLs, optional trailing slashes, query strings, comment
fragments, prose punctuation and Markdown link boundaries. Foreign and malformed
URLs are consumed as URL tokens during strict parsing. The independent raw
exclusion deliberately counts their interior number substrings anyway. Bare
numbers and PR URLs cannot establish issue ownership on their own.

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
The current adoption/regex selection contains **38 tests**; the linked adoption
command contains **30 tests**. Fresh exact-head npm/Bun release evidence is
recorded in PR 169 when CI completes, without changing coverage thresholds.

CodeQL then identified quadratic backtracking in the new URL punctuation
suffix regex. The parser now calls the existing backwards punctuation scanner
with its citation delimiter set, leaving the default structured-locator set
unchanged. The additional adversarial test sends a URL followed by 50,000
exclamation marks and a non-punctuation sentinel through the real matcher. Its
best of three local trials is **0.172 ms**, below the existing 50 ms guard.
Restoring only `citationReferences` from `ef325ba` retains the new scanner and
test but restores the vulnerable regex call: the test then fails at
**3,670.058 ms** (one failure, zero passes/skips, exit 1). These timings are local
regression evidence, not a deployment benchmark. A fresh pushed head receives
new release-gate and CodeQL evidence.

## Raw exclusion review follow-up

The third review showed that bold emphasis could hide a second URL from strict
parsing. Exclusion now scans raw text separately: every `issues/<digits>`,
`pull/<digits>` and `#<digits>` substring must equal the imported issue's
canonical number. The scan has no markup or trailing-character boundaries and
does not require a GitHub host or repository. Noncanonical digit spellings can
also veto adoption conservatively. The strict parser and explicit intent remain
the positive ownership check, with the existing repository-identity safeguard.

Eight fixed decorations (bold, italic, underscore, code span, code fence, angle
brackets, Markdown link and image link) wrap eight reference cores in every
field: **192 fixed cases**. A deterministic xorshift generator with seed
`0x6c8e9cf5` produces **4,096 nested decoration samples**, each checked in title,
description and body: **12,288 property cases**. Another 36 cases require
over-counting unrelated text, foreign/malformed URLs, trailing letters, zero,
noncanonical spelling and very large digit strings. Four repeated-number
controls were eligible under that historical number-only rule; the fourth
review below changes them to UNKNOWN-repository refusals. The earlier 8,925-case shape matrix and all earlier
regression inputs remain present. Three old foreign/malformed-URL expectations
now require refusal because the raw policy intentionally counts their `#31`
substrings; the encoded query case remains unchanged.

Plain and atomic non-git tracker tests reproduce the exact bold-URL example.
The gated preview plans one create, zero adopts and a `multiple_issues` hint.
Actual imports preserve the entire original open item's SDK projection and
create a separate issue item.

The behavioral revert restores only `citesIssue` from `56580ec`, retaining the
new raw scanner, strict parser, current tests, receipts and real SDK persistence.
`node --test --test-name-pattern='raw exclusion' test/cited-issue-adoption.test.ts`
then fails **5/5**, with zero passes/skips and exit 1. Fixed linked commands pass
**30/30 adoption tests** and **8/8 regex/performance tests**.

The saved public tracker snapshots were replayed with this raw exclusion and
live GitHub reads: pm-review pre-tag still plans one adopt; its tagged snapshot
plans one update; the same five pm-context issues plan two creates and three
updates, with three `missing_intent` hints and no adopts/skips. All **393/393
original files** remain unchanged. Fresh release-gate and CodeQL evidence is
linked from PR 169 at the final pushed head.

## Repository-aware raw exclusion

The fourth review reproduced a foreign reference hidden in bold with the same
number as the target: `Fixes acme/widgets#30 and
**https://github.com/other/widgets/issues/30**`. A number-only veto could not
protect that item. Raw exclusion now retains each qualified reference's
repository and canonical number. GitHub issue/PR URL substrings and qualified
shorthand are consumed before their embedded fallback, so they are counted
once. Every collected reference must equal the target repository and number;
foreign repositories, other numbers and UNKNOWN repositories all veto adoption.
The raw path/hash fallback is retained even for malformed or unrelated text.
No Markdown normalization or trailing-character boundary is used.

The item projection carries no verified owning repository. Bare hashes therefore
remain UNKNOWN, even beside a qualified target citation. The import repository
is not proof of the item's repository. Four historical number-only controls and
the prior bare-hash deduplication input now require refusal; their inputs remain
in the suite. Qualified repeated references, case-insensitive repository names
and same-repository/same-number PR links remain allowed by exclusion, while the
strict positive parser and explicit issue ownership intent remain necessary.

New fixed coverage checks four foreign same-number issue/PR/shorthand references
inside all twelve decoration pairs from the property test, in title,
description and body: **144 cases**. A deterministic xorshift generator seeded
with `0x78b3e2d1` creates **4,096 random repository/number/nested-decoration
samples**, each checked in all three fields: **12,288 cases**. Every generated
second reference has a foreign repository, another number or UNKNOWN attribution
and must refuse adoption. The earlier shape/property matrices remain present.
Plain and atomic no-git imports test the exact bold-foreign-URL reproduction
against a closed local item and an open issue. Both preview a create and
`multiple_issues` candidate hint, then create a separate item without reopening
or changing the completed local item.

Behavioral revert: restore only `hasOtherCitationNumber` and `citesIssue` from
`aa86b21` in an isolated source copy, keeping current tests, strict parsing,
receipts and real SDK persistence. Run
`node --test --test-name-pattern='repository veto' test/cited-issue-adoption.test.ts`.
The revert gives **5 failures, 0 passes, 0 skips, exit 1**. Fixed linked commands
pass **35/35 adoption tests** and **8/8 regex/performance tests**. Typecheck,
TypeScript builds, lint, docstrings and duplication checks pass locally; release
gates on both npm and Bun are checked in CI at the final pushed head.

Public replay with this rule still plans the pre-tag pm-review adopt into
`pm-review-withdrawn-lineage`; its tagged snapshot plans one update. The same
five pm-context issues still plan two creates and three updates, with no
adopts/skips. The three candidate hints now report `multiple_issues` because raw
UNKNOWN references veto before intent. All **393/393 original tracker files**
retain their SHA-256 hashes. These are the saved main/pre-tag revisions listed
above, replayed with live GitHub issue/timeline reads; no current-main claim is
made for the replay. Exact-head CI run links and counts are in PR 169.

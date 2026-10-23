# Cited issue adoption validation

## Final policy

The primary duplicate prevention is to create issue work items with
`gh:owner/repo#N` tags. Citation adoption is **off by default**. CLI
`--adopt-cited`, SDK `adoptCited: true`, or reusable sync input `adopt-cited: true`
explicitly enables it. The workflow input defaults to false and is passed to
preview, gated import and repeat verification consistently.

Default imports retain normal create behavior and established tag/structured
URL/provider matching. They add read-only `citation_candidates` hints. Multiple
eligible prose candidates never trigger fallback ambiguity refusal by default.
Their local fields and status remain unchanged, including closed items.

Before citation checks, named/numeric HTML entities and percent bytes are
repeatedly decoded with a bound of eight passes. NFKC normalization and
zero-width/bidi control removal apply too. Markdown destinations/reference
definitions are unwrapped and soft lines joined for ownership matching. The
normalized source is retained alongside the unwrapped/joined views for
exclusion so labels, definitions and split references cannot disappear. A bound
exhaustion refuses adoption with `normalization_limit`.

An opt-in adoption requires a qualified reference in the title, a closing
keyword followed by the reference at the start of the description, or a whole
body line `Issue: <url>` / `Tracks: <url>`. Closing keywords are
Fix/Fixes/Fixed, Close/Closes/Closed and Resolve/Resolves/Resolved. Related
mentions, body fix phrases and unanchored descriptions do not authorize
ownership. Any other normalized GitHub URL, repository, issue number or
unattributable reference refuses adoption. PR URLs are other URLs, even with
the same number. Bare hashes remain UNKNOWN because this item projection has
no verified owning-repository context. Conservative refusals preserve normal
create behavior; arbitrary prose remains weaker evidence than an explicit tag.

One eligible owner with opt-in receives an `adopt` plan and normal upsert.
Multiple eligible owners with opt-in refuse writes with typed
`ambiguous_citation`, IDs and a tagging remedy. Receipts expose `wouldAdopt` /
`adopted`; gated idempotency counts one existing landing item. Status push,
export and Projects matching retain their scope.

## Regression evidence

All earlier review reproductions remain, with adoption scenarios explicitly
opting in and former permissive positives retained as refusal inputs where the
anchored policy requires it. Prior shape/property matrices remain present.

| Review case | Opt-in result |
| --- | --- |
| Closed item with only `Related: acme/widgets#30` | Create with `missing_intent`, never reopen local work |
| Roadmap cites issues 30 and 31 | Create for either issue, `multiple_issues` |
| Second issue URL ends in `/` | Create with candidate hint |
| Second URL wrapped in bold, italic, code, angles or links | Create with candidate hint |
| Foreign repository shares number 30 | Create with candidate hint |
| `[other](https://github.com/other/widgets/issues&sol;31)` | Decode then refuse adoption |
| `issues%2F31` | Decode then refuse adoption |
| pm-review shape `Issue: https://github.com/acme/widgets/issues/30` | Adopt only with explicit opt-in |

The new encoding property uses deterministic seed `0x53ce71a9`: **4,096
repository/number/decoration/encoding samples**, each tested in title,
description and body (**12,288 field cases**). It combines qualified issue/PR
URLs, shorthand, bare hashes and unqualified paths with named/numeric entities,
percent layers, invisible controls, soft breaks and the twelve earlier Markdown
decorations. Every non-target or UNKNOWN second reference must refuse adoption.
Positive controls cover all closing words, body URL labels, title references,
HTML/percent nesting, NFKC, control removal, inline and reference-style links,
soft label breaks and normalization-bound refusal.

Real initialized non-git tracker tests cover plain and atomic imports with the
option both false and true. Default imports create a separate issue item and
preserve the local item's full SDK projection. Opt-in imports adopt the same
ID and repeat against established provenance. SDK defaults report competing
eligible candidates without refusing. The packed CLI checks `--adopt-cited`
against a body-only `Issue:` item, while omission creates normally with a hint.

The mandatory PM-linked commands all pass without failures or skips:

| Command | Pass |
| --- | ---: |
| `node --test test/cited-issue-adoption.test.ts` | 44 / 44 |
| `node --test test/import-regex.test.ts` | 8 / 8 |
| `node --test --test-name-pattern='reusable workflow.*(explicit opt-in\|adoption input)' test/import-gate.test.ts` | 4 / 4 |
| `node --test --test-name-pattern='built package dispatch' test/import-selection.test.ts` | 1 / 1 |

An additional complete selector/fidelity sweep passed **80/80**. Typecheck,
both TypeScript builds, lint, docstrings and zero duplication pass locally.
Scoped coverage preflight found no uncovered branches in the new normalization,
exclusion and anchored ownership functions. Full npm/Bun release-gate evidence
and CodeQL run links are recorded on PR 169 at the final pushed head.
The initial CodeQL alert check flagged an overlapping trailing wildcard in
reference-definition normalization. The unnecessary trailing match was removed
without suppressing the rule or changing thresholds; current normalization and
workflow regressions are rechecked before collecting fresh exact-head evidence.

## Behavioral revert proofs

Each proof uses an isolated source copy with current tests and real SDK
persistence. Source tests import live TypeScript. The workflow proof packs a
real copy of current compiled output and retains the current pinned CLI/SDK;
only the reusable YAML is restored. No SDK mocks replace persistence.

| Restored from `0b4bc29` | Exact command | Reverted result |
| --- | --- | --- |
| Only `matchImportedIssue` | `node --test --test-name-pattern='explicit opt-in (false\|defaults)' test/cited-issue-adoption.test.ts` | 3 failures, 0 passes/skips, exit 1 |
| Only `citesIssue` and its prior `hasOtherCitationReference` helper | `node --test --test-name-pattern='normalized allowlist' test/cited-issue-adoption.test.ts` | 4 failures, 0 passes/skips, exit 1 |
| Only `.github/workflows/pm-github-sync.yml` | `node --test --test-name-pattern='reusable workflow.*(explicit opt-in\|adoption input)' test/import-gate.test.ts` | 2 failures, 2 passes, 0 skips, exit 1 |

The workflow's opt-in true execution imports instead of adopting after the
revert, while omitted/false executions still pass; the input-default check also
fails. These are behavioral assertions, not compilation or infrastructure
failures. Fixed selections all pass. Earlier review proofs remain in the PM
item's append-only history.

## Public tracker replays

Saved public GitHub tracker archives were copied into plain non-git directories.
Original files are read-only and SHA-256 checked after each dry run. Live issue
and closure-timeline data are fetched from GitHub; no source tracker or issue is
changed. These are saved revisions, not a claim about latest repository mains.

| Tracker revision / selection | Adoption off: create / update / adopt | Opt-in: create / update / adopt |
| --- | --- | --- |
| pm-review pre-tag `f72250e4c5ee8dfafaf57ee8afe20ddd3cbc993e`, issue 30 | 1 / 0 / 0 | 0 / 0 / 1 |
| pm-review tagged `e1fc83a81507ca6a91f1675b74863c050f1a89f1`, issue 30 | 0 / 1 / 0 | 0 / 1 / 0 |
| pm-context `7d7479ae77c13d01c54b2b4560ad54091ffed788`, issues 154,153,136,53,81 | 2 / 3 / 0 | 2 / 3 / 0 |

All modes report zero skips. The pre-tag default receipt reports
`pm-review-withdrawn-lineage` with `adoption_disabled`; explicit opt-in plans:

```json
{
  "issue": 30,
  "item": "pm-review-withdrawn-lineage",
  "action": "adopt",
  "github_url": "https://github.com/unbraind/pm-review/issues/30",
  "identity": { "via": "citation" }
}
```

The tagged snapshot correctly updates because provenance already exists.
pm-context retains three `multiple_issues` hints in both modes. All
**393/393 original files** (106 + 106 + 181) remain unchanged after both-mode
replays. The PM item records receipts, decisions and revert results.

# Scheduled sync and closeout watch, November 6

Trackers: [pm-github-o9r7](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-o9r7.toon)
and [pm-github-samq](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-samq.toon).

The watch identifies **21 failing sync runs and 15 failing closeout runs across
22 public repositories**. REST run/job metadata identifies every failed step;
bounded job-log samples and check-run annotations supply the error classes below.
The run links in the caller table identify the measured run, rather than a claim
about a later default branch or rerun. No caller repository was modified.

## Causes and ownership

| Cause / failed step | Affected runs | Evidence | Resolution |
| --- | --- | --- | --- |
| Padded release version compared literally after successful extension install | Sync: pm-evidence, pm-glossary, pm-http, pm-rust, pm-swarm, pm-vcs. Closeout: pm-ado, pm-presets, pm-rust, pm-swarm. | [pm-vcs job](https://github.com/unbraind/pm-vcs/actions/runs/42184005718/job/127779923012), [pm-rust job](https://github.com/unbraind/pm-rust/actions/runs/42184269190/job/127780777444). Requested `2026.11.02`; healthy install returns `2026.11.2`; silent verifier exits 1. | Already normalized in 2026.11.4. Adopt through Dependabot. This PR makes unexpected installed-version mismatches and unreadable metadata actionable without printing arbitrary metadata or paths. |
| Repeat import changes item/history, including native `updated_at` | Sync: pm-ado, pm-context, pm-csv, pm-gantt-chart, pm-linear, pm-presets, pm-slack, pm-slack-standup. | [pm-slack job](https://github.com/unbraind/pm-slack/actions/runs/42184074654/job/127780143226), [pm-ado job](https://github.com/unbraind/pm-ado/actions/runs/42184199180/job/127780547270). | Existing no-op fixes are in 2026.11.4. Actual pm-slack data repeats byte-identically on that release; see replay table. |
| Duplicate existing provenance owners; preview refuses before writes | Sync: pm-beads, pm-brief, pm-memory, pm-rl. | [pm-beads job](https://github.com/unbraind/pm-beads/actions/runs/42195026438/job/127816010151): one duplicated key; [pm-rl job](https://github.com/unbraind/pm-rl/actions/runs/42184101173/job/127780231134): two. pm-brief log and pm-memory annotation also identify one duplicated key each. | Caller-owned provenance repair. Keep one verified owner for each issue and preserve history. Both old and latest packages correctly refuse the pm-beads corpus. |
| Required create options missing during gated atomic apply | Sync: pm-changelog. | [job](https://github.com/unbraind/pm-changelog/actions/runs/42027324581/job/127244690810). Missing acceptance criteria, assignee, comment, deadline, dependency, doc, estimate, file, learning, note, explicit priority and test. | Caller-owned import/type policy decision or complete required source fields. Both released versions refuse; do not fabricate required values. |
| Configured completeness policy refuses mutation | Sync: pm-ops. | [job](https://github.com/unbraind/pm-ops/actions/runs/42184434094/job/127781317996). Close requires `repro_steps`, `expected_result`, `resolution`. | Caller-owned policy/data repair. 2026.11.4 still refuses, earlier in an update requiring `repro_steps`. No policy bypass belongs in this fix. |
| Planned source content fails privacy scan | Sync: pm-jev. | [job](https://github.com/unbraind/pm-jev/actions/runs/42207291810/job/127857017395), annotation: item `pm-jev-admission-teardown`, field `body`, rule `absolute-host-path`. | Caller-owned source remediation or reviewed content-addressed allowlist. Latest package removes one historical finding but retains another; no matched values are published here. |
| Closeout hides the command's actual stderr | Closeout: pm-brief, pm-changelog, pm-context, pm-csv, pm-gantt-chart, pm-jira, pm-linear, pm-rl, pm-slack, pm-slack-standup, pm-vcs. | [pm-slack job](https://github.com/unbraind/pm-slack/actions/runs/42210316609/job/127867049216), [pm-context job](https://github.com/unbraind/pm-context/actions/runs/42210348997/job/127867158497). Both expose only the generic token/validation message. A pm-slack read-only local replay reveals `Unverifiable GitHub pagination.` | These pins precede numeric repository pagination and actionable diagnostic fixes. Adopt 2026.11.4 or later. All eleven callers currently return a numeric next-page URL on the first 100-PR REST page, which their pinned guard rejects. Historical hidden stderr is unavailable; later required-check or close-validation refusals remain independently actionable. This PR also handles plain host stderr and redacts candidate diagnostics before the existing final privacy scan. |

At the time of this watch, the deprecated `pm-github-version` input did **not**
override a release-tagged workflow SHA. Issue #238 subsequently changes this
contract: an explicit hold is honored with a two-version warning; callers should
remove the input to follow the workflow manifest version. For the historical
runs above, removing a stale input only removed a warning; it did not repair
those failures. No ambiguity error was observed in the sampled install
failures: the failure occurred after installation in the exact-version verifier.

## Disposable public-data replays

Each representative starts from a fresh depth-50 public caller clone, checked
out at its watched run head, and uses that caller's exact pinned pm SDK. Both
its installed workflow package and 2026.11.4 are installed with the real pm CLI.
Imports reuse public REST issue/comment/timeline snapshots through the package's
transport seams and real SDK/CLI writers. Optional GraphQL closure enrichment
is deliberately omitted, preserving the near-exhausted GraphQL budget. These
are current public source snapshots against historical tracker heads, not a
reconstruction of every historical API response.

| Caller / exact run head | SDK | Old package | Old result | 2026.11.4 result |
| --- | --- | --- | --- | --- |
| pm-vcs / `382a8dd3bb280dc98a0917af81b83e7b4f1a97f5` | 2026.11.4 | 2026.11.02 requested | Install exits 0 and returns 2026.11.2; literal verifier mismatches | Installed 2026.11.4 matches |
| pm-slack / `83f41f0a157668cefb60aa42ee9562688e1d0250` | 2026.11.4 | 2026.10.28 | Issue #159: second import updates one item and changes two durable files | Second import updates zero; `unchanged=true`; zero durable changes |
| pm-beads / `85b6392112929e967dfb5e174c773a0590124c35` | 2026.11.2 | 2026.10.29 | Nine issues; one duplicated provenance key; pre-write refusal | Same refusal |
| pm-changelog / `f1a529580fafb219f0ad3bad79fe351732556767` | 2026.11.2 | 2026.10.28 | 29 issues; required create options missing | Same refusal |
| pm-ops / `07f965b220f7c6725b6587bd4bc522b9bc145298` | 2026.11.3 | 2026.10.29 | Ten issues; close policy missing three fields | Update policy missing `repro_steps` |
| pm-jev / `93c51cb0d51b20b33fcd38dbf76a22bbcdc093f0` | 2026.11.4 | 2026.10.30 | Nine issues; two body host-path findings | One body host-path finding remains |

Closeout was first executed **without `--apply`** on pm-slack. The old CLI exits
1 and its captured stderr identifies unverifiable pagination. The latest full
CLI preview exceeded the 240-second scratch deadline; it is not a passing full
closeout result. Targeted pagination tests cover accepted numeric aliases and
rejected foreign IDs, names, endpoints, origins, cycles and unavailable identity
reads. The live host token has different permissions from `GITHUB_TOKEN`, so it
cannot certify scheduled token permissions or all historical head checks.

## Caller follow-up matrix

Dependabot owns reusable workflow pin adoption. **2026.11.4 already carries
the normalization, repeat-import and pagination fixes.** Callers exhibiting
those failures need a newer pin. For the sync-only policy/data refusals in
pm-beads, pm-memory, pm-ops and pm-jev, the demonstrated requirement is the
caller repair below; a newer pin is recommended for current diagnostics but
is not an established remedy for that refusal. A subsequent release will
carry this PR's diagnostic hardening. An absent workflow below means absent
from this watch, rather than absent from the repository.

Every watched sync caller grants `issues: read`; change that to `issues: write`
if failure-issue alerts are wanted. The sync itself retains its existing
permission boundary. Every caller except pm-glossary also supplies a stale
deprecated version input; remove it as cleanup. No watched closeout caller
supplies explicit `required-checks`. Add that declaration only when the new
per-item diagnostic establishes unreadable policy metadata, after verifying
the actual required contexts; do not guess or weaken protection.

| Caller | Sync pin / watched run | Closeout pin / watched run | Required follow-up |
| --- | --- | --- | --- |
| pm-ado | [2026.10.25](https://github.com/unbraind/pm-ado/actions/runs/42184199180) | [2026.11.01](https://github.com/unbraind/pm-ado/actions/runs/42210474404) | Pin adoption; no additional cause-specific config proven. |
| pm-beads | [2026.10.29](https://github.com/unbraind/pm-beads/actions/runs/42195026438) | — | Repair duplicate provenance ownership; newer pin recommended for diagnostics. |
| pm-brief | [2026.10.28](https://github.com/unbraind/pm-brief/actions/runs/42207372623) | [2026.10.28](https://github.com/unbraind/pm-brief/actions/runs/42210529287) | Pin adoption plus repair duplicate provenance ownership. |
| pm-changelog | [2026.10.28](https://github.com/unbraind/pm-changelog/actions/runs/42027324581) | [2026.10.28](https://github.com/unbraind/pm-changelog/actions/runs/42210877837) | Pin adoption plus resolve required-create field/type policy. |
| pm-context | [2026.10.28](https://github.com/unbraind/pm-context/actions/runs/42184398828) | [2026.10.28](https://github.com/unbraind/pm-context/actions/runs/42210348997) | Pin adoption; no additional cause-specific config proven. |
| pm-csv | [2026.10.28](https://github.com/unbraind/pm-csv/actions/runs/42195481558) | [2026.10.28](https://github.com/unbraind/pm-csv/actions/runs/42210605340) | Pin adoption; no additional cause-specific config proven. |
| pm-evidence | [2026.11.02](https://github.com/unbraind/pm-evidence/actions/runs/42205347271) | — | Pin adoption; no additional cause-specific config proven. |
| pm-gantt-chart | [2026.10.28](https://github.com/unbraind/pm-gantt-chart/actions/runs/42184337810) | [2026.10.28](https://github.com/unbraind/pm-gantt-chart/actions/runs/42210851846) | Pin adoption; no additional cause-specific config proven. |
| pm-glossary | [2026.11.02](https://github.com/unbraind/pm-glossary/actions/runs/42205634086) | — | Pin adoption; no additional cause-specific config proven. |
| pm-http | [2026.11.02](https://github.com/unbraind/pm-http/actions/runs/42206584592) | — | Pin adoption; no additional cause-specific config proven. |
| pm-jev | [2026.10.30](https://github.com/unbraind/pm-jev/actions/runs/42207291810) | — | Remediate body privacy finding or review a narrow allowlist; newer pin recommended for diagnostics. |
| pm-jira | — | [2026.10.28](https://github.com/unbraind/pm-jira/actions/runs/42210400598) | Pin adoption; no additional cause-specific config proven. |
| pm-linear | [2026.10.28](https://github.com/unbraind/pm-linear/actions/runs/42205870054) | [2026.10.28](https://github.com/unbraind/pm-linear/actions/runs/42210479407) | Pin adoption; no additional cause-specific config proven. |
| pm-memory | [2026.10.30](https://github.com/unbraind/pm-memory/actions/runs/42206711464) | — | Repair duplicate provenance ownership; newer pin recommended for diagnostics. |
| pm-ops | [2026.10.29](https://github.com/unbraind/pm-ops/actions/runs/42184434094) | — | Resolve configured completeness policy/data; newer pin recommended for diagnostics. |
| pm-presets | [2026.10.26](https://github.com/unbraind/pm-presets/actions/runs/42025638809) | [2026.11.02](https://github.com/unbraind/pm-presets/actions/runs/42210547090) | Pin adoption; no additional cause-specific config proven. |
| pm-rl | [2026.10.28](https://github.com/unbraind/pm-rl/actions/runs/42184101173) | [2026.10.28](https://github.com/unbraind/pm-rl/actions/runs/42210344121) | Pin adoption plus repair duplicate provenance ownership. |
| pm-rust | [2026.11.02](https://github.com/unbraind/pm-rust/actions/runs/42184269190) | [2026.11.02](https://github.com/unbraind/pm-rust/actions/runs/42210715831) | Pin adoption; no additional cause-specific config proven. |
| pm-slack | [2026.10.28](https://github.com/unbraind/pm-slack/actions/runs/42184074654) | [2026.10.28](https://github.com/unbraind/pm-slack/actions/runs/42210316609) | Pin adoption; no additional cause-specific config proven. |
| pm-slack-standup | [2026.10.27](https://github.com/unbraind/pm-slack-standup/actions/runs/42195150911) | [2026.10.27](https://github.com/unbraind/pm-slack-standup/actions/runs/42019226163) | Pin adoption; no additional cause-specific config proven. |
| pm-swarm | [2026.11.02](https://github.com/unbraind/pm-swarm/actions/runs/42206851091) | [2026.11.02](https://github.com/unbraind/pm-swarm/actions/runs/42210331915) | Pin adoption; no additional cause-specific config proven. |
| pm-vcs | [2026.11.02](https://github.com/unbraind/pm-vcs/actions/runs/42184005718) | [2026.10.27](https://github.com/unbraind/pm-vcs/actions/runs/42019292994) | Pin adoption; no additional cause-specific config proven. |

## Changes and regression evidence

Both reusable installation steps now name the safe installed and resolved
versions on mismatch. Missing or malformed package metadata produces a fixed
error message, rather than an exception containing the tracker path or metadata.
The verifier remains fail-closed. Existing tag normalization is retained.

The workflow diagnostic command now recognizes plain `Error:` stderr and the
host's `What happened:` section as well as JSON receipts. It selects the actual
failure line rather than help or recovery text. The shared privacy scanner
redacts known matched values while preserving useful status and required-field
text. Overlapping matches are merged using the scanner's original-source start
and exclusive end offsets, including complete encoded characters. The workflows still privacy-scan the final
candidate and escape Actions annotation control characters before logging it.
Raw stderr and tracker diffs remain private.

Initial PR validation at `5a31da1` (before this review round):

- `node --test --test-concurrency=2 test/self-versioned-workflows.test.ts test/scheduled-refusals.test.ts`: **81/81 pass**, zero failures, skips or cancellations.
- `npm run build && node --test --test-concurrency=2 --test-name-pattern='workflow refusal reporter emits' test/closeout-workflow.test.ts`: **1/1 pass**, using the rebuilt packed extension and real CLI.
- `node --test --test-concurrency=2 --test-name-pattern='workflow diagnostics|private plain stderr|install verification explains' test/scheduled-refusals.test.ts test/self-versioned-workflows.test.ts`: **5/5 pass**, also verified through the pinned `pm test` link and `pm test --run --progress`.
- `npm run typecheck`, `npm run build:test`, `npm run lint`, `npm run docstring`, `npm run privacy`, `npm run verify:release-publish-attestation`: pass. The privacy gate audited 9,068 pre-change Git objects and approved every identity; it is rerun after committing the new objects.
- Focused c8 instrumentation of `workflow-diagnostic.ts` with the five diagnostic tests reports **100% lines, statements, functions and branches**. This measures that module only.
- At that initial head, full npm/Bun release and coverage gates were delegated to PR CI under the original targeted-gate instruction. The review round below supersedes this with both complete local gates.

Behavioral reversions execute only in a disposable repository copy, leaving
source tracker history intact:

| Reverted behavior | Regression result | Restoration |
| --- | --- | --- |
| Only the installed-version verification block in both workflows | 2/2 metadata-diagnostic tests fail | Fixed selection passes 5/5 |
| Only the previous stderr decoder function | 2/2 plain-stderr tests fail | Fixed selection passes 5/5 |
| Only redaction, replaced with its previous identity behavior | 2/2 privacy tests fail | Fixed selection passes 5/5 |

An initial integration probe omitted the build and therefore packed no entry
file; the installer correctly refused it. Rebuilding the artifact resolved that
setup error, and the same integration regression passes. No source assertion
was relaxed to hide it.

A pagination-only replay preserves the recorded real REST Link headers and
repository identity responses while supplying empty PR arrays, so it evaluates
pagination without historical PR checks or tracker mutations. It reproduces
`Unverifiable GitHub pagination.` on the installed 2026.10.28 artifact and
completes on installed 2026.11.4 using the same recorded responses. This proves
the route correction, not complete delivery eligibility.

## Remaining boundaries and upstream proposals

Configured policy refusals and duplicate owners require caller-owned decisions.
A separate package follow-up, `pm-github-xgk0`, tracks the observed difference
between an import preview's completeness/privacy checks and apply's native
mutation/finalization validation. The SDK already exposes
`previewItemMutations`; this is not recorded as a missing SDK capability.
No new pm CLI/SDK defect was established and no upstream issue was filed.
Main already tracks the separate lifecycle-compensation defect as
[pm-cli#1656](https://github.com/unbraind/pm-cli/issues/1656); its two quarantined
tests remain skipped in the full suites. See
[the existing compensation investigation](atomic-finalization-197-recheck.md).
These skips do not certify rollback of finalized imported lifecycle data.

No merge, release, tag, caller PR, bot trigger, thread reply or hosted-data
operation is part of this work. Real scheduled-token acceptance and the full
CI certification remain separate from the local replays above.


## Review class closure

PR #225 review findings were checked against every package call site. Live
operator entry points (README and the caller-adoption issue description) now
reference this complete 22-caller watch matrix alongside historical evidence.
Closed historical tracker records retain their original incident context.

Both reusable workflow verifier tests assert the actual and expected version,
including punctuation, for every accepted release-resolution scenario. Rejected
metadata tests exclude every raw fixture value and its JSON-escaped form from
output, in addition to the credential and tracker-path checks.

Generic stderr wrappers cannot override a specific later cause, the host's
`What happened:` section, or an actionable structured stdout receipt. Both sync
and closeout call the same diagnostic command, and the public SDK command and
packed npm/native Bun CLI paths share that selection and redaction function.

Scanner hits now carry an exclusive source end offset for both ordinary rules
and high-entropy assignments. Redaction merges those source spans rather than
combining a source start with a decoded length. Generated encodings verify that
each span decodes to exactly the matched value; the prefix-overlap Windows case
retains safe surrounding context while removing the entire encoded match.
Gate JSON/TOON receipts keep their existing rule, hash and start-offset contract;
no persisted record or allowlist hash is rewritten.

The first investigation also mistakenly tagged the caller-adoption item as a
second owner of issue #175. The duplicate tag was removed through pinned pm;
all history and the canonical owner remain intact. A data-revert regression
prevents that rollout follow-up from taking the canonical owner's provenance.

The class tests cover plain non-git trackers, JSON and TOON, generic and specific
stderr, structured stdout reports, every scanner hit-construction path, and
one packed artifact consumed through npm and native Bun. Revert proofs and
full-gate results for this round are recorded on pm-github-o9r7.

Nine independent review-round behavioral controls ran in disposable copies:

| Reverted behavior or data | Regression failures |
| --- | --- |
| README current-watch link | 1/1 |
| Adoption description current-watch link | 1/1 |
| Expected version omitted from both real workflow verifiers | 2/2 |
| Malformed metadata appended by both real verifier catch blocks | 2/2 |
| Specific text-cause decoder | 1/1 |
| Specific stdout/stderr receipt precedence | 1/1 |
| Source-span redactor | 1/1 |
| Scanner source-span construction | 1/1 |
| Duplicate canonical provenance tag on adoption item | 1/1 |

The fixed implementation restores the seven-test selection; the corrected
provenance separately passes 1/1. The final linked regression selection passes
8/8 with no failures, skips or cancellations. Existing tests and privacy,
coverage, identity and publication thresholds remain unchanged.

Review-round full validation used serial isolated environments and at most two
test workers. Both commands completed on the final runtime source:

| Command | Result | Tests | Exact coverage over 30 authored modules |
| --- | --- | --- | --- |
| `npm run release:check` | Exit 0 | 1,780 pass; 0 fail/cancelled; 2 existing skips | 14,415/14,415 lines and statements; 456/456 functions; 5,440/5,440 branches |
| `bun run release:check` | Exit 0 | 1,780 pass; 0 fail/cancelled; 2 existing skips | 14,415/14,415 lines and statements; 456/456 functions; 5,440/5,440 branches |

Both complete gates also pass typecheck, build, docstrings, lint, duplication,
identity/privacy, production audit (zero vulnerabilities), pack dry-run,
changelog and publication attestation. The two skips are the existing
pm-cli#1656 lifecycle-compensation quarantines described above. No skip,
threshold, source exemption or telemetry policy was added or changed.

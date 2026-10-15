# Strict closeout acceptance proof

The built package was packed with `npm pack --ignore-scripts`, then installed
with `pm install <tgz> --project` only in a scratch clone of `unbraind/pm-rust`.
The clone checked out `f182da3~1`, resolving to
`a5656636d280aa30d11810b28350a6ff2ca3bd5e`, before the closeout changes.
The real tracker retained `governance.close_validation_default: strict`.
No scratch changes were committed or pushed.

Tarball SHA-256: `f4167d8acad52195ba9c4c05da3cb596c5b3bd95f8b97a1a3f14b6fa1b7b888c`.

Build identification: the tarball, every readback below and the gate counts in
"Package validation" are evidence from the pm-github build at commit `bbf6516`
(the first commit of pull request 126). Two review rounds followed it: `64311e9`
and `241ed1d` changed only the fallback check wording, so the readbacks below
still show the earlier text `required checks passing`, while the reviewed head
writes `required checks satisfied; successful head checks`, and the tracker's
later gate record reports 663 tests because two check-wording tests were added.
The proof was not re-run against the reviewed head; the behaviour it proves
(strict close fields filled from GitHub facts, idempotent repeat, no scratch
writes) is unchanged by those rounds.

## Plan and apply

`pm github closeout --repo unbraind/pm-rust --pr 81 --json` produced this plan
with no closes. `pm github closeout --repo unbraind/pm-rust --pr 81 --apply --json`
then reported **7 closed, 0 failed**, retaining the two eligibility skips.
The check policy was `required`, using readable branch protection and rulesets.

| Item | Action | Reason |
| --- | --- | --- |
| pm-rust-cqk7 | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-2tb9 | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-sldg | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-1ycz | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-lcap | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-poen | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-ax0o | close | Required head checks concluded success (branch-protection and ruleset rule). |
| pm-rust-9bci | skip | Item is open, not in progress; a mention is not delivery. Prefix its link with Closes, Fixes, Resolves or Delivers to close it. |
| pm-rust-u4al | skip | Epics close when their children are done, not by a pull request. |

## Written fields

The records below were read back through `pm get --json --fields
id,status,resolution,expected_result,actual_result,acceptance_criteria`.
Each `expected_result` equals its own `acceptance_criteria` byte for byte.
Check names are GitHub facts; their names do not establish platform test execution.

### pm-rust-poen

```json
{
  "id": "pm-rust-poen",
  "status": "closed",
  "resolution": "Delivered by https://github.com/unbraind/pm-rust/pull/81 (merge 0afac780c4b7, head a7e8a4f80810)",
  "expected_result": "A producer cursor without after_index yields continuation_contract.fingerprint opaque_cursor and byte-identical list envelopes against published PM CLI 2026.10.5, including triage pages; cursors that include after_index stay unchanged.",
  "actual_result": "Merged at 2026-10-15T02:10:12Z with required checks passing: Analyze Rust, CodeQL, CodeRabbit, Release gate aggregate, Release gate aggregate macos-latest, Release gate aggregate windows-latest, Rust macos-latest, Rust ubuntu-latest, Rust windows-latest",
  "acceptance_criteria": "A producer cursor without after_index yields continuation_contract.fingerprint opaque_cursor and byte-identical list envelopes against published PM CLI 2026.10.5, including triage pages; cursors that include after_index stay unchanged."
}
```

### pm-rust-cqk7

```json
{
  "id": "pm-rust-cqk7",
  "status": "closed",
  "resolution": "Delivered by https://github.com/unbraind/pm-rust/pull/81 (merge 0afac780c4b7, head a7e8a4f80810)",
  "expected_result": "Every close help field and alias has real oracle differential coverage; regression tests fail on behavioral reversion; unchanged complete Rust gates pass.",
  "actual_result": "Merged at 2026-10-15T02:10:12Z with required checks passing: Analyze Rust, CodeQL, CodeRabbit, Release gate aggregate, Release gate aggregate macos-latest, Release gate aggregate windows-latest, Rust macos-latest, Rust ubuntu-latest, Rust windows-latest",
  "acceptance_criteria": "Every close help field and alias has real oracle differential coverage; regression tests fail on behavioral reversion; unchanged complete Rust gates pass."
}
```

## Behavioral revert proofs

Tests import the TypeScript source directly. Each mutation was restored before
acceptance; no mock SDK or reduced coverage threshold was used.

- Removing only structured SDK close options makes
  `node --test --test-name-pattern='strict close validation' test/closeout.test.ts`
  fail: zero closes versus two expected, with strict validation refusing both.
- Removing only the per-item recovery makes
  `node --test --test-name-pattern='apply continues after lock' test/closeout.test.ts`
  fail on the first real SDK `lock_conflict`, before later closures.
- With the implementation restored, default/strict trackers, missing acceptance
  criteria, private PR prose, real lock and workflow policy refusals, and the
  public command's final `CommandError` exit 1 are exercised by
  `node --test test/closeout.test.ts`.

A repeated packed `--apply --json` returned **0 closed, 0 failed**. Hashes of
every item and history file were identical before and after the repeat.

## Package validation

The packed runtime matched the `bbf6516` build byte for byte across all 16 `dist` files.
The linked `pm test pm-github-2o9k --run --progress` run passed **71/71** tests
with zero failures, skips, cancellations or todos. Its declared timeout was
raised from the default 120 seconds to 600 seconds for the full closeout suite.

`npm run release:check` passed with an isolated `HOME`,
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`: **661/661** tests,
zero failures/skips/cancellations/todos, and exact **100/100/100/100** coverage
across 13 authored modules (10026 lines and statements, 254 functions,
2827 branches). All other release checks passed at unchanged thresholds.

`bun run release:check` also passed under the same isolated-identity settings:
**661/661** tests, zero failures/skips/cancellations/todos, and exact
**100/100/100/100** coverage with the same source counts. Both release gates
passed type checking, build, docstrings, lint, duplication, privacy, production
audit, packing, changelog and publish-attestation checks.

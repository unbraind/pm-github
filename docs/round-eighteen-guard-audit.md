# Ownership guard audit

This audit compares the accepted round-16 implementation with round 17 and the current correction. Coverage thresholds, source inventory and source exclusions are unchanged. Native regression fixtures live in `test/round-eighteen.test.ts`; `test/round-seventeen.test.ts` retains the declaration parser controls.

| Boundary changed in round 17 | Disposition and strongest boundary test |
| --- | --- |
| Closeout: evidence requires exactly one owner | Restored before shared consistency validation. Native contradictory URL/external-ref records reach this guard; unowned and consistent records remain allowed. |
| Closeout: delivery repository prefix | Kept. Native foreign-repository ownership refuses without changing item/history bytes. The redundant arity disjunct stays removed: the restored preceding evidence/arity guard refuses the two-owner native record first. |
| Native declaration: stated number is positive, safe and agrees with URL | Kept in the shared declaration parser, rather than reparsing in the warning caller. Native declarations with zero, negative, unsafe and mismatching numbers are rejected before becoming claims; matching declarations remain owners. |
| Atomic import: rethrow `github_import_owner_conflict` | Restored at the original error propagation boundary, after journal-aware plan cleanup. An ordinary SDK relink in `onPlanStaged` preserves the typed conflict before any transaction transition. |
| Import gate: duplicate identity tracking | Restored. Two native items claiming the target reach the dedicated typed refusal; repeating the same item row is allowed. |
| Import gate: only count requested identity keys | Restored. A planned native owner acquires a second out-of-plan claim; the target filter excludes that key from indexing and shared consistency refuses before writes. |
| Import gate: distinguish repeated same-owner rows from another owner | Restored. Repeated native owner rows index once; an independent native peer refuses. |
| Import gate: refuse nonempty duplicate set | Restored as a dedicated typed ownership refusal before normal idempotency receipts. The test checks that both colliding item IDs are named as claimants. |
| Refresh: conflicting issue numbers | Restored before shared resolution. A native URL for issue 7 combined with explicit number 8 refuses with the refresh conflict diagnostic; consistent 7/7 is allowed. |
| Refresh: issue number safe-integer guard | Restored before target creation, including raw explicit numbers that cannot form an ownership key. Native zero, negative, fractional and unsafe values refuse; 7 remains selectable. |
| Refresh: former raw explicit-number check | Retained semantically in the same preflight safe-number loop; it adds the raw explicit value before validation, without granting ownership to tags or a partial number. |
| Plain import: citation adoption counter in mirroring branch | Restored. This branch is reachable: a native item authored by the importer can contain only an eligible citation. It adopts and mirrors in place; a curated-author twin adopts while retaining its title. |
| Cached index: missing prior state fallback | Removed together with the obsolete cache/updater, not replaced by a non-null assertion. Each separately locked write now certifies and rebuilds its peer index, then validates before mutation. An ordinary SDK peer edit between comments is refused by that fresh check before any old cache could be consulted. |
| Cached index: missing claimant-map fallback | Removed with the same obsolete updater. The native inter-comment race proves the replacement refusal; native index controls verify that every indexed state and claimant map exists. A missing-id document is refused by native completeness certification before the batch callback, and a proposed ID deletion is refused inside the mutation guard before persistence. |
| Import: legacy reference-conflict consumer | Removed: the deprecated helper returns no ownership conflict under issue 230's contract. Native number-only records with multiple same-number and different-number reference tags import once without refusal and without changing those records. |
| Sync: legacy reference-conflict consumer | Removed for the same contract. The same native multi-reference records pass the real extension's sync dry run without an identity-conflict field or any tracker mutation. |
| Refresh: legacy reference-conflict consumer | Removed for the same contract. The same native records remain unowned and refresh selects no target, without conflict or mutation. |

The board `add-issue` gap predates round 17: its validation body is unchanged between `58ae396` and `948ef40`. The new positive-owner check applies both before and after node resolution. The zero-owner alternatives require a current board tag or draft authorization.

The native N=40 batch counter now observes one preflight corpus read plus one fresh read for each of 40 transaction writes and 40 metadata finalizers: 81 reads and bounded O(N*M) parsing. Reusing the live namespace lease does not permit reusing peer snapshots across separately locked writes.

## Public snapshot preview

The read-only checks replayed the same complete public issue snapshots against the same public tracker revisions as round 16. No import was applied, no original tracker bytes changed, and all scratch clones were removed. Plain reference tags remained mentions. Counts are creates/updates/unchanged; no curated title, description, type, body, creation date or existing tag would change.

| Public repository | Tracker revision | Creates | Updates | Unchanged | Curated field changes |
| --- | --- | ---: | ---: | ---: | ---: |
| pm-github | `be28728c3092` | 22 | 2 | 0 | 0 |
| pm-review | `402c544c2c78` | 2 | 2 | 0 | 0 |
| pm-rust | `624e1a09014a` | 6 | 1 | 0 | 0 |
| pm-context | `b94eb039de4c` | 7 | 3 | 0 | 0 |
| pm-linear | `0f9dea0279a0` | 8 | 1 | 0 | 0 |

pm-github retains the previously observed privacy-preflight refusal for existing public source bodies. Its counts are the read-only production-planner diagnostic after that refusal, not a claimed passing gated import. The other four exact gated previews pass. SDK runtimes for scratch extension installation follow each available exact project lock version; the package-pinned SDK is used when no SDK entry exists. No stale-runtime override is used.

## Behavioral reversions

Disposable copies reproduce ten intended failing assertions: lost board owner, removed board tag, an intervening peer claim between comments, proposed ID removal, closeout arity, required atomic typed rethrow, duplicate-owner diagnostics, refresh contradiction diagnostics, the mirroring citation counter, and substring-based API-host classification. Matching owners, current board tags, drafts and ordinary multiple comments remain allowed. Restoring the implementation passes the native regressions. Reverting the atomic function to its prior early rethrow remains an allowed earlier-refusal control; deleting its retained rethrow fails the typed-error assertion.

## Final coverage receipt

`coverage-gate: 34 authored modules, exact 100/100/100/100 coverage.` Native V8 receipts were collected against unchanged authored source through the bounded test batches and standard c8 reports. The complete source inventory and all four 100% thresholds are unchanged; no ignore comments or exemptions were added. The final pm-linked round-18 file passes 32/32. The large capture’s two uninitialized legacy fixtures were initialized through the SDK and their entire file reran successfully; two existing SDK compensation quarantines remain skipped.

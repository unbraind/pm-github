# Bounded coverage receipt aggregation

Tracked by `pm-github-vhi6`. The source inventory remains all 28 authored
TypeScript/JavaScript modules, including operational scripts. All four exact
100% thresholds, `--all`, `--exclude-after-remap`, reporters, includes, and test
files remain unchanged. There are no new exclusions or custom URL filters.

## Measurements before changing the gate

The baseline at `10e9fdd` used Node 24.19.0 and the locked c8 12.0.0. Its test
phase completed 1,609 tests: 1,607 passed and two existing privacy tests failed.
Those failures concern an unrelated unreachable commit identity in the shared
Git object store, tracked separately by `pm-github-privacy-store-followup`.
The subsequent default c8 merge exhausted its 12 GiB heap ceiling.

`coverage/v8` contained 3,839 JSON receipts totaling **10,074,310,347 bytes**.
The largest receipt was 6,701,513 bytes. Reading one file at a time, the
measurement classified script URLs against the file URLs generated from
`collectCoverageSources(root, ".")`:

| Component | Entries | Serialized bytes |
| --- | ---: | ---: |
| Inventory-matching raw script entries | 1,268 | 4,689,282 |
| Other raw script entries | 1,981,178 | 9,004,210,507 |
| Inventory-matching source-map cache values | — | 0 |
| Other source-map cache values | — | 1,059,962,540 |
| Remaining framing, URL keys and metadata | — | 5,448,018 |
| Total on disk | 3,839 receipts | 10,074,310,347 |

Payload sizes use `Buffer.byteLength(JSON.stringify(value))`; total receipt
sizes use file metadata. This is a raw-URL classification before remapping,
not a change to c8's inclusion semantics. Matching raw script entries account
for approximately 0.047% of the input bytes.

| Merge | Heap cap (MiB) | Peak RSS (KiB) | Result |
| --- | ---: | ---: | --- |
| Default, original gate | 12,288 | 12,798,016 | Heap exhaustion |
| Incremental, same receipts | 6,144 | 1,632,684 | Reports completed; privacy branch gap retained |
| Final release gate, incremental | 3,072 | 1,665,096 | All release checks passed |

`/usr/bin/time -v` measured the baseline coverage command and the incremental
c8 report process. c8 was the largest baseline process. Incremental replay
used exactly the retained receipts and the original source, include list,
remapping policy, reporters and `--all` setting. It reported 13,197/13,197
lines and statements, 422/422 functions, and 5,077/5,078 branches. The one
missing branch is the successful privacy CLI path affected by the baseline
privacy failures. This replay is memory evidence, not a passing release gate.

## Selected implementation and margin

c8 12.0.0 defines `--merge-async` in `lib/parse-args.js` and forwards it from
`lib/commands/report.js`. In `lib/report.js`, the default `_loadReports()`
materializes every parsed receipt before merging. `_getMergedProcessCovAsync()`
reads one receipt, normalizes it, and merges it into an accumulator before
reading the next. The gate now selects that native incremental implementation.

Memory depends on the largest receipt and the accumulated unique scripts,
ranges and source maps, rather than retaining one complete object graph per
process receipt. Repeated receipts do not add independent raw graphs. Growing
the unique script/range inventory remains a separate scaling dimension.
Keeping native c8 normalization and remapping also preserves coverage supplied
by generated code with source maps; no custom pre-filter has to approximate
those rules.

`COVERAGE_HEAP_FLAG` is now **`--max-old-space-size=3072`**. The initial
incremental peak RSS was 1.557 GiB; the final release gate peaked at 1.588 GiB,
leaving approximately **1.41 GiB** below that 3 GiB heap ceiling.
RSS includes native memory, making this a conservative
comparison rather than a claim that RSS equals V8 heap. The cap leaves room
for runtime variation while staying below the requested 6 GiB heap target.
The heap argument still precedes the c8 entry point.

An inherited `NODE_OPTIONS` could still lift that ceiling. Node applies
`--max-old-space-size-percentage` ahead of an explicit `--max-old-space-size`.
On this host, `NODE_OPTIONS=--max-old-space-size-percentage=60` with the gate's
flag gave a 19,406 MiB heap limit, against 3,264 MiB without it. The gate
therefore splits every inherited old-space limit out of `NODE_OPTIONS`: both
spellings, the percentage form, and `=` or space-separated values. All other
inherited options stay in the environment unchanged.

The split limits are not discarded. c8 passes its environment to the nested
`node --test` command and its workers, so dropping them would also drop a
caller's test-worker memory limit. The gate puts them back as `--flag=value`
arguments on the nested command, right before `--test`. Node's test runner
forwards those arguments to every worker. On this host a worker reported
19,406 MiB under `--max-old-space-size-percentage=60` and 1,426 MiB under
`--max-old-space-size=1234`. A bare limit with no numeric value is dropped.

A spy test pins the split environment and the nested arguments, and fails if
either part is removed. A real-node probe checks that the merge limit stays at
the ceiling under an inherited percentage. A second probe runs a real
`node --test` worker and checks that it keeps an inherited 1,234 MiB limit.

## Regression and mutation evidence

The existing real-c8 test now exercises 512 synthetic excluded receipts
containing **158,244,352 bytes** under a **128 MiB** c8 heap ceiling. The
incremental gate passes. Removing only `--merge-async` makes c8 exhaust that
small heap, and the regression fails its expected-success assertion. This
checks receipt-count scaling without another complete integration-suite run.

The same test executes only one path through a multiline included source. It
requires the gate to fail, verifies that the source has both covered and
uncovered lines, and checks that failed coverage invalidates LCOV. It also
retains the positive fully covered case and the completely unloaded source
case. Thus losing an included receipt cannot masquerade as a useful coverage
result merely because the gate still fails for missing or unloaded code.

The filter-safety mutation changes c8 normalization to drop the included
`source.ts` URL only when it contains a zero-count range, before indexing it.
The positive fixtures still pass; the partial fixture then fails the assertion
that filtering must retain executed included-source counts. Both mutations
are temporary verification changes and are removed before normal checks.
No custom pre-filter ships in this patch.

## Reproduction and validation scope

Before each coverage run, inspect `free -g` and `df -BG /`: wait for at least
14 GiB available memory and stop if fewer than 20 GB are free. Run gates
serially and remove the temporary fixture and validation directories afterward.

Install with `NPM_CONFIG_USERCONFIG=/dev/null npm ci`, then measure with
`NPM_CONFIG_USERCONFIG=/dev/null /usr/bin/time -v npm run coverage`.
A retained-receipt report can reuse the gate's exact current arguments:

```sh
node --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
import { runCoverageGate } from "./scripts/coverage-gate.ts";
process.exitCode = runCoverageGate(process.cwd(), (node, args, options) =>
  spawnSync("/usr/bin/time", ["-v", node, ...args.slice(0, 2), "report",
    ...args.slice(2, args.indexOf(node))], options));
JS
```

The c8 options end where the nested `node` command begins. Inherited heap
limits sit between that `node` and `--test`, so the slice ends at `node`.

Run focused checks with
`NPM_CONFIG_USERCONFIG=/dev/null node --test test/coverage-gate.test.ts`.
Final acceptance uses `NPM_CONFIG_USERCONFIG=/dev/null npm run release:check`
in an independent clone of this branch with the staged candidate applied.
The independent object store retains the full privacy scan; it does not
certify or repair unrelated objects in the shared store. Hosted Node 22/26 CI
is a separate follow-up after publication of the branch.

The receipts below are historical: they validate the bounded merge at
da3f62e, before the inherited `NODE_OPTIONS` handling above was added.
That revision's single final release check exited zero. All 1,609 tests passed, with zero
failures, skips or cancellations. Exact coverage across the same 28 modules
was 13,195/13,195 lines and statements, 422/422 functions, and 5,080/5,080
branches, with zero skipped source. The final run emitted 3,844 receipts
totaling 10,084,268,775 bytes. Its timed peak RSS of 1,665,096 KiB matched the
c8 process's observed `VmHWM`. Source and test hashes matched the candidate
before and after validation.

The release check also passed typechecking, build, documentation (261
declarations across 27 files), lint, zero duplication across the 28-module
inventory, privacy (3,718 objects), zero production vulnerabilities, the
75-file package dry run, canonical changelog checking, and publish attestation.
Both privacy tests that failed against the unrelated shared-store object
passed in the independent clone. The shared-store follow-up has since closed:
the privacy gate passed over the shared store after the stale objects were
removed.

The current receipt validates the inherited heap handling. Its source matches
479c029, and the checkout adds only this change's branch-only fixture and
documentation. A full `npm run coverage` exited zero. All 1,629 tests passed,
with zero failures, skips or cancellations. Exact coverage across the same 28
modules was 13,252/13,252 lines and statements, 426/426 functions, and
5,103/5,103 branches. Its timed peak RSS was 1,672,188 KiB, within 0.5% of the
historical run. This run inherited no `NODE_OPTIONS`; the probe test above
covers an inherited heap limit.

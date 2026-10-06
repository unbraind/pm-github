# Coverage gap inventory and closure evidence

The baseline test run had four fixture failures, corrected subsequently. This lists every zero-count statement and branch at that measurement; final acceptance must remeasure frozen source. No exemptions or threshold changes. The initial gate.ts receipt overlapped scanner edits; its listed coordinates are historical diagnostics, not exact-source evidence. Subsequent full receipts use frozen authored source.

## gate.ts

Uncovered statement lines: 984, 985, 986, 987, 988, 989, 990, 991, 992, 993, 994, 995.

Uncovered branches: none.

## index.ts

Uncovered statement lines: 1764, 1765, 1921, 1922, 1928, 1929, 1998, 1999, 2193, 2194, 2195, 2196, 2197, 2198, 2223, 2224, 2225, 2932, 2933, 2934, 2935, 2936, 2937, 2938, 2942, 2943, 3128, 3129, 3130, 3131, 3132, 3283, 3284, 3285, 3286, 3289, 3290, 3327, 3328, 3329, 3330, 3332, 3333, 3334, 3335, 3336, 3337, 3338, 3339, 3345, 3346, 3913, 3914, 4071, 4072, 4466, 4846, 4847, 4883, 4884.

Uncovered branches (start line:column to end line:column): 1208:33-1208:60, 1227:32-1227:37, 1404:23-1404:53, 1405:24-1405:53, 1441:27-1441:73, 1468:25-1468:71, 1638:34-1638:46, 1639:57-1639:61, 1640:51-1640:56, 1763:4-1765:3, 1850:28-1850:60, 1851:45-1851:56, 1916:67-1916:80, 1920:6-1922:5, 1927:6-1929:5, 1958:51-1958:64, 2021:55-2021:68, 1997:14-1999:13, 2087:29-2087:34, 2192:42-2198:3, 2206:53-2206:66, 2218:35-2218:46, 2222:8-2225:7, 2285:13-2285:60, 2286:6-2286:16, 2492:18-2492:27, 2493:32-2493:37, 2527:59-2527:64, 2535:33-2535:42, 2537:31-2537:40, 2549:72-2549:77, 2713:34-2713:40, 2727:21-2727:118, 2741:26-2741:67, 2744:61-2744:81, 2848:18-2848:27, 2849:32-2849:37, 2931:4-2938:3, 2941:33-2943:3, 2995:51-2995:64, 3009:39-3009:54, 3009:55-3009:81, 3017:29-3017:57, 3020:-1-3020:99, 3020:100-3020:104, 3127:25-3132:7, 3139:26-3139:107, 3160:102-3160:120, 3168:6-3169:6, 3282:24-3286:9, 3288:27-3290:7, 3311:18-3311:58, 3312:19-3312:58, 3326:23-3330:9, 3331:7-3339:7, 3344:7-3346:7, 3364:22-3364:40, 3380:17-3380:108, 3381:32-3381:58, 3382:88-3382:111, 3238:20-3238:58, 3397:54-3397:86, 3398:41-3398:86, 3415:35-3415:80, 3466:18-3466:27, 3467:32-3467:37, 3469:35-3469:44, 3521:43-3521:84, 3530:31-3530:58, 3546:53-3546:66, 3570:53-3570:66, 3583:31-3583:58, 3587:75-3587:102, 3609:28-3609:33, 3613:22-3613:37, 3644:34-3644:39, 3747:8-3747:28, 3753:44-3753:70, 3866:8-3866:60, 3868:33-3868:53, 3869:8-3869:61, 3873:18-3873:33, 3885:19-3885:64, 3886:31-3886:58, 3912:20-3914:5, 3934:17-3934:62, 3935:29-3935:56, 3851:47-3851:94, 3998:70-3998:73, 4070:4-4072:3, 4129:26-4129:106, 4139:94-4139:107, 4328:36-4328:41, 4330:56-4330:81, 4373:66-4373:71, 4374:42-4374:47, 4396:21-4396:26, 4399:65-4399:76, 4400:83-4400:89, 4406:21-4406:26, 4409:65-4409:76, 4419:14-4419:19, 4461:15-4461:21, 4462:31-4462:36, 4465:35-4465:61, 4465:63-4467:5, 4490:97-4490:102, 4538:23-4538:40, 4681:64-4681:68, 4736:54-4736:111, 4739:58-4739:87, 4802:51-4802:96, 4804:19-4804:109, 4807:23-4807:114, 4830:21-4830:115, 4833:22-4833:128, 4835:21-4835:112, 4845:38-4845:52, 4845:54-4847:3, 4882:69-4884:7, 4889:17-4889:82, 4899:35-4899:40, 4911:71-4911:84, 5057:61-5057:72, 5071:79-5071:90, 5079:107-5079:118, 5088:87-5088:92, 5131:23-5131:28, 5365:43-5365:48, 5404:37-5404:42, 5526:14-5526:71.

## scripts/coverage-gate.ts

Uncovered statement lines: none.

Uncovered branches (start line:column to end line:column): 102:52-102:110.

## Final branch closure pass

The subsequent complete run passed all 484 tests with 100% statements, lines,
and functions and 99.59% branches. Its complete remaining branch inventory in
`index.ts` was: 4134:26-106, 4686:64-68, 4809:19-109, 4812:23-114,
4838:22-128, 4840:21-112, 4893:17-82, 5075:79-90, 5408:37-42.
These coordinates refer to that measured source revision, before the last two
private-path removals shifted later lines.

The real HTTP/PM command cases now exercise unauthenticated low-quota advice,
open and closed board listing, each local Projects mutation failure, and a
successful subprocess returning an object with missing tags. The Projects
missing-identity fixtures verify the upstream helpers reject empty ids before
the private executor can receive them. Its redundant empty-id guard was removed.
The pull planner only appends a skipped status when its name is truthy and
assigns that same name to the entry, proving the missing-name fallback dead.

Other removed arms have their proofs recorded in `pm-github-9cjx`: validated
phone matches contain digits; fixed subprocess arguments return failure receipts;
nullish SDK bindings only execute for missing injections; successful HTTP calls
are 2xx; a loop over search hits requires nonempty hits; an atomic preview returns
before the plain preview; private project entries have parsed issue coordinates
and originate in a complete SDK corpus with tags and body fields. Exported
planner and report defaults that callers can actually supply remain tested.

All coverage measurements use the unchanged inventory of 12 authored TypeScript
and JavaScript modules, including operational scripts, with exact thresholds,
zero source ignores, and zero skipped executable source. Final full release
receipts are recorded in the linked PM items.

The first full npm release acceptance at `40db9b3` passes all 487 tests, with zero failures or skips.
The complete receipt covers 8,391/8,391 statements and lines,
2,218/2,218 branches, and 208/208 functions across the 12-module inventory.
Every statement and branch counter is positive; no uncovered entries remain.
The full release command also passes typecheck, build, docstrings, lint,
zero duplication, Git-object privacy, production audit, packing, changelog,
and publish attestation. Native Bun and the Bun-invoked release command are
reported separately in PM evidence.

## Native Bun transport timeout regression

The broad native suite and a focused rerun both showed that a real local
silent server passed the socket timeout and reached the unchanged 45-second
test limit. The HTTP client now enforces the original 30 seconds with an
explicit wall-clock timer, cleared on Promise settlement. The callback rejects
before destroying the request: native Bun can emit response end synchronously
on destruction, which must not resolve a truncated timed-out response as success.
The regression covers silent headers and a partial body that never completes
using two real HTTP connections. Details and before/after receipts are recorded
in `pm-github-hptv`; this independent defect does not establish the historical
installed-public-repeat root cause. Full release gates are remeasured after it.

The post-fix full npm release check at `5ed8c47` also passes all 487 tests
with zero failures or skips. Exact coverage is 8,398/8,398 lines and statements,
2,219/2,219 branches, and 208/208 functions, with no uncovered counters.
The same 12-module inventory and every 100% threshold remain unchanged.

The complete `bun run release:check` repeats those same exact counts and all
487 passing tests, with no failures/skips and every configured release gate
passing. Four syscall fault fixtures use explicit method replacement/restoration
because native Bun lacks `node:test`'s `mock.method`; the real files, permission
changes, live-peer assertions and fault outcomes are unchanged. Focused checks
pass 4/4 under Node and Bun, and the complete Node lock file passes 24/24.

Privacy executable-lookup fixtures start a real same-runtime child with its PATH
set at launch. Bun caches startup lookup and falls back to default tool lookup
for an empty PATH, so the missing-tool control uses a scratch directory with no
Git executable. Malformed inventory and blob-read controls retain real Git
repositories and narrow wrappers that delegate valid operations. The complete
25-case privacy files pass under Node and native Bun; authored production code
has not changed since the full npm/Bun release checks.

## Historical closing receipts

The receipts in this closing section are historical: they were measured at the
implementations named above, they cite the 487-test count of that era, and the
"remain open" note predates the orchestrator's verification.

The final fresh coverage run with every portable fixture again passes 487/487
without skips, covers all 12 modules at exact 100/100/100/100, and has zero
uncovered statement/branch counters. Its final receipt contains 8,398 lines and
statements, 2,220 branches and 208 functions, all covered. Earlier complete
release receipts contain 2,219/2,219 branches; the final fixture receipt is the
current measurement and remains exact 100 with unchanged production source.

Entry-fixture cleanup explicitly restores `process.exitCode` to the previous
value or zero. Bun does not clear a prior failure when assigned undefined.
The four affected Bun files each return exit zero; their combined Node run
passes all 38 cases. The final native acceptance requires both all 487 cases
passing across 30 files and a zero command exit status.

Final `npm run test:bun` acceptance returns process exit zero and passes all
487 cases across all 30 files, with zero failed cases. All final portable
fixtures, the original deadline checks and the executable workflow battery are
included. PM items remain open with released claims for orchestrator review.

Current status (review round 3): `pm-github-9cjx` is closed by the orchestrator
with the exact all-source 100/100/100/100 gate green across the unchanged
12-module inventory. The closing head passes 504/504 tests; the current head
passes 505/505 with zero failures or skips.

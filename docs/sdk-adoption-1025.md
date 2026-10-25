# Import lifecycle SDK adoption

The 2026-10-25 audit identified one remaining manual persistence boundary.
The implementation uses the existing pinned SDK 2026.10.20; no dependency bump
or provider chronology rewrite is required.

| Audit finding | Replacement or disposition | Evidence |
| --- | --- | --- |
| `import-fidelity.ts:445-454` manual lock followed by item/history persistence | `mutateItem` owns locking, persistence, append rollback, index refresh and hooks. The mutation callback retains GitHub lifecycle fields, normalization, chronology validation and no-op detection. `createHistoryEntry` only projects the established JSON-pointer hook fields; it does not persist an event. | `test/sdk-adoption.test.ts`, `test/import-fidelity.test.ts`, differential replay below |
| Same finding: assess `commitItemMutations` for ordinary conditional fields | Already used by `index.ts`'s atomic import path. Its update step forwards ordinary update options; it has no document callback for exact reserved native lifecycle timestamp edits. Lifecycle finalization must remain a single `mutateItem` boundary rather than splitting its fields across another transaction. No missing SDK API blocks this adoption. | Existing atomic import, compensation and retry tests in `test/import-fidelity.test.ts` |
| `closeout.ts:357-368` acceptance chronology | Already uses `readHistoryEntries`, `getHistoryPath` and `verifyHistoryEntries`. Remaining chronology and attribution are GitHub domain rules, explicitly excluded by the audit from unused history APIs. | Existing closeout tests; no code replacement |

## Differential proof

The baseline is the **built origin/main** at
`1cb49ac06bfee8d1193137367f86a36798a1040e`, compiled before editing source.
Replay inputs are complete public `.agents/pm` snapshots from that pm-github
commit and pm-brief commit `d20acab0e54b33f01324d6e5201f4c13937c9e5f`.
Selected existing items are `pm-github-sq5l` and `pm-brief-1oo2`.
Their input snapshots are never written: the harness hashes every source file
before and after replay. Every invocation uses a separate copy in a plain
temporary directory, a Git discovery ceiling, and a PATH with no git executable.

`test/sdk-adoption-differential.ts` accepts a baseline build root followed by
pairs of snapshot tracker roots and item IDs. Run it after compiling the current
implementation with `npm run build`. Each build root contains `dist/` and resolves
the package's pinned dependencies. Produce the baseline with `git archive` of
the commit above in a disposable checkout and compile it with the same lockfile;
produce tracker snapshots with `git archive <commit> .agents/pm` from each public
repository. Pass the extracted `.agents/pm` directories to the harness.

**14 scenarios passed:** two real public trackers times seven scenarios.
Closed source, reopened source, provider link-only, and normalized-timestamp
retries produce identical item/history bytes and import hook payloads. A frozen
clock makes exact history hashes comparable. All successful scenarios also assert
that retry preserves bytes and emits no further import hooks.

Intentional SDK differences, asserted separately on each tracker:

- A transactional `beforeMutation` guard now refuses before either durable write,
  with SDK conflict exit code 4 and the guard's structured refusal code.
- Strict ownership now refuses a conflicting assignee before either durable write,
  with SDK conflict exit code 4.
- A missing item uses the SDK's `Item … not found` diagnostic rather than the
  import adapter's custom missing-during-finalization message. Its exit code is
  now SDK not-found code 3 instead of generic code 1. Both write nothing.
- SDK derived-index maintenance emits its own lock create/release observations.
  These runtime lock events are excluded from durable/import-hook equality;
  both `import` and `import:history` payloads remain exactly compared.

Other inherited SDK contracts apply: workflow/history-stream policies, native
TOON storage migration for legacy documents, service overrides and affected-item
accounting. Public replay inputs use native TOON; format migration is not claimed
as byte-identical legacy-format behavior. Source timestamps, cross-provider
lifetimes, release retention and existing import hooks remain domain contracts.

## Behavioral revert proof

Restoring only `persistImportFidelity` and its imports to origin/main makes
`node --test test/sdk-adoption.test.ts` fail **2/3** cases: transactional guard
and strict-ownership refusal both become missing rejections. The hook/retry case
still passes, confirming that it checks retained compatibility. Restoring the
SDK implementation passes **3/3**, without SDK mocks and without git.
The tracker records the command and result; full package gates retain all four
100 percent coverage thresholds.

## Gate evidence

The local `npm run release:check` passed with an isolated home and Git identity:
**1,498 passed, zero failed/cancelled/skipped**, exact **100/100/100/100** across
**19 authored modules**, zero production vulnerabilities, and passing privacy,
duplication, packaging, changelog and publish-attestation checks.
The native Bun targeted regressions passed **3/3** as well.

CI's npm and Bun release-gate steps passed on Node 22 and 26 for source commit
`cd75897ec50399a996be8680b7830bd5836f4004`:
[source CI run](https://github.com/unbraind/pm-github/actions/runs/40208204021).
The [PR checks](https://github.com/unbraind/pm-github/pull/180/checks) carry the
current head's complete matrix and additional native Bun acceptance results.
Independent review remains pending; unavailable, skipped and neutral automated
review responses do not count as approval.

# Issue #197: lifecycle compensation recheck

Issue #197 is **not fixed**. Main `300e115` includes PR #223, but lifecycle
finalization still writes a separate `import` history event from the bulk
transaction's `committing` observer. An ordinary failure after that write
leaves the SDK unable to prove exclusive ownership for compensation.

The existing owner is [pm-github-quay](../.agents/pm/issues/pm-github-quay.toon).
The required API is tracked by
[pm-cli#1656](https://github.com/unbraind/pm-cli/issues/1656), still open at this
2026-11-06 check. This recheck changes documentation and tracking only. It does
not add a rollback implementation, change dependency pins, remove assertions,
extend quarantines or claim a behavioral revert proof.

## Reproduction

The three existing cases were run against a disposable copy of main using real
temporary SDK trackers. The recovery fixture starts a real OS process and exits
after finalization, before the journal commits. Each version was also run with
only the two tracker helpers' `git init` calls removed, exercising plain
directories. Production source and test assertions were unchanged.

For the pinned SDK only, the disposable copy set both
`needsOwnedFinalization` constants to `false`; this made the two quarantined
tests execute. The committed predicates and their assertions remain unchanged.
The reproduction command was:

```sh
node --test --test-concurrency=1 --test-reporter=tap \
  --test-name-pattern='real SDK atomic compensation restores|terminal failures remove replay plans after real SDK compensation' \
  test/import-fidelity.test.ts test/refresh.test.ts
```

Other SDK versions were installed from public npm into separate disposable
consumers with lifecycle scripts disabled. Each used the same source and test
files plus the extension's runtime dependencies; development-tool peer
requirements were excluded. No original tracker or installed SDK was patched.

| SDK | Git tracker | Non-Git tracker | Skips |
| --- | --- | --- | --- |
| 2026.10.17 (declared minimum) | 3 passed, 0 failed | 3 passed, 0 failed | 0 |
| 2026.10.26 | 1 passed, 2 failed | 1 passed, 2 failed | 0 |
| 2026.11.4 (development pin; quarantine disabled in the copy) | 1 passed, 2 failed | 1 passed, 2 failed | 0 |
| 2026.11.5 | 1 passed, 2 failed | 1 passed, 2 failed | 0 |
| 2026.11.6 | 1 passed, 2 failed | 1 passed, 2 failed | 0 |

Every failing row has the same failures: source-lifecycle restoration/removal
of the new item, and recovered-refresh plan cleanup. Across ten runs, the
30 executed cases report 14 passes and 16 failures, with no skips. These are
deliberately exposed compatibility failures, not passing acceptance gates.

The passing fresh-refresh control first completes its original import, then
changes only the title. Its finalizer is a no-op. It does **not** establish
rollback after a fresh lifecycle change.

## Actual state after failure

A non-Git mixed-import reproduction also inspected the original failure after
catching it: the existing item's title and `github_updated_at` retained the
new imported values, and the newly created item still existed. Two items
remained instead of the required original one. The journal was `compensating`,
and the original history bytes remained a prefix of its extended history.

A separate diagnostic used four new non-Git trackers: fresh and recovered
refreshes, each with and without an independent SDK writer. The peer process
ran `update` on the same item while the parent was inside `committing`, after
source finalization and before the injected ordinary failure.

All four retained the new upstream title, closed status and source creation,
closure and completion dates. Each reported incomplete compensation, retained
a `compensating` SDK journal and kept its replay plan discoverable through
`listUnfinishedGithubImports`. The initial history bytes remained an exact
prefix of the resulting history. The finalizer's `import` event had no
`item_transaction_step` ownership context.

In both peer-write cases, the independently written description and its full
history prefix survived. This confirms that the ownership refusal protects a
real writer. It is not permission to force a restore or delete the journal.
These are residual-state and protection observations, not successful rollback
acceptance results.

## Checks on the unchanged development pin

The linked targeted test ran through `pm test pm-github-quay --run --only-last
--progress` on Node 24.19.0. It reported **6 tests: 4 passed, 0 failed, 2
skipped**. The four passes cover the two quarantine-boundary checks, the fresh
cleanup control and the already-fixed GH-1614 plain assignment/repeat case.
The two skips are the existing 2026.11.4-only compensation quarantines.

```sh
node --test --test-concurrency=1 \
  --test-name-pattern='real SDK atomic compensation restores|terminal failures remove replay plans|quarantine re-enables|GH-1614 plain' \
  test/import-fidelity.test.ts test/refresh.test.ts \
  test/atomic-finalization-quarantine.test.ts test/typed-sentinel-normalization.test.ts
npm run lint
npm run typecheck
npm run build:test
```

All three static checks passed. Full npm/Bun release gates and native Bun tests
remain CI responsibilities for this documentation change; a green run with
the retained skips cannot certify #197. There is no production change to
revert and no new test or assertion for which a repair/revert claim is made.

The existing Git-object privacy gate passed for 9,049 objects, and the four
changed files separately passed its content rules. Strict tracker health
passed with an isolated home. The regular home reported the local
2026.11.4/2026.11.5 extension-host version mismatch; no shared configuration
was changed to hide it. Tracker history remains a byte-prefix extension of
main's history.

## Public API inspection

The installed 2026.11.4 declarations and the published 2026.11.5 and 2026.11.6
artifacts expose this union in `dist/sdk/item-transaction.d.ts`:

```ts
export type BulkItemMutation = BulkItemCreateMutation | BulkItemUpdateMutation
  | BulkItemCloseMutation | BulkItemReleaseMutation;
```

`CommitItemMutationsOptions.onTransition` remains an observer. There is no
transaction-owned lifecycle document or finalization step. `mutateItem` and
`commitImportedItem` support independent item writes, but do not join a bulk
step's snapshot and ownership proof. `commitWorkspaceTransaction` requires
the adapter to implement `inspect`, `prepareCompensation`, `apply` and
`compensate`; using it here would require recreating the missing PM item
ownership and recovery semantics.

The 2026.11.5 and 2026.11.6 item-transaction declaration files have identical
SHA-256 `4aef753f5a61a9779e0364d6bda9151bb4ba797480505677870a53276555f3e1`.
The inspected public tarballs have these SHA-256 digests:

| SDK | Tarball SHA-256 |
| --- | --- |
| 2026.11.5 | `902a70b09d7d61e4887ac0cfc0700c177ec17bd1de532c0c149fedf30ffc0d82` |
| 2026.11.6 | `f06ab0ab57b6e7021f1474c6f912cc3dd30eadab35a03a6b1d5faf8438b3e705` |

The next implementation must adopt a supported owned step, preserve source
dates and hooks, and pass these existing ordinary-failure assertions without
quarantine. It must also retain foreign writes and resumable plans when
compensation is unsafe. Reordering the observer, finalizing after commit,
forging ownership markers and forcing timestamp restoration do not meet that
contract. Until the upstream API exists and is adopted, #197 must stay open.

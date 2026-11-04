# Atomic source finalization and SDK compensation

The toolchain PR resolves `@unbrained/pm-cli` 2026.11.4. Its compensation
contract changed in 2026.10.26, in the GH-1591 fix, **guarded terminal updates
conflict with their own scalar write and misreport compensation**.

Previously, `compensateByRestore` forced a restore by timestamp. The new
`hasOwnedCompensationEffects` requires a retained history prefix and proof that
the changes belong to the transaction step. It refuses intervening mutations
with `transaction_partial_mutation`, retaining the compensating journal.
This protects another writer's work and must remain enabled.

`commitGithubImportTransaction` finalizes exact GitHub source lifecycle fields
with `persistImportFidelity` inside its `committing` observer. That operation
appends its own `import` event, with the message `Preserve GitHub source lifecycle
for issue #…`. It is outside the bulk step's ownership proof. If the observer
subsequently throws, native compensation cannot undo that event safely.

This is a production integration incompatibility, not an obsolete assertion.
The existing real-SDK regression must continue requiring both original source
lifecycle restoration and removal of newly created items after finalization.

## Minimal SDK shape

Initialize a synthetic tracker and supply its root as `pmRoot`:

```ts
import { PmClient, commitItemMutations } from '@unbrained/pm-cli/sdk';

const client = new PmClient({ pmRoot, author: 'fixture', noExtensions: true });
await client.init('fixture');
const { item } = await client.create({ title: 'Original', type: 'Task' });
await commitItemMutations({
  pmRoot, author: 'fixture', transactionId: 'synthetic-finalization',
  mutations: [{ op: 'update', id: item.id, options: { title: 'Changed' } }],
  onTransition: async context => {
    if (context.transition !== 'committing') return;
    // A second SDK mutation has its own event, outside the bulk step.
    await client.update(item.id, { description: 'Source finalization' });
    throw new Error('Synthetic finalization failure');
  },
});
```

The importer needs rollback to the pre-batch document. The new SDK instead
reports incomplete compensation, with `transaction_partial_mutation` in the
underlying error, because the second event is unowned. The package reproducer
uses the actual lifecycle finalizer:

```sh
node --test --test-name-pattern='real SDK atomic compensation restores' test/import-fidelity.test.ts
```

## Required resolution

A source finalizer needs a supported durable transaction step, with a snapshot,
ownership attribution and compensation for its exact lifecycle changes. The
current bulk mutation union accepts create, update, close and release; it does
not accept an importer callback as a journaled raw-document mutation.

Moving finalization after commit would sacrifice rollback of source lifecycle
changes. Calling the fault observer before finalization would bypass the
regression's failure boundary. Forging private bulk history markers or forcing
restoration would bypass the new ownership guard. None is an acceptable fix.

The existing pm item `pm-github-quay` retains this blocker for coordinator
review and an upstream API discussion. No upstream regression is asserted:
the new refusal is the documented safety behavior, while the importer needs a
supported way to preserve its stronger atomic finalization property.

## Recheck on SDK 2026.11.4

The focused existing three-case matrix reports **1 passed, 2 failed**:

- Source-lifecycle restoration and removal of newly created items after finalization: failed.
- Terminal refresh plan cleanup, fresh invocation: passed.
- Terminal refresh plan cleanup, recovered invocation: failed.

The standalone public SDK shape above also reproduces an `AggregateError` and
retained `compensating` journal. The item still has `title: "Changed"` and
`description: "Source finalization"`; the importer requires the original
pre-batch document. The ownership refusal remains protective behavior.

[pm-cli#1656](https://github.com/unbraind/pm-cli/issues/1656) is still required
for a supported transaction-owned lifecycle finalizer. SDK 2026.11.4 adds
expected-item-revision guards (GH-1576), but those guards do not add a durable
raw-document step to the create/update/close/release union. A custom coordinator
would have to reimplement native step ownership, recovery and compensation;
that is not a safe narrow replacement for this bulk helper. Registering a new
write hook also must preserve the caller's active hooks and bind replay to the
original plan; changing global hook registries is not a finalization contract.

No observer reordering, post-commit finalization, forged SDK markers, forced
rollback or compensation assertion changes are used. The remaining production
integration blocker is explicit; this PR does not certify atomic finalization.

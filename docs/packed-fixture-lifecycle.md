# Packed consumer lifecycle and cleanup

Issues: [#202](https://github.com/unbraind/pm-github/issues/202) and
[#177](https://github.com/unbraind/pm-github/issues/177).

The packed projection fixture uses real npm and native Bun consumers against a
synthetic HTTP provider and a disposable non-git tracker. Every existing
mixed-import byte/history, JSON/TOON, alias, and preview assertion remains in
place, with the original command deadlines and 600-second test timeout.

## Producer ownership

The pinned CLI's telemetry runtime schedules an unreferenced, detached
`telemetry-flush.js` child by default outside test mode. Its direct parent's
exit therefore does not prove that the queue and state writer has exited.
The fixture removes `NODE_TEST_CONTEXT` when starting consumer commands, so it
must explicitly select the supported `PM_TELEMETRY_INLINE_FLUSH=1` lifecycle.
The same control already appears in the closeout and import-gate fixtures.

`packedFixtureEnvironment` selects this lifecycle and a disposable
`PM_GLOBAL_PATH`, overriding inherited values. It keeps child coverage enabled
and retains credential stripping and the clean npm user configuration. No host
settings or telemetry preferences are changed.

The regression initializes an actual SDK tracker, creates a native item, and
updates it with the installed CLI under the active test runtime. A real preload
records the producer runtime; the Bun test must execute Bun itself. A
fixture-local telemetry endpoint holds its
response for one second. The CLI must finish delivery and record the durable
successful flush before the fixture body returns. Reverting only the inline
flag fails that assertion: the direct CLI exits before delivery completes.
This identifies a real producer and lifecycle boundary; it does not claim to
reconstruct the precise process timing of the historical hosted failure.

## Outcome preservation

`withPackedFixture` starts cleanup ownership immediately after allocation of the
base directory. Directory creation, environment construction, SDK initialization,
the consumer body and HTTP-server teardown all run inside that scope. Both the
packed projection and producer regression use this owner. There is no independent
outer removal that could replace its reported failure.

`withFixtureCleanup` awaits the body, then removes the disposable tree with
bounded retries for transient filesystem errors. It handles all four outcomes:

| Body | Cleanup | Result |
| --- | --- | --- |
| Pass | Pass | Original return value |
| Fail | Pass | Original thrown value |
| Pass | Fail | Cleanup error |
| Fail | Fail | AggregateError containing both errors, original failure as cause |

Tests initialize real SDK trackers and await a real OS child before teardown.
An injectable remover supplies a controlled `ENOTEMPTY` error to exercise
error preservation independently of filesystem permissions or elevated
privileges. The success and primary-only controls still execute real removal.
The delayed telemetry producer test above exercises the actual OS-process
lifecycle; no SDK mock substitutes for tracker operations.

A setup regression creates a real non-git SDK tracker and uses an OS child to
place a file where the consumer directory must be created. Setup must report
`EEXIST`, never start the body, and remove the partial fixture and tracker. This
failure does not depend on permissions or elevated privileges. The cleanup-error
controls run through the same owner used by both consumers.

## Already-fixed coverage issue

Main contains [#215](https://github.com/unbraind/pm-github/pull/215), merged as
`ceaecfe2226e5b41fa39a5c546824d7f1081f79f`. Its native c8 incremental merge and
3072 MiB heap ceiling fix the allocation class in #177 without filtering child
receipts or lowering the exact four-dimensional coverage thresholds. This
change does not alter the coverage implementation or its inventory.

Rechecking main `03c3059` passed all 13 coverage-gate tests. The expanded
512-receipt case handles 158,244,352 serialized bytes under a 128 MiB merge
heap. The focused command peaked at 116,064 KiB RSS. Removing only
`--merge-async` in a disposable copy fails that case with heap exhaustion.
The existing missing/stale/incomplete, uncovered-line, branch-only, and
unloaded-source controls also pass. Prior full-suite measurements are in
[bounded-coverage-merge.md](bounded-coverage-merge.md).

Historical full npm/Bun Node 22/26 acceptance is verified at #215 head
`7e29ca02e8a3df023d3ac4cea079662a08601991` in
[CI run 41718350180](https://github.com/unbraind/pm-github/actions/runs/41718350180).
Current PR CI must independently certify the revised head.

## Reproduction

```sh
npm run build
node --test --test-concurrency=1 test/packed-fixture.test.ts
node --test --test-concurrency=1 test/import-projection.test.ts
node --test --test-concurrency=2 test/coverage-gate.test.ts
npm run lint
npm run typecheck
npm run build:test
```

Behavioral reverts run only in disposable copies. Removing the inline flush
flag fails the real producer test; removing global-root isolation fails the
inherited-override regression; restoring bare `finally` removal fails primary
error preservation. Forcing the producer back to Node fails the runtime
receipt assertion under Bun. Restoring the fixed implementation must pass again.
Moving setup outside cleanup ownership fails the setup-removal regression.
Replacing the owner's delegated cleanup with a bare `finally` fails its
primary-plus-cleanup regression. Each mutation keeps the callable interface and
fault boundary intact and runs in a disposable copy with a passing baseline.
The original packed baseline separately timed out during package installation
on the shared development host. That receipt proves neither import assertion
success nor a cleanup error, and no deadline is increased to accommodate it.
A later complete linked rerun passes all six projection tests, including the
packed consumer, at the original deadlines.

The fixed lifecycle regression passes 4/4 under Node and native Bun with zero
skips. Lint and both source/test typechecks pass. Linked pm reruns pass
13/13 coverage tests, 4/4 lifecycle tests and 6/6 projection tests. Positive
cleanup controls share the primary-error regression so each new test fails its
behavioral revert. Two earlier repaired-fixture attempts timed out during
installation, including one using the existing public npm cache. Follow-up
`pm-github-r14n` retains those intermittent failures and the later successful
rerun without asserting an unproven resource or registry root cause.

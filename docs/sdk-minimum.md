# Declared SDK minimum

pm-github requires PM CLI **2026.10.23 or newer**. The top-level
`manifest.json` `pm_min_version` is the floor enforced by the host. npm peer
dependencies declare that minimum. The development dependency is an independent
exact pin in `package.json`, with an identical integrity-checked lock resolution.

The minimum covers the entire package contract, rather than one imported name:

| Contract | Published evidence | First supported release |
| --- | --- | --- |
| Public `decodePmTableRows` export | Absent in SDK 2026.10.5–2026.10.8; exported through `sdk/index` → `sdk/output` → `sdk/output/table-rows` in 2026.10.9 | 2026.10.9 |
| `BulkItemUpdateMutation.match` under-lock revision guard | Absent in published SDK 2026.10.9–2026.10.15; present in 2026.10.17. Version 2026.10.16 was not published. | 2026.10.17 |
| `acquireLockLease` with generation fencing | Absent from public SDK exports in 2026.10.22; exported with `LockLease.fence` in 2026.10.23 | 2026.10.23 |
| All contracts, including cross-item import ownership | No unfenced fallback: every ownership-changing operation holds a fenced lease | 2026.10.23 |

These declarations were read from published npm tarballs, including
[SDK 2026.10.8](https://registry.npmjs.org/@unbrained/pm-cli/-/pm-cli-2026.10.8.tgz),
[SDK 2026.10.9](https://registry.npmjs.org/@unbrained/pm-cli/-/pm-cli-2026.10.9.tgz),
[SDK 2026.10.15](https://registry.npmjs.org/@unbrained/pm-cli/-/pm-cli-2026.10.15.tgz)
and [SDK 2026.10.17](https://registry.npmjs.org/@unbrained/pm-cli/-/pm-cli-2026.10.17.tgz).
A decoder-only floor would allow an unsupported identity-repair revision guard.
Raising the floor preserves that guard instead of dropping it or detecting it
only after a command has started.

Run `npm run test:minimum-sdk` to build and capture a package artifact, install
it alongside the **exact declared minimum** from npm, and type-check every
production and operational TypeScript module against that installation. This
covers every production and operational SDK import, including the `sdk`,
`sdk/authoring` and `sdk/graph` entry points. It also checks every shipped
declaration as an ambient TypeScript source, so skipped dependency declarations
cannot hide a missing SDK type. It type-checks a public typed consumer, imports
the actual installed artifact, and exercises label preview,
approval, SDK table restoration and literal native comma tags in a plain tracker
with no git executable. No SDK mocks or development-node_modules symlinks are
used. Runtime dependencies, TypeScript and Node types are installed in the
minimum consumer. Operational pm-ops types come from a separate fixture tooling
project, whose newer SDK peer cannot replace the consumer SDK. A synthetic tool
requires the exact development SDK to verify that isolation on every run.
Public npm child processes use the null user configuration and exclude
credential variables; dependency lifecycle scripts are disabled.

The test is part of the normal test inventory, so the unchanged npm/Bun release
gates execute it in CI. Under native Bun, compiler tooling still runs through
Node while the installed artifact runs through Bun itself. A future SDK import
or required SDK option above the floor fails this check even when the newer
development SDK would accept it. The CLI refuses older hosts through the
manifest floor before loading the extension's ESM imports.

The current breaking minimum is generated into `CHANGELOG.md` from
[pm-github-reference-identity](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-reference-identity.toon)
using its `changelog-unreleased` tag. Historical minimum changes remain in their
original release entries. The item stays unclosed until orchestrator verification.

Validation on 2026-10-27 passed under Node and native Bun 1.3.14 (one real
consumer test each). In disposable copies, changing only the manifest floor and
matching dependency ranges to 2026.10.5 fails at ESM linking with the missing
`decodePmTableRows` export; 2026.10.15 links but fails compilation on the missing
`BulkItemUpdateMutation.match` option. Restoring 2026.10.17 passed the same test
at that historical head. The current fenced-lock floor is documented below.
The reviewed checkout is never mutated by those negative proofs.

## Fenced ownership floor (2026-11-12)

Published SDK tarballs establish the adjacent boundary:
[2026.10.22](https://registry.npmjs.org/@unbrained/pm-cli/-/pm-cli-2026.10.22.tgz)
does not export `acquireLockLease`, while
[2026.10.23](https://registry.npmjs.org/@unbrained/pm-cli/-/pm-cli-2026.10.23.tgz)
exports it in both JavaScript and declarations. Its `LockLease.fence` refuses a
released or replaced generation with `lock_lost`, before invoking the callback.
The minimum consumer executes both a live and a released lease on the real SDK.

All audited fleet caller `package-lock.json` resolutions already export this API:

| Caller | Locked PM CLI |
| --- | --- |
| pm-review | 2026.10.28 |
| pm-context | 2026.11.4 |
| pm-linear | 2026.11.4 |
| pm-brief | 2026.11.4 |
| pm-rl | 2026.11.3 |

The manifest and npm peer floor are therefore raised to 2026.10.23. The exact
development dependency remains unchanged. Unsupported hosts are refused by the
package/manifest contract rather than running an ownership write under an
expiring, unfenced lock. Read-only planning remains available on supported hosts.

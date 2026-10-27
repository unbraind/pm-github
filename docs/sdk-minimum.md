# Declared SDK minimum

pm-github requires PM CLI **2026.10.17 or newer**. The top-level
`manifest.json` `pm_min_version` is the floor enforced by the host. npm peer
and development ranges declare the same minimum. The development lockfile keeps
an exact, integrity-checked SDK resolution; it currently resolves 2026.10.23.

The minimum covers the entire package contract, rather than one imported name:

| Contract | Published evidence | First supported release |
| --- | --- | --- |
| Public `decodePmTableRows` export | Absent in SDK 2026.10.5–2026.10.8; exported through `sdk/index` → `sdk/output` → `sdk/output/table-rows` in 2026.10.9 | 2026.10.9 |
| `BulkItemUpdateMutation.match` under-lock revision guard | Absent in published SDK 2026.10.9–2026.10.15; present in 2026.10.17. Version 2026.10.16 was not published. | 2026.10.17 |
| Both contracts, including existing identity repair | Minimum-SDK compilation rejects 2026.10.9 because `match` does not exist; the guard must remain intact | 2026.10.17 |

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
covers all 80 named SDK imports in 11 modules, including the `sdk`,
`sdk/authoring` and `sdk/graph` entry points. It also checks every shipped
declaration as an ambient TypeScript source, so skipped dependency declarations
cannot hide a missing SDK type. It type-checks a public typed consumer, imports
the actual installed artifact, and exercises label preview,
approval, SDK table restoration and literal native comma tags in a plain tracker
with no git executable. No SDK mocks or development-node_modules symlinks are
used. Public npm child processes use the null user configuration and exclude
credential variables; dependency lifecycle scripts are disabled.

The test is part of the normal test inventory, so the unchanged npm/Bun release
gates execute it in CI. Under native Bun, compiler tooling still runs through
Node while the installed artifact runs through Bun itself. A future SDK import
or required SDK option above the floor fails this check even when the newer
development SDK would accept it. The CLI refuses older hosts through the
manifest floor before loading the extension's ESM imports.

The breaking minimum is generated into `CHANGELOG.md` from the pending
[pm-github-2e38](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-2e38.toon)
item using its `changelog-unreleased` tag. The item stays unclosed until the
orchestrator verifies the result.

Validation on 2026-10-27 passed under Node and native Bun 1.3.14 (one real
consumer test each). In disposable copies, changing only the manifest floor and
matching dependency ranges to 2026.10.5 fails at ESM linking with the missing
`decodePmTableRows` export; 2026.10.15 links but fails compilation on the missing
`BulkItemUpdateMutation.match` option. Restoring 2026.10.17 passes the same test.
The reviewed checkout is never mutated by those negative proofs.

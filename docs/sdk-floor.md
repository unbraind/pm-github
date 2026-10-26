# Published pm SDK capability floor

Audited main: `fcd9f93e28e85b170506ceac507d82a911173683`. Required API floor: **2026.10.2**.

Declared host floor: `2026.10.5`. npm peer: `>=2026.10.5`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: acquireLock` | 2026.5.14 | 2026.5.12 | [webhooks.ts:5](../webhooks.ts#L5) |
| `@unbrained/pm-cli/sdk :: canonicalDocument` | 2026.5.14 | 2026.5.12 | [import-fidelity.ts:4](../import-fidelity.ts#L4) |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [closeout.ts:2](../closeout.ts#L2), [index.ts:45](../index.ts#L45), [refresh.ts:5](../refresh.ts#L5) |
| `@unbrained/pm-cli/sdk :: close` | 2026.7.7 | 2026.7.6 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: comments` | 2026.7.9 | 2026.7.8 | [index.ts:45](../index.ts#L45) |
| `@unbrained/pm-cli/sdk :: commitItemMutations` | 2026.7.20 | 2026.7.19 | [index.ts:45](../index.ts#L45), [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: createHistoryEntry` | 2026.5.14 | 2026.5.12 | [import-fidelity.ts:4](../import-fidelity.ts#L4) |
| `@unbrained/pm-cli/sdk :: createPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [index.ts:45](../index.ts#L45), [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2), [index.ts:45](../index.ts#L45), [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: hashDocument` | 2026.7.23 | 2026.7.22 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: isExternalDependencyReference` | 2026.8.29 | 2026.8.28 | [index.ts:45](../index.ts#L45) |
| `@unbrained/pm-cli/sdk :: listAllComplete` | 2026.8.18 | 2026.8.17 | [closeout.ts:2](../closeout.ts#L2), [index.ts:45](../index.ts#L45), [refresh.ts:5](../refresh.ts#L5) |
| `@unbrained/pm-cli/sdk :: listAllItemMetadata` | 2026.7.13 | 2026.7.12 | [index.ts:45](../index.ts#L45) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: mutateItem` | 2026.7.23 | 2026.7.22 | [import-fidelity.ts:4](../import-fidelity.ts#L4) |
| `@unbrained/pm-cli/sdk :: normalizeItemId` | 2026.5.14 | 2026.5.12 | [import-fidelity.ts:4](../import-fidelity.ts#L4), [index.ts:45](../index.ts#L45) |
| `@unbrained/pm-cli/sdk :: pathExists` | 2026.5.14 | 2026.5.12 | [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: previewItemMutations` | 2026.10.2 | 2026.10.1 | [refresh.ts:5](../refresh.ts#L5), [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: readHistoryEntries` | 2026.7.15 | 2026.7.14 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: readHistorySnapshot` | 2026.9.8 | 2026.9.7 | [index.ts:45](../index.ts#L45), [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2), [import-fidelity.ts:4](../import-fidelity.ts#L4), [index.ts:45](../index.ts#L45) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: resolvePmRoot` | 2026.5.14 | 2026.5.12 | [gate.ts:34](../gate.ts#L34), [import-fidelity.ts:4](../import-fidelity.ts#L4), [index.ts:45](../index.ts#L45), [identity.ts:4](../identity.ts#L4) |
| `@unbrained/pm-cli/sdk :: runWithActiveExtensions` | 2026.7.21 | 2026.7.20 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: setActiveExtensionHooks` | 2026.7.23 | 2026.7.22 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [closeout.ts:2](../closeout.ts#L2) |
| `@unbrained/pm-cli/sdk :: writeFileAtomic` | 2026.5.14 | 2026.5.12 | [webhooks.ts:5](../webhooks.ts#L5), [index.ts:45](../index.ts#L45) |
| `@unbrained/pm-cli/sdk/graph :: collectNewOrderingCycleWarnings` | 2026.7.26 | 2026.7.25 | [index.ts:68](../index.ts#L68) |
| `AfterCommandHookContext.ok` | 2026.5.1 | 2026.3.12 | [index.ts:6886](../index.ts#L6886) |
| `BeforeCommandHookContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:6889](../index.ts#L6889) |
| `BeforeCommandHookContext.command` | 2026.5.1 | 2026.3.12 | [index.ts:6887](../index.ts#L6887) |
| `BeforeCommandHookContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:6890](../index.ts#L6890), [index.ts:6893](../index.ts#L6893) |
| `BeforeMutationHookContext.before` | 2026.8.2 | 2026.8.1 | [closeout.ts:668](../closeout.ts#L668) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:4043](../index.ts#L4043), [index.ts:4382](../index.ts#L4382), [index.ts:5564](../index.ts#L5564), [index.ts:6142](../index.ts#L6142), [index.ts:6182](../index.ts#L6182), [index.ts:6987](../index.ts#L6987), [index.ts:7003](../index.ts#L7003), [index.ts:7011](../index.ts#L7011), [index.ts:7021](../index.ts#L7021), [index.ts:7060](../index.ts#L7060) |
| `CommandHandlerContext.command` | 2026.5.1 | 2026.3.12 | [index.ts:6765](../index.ts#L6765) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:4380](../index.ts#L4380), [index.ts:6158](../index.ts#L6158), [index.ts:6216](../index.ts#L6216), [index.ts:7097](../index.ts#L7097), [index.ts:7133](../index.ts#L7133), [index.ts:7172](../index.ts#L7172) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:4042](../index.ts#L4042), [index.ts:4379](../index.ts#L4379), [index.ts:5330](../index.ts#L5330), [index.ts:5563](../index.ts#L5563), [index.ts:6141](../index.ts#L6141), [index.ts:6182](../index.ts#L6182), [index.ts:6198](../index.ts#L6198), [index.ts:6240](../index.ts#L6240), [index.ts:6473](../index.ts#L6473), [index.ts:6765](../index.ts#L6765), [index.ts:6957](../index.ts#L6957), [index.ts:6987](../index.ts#L6987), [index.ts:7002](../index.ts#L7002), [index.ts:7021](../index.ts#L7021), [index.ts:7060](../index.ts#L7060), [index.ts:7090](../index.ts#L7090), [index.ts:7091](../index.ts#L7091), [index.ts:7168](../index.ts#L7168), [index.ts:7172](../index.ts#L7172) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:4071](../index.ts#L4071), [index.ts:4394](../index.ts#L4394), [index.ts:5357](../index.ts#L5357), [index.ts:5401](../index.ts#L5401), [index.ts:6253](../index.ts#L6253), [index.ts:6269](../index.ts#L6269), [index.ts:6289](../index.ts#L6289), [index.ts:6302](../index.ts#L6302), [index.ts:6317](../index.ts#L6317), [index.ts:6508](../index.ts#L6508), [index.ts:6572](../index.ts#L6572), [index.ts:6584](../index.ts#L6584), [index.ts:6964](../index.ts#L6964), [index.ts:6965](../index.ts#L6965), [index.ts:6967](../index.ts#L6967), [index.ts:6987](../index.ts#L6987), [index.ts:7011](../index.ts#L7011), [index.ts:7021](../index.ts#L7021), [index.ts:7060](../index.ts#L7060), [index.ts:7093](../index.ts#L7093), [index.ts:7168](../index.ts#L7168) |
| `ExtensionApi.hooks` | 2026.5.1 | 2026.3.12 | [index.ts:6884](../index.ts#L6884) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:6917](../index.ts#L6917), [index.ts:6945](../index.ts#L6945), [index.ts:6975](../index.ts#L6975), [index.ts:6991](../index.ts#L6991), [index.ts:7015](../index.ts#L7015), [index.ts:7027](../index.ts#L7027), [index.ts:7071](../index.ts#L7071), [index.ts:7113](../index.ts#L7113), [index.ts:7150](../index.ts#L7150), [index.ts:7189](../index.ts#L7189), [index.ts:7224](../index.ts#L7224), [index.ts:7246](../index.ts#L7246), [index.ts:7270](../index.ts#L7270), [index.ts:7302](../index.ts#L7302) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:6820](../index.ts#L6820) |
| `ExtensionApi.registerImporter` | 2026.5.1 | 2026.3.12 | [index.ts:6780](../index.ts#L6780) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [index.ts:6730](../index.ts#L6730) |
| `ExtensionApi.registerPreflight` | 2026.5.1 | 2026.3.12 | [index.ts:6754](../index.ts#L6754) |
| `ExtensionApi.registerSearchProvider` | 2026.5.1 | 2026.3.12 | [index.ts:6850](../index.ts#L6850), [index.ts:6851](../index.ts#L6851) |
| `ImportExportContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:6781](../index.ts#L6781) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:6781](../index.ts#L6781) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:6781](../index.ts#L6781) |
| `SearchProviderQueryContext.documents` | 2026.5.1 | 2026.3.12 | [index.ts:6871](../index.ts#L6871) |
| `SearchProviderQueryContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:6854](../index.ts#L6854) |
| `SearchProviderQueryContext.query` | 2026.5.1 | 2026.3.12 | [index.ts:6859](../index.ts#L6859) |
| `WorkspaceTransactionTransitionContext.transition` | 2026.7.19 | 2026.7.18 | [index.ts:1713](../index.ts#L1713), [identity.ts:175](../identity.ts#L175) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.31 | `d3b4a795704588e414070a22a4034d7fbd7a290a050509cc4852e0051c0969a7` |
| 2026.6.5 | `bb47c85bb2ce1a8ba858651af8d1f4ca6888bc731d0aaaa63a4b97427219cd89` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.8 | `b892cce02e555decd3f0d09af0d2a5d8817494fe577e357ffaea84ef385a9b6a` |
| 2026.7.9 | `87600f77a82d5e66c8ac05f120b435a0fb22b5fad42ae5db4540bb4ca45a01ea` |
| 2026.7.12 | `a612224324e3ae91e2fc8c25f83d9a65fc13db66914aeb04ee65e16a523521be` |
| 2026.7.13 | `10d5b0f8787c643cb8caf58f656cc95097f6ac84fcdaa6ff59911780fcd894a5` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.18 | `44b48fe680cf330254a4ab8d42b55cbcee81ba5cf21e4d4550b40413265d64b9` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.7.21 | `99151effed0e40579f01629f135a73384cb8e8f922c6c63da497638507009452` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.7.26 | `b10b647a7fce423106dfb964934ac2d43b8770f8f085df89a13c9a04e75569cc` |
| 2026.8.1 | `242013e81ed2c4329a3cb20d3e70fa58f6dbb627d00c2c1e883562e786850f80` |
| 2026.8.2 | `c9f8e516319ba4d6609ea0272e4fa70360668531c379ec54b29df8aa418293e3` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.8.28 | `12c1a74910abc8f523320b6b40ee5aaaeaea59d24cef9e250321e7fc6d5c038c` |
| 2026.8.29 | `90705a7bef31b8cbd4eece98b72216d8d456cca1570a7361bf88b4208d6e6a31` |
| 2026.9.7 | `9befaac9056ce94b2dff006e0fe2329c0b0c18479bf9c9f9027684789387c7ae` |
| 2026.9.8 | `529c08a4cb65507f86dc3f9b7efd673a031c6491156ae753c0a058d0d48e10bc` |
| 2026.10.1 | `54eafd4428b5554a1860aa5311349f7dff167a63560f55e7f1315da63a775c02` |
| 2026.10.2 | `d1cc9a7c6ccc1da01788cf307be73cca81089215a88a63ce41c32803fdc45e3e` |

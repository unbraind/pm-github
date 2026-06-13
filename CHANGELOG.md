# Changelog

## Unreleased

### Other

- Daily Release publish step runs prepublishOnly post-tag: align npm publish with --ignore-scripts ([pm-github-za4r](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-za4r.toon))

## 2026.6.7 - 2026-06-07

### Added

- Preserve GitHub not-planned closures as canceled pm items ([pm-github-54tv](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-54tv.toon))

### Other

- Harden release readiness checks ([pm-github-1r09](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-1r09.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-github-ctqq](https://github.com/unbraind/pm-github/blob/main/.agents/pm/chores/pm-github-ctqq.toon))

## 2026.6.4 - 2026-06-04

### Added

- Import GitHub author + timestamps, rate-limit visibility, --skip-drafts ([pm-github-v0c3](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-v0c3.toon))

## 2026.6.3 - 2026-06-03

### Added

- Domain-max SDK enhancement: idempotent import, sync, preflight, renderer ([pm-github-mdlp](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-mdlp.toon))

### Changed

- Idempotent import: match by github\_number, update not duplicate; populate schema fields ([pm-github-fhiv](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-fhiv.toon))

### Fixed

- True round-trip GitHub sync: search provider, validate diagnostics, safe-by-default export, fix activation ([pm-github-9dqy](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-9dqy.toon))
- True round-trip GitHub sync: search provider, validate diagnostics, safe-by-default export, fix activation ([pm-github-4elt](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-4elt.toon))
- FIX: add 'preflight' to manifest capabilities \(activation-breaking bug\) ([pm-github-qndb](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-qndb.toon))

### Other

- Provenance scheme: gh:owner/repo\#N tag \(lowercased\), reused as-is ([pm-github-ggt3](https://github.com/unbraind/pm-github/blob/main/.agents/pm/decisions/pm-github-ggt3.toon))
- Export defaults to dry-run; real writes need --apply AND --repo ([pm-github-epdt](https://github.com/unbraind/pm-github/blob/main/.agents/pm/decisions/pm-github-epdt.toon))
- Search provider maps remote matches to LOCAL items only ([pm-github-o7jl](https://github.com/unbraind/pm-github/blob/main/.agents/pm/decisions/pm-github-o7jl.toon))
- Unit tests + functional verification + README + decisions ([pm-github-f3xf](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-f3xf.toon))
- Export: dry-run default + upsert existing issues by provenance ([pm-github-fv0x](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-fv0x.toon))
- github search provider \(search capability\) ([pm-github-5sbx](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-5sbx.toon))
- github validate diagnostics command ([pm-github-rroh](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-rroh.toon))
- preflight capability: validate token/gh auth + repo reachability before mutating github commands ([pm-github-jget](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-jget.toon))
- pm github sync: push pm status -\> GitHub close/reopen, guarded by token+--repo+--dry-run ([pm-github-yted](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-yted.toon))
- renderers capability: register 'github' output format \(pm items as GitHub-issue markdown\) ([pm-github-vvov](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-vvov.toon))
- Rate-limit/backoff handling \(Retry-After / X-RateLimit-Reset\) + useful afterCommand hook ([pm-github-rx1q](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-rx1q.toon))
- Import issue comments via --with-comments \(append to item body\) ([pm-github-kvl1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-kvl1.toon))
- Tests + functional verification against real public repo \(idempotent re-import\) ([pm-github-2u0d](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-2u0d.toon))
- Production-readiness audit 2026-05-28 ([pm-github-0y40](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-0y40.toon))

## 2026.6.2 - 2026-06-02

### Added

- Adopt full SDK capability surface: native importer/exporter, schema fields, afterCommand hook, richer import flags ([pm-github-gh83](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-gh83.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- Thrown errors lacked exitCode → runtime re-invoked handler \(double fetch\) ([pm-github-fgay](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-fgay.toon))

## 2026.5.29 - 2026-05-29

### Added

- Production-harden gh-issues import ([pm-github-lixc](https://github.com/unbraind/pm-github/blob/main/.agents/pm/features/pm-github-lixc.toon))

### Fixed

- Failed imports exited 0 \(broke automation\) ([pm-github-msh0](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-msh0.toon))
- Issue list truncated at one page \(no pagination\) ([pm-github-v4la](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-v4la.toon))
- Importer was unauthenticated \(60 req/hr, no private repos\) ([pm-github-gtnp](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-gtnp.toon))
- --dry-run silently wrote items instead of previewing ([pm-github-2u31](https://github.com/unbraind/pm-github/blob/main/.agents/pm/issues/pm-github-2u31.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-github-4ouy](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-4ouy.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-github-np9v](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-np9v.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-github-pnr1](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-pnr1.toon))

### Other

- Release readiness hardening for pm-github ([pm-github-kc0d](https://github.com/unbraind/pm-github/blob/main/.agents/pm/tasks/pm-github-kc0d.toon))

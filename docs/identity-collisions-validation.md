# Public tracker validation

Source: public `unbraind/pm-github` main commit
`394129e3a8a607bfc13dd8acc8adfe4704165da2`, archived with
`git archive <commit> .agents/pm` into a disposable non-git directory. No
working tracker or remote provider state was changed. All archived files were
made read-only (0444) and directories 0555. The explorer ran with a PATH
containing no git executable and a git ceiling at the temporary directory's
parent. The source fingerprint covers sorted relative paths and SHA-256 file
hashes, including history.

| Measurement | Result |
| --- | ---: |
| Tracker files verified before/after | 296 |
| Items scanned, all statuses | 145 |
| Distinct exact identities | 9 |
| Conflicting identity groups | 0 |
| Copied/prose mention edges | 3 |
| Selected / returned groups | 3 / 3 |
| Returned nodes / edges | 3 / 3 |
| Continuation | none |
| Compact JSON bytes | 642 |
| Compact TOON bytes | 551 |
| Files changed or added | 0 |

Source fingerprint:
`bc5c275eaecbbce251097ac1fca1602f7cc2b0a2520f33ed137ea7cbc2491638`.

This is real-corpus read-only and no-git evidence, including nonempty prose
mention diagnosis. It is zero-case collision evidence. Nonempty collisions,
structured provider ownership, contradictory identities, approved repairs,
refusals, stale plans, interrupted SDK transactions and byte-identical replay
are validated separately by `node --test test/identity.test.ts` against real
SDK-initialized synthetic trackers. Provider data and metadata mutation rules
remain owned by core and the relevant adapters.

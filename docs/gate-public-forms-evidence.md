# Public technical forms: precision evidence

Issue: gh:unbraind/pm-github#193. Scanner revisions: baseline `9586643`,
comparison scanner `1dd1691` (the public-forms allowances), bracket-smuggle
fix `5bf20e2`. The eight-repository measurement below (refreshed 15:53Z on
2026-11-02), the 134-test recovery regression run and the complete fresh
release check all predate `5bf20e2`; the review-round receipts (this
document's timing runs, corpus counts and 26-mutation proof) were produced on
the branch head after it.

## Inherited diff audit

Read every inherited change in `gate.ts`, `test/gate.test.ts`,
`test/daily-sync-privacy.test.ts` and `test/import-gate.test.ts` before editing.
The gate/import tests replaced reserved `example.org` addresses with
non-reserved, real-looking `example.dev` addresses and retained their refusal
assertions. The daily-sync test moved two refusal fixtures to the allow table;
this continuation restores both refusal cases with `example.dev` addresses and
keeps reserved-domain allowance tests separately. No refusal assertion was
removed or weakened in the final diff. The handoff changed three existing test
files plus `gate.ts`. The complete recovery suite found one more reserved-email
refusal fixture in `test/daily-sync-idempotency.test.ts`; it now uses
non-reserved `example.dev` with all refusal and zero-write assertions intact.
The minimum-SDK source witness now copies the shared corpus dependency used by
the operational proof. It continues to check every production/operational
module and shipped declaration, with no source exemption or assertion removed.
Its optional `PM_GITHUB_TEST_NETWORK_ATTEMPT_TIMEOUT_MS` accepts only a bounded
positive integer and permits only that transport timer after clearing inherited
Node flags. The repaired pair passed all four tests, including the exact
published minimum-SDK compile and runtime witness, using a 5000 ms timer.
Credentials, registry provenance and every consumer assertion remain intact.

The disk-full recovery audit compiled TypeScript and parsed both requested
item reads and every JSONL history record. The unrelated `pm-github-rv9m`
validation-warning comment and its paired history change were reverted; the
reason is recorded on `pm-github-01n8`. That issue is the only item in this
tree tagged for #193. Open triage PR #211 at `56a20d4` adds items for #197,
#199 and #202, with no second #193 owner.
The final complete SDK read inspected 162 items and found exactly that one
owner by tag or explicit issue URL.

The inherited 15-mutation proof passed before edits. The final proof adds sysfs
removal, other SSH local parts, and placeholder-position broadenings. It also
pins full domain-label consumption (including digit/hyphen look-alikes),
case-insensitive bare localhost, dotted placeholder names, and an incomplete
runner workspace. The review round adds four mutations: the reverted
delimiter set (`:`/`=`), the reverted embedded-identity list, the removed
procfs root-entry exception and the removed runner `tmp` exemption, and it
re-points the bracket-smuggle and embedded-identity mutations at the rows the
new checks now own. The second review round caps delimiter-started path
judgments per match at 64 (a 65-path procfs chain passes, a 66-path chain
fails closed) and adds the `remove-delimiter-judgment-cap` mutation; before the
cap a 4,000-path chain took 13.4 s, after it 0.6 s. The third review round
limits the procfs root entry to the entry itself, because it re-exposes the
whole filesystem (`/proc/self/root/var/…` names `/var/…`), and adds the
`allow-procfs-root-continuation` mutation with two must-refuse rows. Sysfs was previously outside the host-root signature; it is
now explicitly scanned so its allowance and traversal refusal are observable.

## Review round: recursion, delimiters and tail roots

The bracket check re-entered the host-path rules through their confirms, so a
line of about 40 repeated procfs-style segments (each ending in a delimiter)
cost about 2^40 confirm calls, and long bracket runs made the loop quadratic
with a fresh `RegExp` per bracket and rule. Measured on the recursive
predecessor: 415 ms at 16 segments, 5.6 s at 20, 23 s at 22 (≈2.3x per
segment — the 40-segment line does not finish), and 934 ms for one 20,000
bracket run. The rewritten check is a single non-recursive pass that judges
only delimiters directly followed by a possible path start, with sticky rule
patterns built once: 1.1 ms for the 40-segment chain, 40 ms for the same
20,000-bracket run, and the corpus timing test keeps both under 200 ms.

Two traced refusals passed inside permitted tails and are now pinned as
must-refuse rows: a procfs `root` entry continuing into the temp root with a
person-named file, and a placeholder home path followed by a colon and a
root-owned SSH key path. The delimiter set grew from brackets to `:` and `=`
(a label or assignment prefix hides a path the same way a bracket does), and
the embedded-identity list grew to `tmp`, `private`, `Volumes`, `mnt`,
`media`, `srv` and `root` — the last exempt only directly after a procfs
numeric or `self` pid, where procfs exposes the real entry. The hosted
runner's own `tmp` scratch directory inside its workspace stays allowed;
corpus rows cover both directions, and every new check has its own mutation.

## Corpus and proof

The shared corpus has 55 must-allow and 72 must-refuse rows. Every row runs as
plain text and JSON-escaped TOON text and through a complete synthetic tracker
diff; allow rows also run as whole JSON strings and JSONL history changes.
Refusal findings retain their expected rule and item attribution. All corpus
names and account paths are synthetic and assembled at runtime.

Angle and curly brackets continue a path so whole placeholder segments are
judged in place. A delimiter — bracket, label colon or assignment equals —
inside any other segment can end one path and start the next, so the text
after it is judged with the public-path predicates exactly as if it stood
alone: a refused root-account, temp, other-drive or tilde-username path behind
a permitted prefix keeps the whole match refused (`smuggled-*` rows), while a
placeholder path in markup or followed by a public procfs path, runner
workspace or `file://` URL stays allowed (`placeholder-home-*` rows).

Run `node scripts/prove-gate-public-forms.ts`. Each disposable gate mutation
must flip exactly its recorded row IDs; missing/duplicate anchors, unexpected
flips and import failures fail the proof. Temporary copies are removed.

| Mutation | Allow flips | Refuse flips |
| --- | ---: | ---: |
| `remove-sysfs-allowance` | 2 | 0 |
| `remove-procfs-allowance` | 13 | 0 |
| `remove-reserved-domain-allowance` | 12 | 0 |
| `remove-git-transport-allowance` | 4 | 0 |
| `remove-runner-workspace-posix` | 3 | 0 |
| `remove-runner-workspace-windows` | 5 | 0 |
| `remove-toolcache-allowance` | 1 | 0 |
| `remove-placeholder-home-posix` | 16 | 0 |
| `remove-placeholder-home-windows` | 3 | 0 |
| `broaden-reserved-domain-anchor` | 0 | 7 |
| `broaden-runner-shape-posix` | 0 | 3 |
| `broaden-runner-shape-windows` | 0 | 2 |
| `broaden-git-transport-local-part` | 0 | 2 |
| `broaden-placeholder-position-posix` | 0 | 1 |
| `broaden-placeholder-position-windows` | 0 | 1 |
| `remove-escape-segment-check` | 0 | 5 |
| `remove-embedded-identity-check` | 0 | 12 |
| `allow-procfs-root-continuation` | 0 | 2 |
| `broaden-proc-shape` | 0 | 3 |
| `remove-bracket-leadins` | 0 | 1 |
| `remove-bracket-smuggle-check` | 0 | 6 |
| `revert-delimiter-set` | 0 | 3 |
| `revert-embedded-identity-list` | 0 | 8 |
| `remove-proc-root-exception` | 2 | 0 |
| `remove-runner-tmp-exemption` | 2 | 0 |
| `remove-delimiter-judgment-cap` | 0 | 1 |

The proof harness also tests unreadable source, invalid baselines, source-anchor
drift, changed row expectations, private diagnostic suppression, cleanup and
main-invocation stdout/stderr/exit behavior.

The recovery PM-linked regression run passed all 134 tests with zero failures,
cancellations or skips (2358 seconds). Its earlier 1800-second runner cap
interrupted one file after 125 passes and zero assertion failures; increasing
only the linked timeout to 7200 seconds produced the complete result. The
command and every assertion were preserved. Owned timeout leftovers were
independently attributed and removed; the successful rerun's dedicated scratch
root was also removed.

## Eight-repository measurement

Read-only REST measurement refreshed at 15:53Z on 2026-11-02 using `gh api`.
Core quota was 2349 before collection and 2152 afterwards (never below the
required 1500). The refresh reproduced every prior rule/hash count.
Paginated every repository's `issues?state=all&per_page=100` and
`issues/comments?per_page=100`; excluded pull requests and their comments.
Scanned every issue title/body and every issue comment line with the old
scanner from `9586643` and the comparison scanner at `1dd1691`, without an
allowlist. Counts
are match occurrences, with identical rule/hash pairs aggregated below. Raw
API responses stay outside tracked evidence. No issue bodies or comments were
written to GitHub.

Current text reflects the earlier seven issue-body edits. Original snippets
already embedded in the shared corpus are a separate comparison; they are
never added to current-text counts. They are bounded excerpts, not recovered
historical full issues or historical comments. The pre-existing SSH transport
allowance already passes the pm-jev original snippet.

| Repo | Issues | Comments | Current before | Current after | Original snippet rows | Snippet before | Snippet after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pm-review | 4 | 1 | 3 | 0 | 3 | 3 | 0 |
| pm-context | 9 | 18 | 0 | 0 | 1 | 1 | 0 |
| pm-jev | 2 | 2 | 0 | 0 | 1 | 0 | 0 |
| pm-rust | 4 | 7 | 0 | 0 | 1 | 1 | 0 |
| pm-swarm | 6 | 7 | 0 | 0 | 1 | 2 | 0 |
| pm-ops | 9 | 2 | 0 | 0 | 2 | 2 | 2 |
| pm-vcs | 8 | 18 | 0 | 0 | 0 | 0 | 0 |
| pm-changelog | 26 | 27 | 0 | 0 | 0 | 0 | 0 |

All current after counts are zero. The only remaining original-snippet findings
are the pm-ops root and temporary paths, deliberately retained as refusals.
The following inventory lists every nonzero rule/hash pair; repositories not
listed have zero findings in that comparison. Hashes are SHA-256 of the
matched content; no matched text is recorded.

| Source | Repo | Rule | Hash | Before | After |
| --- | --- | --- | --- | ---: | ---: |
| Current | pm-review | absolute-host-path | `71ad1dfa1de556decbd6d7314196552e349d66067b49ab6bf8d4865faa663441` | 2 | 0 |
| Current | pm-review | absolute-host-path | `9d69c4b8ab582c9d38d6afabf34fef9dfa3e0e41cd717aecb748c541dfe43508` | 1 | 0 |
| Original snippet | pm-review | absolute-host-path | `71ad1dfa1de556decbd6d7314196552e349d66067b49ab6bf8d4865faa663441` | 2 | 0 |
| Original snippet | pm-review | absolute-host-path | `9d69c4b8ab582c9d38d6afabf34fef9dfa3e0e41cd717aecb748c541dfe43508` | 1 | 0 |
| Original snippet | pm-context | email-address | `cc6d96611cffa9f02c3626f0b9ee897dc171e2d540a5cae349d4ec316104997b` | 1 | 0 |
| Original snippet | pm-rust | windows-host-path | `0001cdf3ebc04c14a667ec0b3c18772a5232b7c5ff39d2d8a37b257858e58577` | 1 | 0 |
| Original snippet | pm-swarm | absolute-host-path | `b7e6512807f60bced94b564e94168800ce0e7027207bb8f7db7bc3920cc6667b` | 1 | 0 |
| Original snippet | pm-swarm | absolute-host-path | `b56b104578dd00431c4793de18349a132898799574d22afaf2c74722bb83e8da` | 1 | 0 |
| Original snippet | pm-ops | absolute-host-path | `9efd9fc7399ad80acfb4ac0c2ba77920f370d9e554337b28c457c96362fe2811` | 1 | 1 |
| Original snippet | pm-ops | absolute-host-path | `9ef9a9c7fe4a9ef1b186339d0fcfc17270432fd5e4b53ee5cc3de4d0af1b199a` | 1 | 1 |

## Completed verification

The complete fresh release check passed all 1609 tests with zero failures,
cancellations or skips. It retained all 29 authored modules and exact coverage:
13776/13776 lines and statements, 437/437 functions and 5184/5184 branches,
with zero skipped source. Documentation checked 268 declarations; duplication
was zero at the unchanged 50-token threshold; the privacy audit checked 7982
objects with no findings; production audit found zero vulnerabilities. Pack
dry-run contained 75 files, changelog consistency passed, and the release
workflow's one publish invocation carried provenance.

The successful command used process-local resource and transport controls:

```sh
NODE_OPTIONS='--max-old-space-size-percentage=55 --network-family-autoselection-attempt-timeout=5000' \
PM_GITHUB_TEST_NETWORK_ATTEMPT_TIMEOUT_MS=5000 \
NPM_CONFIG_USERCONFIG=/dev/null npm run release:check
```

The initial complete attempt had two fixture failures described above and
exhausted the configured 12 GiB aggregation heap. A separate saved-receipt
diagnostic reached exact coverage at 16 GiB; it was not counted as a passing
release run. The command above reran every test and gate. Default-cap and CI
memory acceptance remain on existing follow-up `pm-github-vhi6`, which stays
open. No threshold, source exemption or assertion was relaxed. All free-space
checks satisfied the required floor, and owned external scratch roots were
removed.

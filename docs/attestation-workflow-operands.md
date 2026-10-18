# Reusable workflow attestation compatibility

Dependabot PR #135 updates pm-ops and pm-changelog. Its actual failing test is
`this repository's own workflows pass the gate` in
`test/verify-release-publish-attestation.test.ts`, not the expected coverage-gate
self-test diagnostics. The canonical auditor reports 38 unresolved executable
positions in the reusable workflows: associative-array element assignments,
regular expressions containing shell delimiters, multiline array literals and
dynamic case-arm patterns.

Keep the canonical auditor and every finding intact. The workflows now express
those dynamic values as operands to literal commands: declare for array element
bindings, printf/mapfile for pathspec data, grep for the full version ERE, and
conditional tests for path classification. The property is that dynamic data
has a provable argument boundary, rather than depending on a particular version
or path string. NUL-delimited grep rejects multiline values as a whole.

The publication allowlist, privacy scans, exact release-tag resolution, lease,
no-op guard and protected branches retain their existing behavior. This does not
vendor, filter, exempt or weaken the shared attestation scanner. The dependency
pins remain owned by Dependabot. PR #142 and its branch are outside this change.

Verification uses the exact PR #135 diff over the fix, including its launcher
refresh, then npm ci and the npm/Bun release gates with CI identity. Reverting
only the changed workflow shell under that overlay must fail the repository
attestation regression. The workflow tests also exercise release-tag ordering,
annotated tags, invalid versions, literal tracker names and rejected runtime
paths. The final fix does not commit the temporary dependency overlay.

The exact Dependabot overlay also refreshes the canonical prepare launcher.
Artifact-time omission tests exercise pack and publish without development tools,
requiring one explicit notice and unchanged Git config and attributes. They
support both canonical launcher generations without version assertions; the
canonical-copy identity check and all install-failure checks remain enforced.

# External-name lookup audit

The package-wide audit covers every authored TypeScript/JavaScript file,
including operational scripts, tests and test helpers. Searches included computed
member access, `in` checks, nullish indexed lookups, empty record accumulators,
`Object.assign`, and dynamic assignments. AST enumeration supplemented text
searches so optional computed access was included.

| Surface | Own-property treatment |
| --- | --- |
| `issue-forms.ts` | Parse answer/binding objects from `Object.entries` into validated `Map` instances. This preserves own `__proto__` entries that a record parser discarded. Resolve native bindings through `ownValue` against a null-prototype snapshot. No name denylist; Unicode identifiers are supported. |
| `index.ts` | Guard CLI option, response header and blocker GraphQL alias reads with `ownValue`; normalize external header keys into `Map`. Replace membership checks on imported/search envelopes with `Object.hasOwn`. Form-scoped export uses certified complete SDK listing in process, without a child CLI. |
| `projects.ts` | Guard externally selected status candidate lookup; existing explicit mappings and option indexes already use `Map`. |
| `closeout.ts` | Guard repeatable/keyed option reads; accumulate skip counts in `Map`, then serialize with `Object.fromEntries`. |
| `identity.ts` | Enumerate provider fields through own entries and guard external identity field reads. |
| `import-fidelity.ts` | Guard timeline timestamp and closure field reads; metadata updates define own data properties instead of invoking a prototype setter. Deletion cannot traverse a prototype. |
| `refresh.ts` | Guard GraphQL aliases and source-selected native field comparisons. |
| `webhooks.ts` | Require an own PR discriminator on issue payloads. |
| `gate.ts` | Guard escape-table and selected patch field reads. |
| `scripts/coverage-gate.ts` | Guard external threshold and coverage-counter dimension lookup; thresholds and scope are unchanged. |
| `scripts/release-merge-policy.ts` | Guard lockfile package entry lookup. The isolated shell fixture copies the shared helper too. |
| Test helpers/runners | Environment snapshots and real-data repair counters use `Map`; generated GraphQL fixtures use null-prototype accumulators. Manifest lookups use the shared own reader. |

`own-record.ts` centralizes guarded reads (`Object.hasOwn` before indexing),
own data-property writes, and null-prototype accumulator creation. Public serialized records retain ordinary
JSON shapes through `Object.fromEntries`; internal maps never invoke prototype
setters. Environment writes also define own data properties, so they work when
runtime assignment would invoke a prototype setter. Snapshots/readback are
own-only and prototype-name restoration is tested in Node and Bun.

Remaining computed accesses are numeric array/string offsets, fixed-schema
literal fields, guarded access inside `ownValue`, or test fixtures iterating
explicit native-field whitelists. Empty option defaults are not accumulators.
Remaining controlled test writes patch fixed module members or fixture fields;
they do not consume external names. There is no local template-name dictionary.

The regression suite allows all prototype names as IDs, binding names and option
values, rejects malformed pollution-shaped values, and compares 500 generated
forms against an independent `Map` reference. Every name is observed as required
and optional, answered/omitted/blank. Required-answer failures run the actual
exporter against a recording HTTP server and assert zero writes. The fixed case
omits optional `toString` and completes a real exporter POST to that fake server.
Every generated case asserts that `Object.prototype` descriptors are unchanged.

The first full CI run passed all 1,513 tests but exhausted the unchanged 12 GiB
c8 aggregation heap: each required-answer export case had launched the SDK CLI
and added another dependency profile. Form-scoped selection now uses the same
certified complete SDK read already adopted elsewhere in this package, in the
current process. This preserves every generated case and actual HTTP refusal
check while eliminating redundant child profiles. The legacy unselected export
path remains available. A real no-git tracker test also removes `pm` from PATH;
the form export preview still succeeds. Source inventory, coverage thresholds,
heap limit and CI commands are unchanged.

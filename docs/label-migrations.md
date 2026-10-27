# Label migration plans

`pm github labels plan` previews a provider label policy change. Every source is
an exact GitHub `node_id` plus its expected current name. A rename selects one
source and an unused destination name. A consolidation explicitly selects a
separate existing destination ID and expected name. Similar spelling, case,
whitespace or display intent never chooses or merges identities.

Copy [the request example](label-migration.json), replace its repository and
source ID/name with current values, and inventory the filters and mappings you
actually use. `filters` describe saved `--labels` selections. `mappings` describe
export `--label-map` pairs (`from` is the local tag; `to` is the GitHub label).
Provider-name comparisons ignore case: selecting `bug` also affects a filter
containing `BUG` or an export destination `BuG`. The first configured spelling
is preserved in each affected row. Repeated case variants within one filter
count once per selected source ID, and unresolved policy choices still block
approval when their rows fall outside the displayed page. Local mapping keys,
opaque node IDs and expected catalog spellings retain their exact semantics;
name comparison never combines distinct selected IDs.
These flags have no persistent package-wide inventory to discover. Empty arrays
explicitly declare no such policies. IDs identify individual policies in output.
The report covers exactly this declared inventory, not configuration hidden in
external workflows.

```sh
# Fetch all current provider label IDs; this is a read-only GitHub request.
gh api repos/example/widgets/labels --paginate --jq '.[] | {id: .node_id, name}'
pm github labels plan --input label-migration.json --limit 10 --json
pm github labels plan --input label-migration.json --limit 10 --offset 10
# Resolve review choices, preview again, then copy that report's digest.
pm github labels plan --input label-migration.json --approve <approval> --json
```

Consolidation replaces `change` with:

```json
{"kind":"consolidate","target":{"id":"LA_destination","name":"kind/bug"}}
```

The importer stores names as native tags, not provider label IDs. Every matching
tag is therefore an **unverified name occurrence**, even on a GitHub-linked item.
Rows identify the exact local item, source ID, before/after names, current choice,
and its matching repository issue provenance tags. Unlinked and other-provider
items remain visible with an empty issue identity list; they are never adopted
or changed. `review`, `keep`, and `replace` are explicit per-surface choices.
The mapping policy ID points back to its exact `from`/`to` entry in the request.
`after` shows the replacement candidate for review; a `keep` choice retains
`before` rather than applying that candidate.
For tag rows, `before` and `local_tag` identify a matched native tag; `after` is
the raw destination label name and `after_tags` is its complete imported native
tag array. For example, source `one,two` matches both `one` and `two`, and
destination `alpha,beta` exposes `["alpha","beta"]` on each tag row. A label
consisting of commas imports no tags and exposes `[]`. Policy rows have
`after_tags: null`. Repeated native tags from one source count once; different
source IDs remain separate occurrences even when their expansions overlap.
`replace` proposes a change; both preview and approval check write nothing.
Apply reviewed edits through the owning provider/configuration workflow and core
tag mutation facilities, after checking their revisions at the write boundary.

Counts cover the complete certified SDK read across all configured statuses,
including custom statuses and terminal items, and every declared policy entry.
No lifecycle classification occurs. `counts.items` counts distinct affected items;
`tags`, `filters`, and `mappings` count source-label occurrences per item/policy;
`total` is their exact integer sum. Repeated labels in one filter count once.
Pagination covers all occurrences, retaining at most 100 rows (20 by default).
Issue provenance lists retain at most 100 exact tags per row and explicitly count
omitted tags. There are no body, description or provider payload excerpts.

`approval` hashes the entire selected policy, complete sorted label catalog and
every item's SDK revision and tags. It never depends on the displayed page.
`--approve` fetches current labels again and re-reads current targets through the
SDK. Deleted/recreated IDs, renamed labels, any catalog drift, replayed older
policy inputs or changed target revisions refuse. A same-content edit with a new
revision invalidates the old digest. No receipt, checkpoint, journal, idempotency
key, background worker or recovery mutation exists. `checked: true` records a
point-in-time check, not a lock or permission to replay mutations later.

For fully offline use, pass `--catalog catalog.json` containing:

```json
{"complete":true,"labels":[{"id":"LA_source","name":"bug"}]}
```

The caller must supply a fresh, complete, repository-scoped catalog for each
check. Offline checks cannot detect provider changes absent from that snapshot.
Live checks omit `--catalog`; pagination drains every page and refuses cycles,
cross-repository links, malformed payloads and incomplete access. Public reads
work without credentials subject to GitHub's rate limit; private reads need the
existing token resolution (`GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth login`).

```ts
import { planGithubLabelMigration, validateGithubLabelMigrationReport,
  type GithubLabelMigrationInput } from "pm-github";

const request: GithubLabelMigrationInput = {
  repo: "example/widgets", sources: [{ id: "LA_source", name: "bug" }],
  change: { kind: "rename", name: "kind/bug" },
  filters: [], mappings: [],
  choices: { tags: "keep", filters: "keep", mappings: "keep" },
};
const preview = await planGithubLabelMigration(pmRoot, request);
const checked = await planGithubLabelMigration(pmRoot, request, {
  approval: preview.approval, page: { limit: 10 },
});
validateGithubLabelMigrationReport(JSON.parse(JSON.stringify(checked)));
```

Validate decoded host TOON with this same function. The host can omit null
terminal fields; the shared schema restores their declared null defaults.
Missing continuation on an unfinished page, missing native tag identities and
malformed tag expansions still refuse. No separate wire normalizer is needed.
The same boundary accepts the host's `rows_encoding` metadata and restores
nested cells with the SDK's `decodePmTableRows`. JSON-looking label strings are
never decoded by inference. Encoded rows retain the 100-row limit; keys come
from the producer schema, cells are bounded at 128 KiB, and absent coordinates
must be unique, in range and backed by an own null-padding entry; inherited
properties never stand in for encoded cells.

The optional SDK `readCatalog` adapter supports an explicit offline snapshot and
must return `{complete:true, labels:[{id,name}]}`. The planner reuses the package's
isolated complete SDK reader; SDK acquisition never examines executable paths or
global symlinks. It also works on an ordinary read-only tracker outside git.

Input JSON files must be regular, unlinked files of at most 1 MiB. Strict schemas
reject unknown fields, sparse arrays, nonfinite/unsafe integers, empty IDs,
newlines in names, duplicate IDs and out-of-domain pagination. Names and IDs are
1..200 characters; repositories have two 1..100 character components. Limits:
20 sources, 10,000 catalog labels, 1,000 filters with 100 labels each, and 1,000
mappings. Provider label spelling is significant and is never normalized into an
identity. Provider label names call the importer's exported
`githubLabelsToTags(names)` function, which joins the importer CSV representation
and delegates to the SDK's string tag parser. Stored native tag elements instead
use the SDK's array-tag normalization without CSV splitting. Thus a provider
label `one,two` produces two tags, but stored `["one,two"]` is one native tag and
differs from `["one", "two"]`. Planning and approval checks use that intersection;
refresh compares the writer's desired native tag set with the stored native set.
Link-only and citation updates retain native atoms in place and add only new
provider-derived tags, avoiding a CSV round trip of existing state. Raw names/IDs stay bounded at 200 characters;
emitted native tags allow up to 600 characters for SDK Unicode expansion, and
`after_tags` contains at most 200 entries. Two provider IDs may point to the same native tag
and remain separate unverified occurrences. Producers and validators share the
same output schema. The host may omit empty `rows` and terminal `next`; schema
defaults restore them only when complete-count and continuation checks still
prove a completed page. Missing rows on an unfinished page refuse. All numeric
decisions use integers or exact `BigInt` sums.

| Refusal code | Remedy |
| --- | --- |
| `invalid_input` | Correct the strict request/catalog shape, identity selection or bounds. |
| `catalog_unavailable` | Restore complete repository label read access; retry with fresh data. |
| `stale_labels` | Fetch current IDs/names and select explicit identities again. |
| `incomplete_read` | Restore a complete readable ordinary tracker copy. |
| `stale_plan` | Preview again and review the new digest against changed policy/revisions. |
| `unresolved_choices` | Resolve affected `review` choices to `keep`/`replace` and preview again. |
| `invalid_output` | Discard the invalid record and regenerate it with a supported version. |

Failures use SDK expected errors (exit 2), with typed `code` and `required` remedy.
An invalid policy request affects only its own invocation; no tracker item is
modified or partially applied.

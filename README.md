# pm-github

A true **round-trip** GitHub Issues integration for [pm-cli](https://github.com/unbraind/pm-cli): import, export, status-sync, search, and validate.

Import issues from any GitHub repo as pm items, export pm items back to GitHub (safely, dry-run by default), push status changes upstream, reach GitHub from `pm search`, and track GitHub provenance on each item. Works unauthenticated (60 req/hr); set `GITHUB_TOKEN`/`GH_TOKEN` or run `gh auth login` for 5000 req/hr and private repos.

---

## Installation

```bash
pm install github.com/unbraind/pm-github --global
```

## Capabilities

| SDK capability | What it provides |
|---|---|
| `importers` | `pm github import <owner/repo>` — idempotent native import pipeline |
| `importers` (exporter) | `pm github export` — pm items → GitHub issues (dry-run by default; upsert) |
| `commands` | `pm gh-issues import` (legacy import alias), `pm github sync` (push status), `pm github validate` (diagnostics) |
| `schema` | declares `github_url`, `github_number`, `github_state`, `github_author`, `github_created_at`, `github_updated_at` item fields |
| `hooks` | `afterCommand` — opt-in sync reminder (`PM_GITHUB_SYNC`) for linked items |
| `preflight` | early warning when a mutating github command lacks a token |
| `search` | `github` search provider — `pm search` reaches GitHub for imported items |

## Import

### `pm github import <owner/repo>` (or `pm gh-issues import`)

```bash
pm github import unbraind/pm-cli
pm github import owner/repo --state all
pm github import owner/repo --labels bug,enhancement
pm github import owner/repo --since 2026-01-01T00:00:00Z   # incremental sync
pm github import owner/repo --assignee octocat
pm github import owner/repo --milestone "v1.0"
pm github import owner/repo --include-prs
pm github import owner/repo --dry-run
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--all` | boolean | Include closed issues (shorthand for `--state all`) |
| `--state <state>` | string | `open` \| `closed` \| `all` (default: open) |
| `--labels <labels>` | string | Comma-separated label filter |
| `--since <iso>` | string | Only issues updated after this ISO timestamp (incremental sync) |
| `--assignee <login>` | string | Filter by assignee login |
| `--milestone <name>` | string | Filter by milestone title |
| `--include-prs` | boolean | Include pull requests (default: skip PRs) |
| `--skip-drafts` | boolean | Exclude draft pull requests (only meaningful with `--include-prs`) |
| `--with-comments` | boolean | Fetch issue comments and append them to the item body |
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Override pm item type (default: Issue) |

Each imported item records GitHub provenance: the `gh:owner/repo#N` idempotency tag, a `github_author:<login>` tag, and an enriched description (`author @<login> · state reason <reason> · created <iso> · updated <iso>`). GitHub issues closed as `not_planned` import as pm `canceled` instead of `closed`, preserving the difference between completed work and deliberately dropped work. The integration declares the `github_url`, `github_number`, `github_state`, `github_author`, `github_created_at`, and `github_updated_at` schema fields.

## Export (pm → GitHub)

### `pm github export`

**Safe by default.** Export previews the create/update plan and writes *nothing* unless you explicitly opt in with `--apply` **and** name a `--repo`. With a `--repo`, items already linked to an issue in that repo (via the `gh:owner/repo#N` provenance tag) are **updated** (upsert) instead of duplicated.

```bash
pm github export --repo owner/repo            # DRY-RUN: print the create/update plan, write nothing
pm github export --repo owner/repo --format md
pm github export --repo owner/repo --ids pm-12,pm-34
pm --json github export --repo owner/repo     # return the plan as JSON
pm github export --repo owner/repo --apply    # actually create/update issues (requires a token)
pm github export --repo owner/repo --ids pm-12,pm-34 --apply
```

| Flag | Type | Description |
|---|---|---|
| `--repo <owner/repo>` | string | Target repo; decides create-vs-update and is required for `--apply` |
| `--ids <pm-1,pm-2>` | string | Scope export to specific pm item IDs (comma-separated); unknown IDs fail fast |
| `--format <json\|md>` | string | Dry-run output format (default: json) |
| `--apply` | boolean | Perform real GitHub writes (alias: `--no-dry-run`, legacy `--push`). Requires a token + `--repo` |
| `--dry-run` | boolean | Force preview even alongside `--apply` (dry-run always wins) |

## Status sync (pm → GitHub state)

### `pm github sync`

Push pm status changes back to GitHub: close/reopen the linked issue to match the pm item's status. Requires a token and explicit `--repo`.

```bash
pm github sync --repo owner/repo --dry-run    # preview the close/reopen plan
pm github sync --repo owner/repo --ids pm-12,pm-34 --dry-run
pm github sync --repo owner/repo              # push the changes
```

`--ids` scopes sync to specific pm item IDs (comma-separated). Unknown IDs fail fast so agent runs do not silently skip typoed targets.

## Search (pm search → GitHub)

### `github` search provider

Registers a `github` search provider so `pm search ... --semantic` can reach GitHub. It asks GitHub which issues in the target repo match your query, then returns hits for the **pm items you've already imported** from those issues (matched by the `gh:owner/repo#N` provenance tag).

```bash
pm config project set ...                      # set search.provider = "github" in .agents/pm/settings.json
export PM_GITHUB_REPO=owner/repo               # or pass the repo another way
pm search "uppercase dashes" --semantic        # hits = imported items whose upstream issue matches
```

Enable it by setting `search.provider` to `"github"` in `.agents/pm/settings.json` and pointing it at a repo via the `PM_GITHUB_REPO` env var.

## Validate / diagnostics

### `pm github validate`

Read-only check of the integration: `gh` CLI presence, token resolvability (and source), and—with `--repo`—repo accessibility. When `--repo` is given it also surfaces the remaining GitHub API quota (`X-RateLimit-Remaining`/`Limit`/`Reset`) and warns when the quota is running low. Never mutates anything.

```bash
pm github validate
pm github validate --repo owner/repo
pm --json github validate --repo owner/repo
```

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

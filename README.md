# pm-github

GitHub Issues importer **and exporter** for [pm-cli](https://github.com/unbraind/pm-cli).

Import issues from any GitHub repo as pm items, export pm items back as a GitHub-issues payload, and track GitHub provenance on each item. Works unauthenticated (60 req/hr); set `GITHUB_TOKEN`/`GH_TOKEN` or run `gh auth login` for 5000 req/hr and private repos.

---

## Installation

```bash
pm install github.com/unbraind/pm-github --global
```

## Capabilities

| SDK capability | What it provides |
|---|---|
| `importers` | `pm github import <owner/repo>` — native import pipeline |
| `importers` (exporter) | `pm github export` — render pm items as a GitHub-issues payload |
| `commands` | `pm gh-issues import <owner/repo>` — legacy alias of the importer |
| `schema` | declares `github_url`, `github_number`, `github_state` item fields |
| `hooks` | `afterCommand` — opt-in sync reminder (`PM_GITHUB_SYNC`) for linked items |

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
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Override pm item type (default: Issue) |

## Export

### `pm github export`

```bash
pm github export                       # JSON GitHub-issues payload to stdout
pm github export --format md           # markdown
pm github export --repo owner/repo --push   # create the issues on GitHub (requires a token)
```

| Flag | Type | Description |
|---|---|---|
| `--format <json\|md>` | string | Output format (default: json) |
| `--repo <owner/repo>` | string | Target repo for `--push` |
| `--push` | boolean | Create issues on GitHub (requires `GITHUB_TOKEN`/`GH_TOKEN`) |

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

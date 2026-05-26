# pm-github

GitHub Issues importer for [pm-cli](https://github.com/unbraind/pm-cli).

Fetch issues from any public GitHub repo and create pm items. No authentication needed (uses unauthenticated API, 60 req/hr rate limit).

---

## Installation

```bash
pm install github.com/unbraind/pm-github --global
```

## Commands

### `pm gh-issues import <owner/repo>`

```bash
pm gh-issues import unbraind/pm-cli
pm gh-issues import unbraind/pm-cli --all
pm gh-issues import owner/repo --labels bug,enhancement
pm gh-issues import owner/repo --dry-run
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--all` | boolean | Include closed issues (default: open only) |
| `--labels <labels>` | string | Comma-separated label filter |
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Override pm item type (default: Issue) |

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

# pm-ext-gh-issues

GitHub Issues importer for [pm-cli](https://github.com/unbraind/pm-cli).

Fetch issues from any public GitHub repo and create pm items. No authentication needed (uses unauthenticated API, 60 req/hr rate limit).

---

## Installation

```bash
pm extension install github.com/unbraind/pm-ext-gh-issues --global
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

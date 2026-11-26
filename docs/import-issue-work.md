# Start work on a GitHub issue

Search the tracker for the issue first. When it has no linked item, import the
specific issue to record its GitHub provenance.

```sh
pm github import <owner>/<repo> --issue <N>
```

The importer reserves IDs of the form `<prefix>-github-<repo-hash>-<N>`.
Use the import command to create those IDs. When the importer is unavailable,
create an ordinary item with a generated ID and set its declared `github_url`
field to the issue's exact URL. A `gh:<owner>/<repo>#<N>` tag is a reference.

## Repair a reserved-ID refusal

Verify that the named tracker item belongs to the named issue. If it does, run
the command in the refusal. For example, to explicitly link issue 7:

```sh
pm update pm-github-0123456789ab-7 --field github_url=https://github.com/example/project/issues/7
pm github import example/project --state all --atomic --gate --dry-run
```

The preview should count the item as matched by provenance. The link keeps the
curated item's title, description, body, and local comments. With
`--with-comments`, the importer adds GitHub comments as native comments on
linked curated items, preserving the GitHub creation time and skipping IDs
already mirrored, including markers written by older releases.

If the item belongs to other work, keep it and its history. Use a different
configured ID prefix or tracker, or review any competing GitHub ownership
claims before retrying.

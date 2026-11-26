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
the command in the refusal. It repeats the tracker selection the failed
import used. An invocation that passed `--pm-path` (or the legacy `--path`)
gets the same selector in the command, so a copy made from the same
directory still updates only that tracker; a relative selector stays
relative to that directory, and an invocation that selected its tracker
implicitly (the working directory or `PM_PATH`) gets no selector at all, so
run the copy from the same directory and environment. Only an absolute
selector keeps the command safe from any other directory. For example, to
explicitly link issue 7:

```sh
pm update pm-github-0123456789ab-7 --field github_url=https://github.com/example/project/issues/7
pm github import example/project --state all --atomic --gate --dry-run
```

The example above shows the implicit form: run its first line from the
tracker's own workspace, or add that workspace's `--pm-path` selector.

The refusal offers that command only when the item's existing GitHub
provenance does not contradict the link — an item whose declared
`github_number` or `github_repo` names a different issue keeps the plain
refusal, because linking it would create two owners and block the next import.
In that case, correct the fields first or use a different configured ID prefix
or tracker.

The preview should count the item as matched by provenance. The link keeps the
curated item's title, description, body, and local comments. With
`--with-comments`, the importer adds GitHub comments as native comments on
linked curated items, preserving the GitHub creation time and skipping IDs
already mirrored, including markers written by older releases. A comment
whose source timestamp is missing, not RFC 3339, or names an impossible
calendar date (such as February 30) is refused and counted as a failed
write, never stored with a time that never existed.

If the item belongs to other work, keep it and its history. Use a different
configured ID prefix or tracker, or review any competing GitHub ownership
claims before retrying.

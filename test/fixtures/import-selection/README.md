Recorded GitHub REST fixtures captured on 2026-10-12 with `gh api`:

- `repos/unbraind/pm-web/issues/189`
- `repos/unbraind/pm-web/issues/96`
- `repos/unbraind/pm-web/issues/175` (a closed pull request)
- `repos/unbraind/pm-web/issues/comments/6105893043`
- `repos/unbraind/pm-slack-standup/issues/113`

The JSON retains importer-consumed fields. Account objects and unused REST metadata are omitted; labels retain their names. Bodies for #189 and #113 are complete. Bodies for #96 and PR #175 retain their first paragraph. The comments fixture retains one public comment with its original id, timestamp, and body; its account object is omitted. Tests replay these responses over HTTP into real disposable trackers. Pagination tests arrange recorded responses into deterministic pages; explicitly marked synthetic variants exercise invalid responses and dependency/draft boundaries.

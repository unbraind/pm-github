These response bodies were recaptured from GitHub's GraphQL API during the continuation
on 2026-10-12 using the current query builder. They contain no authorization headers or tokens.

The query builder aliases repositories as `rN`, and issues/PRs in numeric order
as `iN_M`/`pN_M`. `pm-cli-blockers-batch.json` contains the query for numbers 34,
854, 1246, and 999999 in `unbraind/pm-cli`: merged PR, completed issue, open issue,
and missing number. GitHub returns partial NOT_FOUND errors for the unused kind
of each number. Single-reference files contain the corresponding query for 854
or 1246. `repository-not-found.json` queries the nonexistent public locator
`unbraind/unbraind-no-such-repo-xyz`; `bare-and-ghost-repo.json` combines that
query with issue 854. `graphql-error-data-null.json` is a real undefined-field
GraphQL error (`viewerNonsenseField`), despite its filename: data is absent.

Permission denials in the tests are explicitly constructed responses around the
recorded public data. A public issue cannot reliably produce a FORBIDDEN error
with an authenticated token, and no private resource is used for these fixtures.

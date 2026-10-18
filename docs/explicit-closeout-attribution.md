# Explicit closeout delivery attribution

pm-ado issue [33](https://github.com/unbraind/pm-ado/issues/33) identified a durable provenance error: merged PR 16 reported the statement-enforcement gap, while PR 19 delivered enforcement. Both bodies link the same tracker item. The previous rule let any in-progress item close on a bare body link, then ascending PR order gave PR 16 first choice.

Closeout now requires explicit evidence regardless of the item's status:

- A closing keyword immediately before a canonical tracker link.
- A whole-line closing declaration such as `Closes pm-ado-5w3m`.
- A whole-line `pm-github: pm-ado-5w3m` trailer.
- The item's `github_pr`, `pr_url` or `pull_request_url` set to the exact PR URL.

The entire selected PR set is planned before any SDK close. If multiple merged PRs explicitly claim the same item, every candidate is reported as `ambiguous_delivery` and no candidate closes it. Existing required-check, child-item, epic, skip and terminal-item safeguards still apply. Titles and incidental mentions never establish delivery.

The minimal fixtures retain the real titles, relevant body paragraphs and commit messages fetched with `gh pr view -R unbraind/pm-ado 16 --json title,body,commits` and the corresponding PR 19 command. Neither historical body explicitly declares delivery. Both are therefore refused until an explicit link or declaration is supplied; with the item's PR URL set to 19, closeout uses its October 8 merge chronology. Existing proposed pm-ado PR 32 tracker history is not rewritten here.

`node --test test/closeout-attribution.test.ts` passes all four real-tracker cases. Restoring only the old in-progress bypass in runCloseout makes both real-shape provenance regressions fail: PR 16 becomes eligible again and the explicit PR 19 link cannot select the intended delivery. Both package release gates remain mandatory at unchanged thresholds; final receipts are in the PM item and PR.

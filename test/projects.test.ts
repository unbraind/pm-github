import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STATUS_CANDIDATES,
  buildProjectImportPlan,
  buildProjectPullPlan,
  buildProjectPushPlan,
  indexPmByIssue,
  indexPmByProjectItem,
  indexProjectItemsByIssue,
  mapOptionNameToPmStatus,
  parseProjectRef,
  parseProjectItemTag,
  parseStatusMap,
  projectItemTag,
  resolveOptionForStatus,
  type ProjectItem,
  type ProjectRef,
  type ProjectStatusField,
} from "../dist/projects.js";

const REF: ProjectRef = { owner: "unbraind", number: 5 };

const STATUS_FIELD: ProjectStatusField = {
  id: "F_status",
  name: "Status",
  options: [
    { id: "opt_todo", name: "Todo" },
    { id: "opt_doing", name: "In Progress" },
    { id: "opt_done", name: "Done" },
  ],
};

// --- parseProjectRef -------------------------------------------------------

test("parseProjectRef parses owner/number, owner#number, and URLs", () => {
  assert.deepEqual(parseProjectRef("unbraind/5"), { owner: "unbraind", number: 5 });
  assert.deepEqual(parseProjectRef("unbraind#5"), { owner: "unbraind", number: 5 });
  assert.deepEqual(parseProjectRef("https://github.com/orgs/unbraind/projects/7"), {
    owner: "unbraind",
    number: 7,
  });
  assert.deepEqual(parseProjectRef("https://github.com/users/steve/projects/2"), {
    owner: "steve",
    number: 2,
  });
});

test("parseProjectRef rejects garbage", () => {
  assert.equal(parseProjectRef(undefined), undefined);
  assert.equal(parseProjectRef(""), undefined);
  assert.equal(parseProjectRef("unbraind"), undefined);
  assert.equal(parseProjectRef("unbraind/abc"), undefined);
  assert.equal(parseProjectRef("unbraind/0"), undefined);
});

// --- provenance tags -------------------------------------------------------

test("projectItemTag round-trips through parseProjectItemTag", () => {
  const tag = projectItemTag(REF, "PVTI_lAHOABGZtc4BdHj8zGYf8pU");
  assert.deepEqual(parseProjectItemTag(tag), {
    owner: "unbraind",
    number: 5,
    itemId: "PVTI_lAHOABGZtc4BdHj8zGYf8pU",
  });
});

test("projectItemTag survives lowercasing (pm normalizes tags) without corrupting the case-sensitive node id", () => {
  // Regression: pm lowercases tag values. The raw node id is mixed-case, so a
  // naive tag would decode to the wrong id and re-adds/duplicates on re-sync.
  const rawId = "PVTI_lAHOABGZtc4BdHj8zGYf8pU";
  const lowered = projectItemTag(REF, rawId).toLowerCase();
  assert.equal(parseProjectItemTag(lowered)?.itemId, rawId);
});

test("parseProjectItemTag rejects non-project tags and malformed ids", () => {
  assert.equal(parseProjectItemTag("gh:unbraind/pm-cli#12"), undefined);
  assert.equal(parseProjectItemTag("gh-project:unbraind/5#"), undefined);
  assert.equal(parseProjectItemTag("gh-project:unbraind/5#nothex!"), undefined);
  assert.equal(parseProjectItemTag("random"), undefined);
});

test("parseProjectItemTag tolerates malformed non-string runtime values", () => {
  assert.equal(parseProjectItemTag(null as unknown as string), undefined);
  assert.equal(parseProjectItemTag({} as unknown as string), undefined);
});

// --- status mapping --------------------------------------------------------

test("parseStatusMap builds a forward table and skips bad entries", () => {
  const m = parseStatusMap(["in_progress=Doing", "closed=Shipped", "bad", "=x", "y="]);
  assert.equal(m?.get("in_progress"), "Doing");
  assert.equal(m?.get("closed"), "Shipped");
  assert.equal(m?.size, 2);
  assert.equal(parseStatusMap([]), undefined);
});

test("resolveOptionForStatus matches default candidates case-insensitively", () => {
  assert.equal(resolveOptionForStatus("open", STATUS_FIELD.options)?.id, "opt_todo");
  assert.equal(resolveOptionForStatus("in_progress", STATUS_FIELD.options)?.id, "opt_doing");
  assert.equal(resolveOptionForStatus("closed", STATUS_FIELD.options)?.id, "opt_done");
  // canceled has no matching option here → skip (no guess)
  assert.equal(resolveOptionForStatus("canceled", STATUS_FIELD.options), undefined);
});

test("resolveOptionForStatus honors an override and hard-misses on a bad override", () => {
  const override = parseStatusMap(["closed=In Progress"]);
  assert.equal(resolveOptionForStatus("closed", STATUS_FIELD.options, override)?.id, "opt_doing");
  const bad = parseStatusMap(["closed=Nonexistent"]);
  assert.equal(resolveOptionForStatus("closed", STATUS_FIELD.options, bad), undefined);
});

test("mapOptionNameToPmStatus classifies option names and skips unknowns", () => {
  assert.equal(mapOptionNameToPmStatus("Todo"), "open");
  assert.equal(mapOptionNameToPmStatus("Backlog"), "open");
  assert.equal(mapOptionNameToPmStatus("In Progress"), "in_progress");
  assert.equal(mapOptionNameToPmStatus("Done"), "closed");
  assert.equal(mapOptionNameToPmStatus("Won't Do"), "canceled");
  assert.equal(mapOptionNameToPmStatus("Blocked"), "blocked");
  assert.equal(mapOptionNameToPmStatus("Not Started"), "open");
  assert.equal(mapOptionNameToPmStatus("Unstarted"), "open");
  assert.equal(mapOptionNameToPmStatus("Zorptastic"), undefined);
  assert.equal(mapOptionNameToPmStatus(undefined), undefined);
});

test("status and provenance helpers tolerate nullable API collection entries", () => {
  assert.equal(resolveOptionForStatus("open", [null, undefined, { id: "todo", name: "Todo" }])?.id, "todo");
  assert.equal(indexPmByIssue([null, undefined, { id: "pm-1", tags: ["gh:unbraind/pm-cli#1"] }]).size, 1);
  assert.equal(indexPmByProjectItem([null, undefined], REF).size, 0);
  assert.equal(indexProjectItemsByIssue([null, undefined]).size, 0);
});

test("mapOptionNameToPmStatus maps Draft to draft, not open (push↔pull symmetry)", () => {
  // Regression (greptile P2): forward map sends pm "draft" → "Draft", so the
  // reverse must return "draft" and not fall into the open/todo bucket.
  assert.equal(mapOptionNameToPmStatus("Draft"), "draft");
  assert.equal(resolveOptionForStatus("draft", [{ id: "o", name: "Draft" }])?.name, "Draft");
});

test("mapOptionNameToPmStatus prefers an inverted override", () => {
  const override = parseStatusMap(["in_progress=Doing"]);
  assert.equal(mapOptionNameToPmStatus("Doing", override), "in_progress");
});

test("DEFAULT_STATUS_CANDIDATES covers the core pm statuses", () => {
  for (const s of ["open", "in_progress", "closed", "canceled", "blocked", "draft"]) {
    assert.ok(Array.isArray(DEFAULT_STATUS_CANDIDATES[s]), `missing candidates for ${s}`);
  }
});

// --- push plan -------------------------------------------------------------

test("buildProjectPushPlan: add-draft for unlinked item, set-status for linked", () => {
  const linkedItemId = "PVTI_linked";
  const projectItems: ProjectItem[] = [
    { id: linkedItemId, statusOptionId: "opt_todo", statusName: "Todo", content: { typename: "DraftIssue", title: "Linked" } },
  ];
  const pmItems = [
    { id: "pm-1", title: "Unlinked", status: "open", tags: [] },
    { id: "pm-2", title: "Linked", status: "in_progress", tags: [projectItemTag(REF, linkedItemId)] },
  ];
  const plan = buildProjectPushPlan(pmItems, REF, projectItems, STATUS_FIELD);
  const add = plan.entries.find((e) => e.pmId === "pm-1");
  const set = plan.entries.find((e) => e.pmId === "pm-2");
  assert.equal(add?.action, "add-draft");
  assert.equal(add?.targetOptionName, "Todo");
  assert.equal(set?.action, "set-status");
  assert.equal(set?.targetOptionName, "In Progress");
  assert.equal(set?.currentOptionName, "Todo");
});

test("buildProjectPushPlan: already-in-sync linked item is a noop", () => {
  const id = "PVTI_x";
  const projectItems: ProjectItem[] = [
    { id, statusOptionId: "opt_done", statusName: "Done", content: { typename: "DraftIssue", title: "X" } },
  ];
  const pmItems = [{ id: "pm-1", title: "X", status: "closed", tags: [projectItemTag(REF, id)] }];
  const plan = buildProjectPushPlan(pmItems, REF, projectItems, STATUS_FIELD);
  assert.equal(plan.entries[0].action, "noop");
  assert.equal(plan.entries[0].reason, "already in sync");
});

test("buildProjectPushPlan: issue-linked pm item attaches the existing issue", () => {
  const pmItems = [{ id: "pm-1", title: "Real issue", status: "open", tags: ["gh:unbraind/pm-cli#42"] }];
  const plan = buildProjectPushPlan(pmItems, REF, [], STATUS_FIELD);
  const e = plan.entries[0];
  assert.equal(e.action, "add-issue");
  assert.equal(e.issueRepo, "unbraind/pm-cli");
  assert.equal(e.issueNumber, 42);
});

test("buildProjectPushPlan: unmapped status is recorded in statusSkipped", () => {
  const pmItems = [{ id: "pm-1", title: "Cancelled thing", status: "canceled", tags: [] }];
  const plan = buildProjectPushPlan(pmItems, REF, [], STATUS_FIELD);
  assert.equal(plan.statusSkipped.length, 1);
  assert.equal(plan.statusSkipped[0].pmId, "pm-1");
  // It is still added to the board (add-draft), just without a status set.
  assert.equal(plan.entries[0].action, "add-draft");
  assert.equal(plan.entries[0].targetOptionId, undefined);
});

test("buildProjectPushPlan: --no-add-missing never adds unlinked items", () => {
  const pmItems = [{ id: "pm-1", title: "Unlinked", status: "open", tags: [] }];
  const plan = buildProjectPushPlan(pmItems, REF, [], STATUS_FIELD, { addMissing: false });
  assert.equal(plan.entries[0].action, "noop");
});

// --- pull plan -------------------------------------------------------------

test("buildProjectPullPlan: linked item with diverging board status yields an update", () => {
  const id = "PVTI_p";
  const projectItems: ProjectItem[] = [
    { id, statusOptionId: "opt_done", statusName: "Done", content: { typename: "DraftIssue", title: "P" } },
  ];
  const pmItems = [{ id: "pm-1", title: "P", status: "open", tags: [projectItemTag(REF, id)] }];
  const plan = buildProjectPullPlan(pmItems, REF, projectItems);
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(
    { from: plan.entries[0].fromStatus, to: plan.entries[0].toStatus },
    { from: "open", to: "closed" },
  );
});

test("buildProjectPullPlan: unknown board status is skipped, not forced", () => {
  const id = "PVTI_q";
  const projectItems: ProjectItem[] = [
    { id, statusName: "Zorptastic", content: { typename: "DraftIssue", title: "Q" } },
  ];
  const pmItems = [{ id: "pm-1", title: "Q", status: "open", tags: [projectItemTag(REF, id)] }];
  const plan = buildProjectPullPlan(pmItems, REF, projectItems);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.statusSkipped.length, 1);
});

test("buildProjectPullPlan: in-sync item produces no entry", () => {
  const id = "PVTI_r";
  const projectItems: ProjectItem[] = [
    { id, statusName: "Done", content: { typename: "DraftIssue", title: "R" } },
  ];
  const pmItems = [{ id: "pm-1", title: "R", status: "closed", tags: [projectItemTag(REF, id)] }];
  assert.equal(buildProjectPullPlan(pmItems, REF, projectItems).entries.length, 0);
});

// --- import plan -----------------------------------------------------------

test("buildProjectImportPlan: creates for new items, updates linked, dual-tags issues", () => {
  const projectItems: ProjectItem[] = [
    { id: "PVTI_a", statusName: "In Progress", content: { typename: "DraftIssue", title: "Draft A", body: "b" } },
    {
      id: "PVTI_b",
      statusName: "Done",
      content: { typename: "Issue", title: "Issue B", number: 9, repo: "unbraind/pm-cli", state: "closed" },
    },
  ];
  const existing = [{ id: "pm-existing", title: "old", status: "open", tags: [projectItemTag(REF, "PVTI_a")] }];
  const plan = buildProjectImportPlan(projectItems, REF, existing);

  const a = plan.find((e) => e.itemId === "PVTI_a");
  const b = plan.find((e) => e.itemId === "PVTI_b");
  assert.equal(a?.action, "update");
  assert.equal(a?.pmId, "pm-existing");
  assert.equal(a?.status, "in_progress");
  assert.equal(b?.action, "create");
  assert.equal(b?.status, "closed");
  assert.ok(b?.tags.includes("gh:unbraind/pm-cli#9"), "issue item should carry the gh: tag");
  assert.ok(b?.tags.includes(projectItemTag(REF, "PVTI_b")), "issue item should carry the project tag");
});

test("buildProjectImportPlan: update MERGES new provenance tags with existing tags (no data loss)", () => {
  // Regression (greptile P1): a re-import must not wipe labels/user tags.
  const projectItems: ProjectItem[] = [
    { id: "PVTI_z", statusName: "Todo", content: { typename: "Issue", title: "Z", number: 3, repo: "unbraind/pm-cli", state: "open" } },
  ];
  const existing = [
    {
      id: "pm-z",
      title: "Z",
      status: "open",
      // Pre-existing tags: a label + provenance from a prior `pm github import`.
      tags: ["bug", "priority/high", "gh:unbraind/pm-cli#3", "github_author:octocat"],
    },
  ];
  const plan = buildProjectImportPlan(projectItems, REF, existing);
  const e = plan[0];
  assert.equal(e.action, "update");
  // Every pre-existing tag survives…
  for (const t of ["bug", "priority/high", "gh:unbraind/pm-cli#3", "github_author:octocat"]) {
    assert.ok(e.tags.includes(t), `existing tag ${t} must be preserved`);
  }
  // …plus the project provenance tag is added…
  assert.ok(e.tags.includes(projectItemTag(REF, "PVTI_z")), "project tag added");
  // …and no tag is duplicated (the gh: tag appears once).
  assert.equal(e.tags.filter((t) => t === "gh:unbraind/pm-cli#3").length, 1);
});

test("buildProjectImportPlan: a Draft board status imports as pm draft (roundtrip-symmetric)", () => {
  const projectItems: ProjectItem[] = [
    { id: "PVTI_d", statusName: "Draft", content: { typename: "DraftIssue", title: "D" } },
  ];
  assert.equal(buildProjectImportPlan(projectItems, REF, [])[0].status, "draft");
});

test("buildProjectImportPlan: redacted content is skipped", () => {
  const projectItems: ProjectItem[] = [{ id: "PVTI_x", content: { typename: "Unknown", title: "" } }];
  assert.equal(buildProjectImportPlan(projectItems, REF, []).length, 0);
});

test("buildProjectImportPlan: merged pull requests fall back to closed", () => {
  const projectItems: ProjectItem[] = [{
    id: "PVTI_merged",
    content: {
      typename: "PullRequest",
      title: "Merged change",
      state: "merged",
      repo: "unbraind/pm-github",
      number: 28,
    },
  }];
  assert.equal(buildProjectImportPlan(projectItems, REF, [])[0].status, "closed");
});

test("indexPmByProjectItem only matches this project's tags", () => {
  const items = [
    { id: "pm-1", tags: [projectItemTag(REF, "PVTI_1")] },
    { id: "pm-2", tags: [projectItemTag({ owner: "other", number: 9 }, "PVTI_2")] },
  ];
  const idx = indexPmByProjectItem(items, REF);
  assert.equal(idx.get("PVTI_1")?.id, "pm-1");
  assert.equal(idx.has("PVTI_2"), false);
});

// --- re-import status refresh (Greptile 2006f478) --------------------------
// A re-import (update path) must refresh the mapped pm status alongside the
// other fields, while preserving no-data-loss: an UNKNOWN board status is
// skipped (mappedStatus undefined) so the handler omits --status and leaves the
// existing pm state untouched. A KNOWN mapping surfaces mappedStatus so the
// handler can pass --status and keep pm in lockstep with the board.

test("buildProjectImportPlan: re-import surfaces mappedStatus for a known board status (update path can refresh)", () => {
  const projectItems: ProjectItem[] = [
    { id: "PVTI_done", statusName: "Done", content: { typename: "DraftIssue", title: "Done item", body: "b" } },
  ];
  const existing = [{ id: "pm-done", title: "old", status: "open", tags: [projectItemTag(REF, "PVTI_done")] }];
  const plan = buildProjectImportPlan(projectItems, REF, existing);
  const e = plan[0];
  assert.equal(e.action, "update");
  // mappedStatus is the explicit, resolvable mapping the handler will pass as
  // --status to refresh the pm item in lockstep with the board.
  assert.equal(e.mappedStatus, "closed");
  assert.equal(e.status, "closed", "status still resolves to the mapped value for display/create fallback");
});

test("buildProjectImportPlan: re-import skips status refresh for an unknown board status (no data loss)", () => {
  // The board carries a Status option we do not recognize; the pm item is
  // currently "in_progress". mappedStatus must be undefined so the update path
  // omits --status and preserves the real pm state instead of guessing.
  const projectItems: ProjectItem[] = [
    { id: "PVTI_zzz", statusName: "Zorptastic", content: { typename: "DraftIssue", title: "Z" } },
  ];
  const existing = [{ id: "pm-z", title: "Z", status: "in_progress", tags: [projectItemTag(REF, "PVTI_zzz")] }];
  const plan = buildProjectImportPlan(projectItems, REF, existing);
  const e = plan[0];
  assert.equal(e.action, "update");
  assert.equal(e.mappedStatus, undefined, "unknown board status must NOT surface a mappedStatus");
  // status falls back to "open" for the create path, but the handler ignores it
  // on update because mappedStatus is undefined.
  assert.equal(e.status, "open");
  // The plan never carries the pm item's current status; it only signals "skip"
  // via the undefined mappedStatus, leaving the handler to omit --status.
  assert.equal(existing[0].status, "in_progress");
});

test("buildProjectImportPlan: re-import without a board status field skips status refresh", () => {
  // No Status option on the board at all (statusName undefined): mappedStatus
  // is undefined, so a re-import never writes --status.
  const projectItems: ProjectItem[] = [
    { id: "PVTI_none", content: { typename: "DraftIssue", title: "No status" } },
  ];
  const existing = [{ id: "pm-none", title: "No status", status: "blocked", tags: [projectItemTag(REF, "PVTI_none")] }];
  const e = buildProjectImportPlan(projectItems, REF, existing)[0];
  assert.equal(e.action, "update");
  assert.equal(e.mappedStatus, undefined);
  assert.equal(e.status, "open");
});

test("buildProjectImportPlan: create entries also carry mappedStatus for parity", () => {
  // New items use the fallback `status` for --status, but mappedStatus is still
  // surfaced for parity so the create path could prefer it when present.
  const projectItems: ProjectItem[] = [
    { id: "PVTI_new", statusName: "In Progress", content: { typename: "DraftIssue", title: "New" } },
  ];
  const e = buildProjectImportPlan(projectItems, REF, [])[0];
  assert.equal(e.action, "create");
  assert.equal(e.mappedStatus, "in_progress");
  assert.equal(e.status, "in_progress");
});

test("buildProjectImportPlan: status-map override drives mappedStatus on re-import", () => {
  const projectItems: ProjectItem[] = [
    { id: "PVTI_ov", statusName: "Doing", content: { typename: "DraftIssue", title: "OV" } },
  ];
  const existing = [{ id: "pm-ov", title: "OV", status: "open", tags: [projectItemTag(REF, "PVTI_ov")] }];
  const override = parseStatusMap(["in_progress=Doing"]);
  const e = buildProjectImportPlan(projectItems, REF, existing, override)[0];
  assert.equal(e.action, "update");
  assert.equal(e.mappedStatus, "in_progress");
});

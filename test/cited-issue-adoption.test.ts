/** Citation adoption exercises real initialized trackers, including a PATH without git. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { create, get, listAllComplete, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { parseImportOptions, prepareGithubImport, runImport, verifyImportIdempotency, type GhIssue, type PreparedGithubImport } from "../index.ts";
import { AmbiguousCitationError, matchImportedIssue } from "../import-fidelity.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

const root = join(import.meta.dirname, "..");
const cli = join(root, "node_modules/.bin/pm");
const repo = "acme/widgets";
const issue: GhIssue = { number: 30, title: "Fixed behavior", body: "Upstream fix", state: "closed", state_reason: "completed",
  labels: [{ name: "bug" }], assignee: null, milestone: null, user: null,
  html_url: `https://github.com/${repo}/issues/30`, created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-03T00:00:00Z", closed_at: "2026-10-02T00:00:00Z" };

/** Initialize an isolated tracker with no enclosing repository and optionally allow a real gate. */
async function tracker(run: (pmRoot: string) => Promise<void>, git = false): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pm-cited-issue-"));
  const pmRoot = join(directory, ".agents/pm");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(cli, join(bin, "pm"));
  try {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), PM_GLOBAL_PATH: join(directory, "global") };
    if (git) assert.equal(spawnSync("git", ["init", "-q", directory], { env }).status, 0);
    const initialized = spawnSync(cli, ["--no-extensions", "--path", pmRoot, "init", "fixture"], { env, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    await withEnv({ PM_PATH: pmRoot, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: env.PM_GLOBAL_PATH,
      GIT_CEILING_DIRECTORIES: tmpdir(), PATH: git ? join(root, "node_modules/.bin") + delimiter + process.env.PATH : bin }, () => run(pmRoot));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Import injected REST data through the real planner and SDK or CLI mutation path. */
async function importing(pmRoot: string, options: Record<string, unknown>, issues = [issue]) {
  return captureStderr(async () => await runImport(repo, pmRoot, parseImportOptions(options), {
    resolveToken: () => undefined, fetchIssues: async () => issues,
  }) as Record<string, unknown>);
}

/** Read a certified complete corpus for identity and no-write assertions. */
async function items(pmRoot: string) {
  const result = await listAllComplete({ includeBody: true }, { pmRoot, noExtensions: true });
  certifyCompleteListResult(result);
  return result.items;
}

for (const atomic of [false, true]) {
  test(`${atomic ? "atomic" : "plain"} citation adopts a terminal item without git, then re-import updates one item`, async () => tracker(async pmRoot => {
    const existing = (await create({ type: "Task", title: "Local fix", description: `Fixed (${issue.html_url}).`,
      body: `Fix for ${repo}#30`, tags: "local", status: atomic ? "canceled" : "closed", closeReason: "Landed locally" }, { pmRoot })).item;
    const before = await items(pmRoot);
    const preview = await importing(pmRoot, { atomic, "dry-run": true });
    assert.equal(preview.result.wouldImport, 0);
    assert.equal(preview.result.wouldUpdate, 0);
    assert.equal(preview.result.wouldAdopt, 1);
    assert.match(preview.stderr.join("\n"), /#30 adopt:/);
    assert.deepEqual((preview.result.plan as { action: string; item: string }[]).map(entry => [entry.action, entry.item]), [["adopt", existing.id]]);
    assert.deepEqual(await items(pmRoot), before);
    const landed = await importing(pmRoot, { atomic });
    assert.equal(landed.result.adopted, 1);
    assert.equal(landed.result.imported, 0);
    assert.equal(landed.result.updated, 0);
    const actual = (await get(existing.id, {}, { pmRoot })).item;
    assert.ok(actual.tags!.includes(`gh:${repo}#30`));
    assert.ok(actual.tags!.includes("local"));
    assert.equal(actual.github_url, issue.html_url);
    assert.equal(actual.github_state, "closed");
    assert.equal(actual.github_closed_at, issue.closed_at);
    assert.equal(actual.status, "closed");
    const repeated = await importing(pmRoot, { atomic });
    assert.equal(repeated.result.adopted, 0);
    assert.equal(repeated.result.imported, 0);
    assert.equal((await items(pmRoot)).length, 1);
  }));

  test(`${atomic ? "atomic" : "plain"} ambiguity lists both candidates and refuses the entire batch before writes`, async () => tracker(async pmRoot => {
    const first = (await create({ type: "Task", title: `Fix ${repo}#30` }, { pmRoot })).item;
    const second = (await create({ type: "Task", title: "Other fix", body: `Issue: (${issue.html_url})` }, { pmRoot })).item;
    const before = await items(pmRoot);
    const batch = [{ ...issue, number: 31, html_url: issue.html_url.replace("/30", "/31") }, issue];
    const preview = await importing(pmRoot, { atomic, gate: true, "dry-run": true }, batch);
    assert.equal(preview.result.blocked, true);
    assert.equal(preview.result.wouldImport, 0);
    const entry = (preview.result.plan as { action: string; candidates: string[]; remedy: string }[])[0]!;
    assert.equal(entry.action, "ambiguous_citation");
    assert.deepEqual(entry.candidates, [first.id, second.id].sort());
    assert.match(entry.remedy, /Tag the correct item with gh:acme\/widgets#30/);
    assert.match(preview.stderr.join("\n"), /ambiguous_citation/);
    for (const gate of [false, true]) await assert.rejects(importing(pmRoot, { atomic, gate }, batch), /ambiguous_citation/);
    assert.deepEqual(await items(pmRoot), before);
    await assert.rejects(importing(pmRoot, { atomic }, [{ ...issue, title: "", number: 31 }, issue]), /ambiguous_citation/);
  }));

  test(`${atomic ? "atomic" : "plain"} gate counts an adopt as one existing landing item`, async () => tracker(async pmRoot => {
    const existing = (await create({ type: "Task", title: `Fixed ${repo}#30` }, { pmRoot })).item;
    const preview = await importing(pmRoot, { atomic, gate: true, "dry-run": true });
    const gate = preview.result.gate as { idempotency: Record<string, number> };
    assert.deepEqual(gate.idempotency, { adopted: 1, provenance_indexed: 0, matched_by_provenance: 0, new_entries: 0 });
    await importing(pmRoot, { atomic, gate: true });
    assert.equal((await items(pmRoot))[0]!.id, existing.id);
    assert.equal((await items(pmRoot)).length, 1);
  }, true));

  test(`${atomic ? "atomic" : "plain"} closed incidental item is reported but never overwritten or reopened`, async () => tracker(async pmRoot => {
    const local = (await create({ type: "Task", title: "Completed related work", description: `Related: ${repo}#30`,
      body: "Retain this completed work and its context", status: "closed", closeReason: "Landed independently", tags: "local" }, { pmRoot })).item;
    const before = (await get(local.id, {}, { pmRoot })).item;
    const opened = { ...issue, state: "open" as const, state_reason: "reopened" as const, closed_at: null };
    const preview = (await importing(pmRoot, { atomic, "dry-run": true }, [opened])).result;
    assert.equal(preview.wouldAdopt, 0);
    assert.equal(preview.wouldImport, 1);
    assert.deepEqual(preview.citation_candidates, [{ issue: 30, id: local.id, reason: "missing_intent" }]);
    const plan = (preview.plan as { action: string; citation_candidates: unknown }[])[0]!;
    assert.equal(plan.action, "create");
    assert.deepEqual(plan.citation_candidates, [{ id: local.id, reason: "missing_intent" }]);
    const result = (await importing(pmRoot, { atomic }, [opened])).result;
    assert.equal(result.imported, 1);
    assert.equal(result.adopted, 0);
    assert.deepEqual(result.citation_candidates, preview.citation_candidates);
    assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    assert.equal((await items(pmRoot)).length, 2);
  }));

  test(`${atomic ? "atomic" : "plain"} roadmap never adopts when either issue is imported alone`, async () => tracker(async pmRoot => {
    const local = (await create({ type: "Task", title: `Roadmap: ${repo}#30 and ${repo}#31`,
      body: "Independent roadmap context", status: "open" }, { pmRoot })).item;
    const before = (await get(local.id, {}, { pmRoot })).item;
    for (const number of [30, 31]) {
      const source = { ...issue, number, html_url: `https://github.com/${repo}/issues/${number}` };
      const preview = (await importing(pmRoot, { atomic, gate: true, "dry-run": true }, [source])).result;
      assert.equal(preview.wouldAdopt, 0);
      assert.equal(preview.wouldImport, 1);
      assert.deepEqual(preview.citation_candidates, [{ issue: number, id: local.id, reason: "multiple_issues" }]);
      const landed = (await importing(pmRoot, { atomic }, [source])).result;
      assert.equal(landed.adopted, 0);
      assert.equal(landed.imported, 1);
      assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    }
    assert.equal((await items(pmRoot)).length, 3);
  }));
}

test("citation matching accepts exact qualified references across prose fields and trailing punctuation", () => {
  for (const field of ["title", "description", "body"]) {
    for (const citation of [issue.html_url, `${issue.html_url}.`, `(${issue.html_url})`, `${issue.html_url}?`,
      `Issue:${issue.html_url}`, `${repo}#30`, `Tracks:${repo}#30`, `${repo}#30?`, `ACME/Widgets#30;`]) {
      const local = { id: "local", [field]: `Fixed ${citation}` };
      assert.equal(matchImportedIssue([local], issue).item, local, `${field}: ${citation}`);
    }
  }
  assert.equal(matchImportedIssue([{ id: "local", tags: ["gh:invalid"], title: `${repo}#30` }], issue).via, "citation");
  assert.equal(matchImportedIssue([{ id: "local", title: `${repo}#30` }], { ...issue, pull_request: {} }).via, "new");
});

test("bare numbers, other repos, longer identities, URL paths and different issue tags cannot adopt", () => {
  for (const body of ["#30", "https://github.com/other/widgets/issues/30", "other/widgets#30", `${repo}#300`,
    `${issue.html_url}0`, `${issue.html_url}/extra`, `${issue.html_url}?view=all`, `${issue.html_url}.json`,
    `https://other.test/${repo}#30`, `x${issue.html_url}`, "http://github.com/acme/widgets/issues/30"]) {
    assert.equal(matchImportedIssue([{ id: "local", body }], issue).via, "new", body);
  }
  assert.equal(matchImportedIssue([{ id: "tagged-other", body: issue.html_url, tags: [`gh:${repo}#31`] }], issue).via, "new");
  assert.equal(matchImportedIssue([{ title: repo + "#30" }], issue).via, "new");
});

test("tagged and URL-linked owners take precedence over even multiple prose citations", () => {
  const citing = ["first", "second"].map(id => ({ id, body: `Fixes ${issue.html_url}` }));
  const tagged = { id: "tagged", tags: [`gh:${repo}#30`] };
  assert.equal(matchImportedIssue([...citing, tagged], issue, tagged).item, tagged);
  const linked = { id: "linked", github_url: issue.html_url };
  assert.equal(matchImportedIssue([...citing, linked], issue).item, linked);
  assert.throws(() => matchImportedIssue(citing, issue), AmbiguousCitationError);
});

test("opt-out preserves create semantics for reference-only prose", async () => tracker(async pmRoot => {
  await create({ type: "Task", title: `References ${repo}#30` }, { pmRoot });
  assert.equal(parseImportOptions({}).noAdoptCited, false);
  assert.equal(parseImportOptions({ noAdoptCited: true }).noAdoptCited, true);
  const preview = await importing(pmRoot, { "dry-run": true, "no-adopt-cited": true });
  assert.equal(preview.result.wouldImport, 1);
  assert.equal(preview.result.wouldAdopt, 0);
}));

test("provider-owned citation adoption links without replacing local context", async () => tracker(async pmRoot => {
  const owner = (await create({ type: "Task", title: `Provider fix ${repo}#30`, body: "Native context", tags: "linear:fixture", status: "in_progress" }, { pmRoot })).item;
  const result = await importing(pmRoot, {});
  assert.equal(result.result.adopted, 1);
  const actual = (await get(owner.id, {}, { pmRoot })).item;
  assert.equal(actual.title, owner.title);
  assert.equal(actual.status, owner.status);
  assert.equal(actual.github_url, issue.html_url);
}));

test("batch plans both issues normally instead of transferring a roadmap", async () => tracker(async pmRoot => {
  const roadmap = (await create({ type: "Task", title: `${repo}#30 and ${repo}#31` }, { pmRoot })).item;
  for (const gate of [false, true]) {
    const result = (await importing(pmRoot, { gate, "dry-run": true }, [issue, { ...issue, number: 31, html_url: issue.html_url.replace("/30", "/31") }])).result;
    assert.equal(result.wouldAdopt, 0);
    assert.equal(result.wouldImport, 2);
    assert.deepEqual(result.citation_candidates, [30, 31].map(number => ({ issue: number, id: roadmap.id, reason: "multiple_issues" })));
  }
}));

test("only explicit closing keywords, issue labels or a title reference establish citation intent", () => {
  for (const reference of [issue.html_url, `${repo}#30`]) {
    for (const prefix of ["Fix", "fixes", "FIXED:", "Close", "Closes", "Closed", "Resolve", "Resolves", "Resolved", "Issue:", "Tracks:", "GH issue", "GH issue:"]) {
      for (const field of ["description", "body"]) assert.equal(matchImportedIssue([{ id: "local", [field]: `${prefix} (${reference})` }], issue).via, "citation", `${field}: ${prefix}`);
    }
    assert.equal(matchImportedIssue([{ id: "local", title: `Work for ${reference}`, body: "Related context" }], issue).via, "citation");
    for (const prefix of ["Related:", "See", "References:", "Fix for", "Tracks", "Tracking:", "PrefixFixes"]) {
      const result = matchImportedIssue([{ id: "local", description: `${prefix} ${reference}` }], issue);
      assert.equal(result.via, "new", prefix);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "missing_intent" }]);
    }
  }
});

test("distinct issue count includes other repositories and all three fields but deduplicates repeated identity", () => {
  for (const other of [`${repo}#31`, "Other/widgets#30", "https://github.com/other/widgets/issues/31?view=all#fragment", "http://www.github.com/other/widgets/issues/31"]) {
    for (const field of ["title", "description", "body"]) {
      const result = matchImportedIssue([{ id: "local", description: `Fixes ${issue.html_url}`, [field]: `Tracks: ${other}`,
        body: `Issue: ${repo}#30${field === "body" ? ` and ${other}` : ""}` }], issue);
      assert.equal(result.via, "new");
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
    }
  }
  const local = { id: "local", title: `Fix ${repo}#30`, description: `Issue: ${issue.html_url}`, body: "Tracks: ACME/Widgets#30" };
  assert.equal(matchImportedIssue([local], issue).item, local);
  const hints = matchImportedIssue([{ id: "z", body: `Related: ${repo}#30` },
    { id: "a", title: `${repo}#30 and other/widgets#31` }], issue);
  assert.deepEqual(hints.citation_candidates, [{ id: "a", reason: "multiple_issues" }, { id: "z", reason: "missing_intent" }]);
});

test("incidental hints do not create ambiguity and remain visible alongside eligible owners or refusal", async () => tracker(async pmRoot => {
  const related = (await create({ type: "Task", title: "Related work", body: `Related: ${issue.html_url}` }, { pmRoot })).item;
  const eligible = (await create({ type: "Task", title: `Fixes ${repo}#30` }, { pmRoot })).item;
  const preview = (await importing(pmRoot, { "dry-run": true })).result;
  assert.equal(preview.wouldAdopt, 1);
  assert.equal((preview.plan as { item: string }[])[0]!.item, eligible.id);
  assert.deepEqual(preview.citation_candidates, [{ issue: 30, id: related.id, reason: "missing_intent" }]);
  await create({ type: "Task", title: "Another owner", body: `Tracks: ${repo}#30` }, { pmRoot });
  const refused = (await importing(pmRoot, { "dry-run": true })).result;
  assert.equal(refused.blocked, true);
  assert.deepEqual(refused.citation_candidates, preview.citation_candidates);
  assert.deepEqual((refused.plan as { citation_candidates: unknown }[])[0]!.citation_candidates, [{ id: related.id, reason: "missing_intent" }]);
  assert.equal(new AmbiguousCitationError(repo, 30, ["a", "b"]).entry.citation_candidates, undefined);
}));

test("a citation without a local tag array still receives the issue provenance tag", async () => {
  const entry = await prepareGithubImport(issue, repo, parseImportOptions({}), undefined, undefined, undefined,
    { items: [{ id: "local", title: `${repo}#30` }], releases: [], timeline: async () => [] });
  assert.ok(entry!.tags.includes(`gh:${repo}#30`));
});

test("idempotency requires the provenance tag on an adopt too", () => {
  const entry = { issueNumber: 30, tags: [], identity: { via: "citation" }, match: { id: "local" } } as unknown as PreparedGithubImport;
  assert.throws(() => verifyImportIdempotency([], [entry], repo), /without a provenance tag/);
});

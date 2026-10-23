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
    const second = (await create({ type: "Task", title: "Other fix", body: `${issue.html_url})` }, { pmRoot })).item;
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
}

test("citation matching accepts exact qualified references across prose fields and trailing punctuation", () => {
  for (const field of ["title", "description", "body"]) {
    for (const citation of [issue.html_url, `${issue.html_url}.`, `(${issue.html_url})`, `${repo}#30`, `ACME/Widgets#30;`]) {
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
  const citing = ["first", "second"].map(id => ({ id, body: issue.html_url }));
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

test("gate rejects adopting the same local item for two issues", async () => tracker(async pmRoot => {
  await create({ type: "Task", title: `${repo}#30 and ${repo}#31` }, { pmRoot });
  for (const gate of [false, true]) await assert.rejects(importing(pmRoot, { gate, "dry-run": true }, [issue, { ...issue, number: 31 }]), /conflicting target/);
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

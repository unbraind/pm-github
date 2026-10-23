/** Citation adoption exercises real initialized trackers, including a PATH without git. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { create, get, listAllComplete, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { parseImportOptions, prepareGithubImport, runImport, verifyImportIdempotency, type GhIssue, type PreparedGithubImport } from "../index.ts";
import { AmbiguousCitationError, matchImportedIssue as resolveImportedIssue } from "../import-fidelity.ts";
import { captureStderr, withEnv } from "./helpers/mock-github-server.ts";

/** Existing adoption regressions opt in explicitly; default-off cases call the production matcher directly. */
const matchImportedIssue: typeof resolveImportedIssue = (items, issue, tagged, adoptCited = true) => resolveImportedIssue(items, issue, tagged, adoptCited);

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
  return captureStderr(async () => await runImport(repo, pmRoot, parseImportOptions({ adoptCited: true, ...options }), {
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
      body: `Issue: ${issue.html_url}\n\nFix for ${repo}#30`, tags: "local", status: atomic ? "canceled" : "closed", closeReason: "Landed locally" }, { pmRoot })).item;
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
    const second = (await create({ type: "Task", title: "Other fix", body: `Issue: (${issue.html_url})\n\nIssue: ${issue.html_url}` }, { pmRoot })).item;
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

  test(`${atomic ? "atomic" : "plain"} trailing-slash second reference preserves the roadmap in a non-git tracker`, async () => tracker(async pmRoot => {
    const local = (await create({ type: "Task", title: "Independent roadmap", description: `Fixes ${repo}#30 and https://github.com/${repo}/issues/31/`,
      body: "Keep the roadmap context", status: "open" }, { pmRoot })).item;
    const before = (await get(local.id, {}, { pmRoot })).item;
    const preview = (await importing(pmRoot, { atomic, "dry-run": true })).result;
    assert.equal(preview.wouldImport, 1);
    assert.equal(preview.wouldAdopt, 0);
    assert.deepEqual(preview.citation_candidates, [{ issue: 30, id: local.id, reason: "multiple_issues" }]);
    assert.equal((preview.plan as { action: string }[])[0]!.action, "create");
    const landed = (await importing(pmRoot, { atomic })).result;
    assert.equal(landed.imported, 1);
    assert.equal(landed.adopted, 0);
    assert.deepEqual(landed.citation_candidates, preview.citation_candidates);
    assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    assert.equal((await items(pmRoot)).length, 2);
  }));

  test(`${atomic ? "atomic" : "plain"} raw exclusion preserves an item with a bold second URL without git`, async () => tracker(async pmRoot => {
    const local = (await create({ type: "Task", title: "Protected roadmap", description: `Fixes ${repo}#30 and **https://github.com/${repo}/issues/31**`,
      body: "Keep all roadmap context", status: "open", tags: "local" }, { pmRoot })).item;
    const before = (await get(local.id, {}, { pmRoot })).item;
    const preview = (await importing(pmRoot, { atomic, gate: true, "dry-run": true })).result;
    assert.equal(preview.wouldImport, 1);
    assert.equal(preview.wouldAdopt, 0);
    assert.deepEqual(preview.citation_candidates, [{ issue: 30, id: local.id, reason: "multiple_issues" }]);
    assert.equal((preview.plan as { action: string }[])[0]!.action, "create");
    const landed = (await importing(pmRoot, { atomic })).result;
    assert.equal(landed.imported, 1);
    assert.equal(landed.adopted, 0);
    assert.deepEqual(landed.citation_candidates, preview.citation_candidates);
    assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    assert.equal((await items(pmRoot)).length, 2);
  }));

  test(`${atomic ? "atomic" : "plain"} repository veto preserves the exact foreign same-number bold URL reproduction without git`, async () => tracker(async pmRoot => {
    const local = (await create({ type: "Task", title: "Protected work", description: "Fixes acme/widgets#30 and **https://github.com/other/widgets/issues/30**",
      status: "closed", closeReason: "Independent completed work", body: "Preserve local context", tags: "local" }, { pmRoot })).item;
    const before = (await get(local.id, {}, { pmRoot })).item;
    const opened = { ...issue, state: "open" as const, state_reason: "reopened" as const, closed_at: null };
    const preview = (await importing(pmRoot, { atomic, gate: true, "dry-run": true }, [opened])).result;
    assert.equal(preview.wouldAdopt, 0);
    assert.equal(preview.wouldImport, 1);
    assert.deepEqual(preview.citation_candidates, [{ issue: 30, id: local.id, reason: "multiple_issues" }]);
    assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    const landed = (await importing(pmRoot, { atomic }, [opened])).result;
    assert.equal(landed.adopted, 0);
    assert.equal(landed.imported, 1);
    assert.deepEqual(landed.citation_candidates, preview.citation_candidates);
    assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    assert.equal((await items(pmRoot)).length, 2);
  }));

}

test("raw exclusion rejects Markdown-wrapped second numbers across every prose field", () => {
  const wrappers = [["**", "**"], ["*", "*"], ["_", "_"], ["`", "`"], ["```text\n", "\n```"], ["<", ">"], ["[reference](", ")"], ["![reference](", ")"]];
  const references = [`https://github.com/${repo}/issues/31`, `https://github.com/${repo}/pull/31`, `${repo}#31`, "#31",
    "issues/31suffix", "pull/31suffix", "prefix#31suffix", "https://foreign.example/anything#31"];
  for (const [left, right] of wrappers) for (const reference of references) {
    for (const field of ["title", "description", "body"] as const) {
      const local = { id: "local", title: "Local work", description: `Fixes ${repo}#30`, body: "" };
      local[field] += ` and ${left}${reference}${right}`;
      const result = matchImportedIssue([local], issue);
      assert.equal(result.via, "new", `${field}: ${left}${reference}${right}`);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
    }
  }
});

test("raw exclusion property rejects second numbers wrapped in seeded random Markdown decorations", t => {
  let seed = 0x6c8e9cf5;
  /** Reproduce the same generated decoration stream on every supported runtime. */
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const wrappers = [["**", "**"], ["*", "*"], ["__", "__"], ["_", "_"], ["`", "`"], ["```text\n", "\n```"],
    ["<", ">"], ["[reference](", ")"], ["![reference](", ")"], ["~~", "~~"], ["\\*", "\\*"], ["> ", "\n"]];
  const tails = ["", "next", ".", ")", "**tail", "_suffix", "/extra", "?query=anything"];
  for (let sample = 0; sample < 4096; sample++) {
    const number = 31 + next(10000);
    const references = [`https://github.com/${repo}/issues/${number}`, `https://github.com/${repo}/pull/${number}`, `${repo}#${number}`,
      `#${number}`, `issues/${number}tail`, `pull/${number}tail`, `prefix#${number}tail`, `https://foreign.example/path#${number}`];
    let decorated = references[next(references.length)]!;
    const depth = 1 + next(8);
    for (let layer = 0; layer < depth; layer++) {
      const [left, right] = wrappers[next(wrappers.length)]!;
      decorated = left + decorated + right;
    }
    decorated += tails[next(tails.length)];
    for (const field of ["title", "description", "body"] as const) {
      const local = { id: "local", title: "Local work", description: `Fixes ${repo}#30`, body: "" };
      local[field] += ` and ${decorated}`;
      const result = matchImportedIssue([local], issue);
      assert.equal(result.via, "new", `seed 0x6c8e9cf5, sample ${sample}, ${field}: ${decorated}`);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
    }
  }
  t.diagnostic("seed 0x6c8e9cf5: 4096 generated decorations, 12288 field cases");
});

test("raw exclusion deliberately over-counts unrelated substrings and trailing characters", () => {
  for (const text of ["issues/31letters", "pull/31/anything", "#31letters", "prefix#31suffix", "nestedissues/31tail", "ISSUES/31tail",
    "notgithub/pull/31anything", "https://foreign.example/path#31", "https://[bad#31", "#0", "#030", "#999999999999999999999999999999999999"]) {
    for (const field of ["title", "description", "body"] as const) {
      const local = { id: "local", title: "Local work", description: `Fixes ${repo}#30`, body: "" };
      local[field] += ` and ${text}`;
      const result = matchImportedIssue([local], issue);
      assert.equal(result.via, "new", `${field}: ${text}`);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
    }
  }
  for (const text of ["**issues/30**", "prefix#30suffix", "pull/30/anything", "https://foreign.example/path#30"]) {
    assert.equal(matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30 and ${text}` }], issue).via, "new", text);
  }
});

test("repository veto rejects foreign same-number issues and PRs in every property decoration", () => {
  const wrappers = [["**", "**"], ["*", "*"], ["__", "__"], ["_", "_"], ["`", "`"], ["```text\n", "\n```"],
    ["<", ">"], ["[reference](", ")"], ["![reference](", ")"], ["~~", "~~"], ["\\*", "\\*"], ["> ", "\n"]];
  const references = ["https://github.com/other/widgets/issues/30", "https://github.com/other/widgets/pull/30",
    "http://www.github.com/ACME/other/issues/30/?query=all#issuecomment-99", "other/widgets#30"];
  for (const [left, right] of wrappers) for (const reference of references) {
    for (const field of ["title", "description", "body"] as const) {
      const local = { id: "local", title: "Local work", description: `Fixes ${repo}#30`, body: "" };
      local[field] += ` and ${left}${reference}${right}`;
      const result = matchImportedIssue([local], issue);
      assert.equal(result.via, "new", `${field}: ${left}${reference}${right}`);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
    }
  }
});

test("repository veto fuzzes random repositories, numbers and nested Markdown decorations", t => {
  let seed = 0x78b3e2d1;
  /** Keep generated repository and decoration combinations reproducible across runtimes. */
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const wrappers = [["**", "**"], ["*", "*"], ["__", "__"], ["_", "_"], ["`", "`"], ["```text\n", "\n```"],
    ["<", ">"], ["[reference](", ")"], ["![reference](", ")"], ["~~", "~~"], ["\\*", "\\*"], ["> ", "\n"]];
  const tails = ["", "/", ".", ")", "**tail", "suffix", "?query=all", "#issuecomment-99"];
  for (let sample = 0; sample < 4096; sample++) {
    const sourceRepo = next(2) === 0 ? repo : `owner-${next(10000)}/repo-${next(10000)}`;
    const number = sourceRepo === repo ? 31 + next(10000) : next(2) === 0 ? 30 : 31 + next(10000);
    const references = [`https://github.com/${sourceRepo}/issues/${number}`, `http://www.github.com/${sourceRepo}/pull/${number}`,
      `${sourceRepo}#${number}`, `#${number}`, `issues/${number}`, `pull/${number}`];
    let decorated = references[next(references.length)]!;
    const depth = 1 + next(8);
    for (let layer = 0; layer < depth; layer++) {
      const [left, right] = wrappers[next(wrappers.length)]!;
      decorated = left + decorated + right;
    }
    decorated += tails[next(tails.length)];
    for (const field of ["title", "description", "body"] as const) {
      const local = { id: "local", title: "Local work", description: `Fixes ${repo}#30`, body: "" };
      local[field] += ` and ${decorated}`;
      const result = matchImportedIssue([local], issue);
      assert.equal(result.via, "new", `seed 0x78b3e2d1, sample ${sample}, ${sourceRepo}#${number}, ${field}: ${decorated}`);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
    }
  }
  t.diagnostic("seed 0x78b3e2d1: 4096 repository/number/decoration samples, 12288 field cases");
});

test("repository veto refuses UNKNOWN references and retains qualified same-target controls", () => {
  for (const reference of ["#30", "**#30**", "issues/30", "pull/30", "prefix#30suffix", "https://foreign.example/path#30",
    "https://github.com/other/widgets/issues/30", "https://github.com/other/widgets/pull/30", "other/widgets#30",
    "https://github.com//widgets/issues/30", "https://github.com/acme//issues/30"]) {
    const result = matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30 and ${reference}` }], issue);
    assert.equal(result.via, "new", reference);
    assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
  }
  for (const reference of [`${repo}#30`, "ACME/Widgets#30", `**https://github.com/${repo}/issues/30**`,
    `https://github.com/${repo}/pull/30`, `http://www.github.com/${repo}/issues/30/?query=all#issuecomment-123`]) {
    assert.equal(matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30 and ${reference}` }], issue).via, reference.includes("/pull/") ? "new" : "citation", reference);
  }
});

test("every accepted second-reference shape disqualifies a fix item across every prose field", () => {
  const suffixes = ["", "/", "#issuecomment-123", "/#issuecomment-123", "?view=all", "/?view=all", "?view=all#issuecomment-123", "/?view=all#issuecomment-123"];
  const firstShapes = [`${repo}#30`, ...suffixes.flatMap(suffix => [issue.html_url + suffix, `http://www.github.com/${repo}/issues/30${suffix}`])];
  const secondShapes = [`${repo}#31`, "#31", "other/widgets#31", ...["issues", "pull"].flatMap(kind => suffixes.flatMap(suffix => [
    `https://github.com/${repo}/${kind}/31${suffix}`, `http://www.github.com/other/widgets/${kind}/31${suffix}`,
  ]))];
  for (const first of firstShapes) {
    for (const field of ["title", "description", "body"] as const) {
      assert.equal(matchImportedIssue([{ id: "local", [field]: `Fixes ${first}` }], issue).via, field === "body" ? "new" : "citation", `${field}: ${first}`);
      for (const second of secondShapes) {
        for (const text of [second, `${second}.`, `(${second})`, `[reference](${second}).`, `[reference](${second})next`]) {
          const local = { id: "local", title: "Local work", description: `Fixes ${first}`, body: "" };
          local[field] += ` and ${text}`;
          const result = matchImportedIssue([local], issue);
          assert.equal(result.via, "new", `${first}; ${field}: ${text}`);
          assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
        }
      }
    }
  }
});

test("strict parsing deduplicates qualified locators without granting ownership to bare numbers or PR links", () => {
  const local = { id: "local", title: `Fixes ${repo}#30`, description: `Issue: ${issue.html_url}/?view=all#issuecomment-123`,
    body: `Same target #30 and ${issue.html_url}#issuecomment-456` };
  assert.equal(matchImportedIssue([local], issue).via, "new");
  assert.deepEqual(matchImportedIssue([local], issue).citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
  assert.equal(matchImportedIssue([{ ...local, body: `Same target ${repo}#30 and ${issue.html_url}#issuecomment-456` }], issue).via, "citation");
  for (const text of ["#30", `https://github.com/${repo}/pull/30/`, `https://github.com/${repo}/issues/30/extra`,
    `${issue.html_url}.json`, "https://github.com/other/widgets/issues/30/", "https://other.test/acme/widgets/issues/30/", "https://["]) {
    assert.equal(matchImportedIssue([{ id: "local", title: `Fixes ${text}` }], issue).via, "new", text);
  }
  for (const embedded of ["https://other.test/path#31", "https://other.test/acme/widgets#31", "https://[bad#31"]) {
    const result = matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30 and ${embedded}` }], issue);
    assert.equal(result.via, "new", embedded);
    assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
  }
  assert.equal(matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30 and https://github.com/search?q=other/widgets%2331` }], issue).via, "new");
});

test("citation matching accepts exact qualified references across prose fields and trailing punctuation", () => {
  for (const field of ["title", "description", "body"]) {
    for (const citation of [issue.html_url, `${issue.html_url}.`, `(${issue.html_url})`, `${issue.html_url}?`,
      `Issue:${issue.html_url}`, `${repo}#30`, `Tracks:${repo}#30`, `${repo}#30?`, `ACME/Widgets#30;`]) {
      const local = { id: "local", [field]: `Fixed ${citation}` };
      assert.equal(matchImportedIssue([local], issue).item, field === "body" || (field === "description" && (/^(?:Issue:|Tracks:)/.test(citation) || citation.startsWith("("))) ? undefined : local, `${field}: ${citation}`);
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
  const citing = ["first", "second"].map(id => ({ id, body: `Fixes ${issue.html_url}\n\nIssue: ${issue.html_url}` }));
  const tagged = { id: "tagged", tags: [`gh:${repo}#30`] };
  assert.equal(matchImportedIssue([...citing, tagged], issue, tagged).item, tagged);
  const linked = { id: "linked", github_url: issue.html_url };
  assert.equal(matchImportedIssue([...citing, linked], issue).item, linked);
  assert.throws(() => matchImportedIssue(citing, issue), AmbiguousCitationError);
});

test("opt-out preserves create semantics for reference-only prose", async () => tracker(async pmRoot => {
  await create({ type: "Task", title: `References ${repo}#30` }, { pmRoot });
  assert.equal(parseImportOptions({}).adoptCited, false);
  assert.equal(parseImportOptions({ adoptCited: true }).adoptCited, true);
  const preview = await importing(pmRoot, { "dry-run": true, adoptCited: false });
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
      for (const field of ["description", "body"]) assert.equal(matchImportedIssue([{ id: "local", [field]: `${prefix} (${reference})` }], issue).via, "new", `${field}: ${prefix}`);
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
  await create({ type: "Task", title: "Another owner", body: `Tracks: ${repo}#30\n\nIssue: ${issue.html_url}` }, { pmRoot });
  const refused = (await importing(pmRoot, { "dry-run": true })).result;
  assert.equal(refused.blocked, true);
  assert.deepEqual(refused.citation_candidates, preview.citation_candidates);
  assert.deepEqual((refused.plan as { citation_candidates: unknown }[])[0]!.citation_candidates, [{ id: related.id, reason: "missing_intent" }]);
  assert.equal(new AmbiguousCitationError(repo, 30, ["a", "b"]).entry.citation_candidates, undefined);
}));

test("a citation without a local tag array still receives the issue provenance tag", async () => {
  const entry = await prepareGithubImport(issue, repo, parseImportOptions({ adoptCited: true }), undefined, undefined, undefined,
    { items: [{ id: "local", title: `${repo}#30` }], releases: [], timeline: async () => [] });
  assert.ok(entry!.tags.includes(`gh:${repo}#30`));
});

test("idempotency requires the provenance tag on an adopt too", () => {
  const entry = { issueNumber: 30, tags: [], identity: { via: "citation" }, match: { id: "local" } } as unknown as PreparedGithubImport;
  assert.throws(() => verifyImportIdempotency([], [entry], repo), /without a provenance tag/);
});

for (const atomic of [false, true]) for (const adoptCited of [false, true]) {
  test(`${atomic ? "atomic" : "plain"} explicit opt-in ${adoptCited} controls the pm-review Issue label in a non-git tracker`, async () => tracker(async pmRoot => {
    const local = (await create({ type: "Task", title: "Completed local fix", body: `Issue: ${issue.html_url}`,
      status: "closed", closeReason: "Already landed", tags: "local" }, { pmRoot })).item;
    const before = (await get(local.id, {}, { pmRoot })).item;
    const preview = (await importing(pmRoot, { atomic, adoptCited, gate: true, "dry-run": true })).result;
    assert.equal(preview.wouldAdopt, adoptCited ? 1 : 0);
    assert.equal(preview.wouldImport, adoptCited ? 0 : 1);
    assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    const result = (await importing(pmRoot, { atomic, adoptCited })).result;
    assert.equal(result.adopted, adoptCited ? 1 : 0);
    assert.equal(result.imported, adoptCited ? 0 : 1);
    assert.equal((await items(pmRoot)).length, adoptCited ? 1 : 2);
    if (!adoptCited) {
      assert.deepEqual(preview.citation_candidates, [{ issue: 30, id: local.id, reason: "adoption_disabled" }]);
      assert.deepEqual(result.citation_candidates, preview.citation_candidates);
      assert.deepEqual((await get(local.id, {}, { pmRoot })).item, before);
    }
  }));
}

test("explicit opt-in defaults off in SDK options and reports competing eligible candidates without refusing", () => {
  assert.equal(parseImportOptions({}).adoptCited, false);
  assert.equal(parseImportOptions({ "adopt-cited": true }).adoptCited, true);
  assert.equal(parseImportOptions({ adoptCited: true }).adoptCited, true);
  const owners = [{ id: "a", description: `Fixes ${repo}#30` }, { id: "b", body: `Issue: ${issue.html_url}` }];
  const result = resolveImportedIssue(owners, issue);
  assert.equal(result.via, "new");
  assert.deepEqual(result.citation_candidates, owners.map(owner => ({ id: owner.id, reason: "adoption_disabled" })));
  assert.throws(() => resolveImportedIssue(owners, issue, undefined, true), AmbiguousCitationError);
});

test("normalized allowlist refuses all five review rounds with explicit opt-in", () => {
  const cases = [
    { description: `Related: ${repo}#30`, reason: "missing_intent" },
    { description: `Fixes ${repo}#30 and ${repo}#31`, reason: "multiple_issues" },
    ...["https://github.com/acme/widgets/issues/31/", "**https://github.com/acme/widgets/issues/31**",
      "**https://github.com/other/widgets/issues/30**", "[other](https://github.com/other/widgets/issues&sol;31)",
      "[other](https://github.com/other/widgets/issues%2F31)", "issues%2F31"].map(other => ({ description: `Fixes ${repo}#30 and ${other}`, reason: "multiple_issues" })),
  ];
  for (const { description, reason } of cases) {
    for (const enabled of [false, true]) {
      const result = resolveImportedIssue([{ id: "local", status: "closed", description }], issue, undefined, enabled);
      assert.equal(result.via, "new", description);
      assert.deepEqual(result.citation_candidates, [{ id: "local", reason }], description);
    }
  }
});

test("normalized allowlist accepts only anchored description, body URL label and title forms", () => {
  for (const keyword of ["Fix", "Fixes", "Fixed", "Close", "Closes", "Closed", "Resolve", "Resolves", "Resolved"]) {
    for (const reference of [`${repo}#30`, issue.html_url]) {
      assert.equal(matchImportedIssue([{ id: "local", description: `${keyword} ${reference} . Additional context` }], issue).via, "citation");
      for (const description of [`Context: ${keyword} ${reference}`, `${keyword}: ${reference}`]) {
        assert.equal(matchImportedIssue([{ id: "local", description }], issue).via, "new", description);
      }
      assert.equal(matchImportedIssue([{ id: "local", body: `${keyword} ${reference}` }], issue).via, "new");
    }
  }
  for (const label of ["Issue:", "Tracks:"]) {
    assert.equal(matchImportedIssue([{ id: "local", body: `${label} ${issue.html_url}` }], issue).via, "citation");
    assert.equal(matchImportedIssue([{ id: "local", body: `${label} <${issue.html_url}>` }], issue).via, "citation");
    for (const body of [`${label} ${repo}#30`, `Context ${label} ${issue.html_url}`, `${label} ${issue.html_url} additional text`]) {
      assert.equal(matchImportedIssue([{ id: "local", body }], issue).via, "new", body);
    }
  }
});

test("normalized allowlist decodes named/numeric entities, percent layers, Unicode and Markdown destinations", () => {
  const references = [issue.html_url.replaceAll("/", "&sol;"), issue.html_url.replaceAll("/", "&#47;"),
    issue.html_url.replaceAll("/", "&#x2f;"), encodeURIComponent(issue.html_url), encodeURIComponent(encodeURIComponent(issue.html_url)),
    issue.html_url.replaceAll("/", "&amp;sol;"), issue.html_url.replace("github", "git\u200bh\u202eub"),
    [...issue.html_url].map(char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join(""),
    issue.html_url.replace("issues/", "issues%FF%2F"), `[target](${issue.html_url})`, `[target](<${issue.html_url}>)`];
  for (const reference of references) {
    const result = matchImportedIssue([{ id: "local", body: `Issue: ${reference}` }], issue);
    assert.equal(result.via, reference.includes("%FF") ? "new" : "citation", reference);
  }
  for (const body of [`Issue: [target][issue]\n\n[issue]: ${issue.html_url}`, `Issue: [issue][]\n\n[issue]: <${issue.html_url}>`,
    `Issue: [issue]\n\n[issue]: ${issue.html_url}`, `Issue: ${issue.html_url}\n\n[unused] text`, `Issue: ${issue.html_url}\r\n\r\nContext`, `Issue:\n${issue.html_url}`]) {
    assert.equal(matchImportedIssue([{ id: "local", body }], issue).via, "citation", body);
  }
  for (const other of ["https://github.com/other/widgets/issues/3\n1", "https://github.com/other/\nwidgets/issues/30",
    "https://github.com/other/widgets/issues&#x2f;31", "[other/widgets#31](https://github.com/acme/widgets/issues/30)",
    "https://github.com/acme/widgets/pull/30", "https://github.com/acme/widgets", "https://github.com/other/widgets/issues%FF%2F31"]) {
    const result = matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30`, body: other }], issue);
    assert.equal(result.via, "new", other);
    assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "multiple_issues" }]);
  }
  const deeplyEncoded = "&" + "amp;".repeat(12) + "sol;31";
  const result = matchImportedIssue([{ id: "local", description: `Fixes ${repo}#30`, body: `issues${deeplyEncoded}` }], issue);
  assert.equal(result.via, "new");
  assert.deepEqual(result.citation_candidates, [{ id: "local", reason: "normalization_limit" }]);
});

test("normalized allowlist fuzz rejects random repository, number, decoration and encoding second references", t => {
  let seed = 0x53ce71a9;
  /** Reproduce encoded, decorated second-reference samples on Node and Bun. */
  const next = (bound: number): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const encoders = [(value: string) => value, (value: string) => value.replaceAll("/", "&sol;"),
    (value: string) => value.replaceAll("/", "&#47;"), (value: string) => value.replaceAll("/", "&#x2f;"),
    (value: string) => encodeURIComponent(value), (value: string) => value.replaceAll("/", "%2F"),
    (value: string) => [...value].map(char => `&#${char.codePointAt(0)!};`).join(""),
    (value: string) => [...value].join("\u200b\u202e"), (value: string) => value.replace("/issues/", "/issues/\n")];
  const wrappers = [["**", "**"], ["*", "*"], ["__", "__"], ["_", "_"], ["`", "`"], ["```text\n", "\n```"],
    ["<", ">"], ["[reference](", ")"], ["![reference](", ")"], ["~~", "~~"], ["\\*", "\\*"], ["> ", "\n"]];
  for (let sample = 0; sample < 4096; sample++) {
    const sourceRepo = next(2) ? repo : `owner-${next(10000)}/repo-${next(10000)}`;
    const number = sourceRepo === repo ? 31 + next(10000) : next(2) ? 30 : 31 + next(10000);
    const references = [`https://github.com/${sourceRepo}/issues/${number}`, `https://github.com/${sourceRepo}/pull/${number}`,
      `${sourceRepo}#${number}`, `#${number}`, `issues/${number}`, `pull/${number}`];
    let other = references[next(references.length)]!;
    const layers = 1 + next(3);
    for (let layer = 0; layer < layers; layer++) other = encoders[next(encoders.length)]!(other);
    const depth = 1 + next(5);
    for (let layer = 0; layer < depth; layer++) {
      const [left, right] = wrappers[next(wrappers.length)]!;
      other = left + other + right;
    }
    for (const field of ["title", "description", "body"] as const) {
      const local = { id: "local", title: "Local fix", description: `Fixes ${repo}#30`, body: "" };
      local[field] += ` and ${other}`;
      const result = matchImportedIssue([local], issue);
      assert.equal(result.via, "new", `seed 0x53ce71a9, sample ${sample}, ${field}: ${other}`);
      assert.equal(result.citation_candidates?.[0]?.id, "local");
    }
  }
  t.diagnostic("seed 0x53ce71a9: 4096 encoded decoration samples, 12288 field cases");
});

test("issue-label URL tails keep the anchored tail grammar after the regex tail was replaced by linear trimming", () => {
  for (const tail of ["", "/", ">", ">.", ")", ").", "> \t", "?q=1).", "#issuecomment-1)>"]) {
    const local = { id: "local", body: `Issue: ${issue.html_url}${tail}` };
    assert.equal(matchImportedIssue([local], issue).item, local, `tail ${JSON.stringify(tail)}`);
  }
  for (const tail of [" .", ">>", "x", ") x"]) {
    assert.equal(matchImportedIssue([{ id: "local", body: `Issue: ${issue.html_url}${tail}` }], issue).item, undefined, `tail ${JSON.stringify(tail)}`);
  }
  const started = performance.now();
  const hostile = { id: "hostile", body: `Issue: ${issue.html_url}${")".repeat(50_000)}x` };
  assert.equal(matchImportedIssue([hostile], issue).item, undefined);
  assert.ok(performance.now() - started < 1_000, "a long run of ')' must not backtrack polynomially");
});

test("citation adoption never overwrites an item that already carries structured ownership", () => {
  const owned = [
    { id: "url", description: `Fixes ${repo}#30`, github_url: "https://github.com/acme/widgets/issues/31" },
    { id: "number", description: `Fixes ${repo}#30`, github_number: 31 },
    { id: "links", description: `Fixes ${repo}#30`, external_links: ["https://github.com/acme/widgets/issues/31"] },
    { id: "ref", description: `Fixes ${repo}#30`, external_ref: "gh:acme/widgets#31" },
    { id: "linear", description: `Fixes ${repo}#30`, external_ref: "linear:ENG-31" },
    { id: "source-owner", description: `Fixes ${repo}#30`, source_owner: "linear", status: "closed" },
    { id: "provider-field", description: `Fixes ${repo}#30`, jira_issue_key: "ENG-31" },
    { id: "github-field", description: `Fixes ${repo}#30`, github_state: "closed" },
    { id: "githuburl", description: `Fixes ${repo}#30`, githuburl: "https://github.com/acme/widgets/issues/31" },
    { id: "not-link-only", description: `Fixes ${repo}#30`, github_link_only: false },
  ];
  for (const item of owned) {
    const result = matchImportedIssue([item], issue);
    assert.equal(result.item, undefined, item.id);
    assert.deepEqual(result.citation_candidates, [{ id: item.id, reason: "structured_owner" }], item.id);
  }
  const native = { id: "native", description: "GitHub issue https://github.com/acme/widgets/issues/31", title: `Fix ${repo}#30` };
  assert.equal(matchImportedIssue([native], issue).item, undefined);
  const docs = { id: "docs", description: `Fixes ${repo}#30`, links: ["https://example.com/design"] };
  assert.equal(matchImportedIssue([docs], issue).item, docs);
});

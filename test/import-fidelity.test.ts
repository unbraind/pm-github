/** Recorded consumer regressions exercised through real temporary PM trackers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { get, create, update, WorkspaceTransactionInterruptedError, deleteItem, readHistorySnapshot, getHistoryPath, listAllComplete, certifyCompleteListResult, commitImportedItem, getItemPath, readSettings } from "@unbrained/pm-cli/sdk";
import { importGithubAtomic, parseImportOptions, runImport, type GhIssue, type PreparedGithubImport, type AtomicImportOptions } from "../index.ts";
import { buildImportFidelity, fetchImportTimeline, importCloseReason, matchImportedIssue, readImportReleases, persistImportFidelity, selectImportContextIndex } from "../import-fidelity.ts";
import { captureStderr, jsonResponse, withEnv, withMockGithub } from "./helpers/mock-github-server.ts";

const root = join(import.meta.dirname, "..");
const fixtures = join(import.meta.dirname, "fixtures/import-fidelity");
const cli = join(root, "node_modules/.bin/pm");
/** Read projected public API fixtures, retaining source lifecycle values verbatim. */
function recorded(name: string): GhIssue { return JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8")) as GhIssue; }
/** Run a bounded command without inheriting the developer's Git identity. */
function command(cwd: string, bin: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
/** Give every scenario an actual Git repository and a real initialized tracker. */
async function tracker(run: (directory: string, pmRoot: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pm-import-fidelity-"));
  const pmRoot = join(directory, ".agents/pm");
  try {
    command(directory, "git", ["init", "-q", "-b", "main"]);
    command(directory, cli, ["--path", pmRoot, "init", "fixture"]);
    await withEnv({ PM_PATH: pmRoot, PM_AUTHOR: "fixture", GITHUB_TOKEN: "fixture",
      PATH: join(root, "node_modules/.bin") + delimiter + process.env.PATH }, () => run(directory, pmRoot));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
/** Certify complete SDK reads without spawning another CLI for assertions. */
async function listItems(pmRoot: string) {
  const result = await listAllComplete({}, { pmRoot, noExtensions: true });
  certifyCompleteListResult(result);
  return result.items;
}
/** Seed identity metadata through the real SDK without adding import provenance tags. */
async function identityItem(pmRoot: string, fields: Record<string, unknown>) {
  const item = (await create({ title: "Existing local item", type: "Task", status: "in_progress" }, { pmRoot })).item;
  await commitImportedItem({ pmRoot, id: item.id, itemPath: getItemPath(pmRoot, "Task", item.id),
    document: { metadata: { ...item, ...fields }, body: "Local context" }, settings: await readSettings(pmRoot),
    author: "fixture", message: "Seed identity fixture", conflictWarningPrefix: "fixture" });
  return (await get(item.id, {}, { pmRoot })).item;
}
/** Replay recorded REST responses through the normal HTTP importer without SDK mocks. */
async function importing(pmRoot: string, issue: GhIssue, atomic: boolean, dryRun = false, timeline?: unknown[], onTransition?: AtomicImportOptions["onTransition"]) {
  const name = issue.html_url.split("/").slice(3, 5).join("/");
  return withMockGithub((request, response) => {
    if (request.url === "/graphql") jsonResponse(response, 200, timeline ? { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } } : JSON.parse(readFileSync(join(fixtures, `${name.split("/")[1]}-${issue.number}-graphql.json`), "utf8")));
    else if (request.url?.includes("/timeline")) jsonResponse(response, 200, timeline ?? JSON.parse(readFileSync(join(fixtures, `${name.split("/")[1]}-${issue.number}-timeline.json`), "utf8")));
    else jsonResponse(response, 200, [issue]);
  }, async () => {
    const captured = await captureStderr(() => runImport(name, pmRoot,
      parseImportOptions({ state: "all", gate: true, atomic, "dry-run": dryRun }),
      { fetchIssueTimeline: fetchImportTimeline,
        ...(onTransition ? { commitAtomic: (root, repo, entries) => importGithubAtomic(root, repo, entries, { onTransition }) } : {}) }));
    return captured.result as Record<string, unknown>;
  });
}

for (const atomic of [false, true]) {
  for (const [fixtureIndex, name] of ["pm-beads-85", "pm-brief-135", "pm-brief-84", "pm-context-81", "pm-csv-86", "pm-csv-134", "pm-slack-standup-45"].entries()) {
    if (atomic !== (fixtureIndex % 2 === 1)) continue;
    test(`${name}: ${atomic ? "atomic" : "plain"} import preserves real lifetimes and honest closure wording`, async () => tracker(async (_directory, pmRoot) => {
      const issue = recorded(name);
      const checkRetry = fixtureIndex < 2;
      if (checkRetry) {
        await create({ title: "Legacy source snapshot", type: "Issue", status: "closed", closeReason: "Legacy generic closure",
          tags: `gh:${issue.html_url.split("/").slice(3, 5).join("/")}#${issue.number}` }, { pmRoot });
        const beforePreview = (await listItems(pmRoot));
        const preview = await importing(pmRoot, issue, atomic, true);
        const plan = (preview.plan as Array<Record<string, unknown>>)[0]!;
        assert.equal(plan.github_created_at, issue.created_at);
        assert.equal(plan.github_closed_at, issue.closed_at);
        assert.deepEqual((await listItems(pmRoot)), beforePreview);
      }
      await importing(pmRoot, issue, atomic);
      const local = (await listItems(pmRoot))[0]!;
      const item = (await get(local.id!, {}, { pmRoot })).item;
      assert.equal(item.created_at, issue.created_at);
      assert.ok(Date.parse(item.updated_at!) >= Date.parse(issue.updated_at));
      assert.equal(item.closed_at, issue.closed_at);
      assert.equal(item.completed_at, issue.closed_at);
      assert.ok(Date.parse(item.closed_at!) >= Date.parse(item.created_at));
      assert.match(item.close_reason!, /^Closed on GitHub as completed on /);
      if (name === "pm-brief-135") assert.match(item.close_reason!, /closing PR https:\/\/github.com\/unbraind\/pm-brief\/pull\/137/);
      assert.doesNotMatch(item.close_reason!, /fixed|remediated/i);
      assert.equal(item.github_state, "closed");
      assert.equal(item.github_updated_at, issue.updated_at);
      const history = await readHistorySnapshot(getHistoryPath(pmRoot, local.id!), local.id!);
      assert.ok(history.entries.length >= 3);
      assert.equal(history.entries.at(-1)!.op, "import");
      if (checkRetry) {
        await importing(pmRoot, issue, atomic);
        assert.equal((await listItems(pmRoot)).length, 1);
        assert.equal((await get(local.id!, {}, { pmRoot })).item.created_at, issue.created_at);
      }
    }));
  }

  test(`pm-csv-72: ${atomic ? "atomic" : "plain"} conflicting GitHub-owned record refreshes state and lifecycle together`, async () => tracker(async (_directory, pmRoot) => {
    const issue = recorded("pm-csv-72");
    const item = (await create({ title: issue.title, type: "Issue", status: "open", tags: "gh:unbraind/pm-csv#72" }, { pmRoot })).item;
    const preview = await importing(pmRoot, issue, atomic, true);
    assert.deepEqual(((preview.plan as Array<{ identity: { conflict: unknown } }>)[0]!).identity.conflict,
      { local: "open", github: "closed", rule: "github-source-wins" });
    await importing(pmRoot, issue, atomic);
    const actual = (await get(item.id, {}, { pmRoot })).item;
    assert.equal(actual.status, "closed");
    assert.equal(actual.github_state, "closed");
    assert.equal(actual.github_updated_at, issue.updated_at);
    assert.equal(actual.created_at, issue.created_at);
    const reopened = { ...issue, state: "open" as const, state_reason: "reopened" as const, closed_at: null };
    await importing(pmRoot, reopened, atomic);
    const open = (await get(item.id, {}, { pmRoot })).item;
    assert.equal(open.status, "open");
    assert.equal(open.closed_at, undefined);
    assert.equal(open.completed_at, undefined);
    assert.equal(open.close_reason, undefined);
    assert.equal(open.github_state, "open");
  }));

  test(`pm-linear-134: ${atomic ? "atomic" : "plain"} links an existing provider owner and preserves export identity`, async () => tracker(async (_directory, pmRoot) => {
    const issue = recorded("pm-linear-134");
    const owner = { id: "fixture-owner", description: "[linear] linear_id=fixture-provider-id linear_url=https://linear.app/fixture/issue/ENG-134", title: "Provider owner", type: "Task", status: "in_progress", priority: 2 as const,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", tags: ["linear"] };
    const committed = await commitImportedItem({ pmRoot, id: owner.id, itemPath: getItemPath(pmRoot, "Task", owner.id),
      document: { metadata: owner, body: "Keep provider context" }, settings: await readSettings(pmRoot),
      author: "fixture", message: "Recorded provider owner", conflictWarningPrefix: "fixture" });
    assert.equal(committed.committed, true);
    const before = (await get(owner.id, {}, { pmRoot })).item;
    await importing(pmRoot, issue, atomic);
    const items = (await listItems(pmRoot));
    assert.equal(items.length, 1);
    const actual = (await get(owner.id, {}, { pmRoot })).item;
    assert.equal(actual.title, "Provider owner");
    assert.equal(actual.status, "in_progress");
    assert.equal(actual.created_at, before.created_at);
    assert.ok(Date.parse(actual.updated_at!) >= Date.parse(before.updated_at!));
    assert.equal(actual.closed_at, undefined);
    assert.ok(actual.tags?.includes("linear"));
    assert.ok(before.tags?.every(tag => actual.tags?.includes(tag)));
    assert.equal(actual.description, before.description);
    const plan = (await importing(pmRoot, issue, atomic, true)).plan as Array<Record<string, unknown>>;
    assert.equal(plan[0]!.action, "link");
    assert.equal((plan[0]!.identity as { via: string }).via, "provider-link");
  }));

  test(`description mentions never adopt or block another issue (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    const issue = recorded("pm-linear-134");
    const owners = await Promise.all(["Blocked by", "See also"].map(text => identityItem(pmRoot, {
      description: `${text} ${issue.html_url}#issuecomment-1`, body_url: issue.html_url,
      source_description: issue.html_url, unrelated_url: issue.html_url,
    })));
    await importing(pmRoot, issue, atomic);
    const items = await listItems(pmRoot);
    assert.equal(items.length, 3);
    for (const owner of owners) assert.deepEqual((await get(owner.id, {}, { pmRoot })).item, owner);
    const imported = items.find(item => item.github_url === issue.html_url)!;
    assert.equal(imported.status, "closed");
    assert.ok(imported.tags?.includes("gh:unbraind/pm-linear#134"));
  }));

  test(`URL-only GitHub owner refreshes native lifecycle and release (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    const issue = recorded("pm-csv-72");
    const owner = await identityItem(pmRoot, { github_url: issue.html_url, release: "stale-release" });
    const preview = await importing(pmRoot, issue, atomic, true);
    const plan = (preview.plan as Array<{ identity: { via: string; linkOnly: boolean } }>)[0]!;
    assert.equal(plan.identity.via, "github-url");
    await importing(pmRoot, issue, atomic);
    assert.equal((await listItems(pmRoot)).length, 1);
    const actual = (await get(owner.id, {}, { pmRoot })).item;
    assert.equal(actual.status, "closed");
    assert.equal(actual.created_at, issue.created_at);
    assert.equal(actual.closed_at, issue.closed_at);
    assert.equal(actual.completed_at, issue.closed_at);
    assert.equal(actual.release, undefined);
    assert.equal(actual.github_link_only, false);
    assert.match(actual.close_reason!, /^Closed on GitHub/);
  }));
}

for (const mode of ["plain", "gate", "atomic"] as const) {
  test(`ambiguous later issue documents write boundary (${mode})`, async () => tracker(async (_directory, pmRoot) => {
    const second = { ...recorded("pm-csv-72"), state: "open" as const, closed_at: null };
    const first = { ...second, number: 1, html_url: "https://github.com/unbraind/pm-csv/issues/1", title: "Earlier issue" };
    await identityItem(pmRoot, { github_url: second.html_url });
    await identityItem(pmRoot, { github_url: second.html_url });
    const before = await listItems(pmRoot);
    await assert.rejects(captureStderr(() => runImport("unbraind/pm-csv", pmRoot,
      parseImportOptions({ state: "all", gate: mode === "gate", atomic: mode === "atomic" }),
      { fetchIssues: async () => [first, second], resolveToken: () => undefined })), /multiple existing owners/);
    const after = await listItems(pmRoot);
    if (mode === "plain") {
      assert.equal(after.length, before.length + 1);
      assert.equal(after.find(item => item.github_url === first.html_url)?.title, first.title);
    } else assert.deepEqual(after, before);
  }));
}

test("empty filtered gated selections omit plan for preview and apply", async () => tracker(async (_directory, pmRoot) => {
  for (const dryRun of [false, true]) {
    const result = await captureStderr(() => runImport("unbraind/pm-csv", pmRoot,
      parseImportOptions({ gate: true, "dry-run": dryRun, "skip-drafts": true, "include-prs": true }),
      { fetchIssues: async () => [{ ...recorded("pm-csv-72"), draft: true, pull_request: {} }], resolveToken: () => undefined }));
    assert.equal(Object.hasOwn(result.result, "plan"), false);
    assert.equal((await listItems(pmRoot)).length, 0);
  }
}));

test("release fixture: two actual tags place closures before, between and after their actual dates", async () => tracker(async (directory, pmRoot) => {
  command(directory, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"],
    { GIT_AUTHOR_DATE: "2026-09-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T12:00:00Z" });
  command(directory, "git", ["tag", "v2026.9.1"]);
  command(directory, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "tag", "-a", "v2026.9.15", "-m", "fixture"], { GIT_COMMITTER_DATE: "2026-09-15T12:00:00Z" });
  const releases = readImportReleases(pmRoot);
  assert.equal(releases.length, 2);
  for (const [number, date, release] of [[1, "2026-08-31T12:00:00Z", "v2026.9.1"], [2, "2026-09-10T12:00:00Z", "v2026.9.15"], [3, "2026-09-16T12:00:00Z", ""]] as const) {
    const issue = { ...recorded("pm-context-81"), number, title: `Window ${number}`, closed_at: date, updated_at: date, html_url: `https://github.com/unbraind/pm-context/issues/${number}` };
    await importing(pmRoot, issue, true, false, []);
    const item = (await get((await listItems(pmRoot)).find(item => item.title === issue.title)!.id!, {}, { pmRoot })).item;
    assert.equal(item.release ?? "", release);
  }
  const payload = JSON.stringify({ items: (await listItems(pmRoot)) });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "2026.9.16" }));
  const result = spawnSync(process.execPath, [join(root, "node_modules/pm-changelog/dist/cli.js"), "--stdin", "--all-release-tags", "--respect-item-release", "--stdout"], { cwd: directory, input: payload, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## (?:v)?2026\.9\.1[\s\S]*Window 1/);
  assert.match(result.stdout, /## (?:v)?2026\.9\.15[\s\S]*Window 2/);
  const unreleased = result.stdout.split(/^## /m)[1]!;
  assert.match(unreleased, /Window 3/);
  assert.doesNotMatch(unreleased, /Window [12]/);
}));

test("identity accepts nested GitHub links, provider back-links, exact URLs and refuses competing owners", () => {
  const issue = recorded("pm-linear-134");
  for (const provider of ["linear", "jira", "ado"]) {
    const value = matchImportedIssue([{ id: "owner", [`${provider}_url`]: "https://linear.app/fixture/issue/ENG-134" }], issue);
    assert.equal(value.item?.id, "owner");
    assert.equal(value.linkOnly, true);
    assert.equal(matchImportedIssue([{ id: "owner", tags: [`${provider}:fixture`], external_links: [{ url: "https://linear.app/fixture/issue/ENG-134" }] }], issue).item?.id, "owner");
    assert.equal(matchImportedIssue([{ id: "owner", [`${provider}_id`]: "fixture", url: "https://linear.app/fixture/issue/ENG-134" }], issue).item?.id, "owner");
  }
  assert.equal(matchImportedIssue([{ id: "owner", description: "[linear] linear_id=fixture linear_url=https://linear.app/fixture/issue/ENG-134" }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", description: "Jira EX-134: https://linear.app/fixture/issue/ENG-134" }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", body: "ado_id=134 ado_url=https://linear.app/fixture/issue/ENG-134" }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", ado_id: 134, provenance: { url: issue.html_url } }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", github_url: `${issue.html_url}?view=all#issuecomment-1` }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", external_links: [{ url: issue.html_url }] }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", GitHubURL: issue.html_url }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", provenance: { provider: "pm-linear", url: "https://linear.app/fixture/issue/ENG-134" } }], issue).item?.id, "owner");
  assert.equal(matchImportedIssue([{ id: "owner", provider: "pm-jira", external_url: "https://bugs.example.test/EX-1" }], { ...issue, body: "Mirrored from https://bugs.example.test/EX-1" }).item?.id, "owner");
  const githubOwner = { id: "github-owner", tags: ["gh:unbraind/pm-linear#134", "linear:documentation"], github_url: issue.html_url,
    github_link_only: false, body: "Example: [linear] linear_id=sample linear_url=https://linear.app/fixture/issue/ENG-134",
    linear_id: null, jira_url: "", ado_key: "   ", linear_status: "open", source: undefined };
  assert.equal(matchImportedIssue([githubOwner], issue, githubOwner).linkOnly, false);
  const documentation = { ...githubOwner, source: "https://docs.example.test/?provider=linear" };
  assert.equal(matchImportedIssue([documentation], issue, documentation).linkOnly, false);

  const adopted = { ...githubOwner, description: "[linear] linear_id=fixture linear_url=https://linear.app/fixture/issue/ENG-134" };
  assert.equal(matchImportedIssue([adopted], issue, adopted).linkOnly, true);


  assert.equal(matchImportedIssue([{ id: "unrelated", links: `${issue.html_url}0` }], issue).item, undefined);
  assert.throws(() => matchImportedIssue([{ id: "one", links: issue.html_url }, { id: "two", links: issue.html_url }], issue), /multiple existing owners/);
});

test("identity excludes descriptions even when multiple items mention another issue", () => {
  const issue = recorded("pm-linear-134");
  const references = ["one", "two"].map(id => ({ id, description: `Blocked by ${issue.html_url}#issuecomment-1`,
    body: issue.html_url, source_description: issue.html_url, unrelated_url: issue.html_url }));
  assert.doesNotThrow(() => matchImportedIssue(references, issue));
  assert.deepEqual(matchImportedIssue(references, issue), { item: undefined, linkOnly: false, via: "new" });
  const owner = { id: "owner", github_url: issue.html_url };
  assert.equal(matchImportedIssue([...references, owner], issue).item, owner);
  assert.throws(() => matchImportedIssue([owner, { ...owner, id: "competitor" }], issue), /multiple existing owners/);
});

test("identity classifies URL-only GitHub owners for lifecycle refresh", () => {
  const issue = recorded("pm-csv-72");
  const owner = { id: "owner", github_url: issue.html_url };
  assert.deepEqual(matchImportedIssue([owner], issue), { item: owner, linkOnly: false, via: "github-url" });
  assert.equal(matchImportedIssue([{ ...owner, github_link_only: true }], issue).linkOnly, true);
});

test("closure evidence ignores unrelated links, honors latest closure commits and preserves every state reason", () => {
  const issue = recorded("pm-beads-85");
  const commit = "a".repeat(40);
  const foreign = { event: "closed", created_at: issue.closed_at, commit_id: "a".repeat(40), commit_url: `https://api.github.com/repos/example/fix/commits/${"a".repeat(40)}` };
  assert.match(importCloseReason(issue, [foreign]), /closing commit https:\/\/github.com\/example\/fix\/commit\//);
  assert.match(importCloseReason(issue, [{ ...foreign, commit_url: "https://example.invalid/commit" }]), /unbraind\/pm-beads\/commit\//);
  assert.match(importCloseReason(issue, [{ ...foreign, commit_id: "b".repeat(40) }]), /unbraind\/pm-beads\/commit\//);

  assert.match(importCloseReason(issue, [{ event: "closed", created_at: issue.closed_at, commit_id: commit }]), /closing commit .*\/commit\/a{40}/);
  assert.match(importCloseReason(issue, [{ event: "connected", created_at: issue.closed_at, url: "https://github.com/unbraind/pm-beads/pull/1" }]), /linked PR/);
  assert.doesNotMatch(importCloseReason(issue, [{ event: "closed", created_at: issue.created_at, commit_id: commit }, null]), /closing commit/);
  for (const state_reason of ["not_planned", "duplicate", "completed", "reopened", null] as const) {
    assert.ok(buildImportFidelity({ ...issue, state_reason }, [], []).github_close_reason.includes(state_reason ?? "unspecified"));
  }
  assert.throws(() => buildImportFidelity({ ...issue, closed_at: "2000-01-01T00:00:00Z" }, [], []), /invalid source lifetime/);
});

test("closure evidence accepts forward skew and never borrows an older closure generation", async () => {
  const issue = recorded("pm-beads-85");
  const timestamp = (delta: number) => new Date(Date.parse(issue.closed_at!) + delta).toISOString();
  const commit = "d".repeat(40);
  const rest = { event: "closed", created_at: timestamp(1000), commit_id: commit };
  const graph = { __typename: "ClosedEvent", createdAt: timestamp(1000),
    closer: { url: "https://github.com/example/project/pull/42", title: "Current fix" } };
  assert.match(importCloseReason(issue, [rest]), /closing commit/);
  assert.match(importCloseReason(issue, [graph]), /closing PR .*42/);
  assert.match(importCloseReason(issue, [{ ...rest, created_at: timestamp(5000) }]), /closing commit/);
  for (const delta of [-1000, 5001]) {
    assert.doesNotMatch(importCloseReason(issue, [{ ...rest, created_at: timestamp(delta) }, { ...graph, createdAt: timestamp(delta) }]), /closing (commit|PR)/);
  }
  // Reverse chronological input still selects the newest candidate; null closers
  // on that candidate cannot borrow a commit or PR from an earlier generation.
  const latestRest = { ...rest, created_at: timestamp(2000), commit_id: null };
  const latestGraph = { ...graph, createdAt: timestamp(2000), closer: null };
  assert.doesNotMatch(importCloseReason(issue, [latestRest, rest, latestGraph, graph]), /closing (commit|PR)/);
  assert.match(importCloseReason(issue, [latestRest, rest, graph]), /closing PR .*42/);
  assert.doesNotMatch(importCloseReason(issue, [{ event: "closed" }, { ...rest, created_at: "invalid" },
    { ...graph, createdAt: "invalid" }]), /closing (commit|PR)/);
  assert.doesNotMatch(importCloseReason({ ...issue, closed_at: null }, [rest, graph]), /closing (commit|PR)/);
  for (const events of [[rest], [latestRest, rest], [{ ...rest, created_at: timestamp(-1000) }], [{ ...rest, commit_id: "bad" }],
    [null, [], 1, { ...rest, event: "referenced" }]]) {
    let graphRequests = 0;
    await withMockGithub((request, response) => {
      if (request.url === "/graphql") {
        graphRequests++;
        jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: {
          nodes: [graph], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
      } else jsonResponse(response, 200, events);
    }, async () => {
      const timeline = await fetchImportTimeline(issue, "example/project", "fixture");
      assert.equal(graphRequests, events[0] === rest ? 0 : 1);
      assert.match(importCloseReason(issue, timeline), events[0] === rest ? /closing commit/ : /closing PR .*42/);
    });
  }
});

test("timeline transport paginates REST and GraphQL, rejects unavailable or malformed evidence", async () => {
  const issue = recorded("pm-beads-85");
  assert.deepEqual(await fetchImportTimeline({ ...issue, state: "open" }, "example/project"), []);
  await withMockGithub((request, response, body, base) => {
    if (request.url === "/graphql") {
      const parsed = JSON.parse(body) as { variables: { cursor: string | null } };
      jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: {
        nodes: parsed.variables.cursor ? [{ __typename: "ClosedEvent", createdAt: issue.closed_at, closer: null }] : [],
        pageInfo: { hasNextPage: !parsed.variables.cursor, endCursor: "next" },
      } } } } });
    } else jsonResponse(response, 200, [], request.url?.includes("page=2") ? {} : { Link: `<${base}/timeline?page=2>; rel="next"` });
  }, async server => {
    assert.equal((await fetchImportTimeline(issue, "example/project", "fixture")).length, 1);
    assert.equal(server.requests.length, 4);
  });
  await withMockGithub((_request, response) => jsonResponse(response, 200, [{ event: "closed", created_at: issue.closed_at, commit_id: "b".repeat(40) }]), async server => {
    assert.equal((await fetchImportTimeline(issue, "example/project", "fixture")).length, 1);
    assert.equal(server.requests.length, 1);
  });
  for (const [status, payload, expected] of [[201, [], /Could not read/], [404, [], /HTTP 404/], [200, {}, /Invalid closure/]] as const) {
    await withMockGithub((_request, response) => jsonResponse(response, status, payload), async () => {
      await assert.rejects(fetchImportTimeline(issue, "example/project"), expected);
    });
  }
  await withMockGithub((_request, response) => { response.writeHead(200); response.end("invalid"); }, async () => {
    await assert.rejects(fetchImportTimeline(issue, "example/project"), /not valid JSON/);
  });
  await withMockGithub((_request, response) => jsonResponse(response, 200, []), async () => {
    assert.deepEqual(await fetchImportTimeline(issue, "example/project"), []);
  });
  for (const data of [{}, { repository: {} }, { repository: { issue: { timelineItems: { nodes: null } } } },
    { repository: { issue: { timelineItems: { nodes: [], pageInfo: {} } } } }]) {
    await withMockGithub((request, response) => jsonResponse(response, 200, request.url === "/graphql" ? { data } : []), async () => {
      await assert.rejects(fetchImportTimeline({ ...issue, pull_request: {} }, "example/project", "fixture"), /Invalid GraphQL/);
    });
  }
});

test("closure and identity edge cases retain exact evidence rather than inventing fixes", () => {
  const issue = recorded("pm-beads-85");
  const commit = "c".repeat(40);
  for (const closer of [{ url: `https://github.com/example/project/commit/${commit}`, messageHeadline: "Repair parser" },
    { url: "https://github.com/example/project/pull/5" }]) {
    assert.match(importCloseReason(issue, [{ __typename: "ClosedEvent", createdAt: issue.closed_at, closer }]), /closing (PR|commit)/);
    assert.match(importCloseReason(issue, [{ __typename: "ConnectedEvent", createdAt: issue.created_at, subject: closer }]), /linked (PR|commit)/);
  }
  assert.doesNotMatch(importCloseReason(issue, [{ createdAt: issue.closed_at, __typename: "UnknownEvent", closer: {} },
    { createdAt: issue.closed_at, __typename: "ClosedEvent", closer: { url: "https://example.invalid/unrelated" } },
    ...[{}, "value", { url: 1 }].map(closer => ({ createdAt: issue.closed_at, __typename: "ClosedEvent", closer })),
    { event: "closed", created_at: issue.closed_at, commit_id: "bad" },
    ...[{}, { url: 1 }, { url: "https://example.invalid/unrelated" }].map(fields => ({ event: "connected", created_at: issue.closed_at, ...fields })),
    [], 1, null]), /closing/);
  assert.match(importCloseReason({ ...issue, closed_at: null, state_reason: null }, []), /unspecified on an unknown date/);
  for (const override of [{ created_at: "bad" }, { updated_at: "bad" }, { updated_at: "2000-01-01" }, { closed_at: "bad" }, { closed_at: "2099-01-01" }]) {
    assert.throws(() => buildImportFidelity({ ...issue, ...override }, [], []), /invalid source lifetime/);
  }
  assert.equal(buildImportFidelity({ ...issue, closed_at: null }, [], []).github_closed_at, "");
  assert.equal(buildImportFidelity({ ...issue, state: "open", state_reason: null }, [], []).github_state_reason, "unspecified");
  const tagged = { id: "tagged", tags: ["gh:unbraind/pm-beads#85"] };
  assert.equal(matchImportedIssue([tagged], issue, tagged).linkOnly, false);
  assert.equal(matchImportedIssue([{ id: "tagged", github_link_only: true }], issue, tagged).linkOnly, true);
  assert.equal(matchImportedIssue([{ id: "provider", github_url: issue.html_url, tags: ["jira:EX-1"] }], issue).via, "provider-link");
  assert.equal(matchImportedIssue([{ links: [issue.html_url] }, { id: "other", github_url: undefined, ado_url: undefined }], { ...issue, body: null }).item, undefined);
  assert.deepEqual(readImportReleases(tmpdir()), []);
});

test("finalization appends history, is a true no-op on retry, restores files on append failure and releases locks", async () => tracker(async (_directory, pmRoot) => {
  const item = (await create({ title: "Finalize fixture", type: "Task" }, { pmRoot })).item;
  const fidelity = buildImportFidelity({ ...recorded("pm-beads-85"), state: "open", closed_at: null }, [], []);
  const shortId = item.id.slice((await readSettings(pmRoot)).id_prefix.length);
  await persistImportFidelity(pmRoot, shortId, fidelity, false);
  const historyPath = getHistoryPath(pmRoot, item.id);
  assert.equal((await readHistorySnapshot(historyPath, item.id)).entries.at(-1)!.op, "import");
  const before = readFileSync(historyPath, "utf8");
  await persistImportFidelity(pmRoot, item.id, fidelity, false);
  assert.equal(readFileSync(historyPath, "utf8"), before);
  await assert.rejects(persistImportFidelity(pmRoot, "fixture-missing", fidelity, false), /missing during lifecycle/);
  const backup = `${historyPath}.fixture-backup`;
  renameSync(historyPath, backup);
  mkdirSync(historyPath);
  try {
    await assert.rejects(persistImportFidelity(pmRoot, item.id, { ...fidelity, github_updated_at: "2026-10-01T00:00:00Z" }, false));
  } finally {
    rmSync(historyPath, { recursive: true });
    renameSync(backup, historyPath);
  }
  assert.equal(readFileSync(historyPath, "utf8"), before);
  assert.equal((await get(item.id, {}, { pmRoot })).item.github_updated_at, fidelity.github_updated_at);
  await persistImportFidelity(pmRoot, item.id, fidelity, true);
}));

/** Build a direct import plan from the same recorded lifecycle used by HTTP replays. */
function atomicEntry(issue: GhIssue): PreparedGithubImport {
  return { issueNumber: issue.number, title: issue.title, itemType: "Issue", status: "closed",
    description: `Recorded ${issue.html_url}`, body: issue.body ?? "", tags: [`gh:unbraind/pm-beads#${issue.number}`],
    comments: [], syncAnnotations: false, closedAt: issue.closed_at ?? undefined, fidelity: buildImportFidelity(issue, [], []) };
}

test("real SDK atomic compensation restores an imported source lifecycle and removes new items after finalization", async () => tracker(async (_directory, pmRoot) => {
  const source = recorded("pm-beads-85");
  const initial = atomicEntry(source);
  const result = await importGithubAtomic(pmRoot, "unbraind/pm-beads", [initial]);
  const id = result.itemIds.get(source.number)!;
  const before = (await get(id, {}, { pmRoot })).item;
  const changed = { ...atomicEntry({ ...source, updated_at: "2026-10-01T00:00:00Z" }), title: "Changed title", match: before };
  const added = atomicEntry({ ...source, number: 86, html_url: "https://github.com/unbraind/pm-beads/issues/86" });
  await assert.rejects(importGithubAtomic(pmRoot, "unbraind/pm-beads", [changed, added], {
    onTransition: context => { if (context.transition === "committing") throw new Error("Fixture finalization failure"); },
  }), /no new partial committed state is expected/);
  const after = (await get(id, {}, { pmRoot })).item;
  for (const key of ["title", "created_at", "closed_at", "completed_at", "close_reason", "github_updated_at"]) {
    assert.equal(after[key], before[key], key);
  }
  assert.equal((await listItems(pmRoot)).length, 1);
}));

test("a committed journal with a missing item reports an unsafe recovered finalization rather than claiming compensation", async () => tracker(async (_directory, pmRoot) => {
  const source = recorded("pm-beads-85");
  const entry = atomicEntry(source);
  const result = await importGithubAtomic(pmRoot, "unbraind/pm-beads", [entry]);
  await deleteItem(result.itemIds.get(source.number)!, { force: true }, { pmRoot });
  await assert.rejects(importGithubAtomic(pmRoot, "unbraind/pm-beads", [entry]), /committed journal.*nothing may be pushed/);
}));

for (const atomic of [false, true]) {
  test(`not-planned and duplicate closures retain canceled status and honest reasons (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    const original = recorded("pm-beads-85");
    await importing(pmRoot, { ...original, state_reason: "not_planned" }, atomic);
    const first = (await listItems(pmRoot))[0]!;
    assert.equal(first.status, "canceled");
    assert.equal(first.created_at, original.created_at);
    assert.equal(first.closed_at, original.closed_at);
    assert.equal(first.close_reason, `Closed on GitHub as not_planned on ${original.closed_at}`);
    await importing(pmRoot, { ...original, state: "open", state_reason: null, closed_at: null, updated_at: original.created_at }, atomic);
    for (const state_reason of ["not_planned", "duplicate"] as const) {
      const issue = { ...recorded("pm-beads-85"), state_reason };
      await importing(pmRoot, issue, atomic);
      const item = (await listItems(pmRoot))[0]!;
      assert.equal(item.status, "canceled");
      assert.equal(item.closed_at, issue.closed_at);
      assert.equal(item.close_reason, `Closed on GitHub as ${state_reason} on ${issue.closed_at}`);
    }
    await importing(pmRoot, original, atomic);
    const completed = (await listItems(pmRoot))[0]!;
    assert.equal(completed.status, "closed");
    assert.equal(completed.closed_at, original.closed_at);
    assert.match(completed.close_reason!, /^Closed on GitHub as completed/);
    await importing(pmRoot, { ...original, state: "open", state_reason: "reopened", closed_at: null, updated_at: "2026-10-01T00:00:00Z" }, atomic);
    const reopened = (await listItems(pmRoot))[0]!;
    assert.equal(reopened.status, "open");
    assert.equal(reopened.closed_at, undefined);
    assert.equal(reopened.close_reason, undefined);
  }));
}

for (const atomic of [false, true]) {
  test(`gated closure plans do not echo an unscanned closing PR title (${atomic})`, async () => tracker(async (_directory, pmRoot) => {
    const issue = recorded("pm-beads-85");
    const token = "ghp_" + "A".repeat(36);
    await withMockGithub((request, response) => {
      if (request.url === "/graphql") jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: {
        nodes: [{ __typename: "ClosedEvent", createdAt: issue.closed_at, closer: { url: "https://github.com/example/project/pull/1", title: "Context" + String.fromCharCode(0x2028) + token } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } });
      else jsonResponse(response, 200, request.url?.includes("/timeline") ? [] : [issue]);
    }, async () => {
      const options = { state: "all", atomic, gate: true };
      const preview = await captureStderr(() => runImport("unbraind/pm-beads", pmRoot, parseImportOptions({ ...options, "dry-run": true })));
      assert.ok(!JSON.stringify(preview).includes(token));
      assert.ok("plan" in preview.result);
      const plan = preview.result.plan as { github_close_reason: string }[];
      assert.equal(plan[0]!.github_close_reason, `Closed on GitHub as completed on ${issue.closed_at}; closing PR https://github.com/example/project/pull/1`);
      await assert.rejects(runImport("unbraind/pm-beads", pmRoot, parseImportOptions(options)), /FAIL before write/);
      assert.equal((await listItems(pmRoot)).length, 0);
    });
  }));
}

test("tag-date ordering ignores non-release and undated blob tags and is stable for equal dates", async () => tracker(async (directory, pmRoot) => {
  command(directory, "git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"],
    { GIT_AUTHOR_DATE: "2026-09-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T12:00:00Z" });
  for (const tag of ["v2026.9.2", "v2026.9.1", "other-tag"]) command(directory, "git", ["tag", tag]);
  writeFileSync(join(directory, "blob.txt"), "fixture");
  const blob = command(directory, "git", ["hash-object", "-w", "blob.txt"]).trim();
  command(directory, "git", ["tag", "v2026.1.1", blob]);
  assert.deepEqual(readImportReleases(pmRoot).map(release => release.tag), ["v2026.9.1", "v2026.9.2"]);
}));

test("legacy records without a source closure date retain honest evidence without inventing a closure date", async () => tracker(async (_directory, pmRoot) => {
  const item = (await create({ title: "Legacy fixture", type: "Task", status: "closed", closeReason: "Fixture closure" }, { pmRoot })).item;
  const fidelity = buildImportFidelity({ ...recorded("pm-beads-85"), closed_at: null }, [], []);
  await persistImportFidelity(pmRoot, item.id, fidelity, false);
  const actual = (await get(item.id, {}, { pmRoot })).item;
  assert.equal(actual.closed_at, item.closed_at);
  assert.equal(actual.close_reason, fidelity.github_close_reason);
  assert.equal(actual.github_closed_at, "");
}));


test("a legacy unknown closure cannot put native closure before source creation", async () => tracker(async (_directory, pmRoot) => {
  const item = (await create({ title: "Legacy chronology fixture", type: "Task", status: "closed", closeReason: "Fixture closure" }, { pmRoot })).item;
  const future = new Date(Date.now() + 86400000).toISOString();
  const fidelity = buildImportFidelity({ ...recorded("pm-beads-85"), created_at: future, updated_at: future, closed_at: null }, [], []);
  await assert.rejects(persistImportFidelity(pmRoot, item.id, fidelity, false), /needs a source closure date/);
  assert.equal((await get(item.id, {}, { pmRoot })).item.created_at, item.created_at);
}));

/** Keep the supported legacy atomic plan usable when no source metadata was supplied. */
test("legacy atomic cancellation creates a terminal item with an explicit closure reason", async () => tracker(async (_directory, pmRoot) => {
  const source = recorded("pm-beads-85");
  const entry = { ...atomicEntry(source), status: "canceled", fidelity: undefined };
  const result = await importGithubAtomic(pmRoot, "unbraind/pm-beads", [entry]);
  const item = (await get(result.itemIds.get(source.number)!, {}, { pmRoot })).item;
  assert.equal(item.status, "canceled");
  assert.equal(item.close_reason, `GitHub issue #${source.number} closed`);
  assert.equal((await listItems(pmRoot)).length, 1);
}));

test("local edits invalidate a completed journal while interrupted reconciliation resumes its original plan", async () => tracker(async (_directory, pmRoot) => {
  const issue = recorded("pm-beads-85");
  const first = await importing(pmRoot, issue, true);
  const id = (await listItems(pmRoot))[0]!.id!;
  await update(id, { status: "open", author: "fixture", message: "Local reopen after completed import" }, { pmRoot });
  const preview = await importing(pmRoot, issue, true, true);
  assert.match(JSON.stringify(preview.plan), /github-source-wins/);
  let interruptedId = "";
  await assert.rejects(importing(pmRoot, issue, true, false, undefined, context => {
    if (context.transition === "step_recorded" && context.stepId?.includes("update")) {
      interruptedId = context.transactionId;
      throw new WorkspaceTransactionInterruptedError("Fixture interrupted after governed update");
    }
  }), /journal is resumable/);
  assert.ok(interruptedId);
  assert.notEqual(interruptedId, first.transactionId);
  const resumed = await importing(pmRoot, issue, true);
  assert.equal(resumed.recovered, true);
  assert.equal(resumed.transactionId, interruptedId);
  const item = (await get(id, {}, { pmRoot })).item;
  assert.equal(item.status, "closed");
  assert.equal(item.closed_at, issue.closed_at);
  const before = readFileSync(getHistoryPath(pmRoot, id), "utf8");
  const retry = await importing(pmRoot, issue, true);
  assert.equal(retry.transactionId, interruptedId);
  assert.equal(readFileSync(getHistoryPath(pmRoot, id), "utf8"), before);
  assert.equal((await listItems(pmRoot)).length, 1);
}));

test("history context ignores staging and rollback while recognizing external edits and state cycles", () => {
  const created = { message: "pm-github import create fixture#1", patch: [{ path: "/metadata/status", value: "open" }] };
  const closed = { message: "bulk-item-transaction github-import-first 1-update apply", patch: [{ path: "/metadata/status", value: "closed" }] };
  const finalized = { message: "Preserve GitHub source lifecycle for issue #1", patch: [{ path: "/metadata/github_state", value: "closed" }] };
  const reopened = { message: "bulk-item-transaction github-import-second 1-update apply", patch: [{ path: "/metadata/status", value: "open" }] };
  const restored = { message: "bulk-item-transaction github-import-second 1-update compensate", patch: [{ path: "/metadata/status", value: "open" }] };
  assert.equal(selectImportContextIndex([], "closed"), -1);
  assert.equal(selectImportContextIndex([finalized], "closed"), -1);
  assert.equal(selectImportContextIndex([created, closed, finalized], "closed"), -1);
  assert.equal(selectImportContextIndex([created, closed, finalized, reopened, restored], "closed"), 3);
  assert.equal(selectImportContextIndex([created, closed, finalized, reopened, closed, finalized], "closed"), 3);
  assert.equal(selectImportContextIndex([{ patch: [] }], "closed"), 0);
  assert.equal(selectImportContextIndex([created, { message: "Compensate interrupted bulk transaction github-import-first", patch: [{ path: "/metadata/status" }] }], "closed"), -1);
});

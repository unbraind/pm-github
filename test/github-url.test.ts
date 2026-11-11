/** Markdown extraction and refresh aliases use real SDK trackers and the real HTTP transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { init, create, get, comments, commitImportedItem, readSettings, getItemPath } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { parseBlockerReferences, buildBlockerClearedComment, appendBlockerComments, type BlockersReport } from "../index.ts";
import { githubUrlTokens, parseGithubIssueUrl } from "../github-url.ts";
import { explicitGithubIdentities, importIdentityKeys } from "../import-fidelity.ts";
import { runRefresh, selectRefreshTargets } from "../refresh.ts";
import { withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

const harness = createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
const first = "https://github.com/o/r/issues/1";
const second = "https://github.com/o/r/issues/2";
const wrappers: Array<[string, (url: string) => string]> = [
  ["bold", url => `**${url}**`], ["double underscore", url => `__${url}__`],
  ["star", url => `*${url}*`], ["underscore", url => `_${url}_`],
  ["backticks", url => "`" + url + "`"], ["autolink", url => `<${url}>`],
  ["Markdown link", url => `[text](${url})`], ["parentheses", url => `(${url})`],
  ["nested emphasis", url => `**_${url}_**`], ["double backticks", url => "``" + url + "``"],
];

/** Plain non-git trackers ensure extraction never depends on repository discovery. */
async function tracker(run: (root: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "github-markdown-"));
  const root = join(directory, "tracker");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: directory, noExtensions: true });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", PM_TELEMETRY_SOURCE_CONTEXT: "automation", GITHUB_TOKEN: "fixture-token", GH_TOKEN: undefined,
      PATH: join(import.meta.dirname, "../node_modules/.bin") + delimiter + process.env.PATH }, () => run(root));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Revalidate a real blocked item: #1 is closed, every other queried issue is open. */
async function blockers(root: string, description: string, annotate = false, tags = "") {
  const item = (await create({ title: "Curated blocker", type: "Task", description, status: "blocked", tags }, { pmRoot: root })).item;
  const file = getItemPath(root, "Task", item.id);
  const before = readFileSync(file, "utf8");
  const queried: number[] = [];
  const result = await withMockGithub((request, response, body) => {
    assert.equal(request.url, "/graphql");
    const query = (JSON.parse(body) as { query: string }).query;
    const repository: Record<string, unknown> = {};
    for (const match of query.matchAll(/(i(\d+)_(\d+)): issue\(number:\s*(\d+)\)/g)) {
      const number = Number(match[4]); queried.push(number);
      repository[match[1]!] = { state: number === 1 ? "CLOSED" : "OPEN", stateReason: number === 1 ? "COMPLETED" : null,
        closedAt: number === 1 ? "2025-01-01T00:00:00Z" : null, url: `https://github.com/o/r/issues/${number}` };
      repository[`p${match[2]}_${match[3]}`] = null;
    }
    jsonResponse(response, 200, { data: { r0: repository } });
  }, async () => {
    const outcome = await (await harness).runCommand({ command: "github blockers", options: { repo: "o/r", comment: annotate }, pmRoot: root, global: { json: true } });
    assert.equal(outcome.handled, true, outcome.errorMessage ?? "The real blocker handler must succeed");
    return outcome.result as BlockersReport;
  });
  return { item, result, queried, unchanged: () => readFileSync(file, "utf8") === before };
}

for (const [label, wrap] of wrappers) test(`Markdown wrapper retains every live blocker (${label})`, async () => tracker(async root => {
  assert.equal(githubUrlTokens(wrap(second))[0]!.raw, second);
  assert.equal(githubUrlTokens(wrap(second + "?q=(value)"))[0]!.raw, second + "?q=(value)", "Balanced URL data is not a Markdown delimiter");
  assert.equal(parseGithubIssueUrl(wrap(second)), undefined, "Structured identities never inherit prose unwrapping");
  const { result, queried, unchanged } = await blockers(root, `Blocked by ${first} and ${wrap(second + "!")}`);
  assert.deepEqual(queried, [1, 2]);
  assert.equal(result.items[0]!.references.find(ref => ref.number === 2)?.state, "open");
  assert.equal(result.items[0]!.verdict, "partially_cleared");
  assert.equal(result.counts.cleared, 0);
  assert.equal(unchanged(), true);
}));

for (const punctuation of ".,;:!?") test(`Markdown punctuation retains every live blocker (${punctuation})`, async () => tracker(async root => {
  const { result, queried } = await blockers(root, `Blocked by ${first} and **${second}**${punctuation}`);
  assert.deepEqual(queried, [1, 2]);
  assert.equal(result.items[0]!.references.find(ref => ref.number === 2)?.state, "open");
  assert.equal(result.counts.cleared, 0);
}));

test("Markdown exact mixed-reference reproduction never reports cleared", async () => tracker(async root => {
  const { result, queried } = await blockers(root, "Blocked by https://github.com/o/r/issues/1 and **https://github.com/o/r/issues/2**", true);
  assert.deepEqual(queried, [1, 2]);
  assert.equal(result.items[0]!.references.find(ref => ref.number === 2)?.state, "open");
  assert.equal(result.items[0]!.verdict, "partially_cleared");
  assert.equal(result.comment!.added, 0);
}));

test("Reference tags cannot hide a parsed open Markdown blocker", async () => tracker(async root => {
  const { result, queried, unchanged } = await blockers(root, `Blocked by ${first} and **${second}**`, true, "gh:o/r#2");
  assert.deepEqual(queried, [1, 2]);
  assert.equal(result.items[0]!.references.find(ref => ref.number === 2)?.state, "open");
  assert.equal(result.counts.cleared, 0);
  assert.equal(result.comment!.added, 0);
  assert.equal(unchanged(), true);
}));

for (const url of ["https://github.com/o/r/issues/nope", "https://github.com/o/r/issues/2/extra", "https://github.com/o/r/issues/999999999999999999999",
  "https://api.github.com/repos/o/r/issues/2", "https://example.invalid/opaque", "https://github.com/o/r/issues/nope?target=GH-2#3",
  "https://github.com/o/r/issues/0", "https://github.com/o/r/issues/2*"]) {
  test(`Unparsed URL remains visible and prevents clearance (${url})`, async () => tracker(async root => {
    const { item, result, queried, unchanged } = await blockers(root, `Blocked by ${first} and ${url}`, true);
    assert.deepEqual(queried, [1]);
    const opaque = result.items[0]!.references.find(ref => ref.state === "unparsed");
    assert.ok(opaque);
    assert.equal(opaque.raw, url);
    assert.equal(opaque.number, undefined);
    assert.equal(result.counts.cleared, 0);
    assert.equal(result.items[0]!.verdict, "partially_cleared");
    assert.equal(result.comment!.added, 0);
    assert.throws(() => buildBlockerClearedComment(opaque), /unparsed blocker reference/);
    await assert.rejects(() => appendBlockerComments(root, [{ itemId: item.id, states: [opaque] }], false), /unparsed blocker reference/);
    assert.equal((await comments(item.id, {}, { pmRoot: root })).comments.length, 0);
    assert.equal(unchanged(), true);
    assert.equal(parseBlockerReferences(url).length, 1, "A URL cannot leak shorter references from its path or query");
  }));
}

/** Persist released URL aliases through the SDK importer adapter, retaining curated content. */
async function linked(root: string, alias: string, number: number, kind: "issues" | "pull") {
  const item = (await create({ title: "Curated alias", type: "Chore", description: "Curated description" }, { pmRoot: root })).item;
  const url = `https://github.com/o/r/${kind}/${number}`;
  await commitImportedItem({ pmRoot: root, id: item.id, itemPath: getItemPath(root, "Chore", item.id), settings: await readSettings(root),
    document: { metadata: { ...item, [alias]: url, github_repo: "o/r", github_number: number }, body: "Curated body" },
    author: "fixture", message: "Released alias fixture", conflictWarningPrefix: "fixture" });
  const saved = (await get(item.id, {}, { pmRoot: root })).item;
  assert.equal(saved[alias], url);
  return saved;
}

for (const alias of ["GitHubURL", "githuburl", "GITHUB_URL", "Github_Url", "github_URL"]) test(`Refresh excludes PRs in every explicit URL alias (${alias})`, async () => tracker(async root => {
  const pr = await linked(root, alias, 7, "pull");
  await linked(root, "github_url", 7, "pull");
  await linked(root, alias, 8, "issues");
  assert.equal(explicitGithubIdentities(pr)[0]!.kind, "pull");
  assert.deepEqual(importIdentityKeys(pr), ["o/r#7"]);
  const queried: number[] = [];
  await withMockGithub((request, response, body) => {
    assert.equal(request.url, "/graphql");
    const query = (JSON.parse(body) as { query: string }).query;
    const repository: Record<string, unknown> = {};
    for (const match of query.matchAll(/i(\d+): issue\(number:\s*(\d+)\)/g)) {
      const number = Number(match[2]); queried.push(number);
      repository[`i${number}`] = number === 7 ? null : { number, title: "Remote issue", body: "Remote body", state: "OPEN", stateReason: null,
        createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-02-01T00:00:00Z", closedAt: null, url: `https://github.com/o/r/issues/${number}`, author: null,
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    jsonResponse(response, 200, { data: { repository } });
  }, async () => {
    const result = await runRefresh("o/r", root, { "dry-run": true });
    assert.deepEqual(queried, [8]);
    assert.equal(result.selected, 1);
    assert.equal(result.missing, 0);
  });
  assert.equal((await get(pr.id!, {}, { pmRoot: root })).item.title, "Curated alias");
  // The alias contract is case-insensitive, with or without the underscore.
  for (let bits = 0; bits < 512; bits++) for (const underscore of [false, true]) {
    const letters = [..."githuburl"].map((character, index) => bits & (1 << index) ? character.toUpperCase() : character);
    if (underscore) letters.splice(6, 0, "_");
    const field = letters.join("");
    const record = { id: pr.id!, title: pr.title, [field]: "https://github.com/o/r/pull/7" };
    assert.equal(explicitGithubIdentities(record)[0]!.kind, "pull");
    assert.deepEqual(selectRefreshTargets([record], "o/r"), []);
  }
}));

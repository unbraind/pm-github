import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test from "node:test";
import { comments as readComments, create } from "@unbrained/pm-cli/sdk";
import {
  CommandError, EXIT_CODE, fetchAllIssues, parseImportOptions, parseIssueNumbers,
  readPmItems, runImport, type GhIssue, type GhComment,
} from "../index.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { captureStderr, jsonResponse, nextLinkHeader, withEnv, withMockGithub, type MockGithubHandler } from "./helpers/mock-github-server.ts";

const packageRoot = join(import.meta.dirname, "..");
const cli = join(packageRoot, "node_modules/.bin/pm");
const fixtureRoot = join(import.meta.dirname, "fixtures/import-selection");
const web = JSON.parse(readFileSync(join(fixtureRoot, "pm-web-189.json"), "utf8")) as GhIssue;
const closed = JSON.parse(readFileSync(join(fixtureRoot, "pm-web-96.json"), "utf8")) as GhIssue;
const pr = JSON.parse(readFileSync(join(fixtureRoot, "pm-web-175.json"), "utf8")) as GhIssue;
const slack = JSON.parse(readFileSync(join(fixtureRoot, "pm-slack-standup-113.json"), "utf8")) as GhIssue;
const comments = JSON.parse(readFileSync(join(fixtureRoot, "pm-web-175-comments.json"), "utf8")) as GhComment[];

/** Run setup commands in a real disposable project with explicit tracker routing. */
function setup(root: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 45000,
    env: { ...process.env, PM_PATH: join(root, ".agents/pm"), PM_AUTHOR: "selection-acceptance" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Initialize and clean a real Git tracker, using the installed PM CLI and SDK. */
async function tracker<T>(fn: (root: string, pmRoot: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "pm-github-selection-"));
  try {
    setup(root, "git", ["init", "-q", "-b", "main"]);
    setup(root, cli, ["--path", join(root, ".agents/pm"), "init", "selection-fixture"]);
    return await withEnv({ PM_PATH: join(root, ".agents/pm"), PM_AUTHOR: "selection-acceptance",
      GITHUB_TOKEN: "fixture", PATH: join(packageRoot, "node_modules/.bin") + delimiter + process.env.PATH },
      () => fn(root, join(root, ".agents/pm")));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Replay recorded issue endpoints; a list request is visible and returns extra issues. */
const recorded: MockGithubHandler = (request, response) => {
  const url = request.url ?? "";
  if (url === "/graphql") {
    jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    return;
  }
  if (url.includes("/timeline?")) { jsonResponse(response, 200, []); return; }
  if (url === "/repos/unbraind/pm-web/issues/175/comments?per_page=100") {
    jsonResponse(response, 200, comments);
    return;
  }
  const match = /^\/repos\/unbraind\/(pm-web|pm-slack-standup)\/issues\/(\d+)$/.exec(url);
  if (match) {
    const number = Number(match[2]);
    const issue = match[1] === "pm-slack-standup" ? (number === 113 ? slack : undefined)
      : [web, closed, pr].find(value => value.number === number);
    jsonResponse(response, issue ? 200 : 404, issue ?? { message: "Not Found" });
    return;
  }
  jsonResponse(response, 200, [web, closed, pr]);
};

/** Run the real import pipeline while retaining progress for assertions. */
async function importing(pmRoot: string, options: Record<string, unknown>, repo = "unbraind/pm-web") {
  return captureStderr(async () => await runImport(repo, pmRoot, parseImportOptions(options)) as Record<string, unknown>);
}

for (const flag of ["state", "all", "labels", "since", "assignee", "milestone", "limit"]) {
  test(`--issue refuses explicit --${flag} before requests or writes`, async () => tracker(async (_root, pmRoot) => {
    await withMockGithub(recorded, async server => {
      await assert.rejects(() => importing(pmRoot, { issue: "189", [flag]: flag === "all" ? true : "1" }),
        (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.USAGE && error.message.includes(`--issue conflicts with --${flag}`));
      assert.equal(server.requests.length, 0);
      assert.deepEqual(readPmItems(pmRoot), []);
    });
  }));
}

test("selection accepts numbers and same-repo references, deduplicates and validates the complete list", () => {
  assert.deepEqual(parseIssueNumbers("unbraind/pm-web", "189,#96,UNBRAIND/PM-WEB#189"), [189, 96]);
  for (const input of ["", "0", "-1", "1.2", "1e2", "#", "189,", "9007199254740992", "other/repo#189"]) {
    assert.throws(() => parseIssueNumbers("unbraind/pm-web", input), CommandError);
  }
  for (const issue of ["", false, 189]) assert.throws(() => parseImportOptions({ issue }), /--issue requires/);
  for (const limit of ["", "0", "-1", "1.5", "1e2", "Infinity", "9007199254740992", true]) {
    assert.throws(() => parseImportOptions({ limit }), /--limit must be a positive integer/);
  }
  assert.equal(parseImportOptions({ limit: "1" }).limit, 1);
});

test("one recorded issue uses one REST endpoint and re-import updates its existing provenance item", async () => tracker(async (_root, pmRoot) => {
  await withMockGithub(recorded, async server => {
    const first = await importing(pmRoot, { issue: "189,#189,unbraind/pm-web#189", type: "Task" });
    assert.equal(first.result.imported, 1);
    const items = readPmItems(pmRoot);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, web.title);
    assert.equal((JSON.parse(setup(join(pmRoot, "../.."), cli, ["show", items[0]!.id!, "--json"])) as { item: { type: string } }).item.type, "Task");
    assert.ok(items[0]!.tags?.includes("gh:unbraind/pm-web#189"));
    const repeat = await importing(pmRoot, { issue: "189" });
    assert.equal(repeat.result.imported, 0);
    assert.equal(repeat.result.updated, 1);
    assert.equal(readPmItems(pmRoot)[0]!.id, items[0]!.id);
    assert.equal(readPmItems(pmRoot).length, 1);
    assert.deepEqual(server.requests.map(request => request.url), Array(2).fill("/repos/unbraind/pm-web/issues/189"));
  });
}));

test("recorded standup issue imports directly into a real tracker", async () => tracker(async (_root, pmRoot) => {
  await withMockGithub(recorded, async server => {
    const { result } = await importing(pmRoot, { issue: "unbraind/pm-slack-standup#113" }, "unbraind/pm-slack-standup");
    assert.equal(result.imported, 1);
    assert.equal(readPmItems(pmRoot)[0]!.body, slack.body!.trim());
    assert.deepEqual(server.requests.filter(request => request.url !== "/graphql" && !request.url.includes("/timeline?")).map(request => request.url), ["/repos/unbraind/pm-slack-standup/issues/113"]);
  });
}));

test("explicit selection imports closed issues without a state filter", async () => tracker(async (_root, pmRoot) => {
  await withMockGithub(recorded, async server => {
    const { result } = await importing(pmRoot, { issue: "189,#96" });
    assert.equal(result.imported, 2);
    assert.equal(readPmItems(pmRoot).find(item => item.tags?.includes("gh:unbraind/pm-web#96"))!.status, "closed");
    assert.deepEqual(server.requests.filter(request => request.url !== "/graphql" && !request.url.includes("/timeline?")).map(request => request.url), ["/repos/unbraind/pm-web/issues/189", "/repos/unbraind/pm-web/issues/96"]);
  });
}));

for (const atomic of [false, true]) {
  test(`missing selection aborts the whole ${atomic ? "atomic" : "plain"} import before writes`, async () => tracker(async (_root, pmRoot) => {
    await withMockGithub(recorded, async () => {
      await assert.rejects(() => importing(pmRoot, { issue: "189,999999", atomic }),
        (error: unknown) => error instanceof CommandError && error.exitCode === EXIT_CODE.NOT_FOUND && /999999.*not found.*no issues were imported/i.test(error.message));
      assert.deepEqual(readPmItems(pmRoot), []);
    });
  }));
  test(`missing numbers are reported by a ${atomic ? "atomic" : "plain"} dry run with zero writes`, async () => tracker(async (_root, pmRoot) => {
    await withMockGithub(recorded, async () => {
      const { result, stderr } = await importing(pmRoot, { issue: "999999,189", "dry-run": true, atomic });
      assert.equal(result.wouldImport, 1);
      assert.deepEqual(result.missingIssues, [999999]);
      assert.ok(stderr.some(line => line.includes("Missing issue: unbraind/pm-web#999999")));
      const onlyMissing = await importing(pmRoot, { issue: "999999", "dry-run": true, atomic });
      assert.equal(onlyMissing.result.dryRun, true);
      assert.equal(onlyMissing.result.wouldImport, 0);
      assert.deepEqual(onlyMissing.result.missingIssues, [999999]);
      assert.deepEqual(readPmItems(pmRoot), []);
    });
  }));
}

test("a selected PR refuses the entire batch unless --include-prs is set", async () => tracker(async (_root, pmRoot) => {
  await withMockGithub(recorded, async () => {
    await assert.rejects(() => importing(pmRoot, { issue: "189,175" }), /175 is a pull request; use --include-prs/);
    assert.deepEqual(readPmItems(pmRoot), []);
    const { result } = await importing(pmRoot, { issue: "175", "include-prs": true });
    assert.equal(result.imported, 1);
    assert.equal(readPmItems(pmRoot)[0]!.status, "closed");
  });
}));

test("selection composes atomic, gate, comment modes and dependency linking with real SDK writes", async () => tracker(async (_root, pmRoot) => {
  await withMockGithub(recorded, async server => {
    const options = { issue: "189,175", "include-prs": true, "with-comments": true, "comments-mode": "annotations", atomic: true, gate: true, "link-deps": true };
    const preview = await importing(pmRoot, { ...options, "dry-run": true });
    assert.equal(preview.result.wouldImport, 2);
    assert.deepEqual(readPmItems(pmRoot), []);
    const first = await importing(pmRoot, options);
    assert.equal(first.result.imported, 2);
    assert.equal((first.result.gate as { verdict: string }).verdict, "pass");
    assert.equal(first.result.linkedDependencies, 0);
    const item = readPmItems(pmRoot).find(value => value.tags?.includes("gh:unbraind/pm-web#175"))!;
    assert.ok(item.body?.includes(comments[0]!.body!));
    assert.equal((await readComments(item.id!, {}, { pmRoot })).comments.length, 1);
    const repeat = await importing(pmRoot, options);
    assert.equal(repeat.result.imported, 0);
    assert.equal(readPmItems(pmRoot).length, 2);
    assert.equal((await readComments(item.id!, {}, { pmRoot })).comments.length, 1);
    assert.ok(server.requests.every(request => request.url === "/graphql" || /\/issues\/(189|175)(\/(comments|timeline)\?per_page=100)?$/.test(request.url)));
  });
}));

test("limit returns newest-updated first, truncates and stops before the remaining pages", async () => tracker(async (_root, pmRoot) => {
  await withMockGithub((request, response, _body, base) => {
    const page = new URL(request.url!, base).searchParams.get("page");
    jsonResponse(response, 200, page === "2" ? [closed] : [pr, web], {
      Link: nextLinkHeader(base, `/repos/unbraind/pm-web/issues?page=${page === "2" ? "3" : "2"}`),
    });
  }, async server => {
    const { result } = await importing(pmRoot, { limit: "1", state: "all" });
    assert.equal(result.imported, 1);
    assert.equal(result.limit, 1);
    assert.equal(result.truncated, true);
    assert.equal(readPmItems(pmRoot)[0]!.title, web.title);
    assert.equal(server.requests.length, 2);
    const query = new URL(server.requests[0]!.url, server.baseUrl).searchParams;
    assert.equal(query.get("sort"), "updated");
    assert.equal(query.get("direction"), "desc");
    assert.equal(query.get("per_page"), "2");
  });
}));

for (const options of [{}, { atomic: true }, { "dry-run": true }, { atomic: true, "dry-run": true }]) {
  test(`limit metadata survives ${JSON.stringify(options)} result paths`, async () => tracker(async (_root, pmRoot) => {
    await withMockGithub(recorded, async server => {
      const { result } = await importing(pmRoot, { ...options, limit: "1", state: "all" });
      assert.equal(result.limit, 1);
      assert.equal(result.truncated, true);
      assert.equal(server.requests.length, 1);
    });
  }));
}

test("exact cap, larger caps, empty lists and filtered lists report no truncation", async () => tracker(async (_root, pmRoot) => {
  for (const issues of [[web], [], [pr]]) {
    await withMockGithub((_request, response) => jsonResponse(response, 200, issues), async () => {
      for (const atomic of [false, true]) {
        const { result } = await importing(pmRoot, { limit: "1", "dry-run": true, atomic });
        assert.equal(result.truncated, false);
        assert.equal(result.limit, 1);
      }
      assert.equal((await importing(pmRoot, { limit: "1000", "dry-run": true })).result.truncated, false);
    });
  }
  assert.deepEqual(readPmItems(pmRoot), []);
}));

test("limit retains only its cap plus one probe even if a response contains a larger page", async () => {
  await withMockGithub(recorded, async () => {
    assert.equal((await fetchAllIssues("unbraind/pm-web", parseImportOptions({ limit: "1", state: "all", "include-prs": true }))).length, 2);
  });
});

test("selected transport and malformed response errors fail before writes", async () => tracker(async (_root, pmRoot) => {
  for (const response of [{ status: 401, body: {} }, { status: 200, body: "invalid" }, { status: 200, body: { number: 96 } }]) {
    await withMockGithub((_request, res) => jsonResponse(res, response.status, response.body), async () => {
      await assert.rejects(() => importing(pmRoot, { issue: "189" }), /Failed to fetch issues/);
      assert.deepEqual(readPmItems(pmRoot), []);
    });
  }
}));

test("built package dispatch advertises and honors selectors and limits through the real CLI", async () => tracker(async (root, pmRoot) => {
  const packed = await boundedCli("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", root], packageRoot,
    { ...process.env, PM_PATH: join(packageRoot, ".agents/pm") });
  assert.equal(packed.code, 0, packed.stderr);
  const archive = (JSON.parse(packed.stdout) as [{ filename: string }])[0].filename;
  setup(root, cli, ["package", "install", join(root, archive), "--project"]);
  await withMockGithub(recorded, async server => {
    const call = async (args: string[]) => boundedCli(cli, ["--path", pmRoot, "github", "import", ...args], root, process.env);
    const help = await call(["--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--issue/);
    assert.match(help.stdout, /--limit/);
    assert.match(help.stdout, /--adopt-cited/);
    const selected = await call(["unbraind/pm-web", "--issue", "189", "--dry-run", "--json"]);
    assert.equal(selected.code, 0, selected.stderr);
    assert.equal((JSON.parse(selected.stdout) as { wouldImport: number }).wouldImport, 1);
    const limited = await call(["unbraind/pm-web", "--limit", "1", "--state", "all", "--dry-run", "--json"]);
    assert.equal(limited.code, 0, limited.stderr);
    assert.equal((JSON.parse(limited.stdout) as { truncated: boolean }).truncated, true);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]!.url, "/repos/unbraind/pm-web/issues/189");
    assert.deepEqual(readPmItems(pmRoot), []);
    await create({ type: "Task", title: "Local issue fix", body: "Issue: https://github.com/unbraind/pm-web/issues/189" }, { pmRoot });
    const adopted = await call(["unbraind/pm-web", "--issue", "189", "--dry-run", "--adopt-cited", "--json"]);
    assert.equal(adopted.code, 0, adopted.stderr);
    assert.equal((JSON.parse(adopted.stdout) as { wouldAdopt: number }).wouldAdopt, 1);
    const optedOut = await call(["unbraind/pm-web", "--issue", "189", "--dry-run", "--json"]);
    assert.equal(optedOut.code, 0, optedOut.stderr);
    assert.equal((JSON.parse(optedOut.stdout) as { wouldImport: number }).wouldImport, 1);
    assert.equal((JSON.parse(optedOut.stdout) as { citation_candidates: { reason: string }[] }).citation_candidates[0]!.reason, "adoption_disabled");
    assert.equal(readPmItems(pmRoot).length, 1);
  });
}));

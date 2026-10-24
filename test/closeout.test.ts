/** HTTP-boundary acceptance for merged-PR closeout with real SDK tracker mutations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, close, update, get, config, acquireLock, PmCliError } from "@unbrained/pm-cli/sdk";
import extension, { fetchJSON, githubApiBase, parseNextLink } from "../index.ts";
import { CloseoutUsageError, closeoutFailureReason, compactCloseoutReport, checkCloseoutHead, declaresDelivery, extractCloseoutItems, runCloseout, type CloseoutApi } from "../closeout.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { decode } from "@toon-format/toon";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { withMockGithub, withEnv, jsonResponse, nextLinkHeader, type MockGithubHandler } from "./helpers/mock-github-server.ts";

const cli = join(import.meta.dirname, "../node_modules/.bin/pm");
const repo = "fixture/project";
const head = "a".repeat(40);
const merge = "b".repeat(40);
const mergedAt = "2099-10-13T12:30:00Z";
const bareLink = (id: string, repository = repo) => `https://github.com/${repository}/blob/main/.agents/pm/tasks/${id}.toon`;

/** Explicit delivery declarations used by all positive closeout fixtures. */
const link = (id: string, repository = repo) => `Closes ${bareLink(id, repository)}`;

/** Complete synthetic merged PR; prose is never trusted as closure evidence. */
function pull(body: string | null, overrides: Record<string, unknown> = {}) {
  return { number: 42, body, merged: true, commits: 0, merged_at: mergedAt, merge_commit_sha: merge,
    html_url: `https://github.com/${repo}/pull/42`, head: { sha: head }, base: { ref: "main", repo: { full_name: repo } }, ...overrides };
}

/** A successful app-bound head run, with independently adjustable safety facts. */
function run(overrides: Record<string, unknown> = {}) {
  return { name: "CI", head_sha: head, status: "completed", conclusion: "success", app: { id: 7 }, ...overrides };
}

/** Serve real REST requests; override one endpoint while retaining complete defaults. */
function fixture(body: string | null, override?: MockGithubHandler): MockGithubHandler {
  return (request, response, requestBody, base) => {
    if (override) {
      override(request, response, requestBody, base);
      if (response.writableEnded) return;
    }
    const url = request.url!;
    if (url.includes("/commits?")) jsonResponse(response, 200, []);
    else if (url.includes("/pulls/")) jsonResponse(response, 200, pull(body, { number: Number(url.split("/").at(-1)), html_url: `https://github.com/${repo}/pull/${url.split("/").at(-1)}` }));
    else if (url.includes("/rules/branches/")) jsonResponse(response, 200, []);
    else if (url.includes("/protection/")) jsonResponse(response, 200, { contexts: ["CI"], checks: [{ context: "CI", app_id: 7 }] });
    else if (url.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run()] });
    else if (url.includes("/statuses")) jsonResponse(response, 200, []);
    else jsonResponse(response, 400, {});
  };
}

/** Use the extension's actual transport, pagination parser and API origin. */
function api(): CloseoutApi {
  return { base: githubApiBase(), get: url => fetchJSON(url, "fixture"), next: parseNextLink };
}

/** Initialize a real scratch tracker; all items and history are owned by the SDK. */
async function tracker(fn: (pmRoot: string, ids: string[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pm-closeout-"));
  try {
    const result = spawnSync(cli, ["--pm-path", root, "init", "fixture"], { encoding: "utf8", cwd: root,
      env: { ...process.env, PM_AUTHOR: "fixture" } });
    assert.equal(result.status, 0, result.stderr);
    const ids: string[] = [];
    for (let n = 0; n < 4; n++) {
      const created = await create({ title: `Delivery ${n}`, type: "Task", author: "fixture", acceptanceCriteria: "Verified delivery" }, { pmRoot: root, noExtensions: true });
      // Delivered work is claimed work; open follow-ups are exercised separately.
      await update(created.item.id, { status: "in_progress" }, { pmRoot: root, noExtensions: true });
      ids.push(created.item.id);
    }
    await fn(root, ids);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Snapshot every durable tracker file, including item history, for zero-write proofs. */
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && !["locks", "runtime"].some(dir => entry.parentPath.split(/[\\/]/).includes(dir)))
    .map(entry => [join(entry.parentPath, entry.name).slice(root.length), readFileSync(join(entry.parentPath, entry.name), "utf8")]).sort());
}

/** Invoke the public core using the same transport as command registration. */
function closeout(root: string, options: Record<string, unknown> = { pr: "42" }) {
  return runCloseout(root, repo, options, api());
}

test("extraction accepts only canonical tracker links and deduplicates references", () => {
  assert.deepEqual(extractCloseoutItems([bareLink("pm-1"), bareLink("pm%2D1"), bareLink("pm-1", "FIXTURE/PROJECT"), bareLink("pm-1", "other/repo"),
    "pm: pm-2", bareLink("pm-3").replace("blob/main", "blob/feature"), bareLink("pm-4") + ".bak", "https://github.com/fixture/project/issues/1"].join("\n")),
  [{ repo, item: "pm-1", declared: false }, { repo: "other/repo", item: "pm-1", declared: false }]);
  // Only a closing keyword before the link on the same line declares delivery; a later declaring line upgrades a mention.
  assert.deepEqual(extractCloseoutItems([`- Closes ${bareLink("pm-5")}`, `- [pm-6](${bareLink("pm-6")}): closed later`, `See ${bareLink("pm-7")}`, `Fixes [pm-7](${bareLink("pm-7")})`,
    `Prefix ${bareLink("pm-8")}`].join("\n")).map(ref => [ref.item, ref.declared]),
  [["pm-5", true], ["pm-6", false], ["pm-7", true], ["pm-8", false]]);
  // The keyword must directly precede its link: prose in between, as in these review-reported lines, declares nothing.
  for (const line of ["Unrelated to the fix in ", "Not fixed here; see ", "Previously closed work: ", "Closes (see notes) ", "Closes [a](not a url) and ", "text]("]) {
    assert.equal(declaresDelivery(line), false, line);
  }
  for (const line of ["Closes ", "- Closes: ", "**Fixes** [pm-x](", "Delivers [a](https://x/a.toon) and [b](", `Resolves ${bareLink("pm-1")}, `, "_Delivered_ "]) {
    assert.equal(declaresDelivery(line), true, line);
  }
  for (const folder of [".", "..", "%2e%2e", "%2Fescape", "%5Cescape", "%00", "bad%ZZ"]) {
    assert.deepEqual(extractCloseoutItems(`https://github.com/${repo}/blob/main/.agents/pm/${folder}/pm-1.toon`), []);
  }
  assert.deepEqual(extractCloseoutItems(bareLink("pm-%2Fescape")), []);
  assert.deepEqual(extractCloseoutItems(bareLink("pm-%ZZ")), []);
});

test("dry-run plans same-repo, foreign, unknown, terminal and excluded items without writes", async () => tracker(async (root, ids) => {
  await close(ids[1]!, "Fixture done", {}, { pmRoot: root, noExtensions: true });
  await update(ids[2]!, { status: "canceled" }, { pmRoot: root, noExtensions: true });
  const before = snapshot(root);
  await withMockGithub(fixture([link(ids[0]!), link(ids[0]!, "other/repo"), link("fixture-unknown"), ...ids.slice(1).map(id => link(id))].join("\n")), async () => {
    const report = await closeout(root, { pr: ["42", "42"], skip: [ids[3], ids[3]] });
    assert.equal(report.dry_run, true);
    assert.equal(report.closed, 0);
    assert.equal(compactCloseoutReport(report).plan[0]!.action, "close");
    assert.deepEqual(report.plan.map(row => row.action), ["close", "skip", "skip", "skip", "skip", "skip"]);
    assert.match(report.plan[1]!.reason, /another repository/);
    assert.match(report.plan[2]!.reason, /does not exist/);
    assert.match(report.plan[3]!.reason, /already closed or canceled/);
    assert.match(report.plan[4]!.reason, /already closed or canceled/);
    assert.match(report.plan[5]!.reason, /--skip/);
    assert.deepEqual(Object.keys(report.plan[0]!), ["item", "pr", "action", "code", "reason"]);
    assert.equal(snapshot(root), before);
    await closeout(root, { pr: "42", apply: true, "dry-run": true });
    await closeout(root, { pr: "42", apply: true, dryRun: true });
    assert.equal(snapshot(root), before);
  });
}));

test("apply persists only exact GitHub reason facts; repeated selection writes zero bytes", async () => tracker(async (root, ids) => {
  const email = ["person", "example.invalid"].join("@");
  const token = "ghp_" + "Z".repeat(36);
  const body = `${link(ids[0]!)}\nPrivate prose ${email} ${token}`;
  await withMockGithub(fixture(body), async () => {
    const first = await closeout(root, { pr: "42", apply: true });
    assert.equal(first.closed, 1);
    const item = (await get(ids[0]!, {}, { pmRoot: root, noExtensions: true })).item;
    assert.equal(item.status, "closed");
    assert.equal(item.close_reason, JSON.stringify({ pr: 42, url: `https://github.com/${repo}/pull/42`, merge_commit_sha: merge,
      head_sha: head, merged_at: mergedAt, checks: ["CI"] }));
    assert.equal(item.completed_at, "2099-10-13T12:30:00.000Z");
    assert.equal(item.resolution, `Delivered by https://github.com/${repo}/pull/42 (merge ${merge.slice(0, 12)}, head ${head.slice(0, 12)})`);
    assert.equal(item.expected_result, "Verified delivery");
    assert.equal(item.actual_result, `Merged at ${mergedAt}; required checks satisfied; successful head checks: CI`);
    const before = snapshot(root);
    assert.ok(!before.includes(email) && !before.includes(token) && !before.includes("Private prose"));
    const repeat = await closeout(root, { pr: "42", apply: true });
    assert.equal(repeat.closed, 0);
    assert.match(repeat.plan[0]!.reason, /already closed or canceled/);
    assert.equal(snapshot(root), before);
  });
}));

for (const mode of ["default", "strict"]) {
  test(`${mode} close validation writes factual fields with and without acceptance criteria`, async () => tracker(async (root, ids) => {
    const sdk = { pmRoot: root, noExtensions: true };
    if (mode === "strict") await config("project", "set", "governance-close-validation-default", undefined, { policy: "strict" }, sdk);
    const criteria = "Reject a legacy cursor without after_index.\nPreserve the query fingerprint.";
    await update(ids[0]!, { title: "Legacy cursors publish the query fingerprint", acceptanceCriteria: criteria }, sdk);
    const without = (await create({ title: "Tests pass on every platform despite Linux-only gating", type: "Task", author: "fixture" }, sdk)).item.id;
    await update(without, { status: "in_progress" }, sdk);
    // The strict fixture must actually reject an evidence-free close before exercising closeout.
    if (mode === "strict") await assert.rejects(() => close(without, "Fixture delivery", {}, sdk),
      (error: unknown) => error instanceof PmCliError && error.code === "close_validation_missing_fields");
    const body = `${link(ids[0]!)}\n${link(without)}\nPrivate PR prose and comments claim Linux, macOS and Windows coverage.`;
    await withMockGithub(fixture(body), async () => {
      const before = snapshot(root);
      assert.equal((await closeout(root)).failed, 0);
      assert.equal(snapshot(root), before);
      const result = await closeout(root, { pr: "42", apply: true });
      assert.equal(result.closed, 2);
      assert.equal(result.failed, 0);
      for (const [id, expected] of [[ids[0]!, criteria], [without, "Delivered by the linked pull request, merged after its head check gate passed."]]) {
        const item = (await get(id!, {}, sdk)).item;
        assert.equal(item.status, "closed");
        assert.equal(item.expected_result, expected);
        assert.equal(item.resolution, `Delivered by https://github.com/${repo}/pull/42 (merge ${merge.slice(0, 12)}, head ${head.slice(0, 12)})`);
        assert.equal(item.actual_result, `Merged at ${mergedAt}; required checks satisfied; successful head checks: CI`);
        const fields = JSON.stringify([item.resolution, item.expected_result, item.actual_result]);
        assert.ok(!fields.includes(String(item.title)) && !fields.includes("Private PR") && !fields.includes("Windows"));
      }
    });
  }));
}

test("apply continues after lock and policy refusals and counts only successful writes", async () => tracker(async (root, ids) => {
  const sdk = { pmRoot: root, noExtensions: true };
  await update(ids[2]!, { tags: "requires-review" }, sdk);
  const policy = { id: "review-required", description: "Private policy prose", effect: "refuse",
    subject: { tags: ["requires-review"], operations: ["close"] }, rule: { kind: "require_fields", fields: ["reviewer"] } };
  for (const args of [["policy-put", policy.id, "--definition", JSON.stringify(policy)], ["policy-mode", "refuse"]]) {
    const result = spawnSync(cli, ["--pm-path", root, "schema", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PM_AUTHOR: "fixture" } });
    assert.equal(result.status, 0, result.stderr);
  }
  const unlock = await acquireLock(root, ids[0]!, 300, "private-lock-owner");
  try {
    await withEnv({ PM_LOCK_WAIT_MS: "0" }, () => withMockGithub(fixture(ids.map(id => link(id)).join("\n")), async () => {
      const result = await closeout(root, { pr: "42", apply: true });
      assert.equal(result.closed, 2);
      assert.equal(result.failed, 2);
      assert.deepEqual(result.plan.map(row => row.action), ["skip", "close", "skip", "close"]);
      assert.equal(result.plan[0]!.reason, "SDK close refused: lock_conflict.");
      assert.match(result.plan[2]!.reason, /workflow_policy/);
      assert.ok(!JSON.stringify(result).includes("private-lock-owner") && !JSON.stringify(result).includes("Private policy") && !JSON.stringify(result).includes(root));
      for (const [index, id] of ids.entries()) assert.equal((await get(id, {}, sdk)).item.status, index % 2 === 0 ? "in_progress" : "closed");
    }));
  } finally { await unlock(); }
}));

test("failure reasons discard arbitrary prose and malformed diagnostic codes", () => {
  for (const code of [undefined, "Private prose", "a".repeat(81)]) {
    assert.equal(closeoutFailureReason(new PmCliError("Private filesystem details", 1, { code })), "SDK close refused (exit 1).");
  }
  for (const error of [new Error("Private filesystem details"), "Private response", null]) {
    assert.equal(closeoutFailureReason(error), "SDK close failed (unclassified error).");
  }
});

test("public apply reports partial results as CommandError exit 1 after remaining closes", async () => tracker(async (root, ids) => {
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  const unlock = await acquireLock(root, ids[0]!, 300, "private-lock-owner");
  try {
    await withEnv({ PM_GITHUB_REPO: repo, GITHUB_TOKEN: "fixture", PM_LOCK_WAIT_MS: "0" }, () => withMockGithub(fixture(ids.slice(0, 2).map(id => link(id)).join("\n")), async server => {
      await assert.rejects(harness.runCommand({ command: "github closeout", pmRoot: root, options: { pr: ["42"], apply: true } }), (error: unknown) => {
        assert.equal((error as Error).name, "CommandError");
        assert.equal((error as { exitCode: number }).exitCode, 1);
        const report = JSON.parse((error as Error).message) as { closed: number; failed: number; plan: { action: string; reason: string }[] };
        assert.equal(report.closed, 1);
        assert.equal(report.failed, 1);
        assert.deepEqual(report.plan.map(row => row.action), ["skip", "close"]);
        assert.equal(report.plan[0]!.reason, "SDK close refused: lock_conflict.");
        return true;
      });
      assert.equal((await get(ids[1]!, {}, { pmRoot: root, noExtensions: true })).item.status, "closed");
      assert.equal(server.requests.filter(request => /\/pulls\/\d+$/.test(request.url)).length, 1);
    }));
  } finally { await unlock(); }
}));

test("equal merge times require review before writes", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!)), async () => {
    const report = await closeout(root, { pr: ["43", "42"], apply: true });
    assert.equal(report.closed, 0);
    assert.deepEqual(report.plan.map(row => [row.pr, row.action, row.code]), [[42, "needs_review", "needs_review"], [43, "needs_review", "needs_review"]]);
  });
}));

for (const [name, changes] of Object.entries({ failed: { conclusion: "failure" }, pending: { status: "in_progress", conclusion: null },
  neutral: { conclusion: "neutral" }, skipped: { conclusion: "skipped" }, wrongApp: { app: { id: 8 } } })) {
  test(`required check gate rejects ${name} evidence without writes`, async () => tracker(async (root, ids) => {
    const before = snapshot(root);
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run(changes)] });
    }), async () => {
      const report = await closeout(root, { pr: "42", apply: true });
      assert.equal(report.closed, 0);
      assert.equal(report.checks[0]!.rule, "required");
      assert.match(report.plan[0]!.reason, name === "wrongApp" ? /missing/ : /did not conclude success/);
      assert.equal(snapshot(root), before);
    });
  }));
}

test("legacy required statuses use newest context and cannot bypass a failed run", async () => tracker(async (root, ids) => {
  for (const state of ["success", "failure"]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: ["legacy"], checks: [] });
      if (request.url!.includes("/statuses")) jsonResponse(response, 200, [{ context: "legacy", state }, { context: "legacy", state: "failure" }]);
    }), async () => {
      const report = await closeout(root);
      assert.equal(report.plan[0]!.action, state === "success" ? "close" : "skip");
      if (state === "success") assert.deepEqual(report.checks[0]!.passed, ["CI", "legacy"]);
    });
  }
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: ["CI"], checks: [{ context: "CI", app_id: -1 }] });
    if (request.url!.includes("/statuses")) jsonResponse(response, 200, [{ context: "CI", state: "failure" }]);
  }), async () => assert.equal((await closeout(root)).plan[0]!.action, "skip"));
}));

for (const protection of [403, 404, "empty"] as const) {
  test(`protection ${protection} refuses gaps and preserves readable-empty fallback`, async () => tracker(async (root, ids) => {
    for (const conclusion of ["success", "neutral", "skipped", "failure", null]) {
      const before = snapshot(root);
      await withMockGithub(fixture(link(ids[0]!), (request, response) => {
        if (request.url!.includes("/protection/")) jsonResponse(response, typeof protection === "number" ? protection : 200, { contexts: [], checks: [] });
        if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run({ conclusion })] });
      }), async () => {
        const report = await closeout(root);
        assert.equal(report.checks[0]!.rule, protection === "empty" ? "fallback" : "unavailable");
        assert.equal(report.plan[0]!.action, protection !== "empty" ? "needs_review" : conclusion === "failure" || conclusion === null ? "skip" : "close");
        assert.equal(report.plan[0]!.code, protection !== "empty" ? "needs_review" : conclusion === "failure" || conclusion === null ? "head_checks_failed" : "head_checks_passed");
        assert.equal(snapshot(root), before);
      });
    }
  }));
}

test("readable-empty fallback rejects empty runs, pending runs and failing legacy statuses", async () => tracker(async (root, ids) => {
  for (const mode of ["empty", "pending", "status"]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: [], checks: [] });
      if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: mode === "empty" ? 0 : 1,
        check_runs: mode === "empty" ? [] : [run({ status: mode === "pending" ? "queued" : "completed" })] });
      if (request.url!.includes("/statuses") && mode === "status") jsonResponse(response, 200, [{ context: "legacy", state: "pending" }]);
    }), async () => assert.equal((await closeout(root, { pr: "42", apply: true })).closed, 0));
  }
}));

for (const [name, data] of Object.entries({ noRuns: { total_count: 0, check_runs: [] }, truncated: { total_count: 2, check_runs: [run()] },
  missingCount: { check_runs: [] }, negativeCount: { total_count: -1, check_runs: [] }, invalidArray: { total_count: 1, check_runs: {} },
  wrongHead: { total_count: 1, check_runs: [run({ head_sha: merge })] }, missingApp: { total_count: 1, check_runs: [run({ app: null })] },
  badApp: { total_count: 1, check_runs: [run({ app: { id: "7" } })] }, badConclusion: { total_count: 1, check_runs: [run({ conclusion: 1 })] },
  missingName: { total_count: 1, check_runs: [run({ name: "" })] }, missingStatus: { total_count: 1, check_runs: [run({ status: "" })] } })) {
  test(`missing or malformed ${name} check evidence fails closed`, async () => tracker(async (root, ids) => {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/check-runs")) jsonResponse(response, 200, data);
    }), async () => {
      const before = snapshot(root);
      const report = await closeout(root, { pr: "42", apply: true });
      assert.equal(report.closed, 0);
      assert.equal(report.plan[0]!.action, "needs_review");
      assert.equal(snapshot(root), before);
    });
  }));
}

test("confirmed unmerged PRs are routine skips and incomplete merge facts hold; null body contributes no references", async () => tracker(async (root, ids) => {
  for (const changes of [{ merged: false }, { merged_at: null }, { merge_commit_sha: null }, { merge_commit_sha: "bad" }, { head: { sha: "bad" } }]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/pulls/")) jsonResponse(response, 200, pull(link(ids[0]!), changes));
    }), async server => {
      const report = await closeout(root, { pr: "42", apply: true });
      assert.equal(report.closed, 0);
      if ("merged" in changes && changes.merged === false) {
        assert.equal(report.plan[0]!.code, "not_merged");
        assert.deepEqual(compactCloseoutReport(report).skipped, { not_merged: 1 });
      }
      assert.equal(server.requests.filter(request => !request.url.includes("/commits?")).length, 1);
    });
  }
  await withMockGithub(fixture(null), async () => assert.deepEqual((await closeout(root)).plan, []));
}));

test("since drains every page and uses inclusive merge time rather than update time", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response, _body, base) => {
    if (request.url!.endsWith("/pulls/40")) jsonResponse(response, 200, pull(link(ids[0]!), { number: 40, html_url: `https://github.com/${repo}/pull/40`, merged: false }));
    if (request.url!.includes("/pulls?")) {
      const page = new URL(request.url!, base).searchParams.get("page");
      jsonResponse(response, 200, page === "2" ? [{ number: 42, merged_at: mergedAt }] : [
        { number: 40, merged_at: null }, { number: 41, merged_at: "2099-10-12T00:00:00Z" }],
      page === "2" ? {} : { Link: nextLinkHeader(base, "/repos/fixture/project/pulls?state=closed&page=2") });
    }
  }), async server => {
    const report = await closeout(root, { since: mergedAt });
    assert.equal(report.plan.find(row => row.action === "close")!.pr, 42);
    assert.equal(server.requests.filter(request => request.url.includes("/pulls?")).length, 2);
  });
}));

test("head check and status pagination retains all required evidence", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response, _body, base) => {
    const url = request.url!;
    if (url.includes("/check-runs")) {
      const second = url.includes("page=2");
      jsonResponse(response, 200, { total_count: 2, check_runs: [run({ name: second ? "CI" : "optional", conclusion: second ? "success" : "failure" })] },
        second ? {} : { Link: nextLinkHeader(base, `/repos/${repo}/commits/${head}/check-runs?page=2`) });
    }
    if (url.includes("/statuses")) jsonResponse(response, 200, [], url.includes("page=2") ? {} : { Link: nextLinkHeader(base, `/repos/${repo}/commits/${head}/statuses?page=2`) });
  }), async () => assert.equal((await closeout(root)).plan[0]!.action, "close"));
}));

test("invalid selectors fail before HTTP or writes", async () => tracker(async (root) => {
  await withMockGithub(fixture(null), async server => {
    for (const options of [{}, { pr: [] }, { pr: false }, { pr: "" }, { pr: ["42", 43] }, { pr: "0" }, { pr: "1.2" }, { pr: "9007199254740992" },
      { pr: "42", since: "2099-10-01" }, { since: "yesterday" }, { since: "2099-02-30" }, { since: "2099-10-01T12:00:00" },
      { since: "2099-10-01T99:00:00Z" }, { since: false }, { since: "" }, { pr: "42", skip: [] }, { pr: "42", skip: true }, { pr: "42", "required-checks": ["CI", 42] }, { pr: "42", "required-checks": false }]) {
      await assert.rejects(() => closeout(root, options), CloseoutUsageError);
    }
    for (const repository of [undefined, "invalid", "bad/repo/name", "./repo", "../repo", "fixture/.", "fixture/.."]) await assert.rejects(() => runCloseout(root, repository, { pr: "42" }, api()), CloseoutUsageError);
    assert.equal(server.requests.length, 0);
  });
}));

for (const [name, changes] of Object.entries({ number: { number: 44 }, repo: { base: { ref: "main", repo: { full_name: "other/repo" } } },
  url: { html_url: "https://example.invalid/42" }, body: { body: 1 }, head: { head: [] }, base: { base: null } })) {
  test(`invalid PR ${name} aborts the entire plan before writes`, async () => tracker(async (root, ids) => {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.endsWith("/43")) jsonResponse(response, 200, pull(link(ids[1]!), changes));
    }), async () => {
      const before = snapshot(root);
      await assert.rejects(() => closeout(root, { pr: ["42", "43"], apply: true }));
      assert.equal(snapshot(root), before);
    });
  }));
}

for (const [name, data] of Object.entries({ absent: {}, invalidContexts: { contexts: null, checks: [] },
  invalidChecks: { contexts: [], checks: {} }, invalidApp: { contexts: [], checks: [{ context: "CI", app_id: -2 }] },
  invalidContext: { contexts: [null], checks: [] }, invalidName: { contexts: [], checks: [{ context: "", app_id: 7 }] } })) {
  test(`unverifiable protection ${name} never activates fallback`, async () => tracker(async (root, ids) => {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 200, data);
    }), async () => {
      const report = await closeout(root, { pr: "42", apply: true });
      assert.equal(report.closed, 0);
      assert.equal(report.checks[0]!.rule, "unavailable");
    });
  }));
}

test("unbound and legacy-only required contexts accept actual successful evidence", async () => tracker(async (root, ids) => {
  for (const app of [undefined, null, -1]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: ["CI"], checks: [{ context: "CI", app_id: app }] });
    }), async () => assert.equal((await closeout(root)).plan[0]!.action, "close"));
  }
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: ["legacy"], checks: [] });
    if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 0, check_runs: [] });
    if (request.url!.includes("/statuses")) jsonResponse(response, 200, [{ context: "legacy", state: "success" }]);
  }), async () => assert.equal((await closeout(root)).plan[0]!.action, "close"));
}));

for (const mode of ["foreign", "cycle", "changed-count", "invalid-statuses", "invalid-json", "unauthorized"]) {
  test(`head evidence ${mode} fails closed without exposing API text`, async () => tracker(async (root, ids) => {
    await withMockGithub(fixture(link(ids[0]!), (request, response, _body, base) => {
      const url = request.url!;
      if (url.includes("/check-runs")) {
        if (mode === "foreign" || mode === "cycle") jsonResponse(response, 200, { total_count: 1, check_runs: [run()] }, {
          Link: nextLinkHeader(mode === "foreign" ? "https://example.invalid" : base, url) });
        if (mode === "changed-count") jsonResponse(response, 200, { total_count: url.includes("page=2") ? 3 : 2, check_runs: [run()] },
          url.includes("page=2") ? {} : { Link: nextLinkHeader(base, `/repos/${repo}/commits/${head}/check-runs?page=2`) });
        if (mode === "invalid-json") jsonResponse(response, 200, "private unparseable response");
        if (mode === "unauthorized") jsonResponse(response, 401, { message: "private error text" });
      }
      if (url.includes("/statuses") && mode === "invalid-statuses") jsonResponse(response, 200, {});
    }), async () => {
      const report = await closeout(root, { pr: "42", apply: true });
      assert.equal(report.closed, 0);
      assert.ok(!JSON.stringify(report).includes("private"));
    });
  }));
}

test("since validates selected numbers and permits an empty selection", async () => tracker(async (root) => {
  for (const selected of [[], [{ number: 0, merged_at: mergedAt }], [{ number: 42, merged_at: "invalid" }]]) {
    await withMockGithub(fixture(null, (request, response) => {
      if (request.url!.includes("/pulls?")) jsonResponse(response, 200, selected);
    }), async () => {
      if (selected.length === 0) assert.deepEqual((await closeout(root, { since: "2099-10-13" })).plan, []);
      else if (selected[0]?.number === 0) await assert.rejects(() => closeout(root, { since: "2099-10-13" }));
      else assert.deepEqual((await closeout(root, { since: "2099-10-13" })).plan, []);
    });
  }
}));

test("public command registration reuses repo resolution and shared transport", async () => tracker(async (root, ids) => {
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  await withEnv({ PM_GITHUB_REPO: repo, GITHUB_TOKEN: "fixture" }, () => withMockGithub(fixture(link(ids[0]!)), async () => {
    const result = await harness.runCommand({ command: "github closeout", pmRoot: root, options: { pr: ["42"] } });
    assert.equal((result.result as { plan: { action: string }[] }).plan[0]!.action, "close");
    const compact = await harness.runCommand({ command: "github closeout", pmRoot: root,
      global: { json: false }, options: { pr: ["42", "43", "44"] } });
    assert.deepEqual((compact.result as { plan: { pr: number; action: string }[] }).plan.map(row => [row.pr, row.action]), [[42, "needs_review"], [43, "needs_review"], [44, "needs_review"]]);
    assert.deepEqual((compact.result as { skipped: object }).skipped, {});
    const full = await harness.runCommand({ command: "github closeout", pmRoot: root,
      global: { json: false }, options: { pr: ["42", "43", "44"], full: true } });
    assert.equal((full.result as { plan: object[] }).plan.length, 3);
    assert.equal("skipped" in (full.result as object), false);
  }));
  // Failures surface as handled command errors (usage 2, evidence 1), so the host never re-runs the handler.
  await withEnv({ PM_GITHUB_REPO: repo, GITHUB_TOKEN: "fixture" }, () => withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/pulls/")) jsonResponse(response, 200, { number: 42 });
  }), async server => {
    await assert.rejects(harness.runCommand({ command: "github closeout", pmRoot: root, options: { pr: ["0"] } }),
      (error: unknown) => (error as { exitCode?: number }).exitCode === 2 && /positive pull-request numbers/.test((error as Error).message));
    await assert.rejects(harness.runCommand({ command: "github closeout", pmRoot: root, options: { pr: ["42"] } }),
      (error: unknown) => (error as { exitCode?: number }).exitCode === 1 && /Invalid GitHub evidence object/.test((error as Error).message));
    assert.equal(server.requests.filter(request => /\/pulls\/\d+$/.test(request.url)).length, 1);
  }));
}));

test("since stops paging once a row was last updated before the cutoff", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response, _body, base) => {
    if (request.url!.includes("/pulls?")) {
      jsonResponse(response, 200, [{ number: 42, merged_at: mergedAt, updated_at: mergedAt }, { number: 41, merged_at: "2099-10-01T00:00:00Z", updated_at: "2099-10-01T00:00:00Z" }],
        { Link: nextLinkHeader(base, "/repos/fixture/project/pulls?state=closed&page=2") });
    }
  }), async server => {
    const report = await closeout(root, { since: mergedAt });
    assert.deepEqual(report.plan.map(row => row.pr), [42]);
    assert.equal(server.requests.filter(request => request.url.includes("/pulls?")).length, 1);
  });
}));

test("packed CLI preserves repeatable selectors, TOON/JSON shape and no-op apply", async () => tracker(async (root, ids) => {
  for (const id of ids) await update(id, { tags: `delivery-pr:https://github.com/${repo}/pull/43` }, { pmRoot: root, noExtensions: true });
  const packageRoot = join(import.meta.dirname, "..");
  const packed = await boundedCli("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", root], packageRoot,
    { ...process.env, PM_PATH: join(packageRoot, ".agents/pm") });
  assert.equal(packed.code, 0, packed.stderr);
  const archive = (JSON.parse(packed.stdout) as [{ filename: string }])[0].filename;
  const install = spawnSync(cli, ["--pm-path", root, "package", "install", join(root, archive), "--project"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PM_AUTHOR: "fixture" } });
  assert.equal(install.status, 0, install.stderr);
  await withEnv({ PM_GITHUB_REPO: repo, GITHUB_TOKEN: "fixture" }, () => withMockGithub(fixture(ids.map(id => link(id)).join("\n")), async () => {
    const call = (args: string[]) => boundedCli(cli, ["--pm-path", root, "github", "closeout", ...args], root, process.env);
    const help = await call(["--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--pr/);
    assert.match(help.stdout, /--since/);
    assert.match(help.stdout, /--skip/);
    const flags = ["--pr", "42", "--pr", "43", "--skip", ids[1]!, "--skip", ids[2]!];
    const before = snapshot(root);
    const preview = await call(flags);
    assert.equal(preview.code, 0, preview.stderr);
    const report = decode(preview.stdout) as { dry_run: boolean; plan: { action: string }[] };
    assert.equal(report.dry_run, true);
    assert.equal(report.plan.length, 2);
    assert.deepEqual((report as unknown as { skipped: object }).skipped, { explicit_skip: 4, duplicate_selection: 2 });
    const full = await call([...flags, "--full"]);
    assert.equal(full.code, 0, full.stderr);
    assert.equal((decode(full.stdout) as { plan: object[] }).plan.length, 8);
    const json = await call([...flags, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal((JSON.parse(json.stdout) as { plan: object[] }).plan.length, 8);
    assert.equal(report.plan.filter(row => row.action === "close").length, 2);
    assert.equal(snapshot(root), before);
    const applied = await call([...flags, "--apply", "--json"]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal((JSON.parse(applied.stdout) as { closed: number }).closed, 2);
    const after = snapshot(root);
    const repeat = await call([...flags, "--apply", "--json"]);
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.equal((JSON.parse(repeat.stdout) as { closed: number }).closed, 0);
    assert.equal(snapshot(root), after);
  }));
}));

test("effective ruleset checks supplement classic required contexts", async () => tracker(async (root, ids) => {
  for (const app of [undefined, null, 7]) {
    for (const state of ["success", "failure"]) {
      await withMockGithub(fixture(link(ids[0]!), (request, response) => {
        if (request.url!.includes("/rules/branches/")) jsonResponse(response, 200, [
          { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ruleset", integration_id: app }] } }]);
        if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 2, check_runs: [run(), run({ name: "ruleset", conclusion: state })] });
      }), async () => assert.equal((await closeout(root)).plan[0]!.action, state === "success" ? "close" : "skip"));
    }
  }
}));

for (const value of [{}, [null], [{ type: "required_status_checks", parameters: {} }],
  [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ruleset", integration_id: -1 }] } }]]) {
  test(`malformed effective rules fail closed: ${JSON.stringify(value)}`, async () => tracker(async (root, ids) => {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/rules/branches/")) jsonResponse(response, 200, value);
    }), async () => assert.equal((await closeout(root, { pr: "42", apply: true })).closed, 0));
  }));
}

test("required definitions and effective rules drain app-bound contexts across pages", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response, _body, base) => {
    if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: ["CI", "extra"], checks: [{ context: "CI", app_id: 7 }] });
    if (request.url!.includes("/rules/branches/")) jsonResponse(response, 200, request.url!.includes("page=2") ? [
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "extra" }] } }] : [],
    request.url!.includes("page=2") ? {} : { Link: nextLinkHeader(base, `/repos/${repo}/rules/branches/main?page=2`) });
  }), async () => {
    const report = await closeout(root);
    assert.match(report.plan[0]!.reason, /Required check missing.*extra/);
  });
}));

test("unreadable effective rules preserve known requirements without hiding authorization failures", async () => tracker(async (root, ids) => {
  for (const status of [401, 403, 404]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/rules/branches/")) jsonResponse(response, status, {});
    }), async () => {
      const report = await closeout(root);
      assert.equal(report.checks[0]!.rule, "unavailable");
      assert.equal(report.plan[0]!.action, "needs_review");
    });
  }
}));

test("repository resolution accepts valid dot, underscore and hyphen repository names", async () => tracker(async (root, ids) => {
  for (const repository of ["fixture/.github", "fixture/_repo", "fixture/-repo"]) {
    await withMockGithub(fixture(link(ids[0]!, repository), (request, response) => {
      if (/\/pulls\/42$/.test(request.url!)) jsonResponse(response, 200, pull(link(ids[0]!, repository), {
        html_url: `https://github.com/${repository}/pull/42`, base: { ref: "main", repo: { full_name: repository } },
      }));
    }), async () => {
      const report = await runCloseout(root, repository, { pr: "42" }, api());
      assert.equal(report.plan[0]!.action, "close");
    });
  }
}));

test("custom SDK folders with dots, encoded spaces and nested paths close through canonical links", async () => tracker(async (root) => {
  for (const [type, folder] of [["ScopedDot", "tasks.v2"], ["ScopedSpace", "custom tasks"], ["ScopedNested", "custom/nested"]]) {
    const configured = spawnSync(cli, ["--pm-path", root, "schema", "add-type", type!, "--folder", folder!], {
      cwd: root, encoding: "utf8", env: { ...process.env, PM_AUTHOR: "fixture" },
    });
    assert.equal(configured.status, 0, configured.stderr);
    const created = await create({ type: type!, title: `Custom delivery ${type}`, author: "fixture", acceptanceCriteria: "Verified delivery" }, { pmRoot: root, noExtensions: true });
    await update(created.item.id, { status: "in_progress" }, { pmRoot: root, noExtensions: true });
    const url = `https://github.com/${repo}/blob/main/.agents/pm/${folder!.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(created.item.id).replaceAll("-", "%2D")}.toon`;
    await withMockGithub(fixture(`Closes ${url}`), async () => {
      assert.equal((await closeout(root, { pr: "42", apply: true })).closed, 1);
      assert.equal((await get(created.item.id, {}, { pmRoot: root, noExtensions: true })).item.status, "closed");
    });
  }
}));

test("unreadable supplemental rules never relax a known required check to neutral", async () => tracker(async (root, ids) => {
  for (const status of [403, 404]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/rules/branches/")) jsonResponse(response, status, {});
      if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run({ conclusion: "neutral" })] });
    }), async () => assert.equal((await closeout(root)).plan[0]!.action, "needs_review"));
  }
}));

test("unauthorized classic protection cannot invoke the permissive fallback", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/protection/")) jsonResponse(response, 401, { message: "private error text" });
  }), async () => {
    const before = snapshot(root);
    const report = await closeout(root, { pr: "42", apply: true });
    assert.equal(report.closed, 0);
    assert.equal(report.checks[0]!.rule, "unavailable");
    assert.equal(report.plan[0]!.action, "needs_review");
    assert.equal(snapshot(root), before);
    assert.ok(!JSON.stringify(report).includes("private error text"));
  });
}));

test("declared policy preserves readable ruleset requirements when classic protection is unavailable", async () => tracker(async (root, ids) => {
  for (const conclusion of ["success", "neutral", "skipped", "failure"]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 403, {});
      if (request.url!.includes("/rules/branches/")) jsonResponse(response, 200, [{ type: "required_status_checks", parameters: {
        required_status_checks: [{ context: "CI", integration_id: 7 }],
      } }]);
      if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run({ conclusion })] });
    }), async () => {
      const report = await closeout(root, { pr: "42", "required-checks": "CI" });
      assert.equal(report.checks[0]!.rule, "declared");
      assert.equal(report.plan[0]!.action, conclusion === "success" ? "close" : "skip");
    });
  }
}));

test("unreadable protection sources refuse without hiding invalid authorization", async () => tracker(async (root, ids) => {
  for (const status of [403, 404, 401]) {
    await withMockGithub(fixture(link(ids[0]!), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 403, {});
      if (request.url!.includes("/rules/branches/")) jsonResponse(response, status, {});
    }), async () => {
      const report = await closeout(root);
      assert.equal(report.checks[0]!.rule, "unavailable");
      assert.equal(report.plan[0]!.action, "needs_review");
    });
  }
}));

test("a mention is not delivery: open follow-ups, epics and parents with active children are never closed", async () => tracker(async (root, ids) => {
  const sdk = { pmRoot: root, noExtensions: true };
  const followUp = (await create({ title: "Deferred follow-up", type: "Task", author: "fixture" }, sdk)).item.id;
  const declared = (await create({ title: "Declared delivery", type: "Task", author: "fixture" }, sdk)).item.id;
  const epic = (await create({ title: "Umbrella", type: "Epic", author: "fixture" }, sdk)).item.id;
  await update(epic, { status: "in_progress" }, sdk);
  await update(ids[1]!, { parent: ids[0]! }, sdk);
  const body = [`Delivers [parent](${bareLink(ids[0]!)}) and [child](${bareLink(ids[1]!)})`, `Follow-up: ${bareLink(followUp)} (not closed by this PR)`,
    `Closes ${bareLink(declared)}`, `Part of ${bareLink(epic)}`].join("\n");
  await withMockGithub(fixture(body), async () => {
    const report = await closeout(root, { pr: "42" });
    const rows = new Map(report.plan.map(row => [row.item, row]));
    assert.equal(rows.get(ids[0]!)!.action, "skip");
    assert.match(rows.get(ids[0]!)!.reason, /1 non-terminal child/);
    assert.equal(rows.get(ids[1]!)!.action, "close");
    assert.equal(rows.get(followUp)!.action, "skip");
    assert.match(rows.get(followUp)!.reason, /A mention is not delivery/);
    assert.equal(rows.get(declared)!.action, "close");
    assert.equal(rows.get(epic)!.action, "skip");
    assert.match(rows.get(epic)!.reason, /Epics close when their children are done/);
    const applied = await closeout(root, { pr: "42", apply: true });
    assert.equal(applied.closed, 2);
    assert.equal((await get(followUp, {}, sdk)).item.status, "open");
    assert.equal((await get(epic, {}, sdk)).item.status, "in_progress");
    // With its only child closed, the parent's own in-progress delivery now closes on a rerun.
    const rerun = await closeout(root, { pr: "42", apply: true });
    assert.deepEqual(rerun.plan.filter(row => row.action === "close").map(row => row.item), [ids[0]]);
  });
}));

test("fallback closes describe the applied check policy and never claim required checks", async () => tracker(async (root, ids) => {
  for (const [conclusion, evidence] of [["success", "successful checks: CI"], ["skipped", "no check reported success"]] as const) {
    const id = (await create({ title: `Fallback ${conclusion}`, type: "Task", author: "fixture" }, { pmRoot: root, noExtensions: true })).item.id;
    await update(id, { status: "in_progress" }, { pmRoot: root, noExtensions: true });
    await withMockGithub(fixture(link(id), (request, response) => {
      if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: [], checks: [] });
      if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run({ conclusion })] });
    }), async () => {
      assert.equal((await closeout(root, { pr: "42", apply: true })).closed, 1);
      const item = (await get(id, { full: true }, { pmRoot: root, noExtensions: true })).item as Record<string, unknown>;
      assert.equal(item.actual_result, `Merged at ${mergedAt}; no readable required checks, so every completed head check run had to succeed, be neutral or be skipped; ${evidence}`);
      assert.doesNotMatch(String(item.actual_result), /required checks (passing|satisfied)/);
    });
  }
}));

test("successful optional checks are never labelled as required", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 2, check_runs: [run(), run({ name: "lint" })] });
  }), async () => {
    assert.equal((await closeout(root, { pr: "42", apply: true })).closed, 1);
    const item = (await get(ids[0]!, { full: true }, { pmRoot: root, noExtensions: true })).item as Record<string, unknown>;
    assert.equal(item.actual_result, `Merged at ${mergedAt}; required checks satisfied; successful head checks: CI, lint`);
    assert.doesNotMatch(String(item.actual_result), /required checks passing/);
  });
}));

test("compact report counts routine skips and retains individual refusals with their head evidence", async () => tracker(async (root, ids) => {
  await update(ids[1]!, { status: "canceled" }, { pmRoot: root, noExtensions: true });
  await withMockGithub(fixture([link(ids[0]!), link(ids[1]!), link(ids[0]!, "other/project")].join("\n"), (request, response) => {
    if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run({ conclusion: "failure" })] });
  }), async () => {
    const full = await closeout(root);
    const report = compactCloseoutReport(full);
    assert.deepEqual(report.skipped, { already_terminal: 1, other_repository: 1 });
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]!.action, "refuse");
    assert.equal(report.checks[0]!.code, "head_checks_failed");
    assert.equal(report.checks.length, 1);
    assert.equal(full.plan.length, 3);
  });
}));

test("declared contexts verify exact names and latest statuses without requiring optional success", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/protection/") || request.url!.includes("/rules/branches/")) jsonResponse(response, 403, {});
    if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 2, check_runs: [run(), run({ name: "optional", conclusion: "failure" })] });
    if (request.url!.includes("/statuses")) jsonResponse(response, 200, [{ context: "legacy", state: "success" }, { context: "legacy", state: "failure" }]);
  }), async () => {
    const before = snapshot(root);
    assert.equal((await checkCloseoutHead(api(), repo, pull(link(ids[0]!)))).code, "required_checks_unverified");
    for (const names of ["CI\nLegacy", "CI\nmissing"]) {
      const report = await closeout(root, { pr: "42", apply: true, "required-checks": names });
      assert.equal(report.closed, 0);
      assert.equal(report.checks[0]!.code, "head_checks_failed");
      assert.equal(snapshot(root), before);
    }
    const report = await closeout(root, { pr: "42", apply: true, "required-checks": "  CI\nlegacy\nCI  " });
    assert.equal(report.closed, 1);
    assert.equal(report.checks[0]!.rule, "declared");
    assert.equal(report.checks[0]!.code, "head_checks_passed");
    assert.equal(report.checks[0]!.reason, "Caller-declared checks concluded success; repository required-check metadata was unavailable.");
    assert.deepEqual(report.checks[0]!.passed, ["CI", "legacy"]);
  });
}));

test("declared names cannot bypass a readable app binding", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/rules/branches/")) jsonResponse(response, 403, {});
    if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 1, check_runs: [run({ app: { id: 8 } })] });
  }), async () => {
    const before = snapshot(root);
    const report = await closeout(root, { pr: "42", apply: true, "required-checks": "CI" });
    assert.equal(report.closed, 0);
    assert.equal(report.checks[0]!.code, "head_checks_failed");
    assert.equal(snapshot(root), before);
  });
}));

test("newline context arrays preserve literal names and empty declarations fail closed", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/protection/") || request.url!.includes("/rules/branches/")) jsonResponse(response, 403, {});
    if (request.url!.includes("/check-runs")) jsonResponse(response, 200, { total_count: 2, check_runs: [run({ name: "test (22)" }), run({ name: "test (26)" })] });
  }), async () => {
    const before = snapshot(root);
    for (const names of [[], "", " \n\t\r\n ", ["", "\n"]]) {
      const report = await closeout(root, { pr: "42", apply: true, "required-checks": names });
      assert.equal(report.plan[0]!.code, "needs_review");
      assert.equal(snapshot(root), before);
    }
    // A former space-separated list is one literal name, so observed runs cannot satisfy it.
    const missing = await closeout(root, { pr: "42", apply: true, "required-checks": "test (22) test (26)" });
    assert.equal(missing.plan[0]!.code, "needs_review");
    assert.equal(snapshot(root), before);
    const report = await closeout(root, { pr: "42", apply: true, requiredChecks: ["  test (22)\n\n", "test (26)\r\n"] });
    assert.equal(report.closed, 1);
  });
}));

for (const invalid of [{}, { type: null }, { type: 4 }, { type: {} }, { type: "" },
  { parameters: { required_status_checks: [{ context: "not-run", integration_id: 7 }] } }]) {
  for (const declared of [false, true]) {
    test(`malformed rule discriminator refuses durable closeout ${JSON.stringify(invalid)} declared=${declared}`, async () => tracker(async (root, ids) => {
      await withMockGithub(fixture(link(ids[0]!), (request, response) => {
        if (request.url!.includes("/protection/")) jsonResponse(response, declared ? 403 : 200, { contexts: [], checks: [] });
        if (request.url!.includes("/rules/branches/")) jsonResponse(response, 200, [invalid]);
      }), async () => {
        const before = snapshot(root);
        const report = await closeout(root, { pr: "42", apply: true, ...(declared ? { "required-checks": "CI" } : {}) });
        assert.equal(report.closed, 0);
        assert.equal(report.checks[0]!.code, "head_evidence_unavailable");
        assert.equal(report.checks[0]!.rule, "unavailable");
        assert.equal((await get(ids[0]!, {}, { pmRoot: root })).item.status, "in_progress");
        assert.equal(snapshot(root), before);
      });
    }));
  }
}

test("valid unrelated effective rule retains readable-empty fallback", async () => tracker(async (root, ids) => {
  await withMockGithub(fixture(link(ids[0]!), (request, response) => {
    if (request.url!.includes("/protection/")) jsonResponse(response, 200, { contexts: [], checks: [] });
    if (request.url!.includes("/rules/branches/")) jsonResponse(response, 200, [{ type: "deletion" }]);
  }), async () => {
    const report = await closeout(root, { pr: "42", apply: true });
    assert.equal(report.closed, 1);
    assert.equal(report.checks[0]!.rule, "fallback");
  });
}));

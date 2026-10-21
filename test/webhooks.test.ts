/** Real no-git trackers and HTTP transport prove authenticated durable reconciliation. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, cp, symlink, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { init, create, get } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { acceptGithubWebhook, reconcileGithubWebhooks, WebhookRefusal, type GithubWebhookDelivery } from "../index.ts";
import { runRefresh } from "../refresh.ts";
import { withEnv, withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";
import { boundedCli } from "./helpers/bounded-cli.ts";

const packageRoot = join(import.meta.dirname, "..");
/** Initialize real storage outside git, then remove git from PATH for the entire scenario. */
async function fixture(fn: (root: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pm-webhook-"));
  const root = join(directory, ".agents/pm");
  try {
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root });
    await withEnv({ PM_PATH: root, PM_AUTHOR: "fixture", GITHUB_TOKEN: "fixture", GH_TOKEN: undefined,
      PATH: directory, GIT_CEILING_DIRECTORIES: dirname(directory) }, () => fn(root, directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
/** Sign exact bytes with a synthetic test-only secret. */
function delivery(id = "delivery-1", number = 1, action = "opened", value?: unknown): GithubWebhookDelivery {
  const payload = Buffer.from(value === undefined ? JSON.stringify({ action, repository: { full_name: "fixture/repo" }, issue: { number, state: "open", title: "Sensitive payload content" } }) : String(value));
  const secret = "fixture-webhook-key";
  return { repo: "fixture/repo", delivery: id, event: "issues", secret, payload,
    signature: "sha256=" + createHmac("sha256", secret).update(payload).digest("hex") };
}
/** Byte snapshots include all files, not only items. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = join(entry.parentPath, entry.name);
    return [file.slice(root.length), (await readFile(file)).toString("hex")];
  })));
}
/** Assert a structured refusal rather than matching incidental native error messages. */
async function refused(operation: () => Promise<unknown>, code: WebhookRefusal["code"]) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof WebhookRefusal);
    assert.equal(error.code, code);
    assert.ok(error.remedy.length > 20);
    assert.deepEqual(JSON.parse(error.message), { ok: false, code, remedy: error.remedy });
    return true;
  });
}
/** Simulate provider state at the HTTP boundary; issue lifecycle is independent of event payloads. */
function upstream(state = "CLOSED") {
  return { number: 1, title: "Current provider title", body: "Provider body", state, stateReason: state === "CLOSED" ? "COMPLETED" : "REOPENED",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-03T00:00:00Z", closedAt: state === "CLOSED" ? "2026-02-02T00:00:00Z" : null,
    url: "https://github.com/fixture/repo/issues/1", author: { login: "fixture" },
    labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
}

test("signature failures perform zero writes even on absent storage and duplicate deliveries", async () => fixture(async root => {
  const input = delivery();
  for (const patch of [{ secret: "" }, { signature: "sha1=wrong" }, { signature: "sha256=" + "0".repeat(64) }, { payload: Buffer.from("changed bytes") }]) {
    const before = await snapshot(root);
    await refused(() => acceptGithubWebhook(root, { ...input, ...patch }), "invalid_signature");
    assert.deepEqual(await snapshot(root), before);
  }
  await acceptGithubWebhook(root, input);
  const before = await snapshot(root);
  await refused(() => acceptGithubWebhook(root, { ...input, signature: "bad" }), "invalid_signature");
  assert.deepEqual(await snapshot(root), before);
  await refused(() => acceptGithubWebhook(join(root, "absent"), { ...input, secret: "" }), "invalid_signature");
  assert.deepEqual(await snapshot(root), before);
}));

test("durable concurrent deduplication, repository scope and conflicting delivery bytes", async () => fixture(async root => {
  const input = delivery();
  const results = await Promise.all(Array.from({ length: 4 }, () => acceptGithubWebhook(root, input)));
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  const before = await snapshot(root);
  assert.equal((await acceptGithubWebhook(root, { ...input, repo: "FIXTURE/REPO" })).duplicate, true);
  assert.deepEqual(await snapshot(root), before);
  await refused(() => acceptGithubWebhook(root, delivery("delivery-1", 2)), "delivery_conflict");
  assert.deepEqual(await snapshot(root), before);
  const receipt = Object.entries(before).find(([path]) => path.includes("github-webhooks") && path.endsWith(".json"))!;
  const value = Buffer.from(receipt[1], "hex").toString();
  for (const forbidden of [input.secret, input.signature, "Sensitive payload content", "action"]) assert.ok(!value.includes(forbidden));
  assert.equal(Object.keys(JSON.parse(value)).length, 5);
}));

test("signed unsupported, malformed and cross-repository payloads are refused without writes", async () => fixture(async root => {
  const before = await snapshot(root);
  const base = delivery();
  for (const input of [
    { ...base, repo: "bad" }, { ...base, event: "issue_comment" }, { ...base, delivery: "../../bad" },
    delivery("a", 0), delivery("a", 1.5), delivery("a", 1, ""), delivery("a", 1, "opened", "not-json"),
    delivery("a", 1, "opened", "[]"), delivery("a", 1, "opened", "null"),
    delivery("a", 1, "opened", JSON.stringify({ action: "opened", repository: { full_name: "other/repo" }, issue: { number: 1 } })),
    delivery("a", 1, "opened", JSON.stringify({ action: "opened", repository: { full_name: "fixture/repo" }, issue: { number: 1, pull_request: {} } })),
  ]) await refused(() => acceptGithubWebhook(root, input), input.repo === "bad" ? "invalid_options" : "invalid_event");
  assert.deepEqual(await snapshot(root), before);
  const large = delivery("large", 1, "opened", " ".repeat(25 * 1024 * 1024 + 1));
  await refused(() => acceptGithubWebhook(root, large), "invalid_event");
}));

test("old reopened events cannot regress lifecycle; proposals read current state and polling recovers", async () => fixture(async root => {
  const local = (await create({ title: "Local stale title", tags: "gh:fixture/repo#1" }, { cwd: root, pmRoot: root })).item;
  await create({ title: "Unrelated linked issue", tags: "gh:fixture/repo#2" }, { cwd: root, pmRoot: root });
  for (const [id, action] of [["new", "closed"], ["old", "reopened"], ["missing-link", "opened"]]) await acceptGithubWebhook(root, delivery(id, id === "missing-link" ? 99 : 1, action));
  let state = "CLOSED";
  await withMockGithub((request, response, body) => {
    if (request.url?.includes("/timeline")) { jsonResponse(response, 200, []); return; }
    const query = (JSON.parse(body) as { query: string }).query;
    if (query.includes("timelineItems")) { jsonResponse(response, 200, { data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }); return; }
    jsonResponse(response, 200, { data: { repository: { i1: upstream(state), i2: null } } });
  }, async server => {
    const before = await snapshot(root);
    const receipt = await reconcileGithubWebhooks(root, "fixture/repo");
    assert.equal(receipt.selected, 3);
    assert.equal(receipt.reconciled, 3);
    assert.equal(receipt.unlinked, 1);
    assert.equal(receipt.proposals.length, 1);
    assert.deepEqual(receipt.proposals[0]!.lifecycle.find(change => change.field === "status"), { field: "status", old: "open", new: "closed" });
    const after = await snapshot(root);
    for (const [file, bytes] of Object.entries(before)) assert.equal(after[file], bytes, file);
    assert.equal((await get(local.id, {}, { pmRoot: root, cwd: root })).item.status, "open");
    assert.ok(server.requests.filter(request => !request.body.includes("timelineItems") && request.url === "/graphql").every(request => !request.body.includes("i2:") && !request.body.includes("i99:")));
    const empty = await reconcileGithubWebhooks(root, "fixture/repo", 1);
    assert.equal(empty.selected, 0);
    assert.equal(empty.proposals.length, 0);
    await runRefresh("fixture/repo", root, { atomic: true }, { numbers: [1] });
    assert.equal((await get(local.id, {}, { pmRoot: root, cwd: root })).item.status, "closed");
    await acceptGithubWebhook(root, delivery("older-again", 1, "reopened"));
    assert.equal((await reconcileGithubWebhooks(root, "fixture/repo")).proposals.length, 0);
    state = "OPEN";
    await acceptGithubWebhook(root, delivery("real-reopen", 1, "closed"));
    const reopened = await reconcileGithubWebhooks(root, "fixture/repo");
    assert.ok(reopened.proposals[0]!.lifecycle.some(change => change.field === "status" && change.new === "open"));
  });
}));

test("missing provider state stays pending, limits drain batches, and API failures retry", async () => fixture(async root => {
  await create({ title: "Local", tags: "gh:fixture/repo#1" }, { cwd: root, pmRoot: root });
  await acceptGithubWebhook(root, delivery("first"));
  await acceptGithubWebhook(root, delivery("second"));
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { repository: { i1: null } } }), async () => {
    const report = await reconcileGithubWebhooks(root, "fixture/repo", 1);
    assert.equal(report.retry, 1);
    assert.equal(report.remaining, 2);
    assert.equal(report.reconciled, 0);
  });
  const before = await snapshot(root);
  await withMockGithub((_request, response) => jsonResponse(response, 401, { message: "unauthorized" }), async () => {
    await refused(() => reconcileGithubWebhooks(root, "fixture/repo"), "provider_unavailable");
  });
  assert.deepEqual(await snapshot(root), before);
  for (const limit of [0, -1, 101, NaN, 1.5]) await refused(() => reconcileGithubWebhooks(root, "fixture/repo", limit), "invalid_options");
  await withMockGithub((_request, response) => jsonResponse(response, 200, { data: { repository: { i1: upstream("OPEN") } } }), async () => {
    assert.equal((await reconcileGithubWebhooks(root, "fixture/repo", 1)).remaining, 1);
    assert.equal((await reconcileGithubWebhooks(root, "fixture/repo", 1)).remaining, 0);
  });
}));

test("corrupt receipts fail closed and native storage failures become typed refusals", async () => fixture(async root => {
  await refused(() => acceptGithubWebhook(join(root, "absent"), delivery()), "inbox_unavailable");
  await acceptGithubWebhook(root, delivery());
  const directory = join(root, "github-webhooks", createHash("sha256").update("fixture/repo").digest("hex"));
  const file = join(directory, (await readdir(directory)).find(file => file.endsWith(".json"))!);
  const original = await readFile(file, "utf8");
  for (const value of ["broken", "{}", original.replace('"version":1', '"version":2'), original.replace('"delivery":"delivery-1"', '"delivery":"other"'), original.replace('"number":1', '"number":0')]) {
    await writeFile(file, value);
    await refused(() => reconcileGithubWebhooks(root, "fixture/repo"), "inbox_corrupt");
    await refused(() => acceptGithubWebhook(root, delivery()), "inbox_corrupt");
  }
  await writeFile(file, original);
  await rm(join(root, "github-webhooks"), { recursive: true });
  await writeFile(join(root, "github-webhooks"), "unavailable");
  await refused(() => acceptGithubWebhook(root, delivery()), "inbox_unavailable");
}));

test("registered CLI contracts validate arguments and render compact JSON and TOON without git", async () => fixture(async (root, directory) => {
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "importers", "schema", "hooks", "preflight", "search"] });
  harness.assertCommandContract({ name: "github webhook receive", flags: ["--payload", "--delivery", "--event", "--signature"] });
  harness.assertCommandContract({ name: "github webhook reconcile", flags: ["--limit"] });
  await refused(() => harness.runCommand({ command: "github webhook receive", pmRoot: root }), "invalid_options");
  await refused(() => harness.runCommand({ command: "github webhook reconcile", pmRoot: root }), "invalid_options");
  const input = delivery();
  const payload = join(directory, "payload.json");
  await writeFile(payload, input.payload);
  const options = { payload, delivery: input.delivery, event: input.event, signature: input.signature };
  await refused(() => harness.runCommand({ command: "github webhook receive", args: [input.repo], pmRoot: root, options: { ...options, payload: directory } }), "invalid_event");
  const oversized = join(directory, "oversized");
  const handle = await open(oversized, "w");
  await handle.truncate(25 * 1024 * 1024 + 1); await handle.close();
  await refused(() => harness.runCommand({ command: "github webhook receive", args: [input.repo], pmRoot: root, options: { ...options, payload: oversized } }), "invalid_event");
  await withEnv({ PM_GITHUB_WEBHOOK_SECRET: undefined }, async () => {
    await refused(() => harness.runCommand({ command: "github webhook receive", args: [input.repo], pmRoot: root, options }), "invalid_signature");
  });
  await withEnv({ PM_GITHUB_WEBHOOK_SECRET: input.secret }, async () => {
    await harness.runCommand({ command: "github webhook receive", args: [input.repo], pmRoot: root, options });
  });
  await harness.runCommand({ command: "github webhook reconcile", args: [input.repo], pmRoot: root, options: { limit: "1" } });
  const installed = join(root, "extensions/pm-github");
  await mkdir(installed, { recursive: true });
  await cp(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true });
  for (const file of ["manifest.json", "package.json"]) await cp(join(packageRoot, file), join(installed, file));
  await symlink(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir");
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  for (const format of ["json", "toon"]) {
    const result = await boundedCli(process.execPath, [cli, "--path", root, ...(format === "json" ? ["--json"] : []), "github", "webhook", "reconcile", input.repo], directory, process.env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.length < 1500, result.stdout);
    if (format === "json") assert.equal(JSON.parse(result.stdout).selected, 0);
    else assert.match(result.stdout, /selected: 0/);
  }
}));

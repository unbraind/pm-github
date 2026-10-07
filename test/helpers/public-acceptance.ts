/** Packed public-data acceptance; opt-in command, never a public writer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundedCli } from "./bounded-cli.ts";
import { startMockGithub, jsonResponse } from "./mock-github-server.ts";
import type { GhIssue, GhComment } from "../../index.ts";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "pm-packed-public-"));
const root = path.join(base, "work");
fs.mkdirSync(root);
const cli = fs.realpathSync(path.join(packageRoot, "node_modules/.bin/pm"));
const env: NodeJS.ProcessEnv & { PM_PATH: string } = { ...process.env, PM_AUTHOR: "codex-sol", PM_PATH: path.join(root, ".agents/pm"),
  PATH: path.dirname(cli) + path.delimiter + path.join(packageRoot, "node_modules/.bin") + path.delimiter + process.env.PATH };
delete env.PM_GITHUB_API_BASE;
delete env.NODE_TEST_CONTEXT;
delete env.NODE_V8_COVERAGE;
/**
 * Run a fixture command and require success.
 *
 * @param bin - Executable to run.
 * @param args - Arguments for the executable.
 * @param cwd - Working directory (the fixture workspace by default).
 * @param environment - Environment for this call (the fixture env by default).
 * @returns The command's stdout.
 */
function setup(bin: string, args: string[], cwd = root, environment: NodeJS.ProcessEnv = env): string {
  const result = spawnSync(bin, args, { cwd, env: environment, encoding: "utf8", timeout: 45000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function run(bin: string, args: string[]): Promise<{ seconds: number; output: string }> {
  const before = snapshot();
  const result = await boundedCli(bin, args, root, env);
  if (result.timedOut) assert.equal(snapshot(), before, "timed-out acceptance must preserve durable tracker bytes");
  assert.equal(result.timedOut, false, "installed CLI exceeded its original 45s deadline");
  assert.equal(result.code, 0, result.stderr);
  return { seconds: result.seconds, output: result.stdout };
}

function snapshot(): string {
  const files = setup("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".agents/pm"])
    .split("\0").filter(file => file && !["extensions", "locks", "runtime", "transactions", "checkpoints"].includes(file.slice(".agents/pm/".length).split("/")[0]!)).sort();
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update(fs.readFileSync(path.join(root, file)));
  return digest.digest("hex");
}
let server: Awaited<ReturnType<typeof startMockGithub>> | undefined;
try {
  const issues = setup("gh", ["api", "repos/unbraind/pm-todos/issues?state=all&since=2026-10-01T00:00:00Z&per_page=100", "--paginate", "--jq", ".[] | select(.pull_request == null) | @json"]).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as GhIssue);
  assert.ok(issues.length > 0);
  const comments = new Map<number, GhComment[]>();
  for (const issue of issues) comments.set(issue.number, setup("gh", ["api", `repos/unbraind/pm-todos/issues/${issue.number}/comments?per_page=100`, "--paginate", "--jq", ".[] | @json"]).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as GhComment));
  server = await startMockGithub((request, response) => {
    const match = /issues\/(\d+)\/comments/.exec(request.url ?? "");
    jsonResponse(response, 200, match ? comments.get(Number(match[1])) : issues);
  });
  env.PM_GITHUB_API_BASE = server.baseUrl;
  setup("git", ["init", "-q", "-b", "main"]);
  setup("git", ["config", "user.name", "Fixture"]);
  setup("git", ["config", "user.email", "fixture@example.invalid"]);
  setup("node", [cli, "--path", env.PM_PATH, "init", "fixture"]);
  // npm 10 runs `prepare` even with --ignore-scripts: give it this checkout's
  // tracker (not the fixture PM_PATH) and keep its stdout out of the JSON
  // receipt, exactly like packWorkflowCandidate in test/import-gate.test.ts.
  const packed = JSON.parse(setup("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", base], packageRoot,
    { ...env, PM_PATH: path.join(packageRoot, ".agents", "pm") })) as [{ filename: string }];
  setup("node", [cli, "package", "install", path.join(base, packed[0].filename), "--project"]);
  const args = [cli, "github", "import", "unbraind/pm-todos", "--state", "all", "--since", "2026-10-01T00:00:00Z", "--atomic", "--gate", "--with-comments", "--json"];
  console.log("public snapshot: imported through the packed Node/Bun CLI HTTP boundary");
  const first = await run("node", args);
  const result = JSON.parse(first.output) as { imported: number; gate: { verdict: string } };
  assert.ok(result.imported > 0);
  assert.equal(result.gate.verdict, "pass");
  const before = snapshot();
  const repeats: number[] = [];
  for (const bin of ["node", "bun", "bun", "bun"]) {
    console.log(`${bin} repeat starting`);
    const repeat = await run(bin, bin === "bun" ? ["--bun", ...args] : args);
    assert.equal(snapshot(), before, "repeat must preserve all durable tracker bytes");
    assert.equal((JSON.parse(repeat.output) as { gate: { verdict: string } }).gate.verdict, "pass");
    repeats.push(repeat.seconds);
  }
  await run("node", [cli, "health", "--strict-exit", "--json"]);
  assert.equal(setup("git", ["remote"]).trim(), "");
  console.log(JSON.stringify({ imported: result.imported, gate: result.gate.verdict, import_seconds: first.seconds,
    node_repeat_seconds: repeats[0], bun_repeat_seconds: repeats.slice(1), strict_health: "pass", live_public_snapshot: true, since: "2026-10-01", no_remote: true }));
} finally { await server?.close(); fs.rmSync(base, { recursive: true, force: true }); }

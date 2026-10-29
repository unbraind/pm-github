/** Serial, credential-free packed acceptance against real current npm and Bun hosts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { init, PmClient } from "@unbrained/pm-cli/sdk";
import { boundedCli } from "./helpers/bounded-cli.ts";
import { discussionSource, discussionRequest } from "./helpers/discussions.ts";
import { withMockGithub, jsonResponse } from "./helpers/mock-github-server.ts";

/** Public package reads never inherit credentials, personal npm config or test instrumentation. */
function publicEnvironment(): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const key of Object.keys(result)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|^NPM_MEDIA_SERVER$|^npm_config_|^NODE_OPTIONS$|^NODE_TEST_CONTEXT$|^NODE_V8_COVERAGE$/i.test(key)) delete result[key];
  result.NPM_CONFIG_USERCONFIG = "/dev/null";
  return result;
}
/** Install/build operations are serial and bounded; successful tool output stays out of receipts. */
function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

const repository = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pm-discussion-packed-"));
const environment = publicEnvironment();
try {
  const pack = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository, environment)) as { filename: string; files: { path: string }[] }[];
  const artifact = join(scratch, pack[0]!.filename);
  assert.ok(pack[0]!.files.some(file => file.path === "dist/discussions.js"));
  assert.ok(pack[0]!.files.some(file => file.path === "docs/discussion-capture-example.json"));
  const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const local = join(scratch, "local"); mkdirSync(local);
  writeFileSync(join(local, "package.json"), '{"private":true,"type":"module"}');
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28", artifact], local, environment);
  const npmGlobal = join(scratch, "npm-global");
  run("npm", ["install", "--global", "--prefix", npmGlobal, "--ignore-scripts", "--no-audit", "--no-fund", "@unbrained/pm-cli@2026.10.28", artifact], scratch, environment);
  const bunInstall = join(scratch, "bun");
  const bunEnvironment = { ...environment, BUN_INSTALL: bunInstall };
  run("bun", ["add", "--global", "--ignore-scripts", "@unbrained/pm-cli@2026.10.28", artifact], scratch, bunEnvironment);
  const nodeModules = join(local, "node_modules");
  const modes = [
    { name: "project-local", command: join(nodeModules, ".bin/pm"), args: [], pkg: join(nodeModules, "pm-github"), cwd: local, environment },
    { name: "npm-global", command: join(npmGlobal, "bin/pm"), args: [], pkg: join(npmGlobal, "lib/node_modules/pm-github"), cwd: scratch, environment },
    { name: "bun-global", command: join(bunInstall, "bin/pm"), args: [], pkg: join(bunInstall, "install/global/node_modules/pm-github"), cwd: scratch, environment: bunEnvironment },
    { name: "npx", command: "npx", args: ["--no-install", "pm"], pkg: join(nodeModules, "pm-github"), cwd: local, environment },
    { name: "bunx", command: "bunx", args: ["--bun", "--no-install", "pm"], pkg: join(nodeModules, "pm-github"), cwd: local, environment },
  ];
  const receipts: { mode: string; created: number; unchanged: number; sdk_readback: boolean }[] = [];
  for (const mode of modes) {
    const directory = join(scratch, `tracker-${mode.name}`); mkdirSync(directory);
    const root = join(directory, "tracker");
    await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { cwd: directory, pmRoot: root, noExtensions: true });
    const client = new PmClient({ pmRoot: root, noExtensions: true, author: "fixture" });
    const item = (await client.create({ type: "Task", title: "Packed context", parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] })).item.id;
    const installed = await boundedCli(mode.command, [...mode.args, "--path", root, "package", "install", artifact, "--project", "--json"], mode.cwd, { ...mode.environment, PM_AUTHOR: "fixture", PM_PATH: root }, 120000);
    assert.equal(installed.code, 0, installed.stderr + installed.stdout);
    const source = discussionSource();
    const input = join(directory, "selection.json"); writeFileSync(input, JSON.stringify(discussionRequest(item, source)));
    await withMockGithub((req, res) => jsonResponse(res, 200, req.url === "/repos/fixture/repo/issues/3" ? { number: 3 } : source), async server => {
      const childEnvironment = { ...mode.environment, PM_AUTHOR: "fixture", PM_PATH: root, GIT_CEILING_DIRECTORIES: scratch, PM_GITHUB_API_BASE: server.baseUrl, GITHUB_TOKEN: "fixture" };
      /** Run the real installed extension host; JSON is decoded without any custom normalization. */
      async function invoke(extra: string[]) {
        const result = await boundedCli(mode.command, [...mode.args, "--path", root, ...extra, "--json"], mode.cwd, childEnvironment, 120000);
        assert.equal(result.code, 0, result.stderr + result.stdout);
        return JSON.parse(result.stdout) as { approval: string; created: number; unchanged: number; rows: { id: string }[]; item: { body: string } };
      }
      const args = ["github", "discussion", "capture", "--input", input];
      const plan = await invoke(args);
      const applied = await invoke([...args, "--approve", plan.approval]); assert.equal(applied.created, 1);
      const repeated = await invoke([...args, "--approve", plan.approval]); assert.equal(repeated.unchanged, 1);
      const native = await invoke(["get", applied.rows[0]!.id, "--full"]);
      assert.equal(JSON.parse(native.item.body).span.quote, source.body);
      assert.ok(server.requests.every(request => request.method === "GET"));
      receipts.push({ mode: mode.name, created: applied.created, unchanged: repeated.unchanged, sdk_readback: true });
    });
  }
  assert.equal(createHash("sha256").update(readFileSync(artifact)).digest("hex"), sha256);
  console.log(JSON.stringify({ cli: "2026.10.28", artifact_sha256: sha256, modes: receipts.length, receipts }));
} finally { rmSync(scratch, { recursive: true, force: true }); }

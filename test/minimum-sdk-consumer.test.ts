/** The shipped artifact and every authored SDK import must work at the enforced minimum, independently of the dev lock. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeToolingExecutable } from "../scripts/main-invocation.ts";

const repo = join(import.meta.dirname, "..");
const cli = "@unbrained/pm-cli";

/** Public npm operations never inherit credentials or a personal npm configuration. */
function publicEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(result)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|^NPM_MEDIA_SERVER$|^npm_config_/i.test(key)) delete result[key];
  }
  result.NPM_CONFIG_USERCONFIG = "/dev/null";
  result.npm_config_userconfig = "/dev/null";
  result.GOMAXPROCS = "2";
  delete result.NODE_OPTIONS;
  // Allow an explicit transport timer while discarding inherited Node flags.
  const networkTimer = process.env.PM_GITHUB_TEST_NETWORK_ATTEMPT_TIMEOUT_MS;
  if (networkTimer !== undefined) {
    assert.ok(/^[1-9]\d{0,4}$/.test(networkTimer), "Registry transport timer must be a bounded positive integer");
    result.NODE_OPTIONS = `--network-family-autoselection-attempt-timeout=${networkTimer}`;
  }
  delete result.NODE_TEST_CONTEXT;
  delete result.NODE_V8_COVERAGE;
  return result;
}

/** Run one bounded real consumer process; failures retain diagnostics without printing successful install logs. */
function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

/** Check shipped declaration bytes as ambient TypeScript sources so skipLibCheck cannot hide a missing SDK type. */
function copyDeclarationSources(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDeclarationSources(join(from, entry.name), join(to, entry.name));
    else if (entry.name.endsWith(".d.ts")) cpSync(join(from, entry.name), join(to, entry.name.replace(/\.d\.ts$/, ".ts")));
  }
}

test("packed package type-checks and imports against its exact declared minimum SDK from npm", { timeout: 900000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "pm-minimum-sdk-"));
  try {
    const environment = { ...publicEnvironment(), GIT_CEILING_DIRECTORIES: dirname(scratch), PM_AUTHOR: "fixture" };
    const node = nodeToolingExecutable(process.versions);
    const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8")) as { pm_min_version: string };
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      dependencies: Record<string, string>; devDependencies: Record<string, string>; peerDependencies: Record<string, string>;
    };
    const minimum = manifest.pm_min_version;
    assert.match(minimum, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.peerDependencies[cli], `>=${minimum}`);
    assert.match(pkg.devDependencies[cli]!, /^\d+\.\d+\.\d+$/, "the development pin is independent of the consumer floor");
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repo, environment)) as { filename: string }[];
    assert.equal(packed.length, 1);
    const consumer = join(scratch, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "minimum-sdk-fixture", version: "0.0.0", private: true, type: "module",
      dependencies: { ...pkg.dependencies, typescript: pkg.devDependencies.typescript, "@types/node": pkg.devDependencies["@types/node"],
        [cli]: minimum, "pm-github": `file:${join(scratch, packed[0]!.filename)}` } }));
    console.log(`minimum SDK ${minimum}: installing isolated packed consumer`);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], consumer, environment);
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { version: string };
    assert.equal(installed.version, minimum, "the floor fixture must not silently resolve the development SDK");
    // Operational scripts need real pm-ops types, but its peer graph belongs to tooling.
    // A synthetic tool deliberately requires the newer dev SDK: flattening this
    // graph into the consumer would reproduce ERESOLVE even without pm-ops.
    const tooling = join(scratch, "tooling"), peerTool = join(scratch, "dev-peer");
    mkdirSync(tooling); mkdirSync(peerTool);
    writeFileSync(join(peerTool, "package.json"), JSON.stringify({ name: "minimum-sdk-dev-peer", version: "0.0.0",
      peerDependencies: { [cli]: pkg.devDependencies[cli] } }));
    writeFileSync(join(tooling, "package.json"), JSON.stringify({ name: "minimum-sdk-tooling", version: "0.0.0", private: true,
      dependencies: { "pm-ops": pkg.devDependencies["pm-ops"], [cli]: pkg.devDependencies[cli], "minimum-sdk-dev-peer": `file:${peerTool}` } }));
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], tooling, environment);
    const toolingSdk = JSON.parse(readFileSync(join(tooling, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { version: string };
    assert.equal(toolingSdk.version, pkg.devDependencies[cli], "the incompatible tool peer must resolve independently");
    assert.notEqual(toolingSdk.version, minimum, "the regression fixture must exercise distinct SDK graphs");
    symlinkSync(join(tooling, "node_modules/pm-ops"), join(consumer, "node_modules/pm-ops"), "junction");

    writeFileSync(join(consumer, "import.mjs"), 'import extension from "pm-github"; if (!extension) throw new Error("Missing packed extension");\n');
    console.log(`minimum SDK ${minimum}: linking the entire packed extension`);
    run(process.execPath, ["import.mjs"], consumer, { ...environment, PATH: consumer });
    const source = join(consumer, "source");
    mkdirSync(source);
    // Checking authored .ts files catches missing type-only imports even with dependency declaration checks skipped.
    const sources = readdirSync(repo).filter(name => name.endsWith(".ts"));
    for (const name of sources) cpSync(join(repo, name), join(source, name));
    cpSync(join(repo, "scripts"), join(source, "scripts"), { recursive: true });
    // Include the proof's shared corpus dependency in the complete source witness.
    mkdirSync(join(source, "test"));
    cpSync(join(repo, "test/gate-public-forms-corpus.ts"), join(source, "test/gate-public-forms-corpus.ts"));
    copyDeclarationSources(join(consumer, "node_modules/pm-github/dist"), join(consumer, "declaration-audit"));
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
      skipLibCheck: true, esModuleInterop: true, allowImportingTsExtensions: true, erasableSyntaxOnly: true, types: ["node"],
    }, include: ["source/**/*.ts", "declaration-audit/**/*.ts", "consumer.ts"] }));
    writeFileSync(join(consumer, "consumer.ts"), 'import extension, { planGithubLabelMigration, validateGithubLabelMigrationReport, type GithubLabelMigrationInput } from "pm-github";\nvoid extension; void planGithubLabelMigration; void validateGithubLabelMigrationReport; const request: GithubLabelMigrationInput | undefined = undefined; void request;\n');
    console.log(`minimum SDK ${minimum}: checking every production and operational TypeScript module`);
    run(node, [join(consumer, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], consumer, environment);
    writeFileSync(join(consumer, "probe.mjs"), `import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import extension, { planGithubLabelMigration, validateGithubLabelMigrationReport, buildAtomicImportMutations } from "pm-github";
import { readGithubImportOwner, mutateGithubOwnedItem } from "pm-github/dist/import-ownership.js";
import { init, create, update, get, mutateItem, readSettings, encodePmTableRows, normalizeItemId } from "@unbrained/pm-cli/sdk";
assert.ok(extension);
const root = join(process.cwd(), "tracker");
await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: process.cwd(), noExtensions: true });
const scope = { clearDeps: true, unset: ["parent", "sprint", "release", "goal", "objective"] };
const item = (await create({ title: "Minimum SDK witness", type: "Task", tags: "bug", ...scope }, { pmRoot: root })).item;
const assigned = spawnSync(process.execPath, [join(process.cwd(), "node_modules/.bin/pm"), "--path", root, "update", item.id, "--stdin-json"], {
  encoding: "utf8", input: JSON.stringify({ assignee: "floor-witness", sprint: "literal milestone" }),
});
assert.equal(assigned.status, 0, assigned.stderr + assigned.stdout);
assert.equal((await get(item.id, {}, { pmRoot: root })).item.assignee, "floor-witness");
assert.equal((await get(item.id, {}, { pmRoot: root })).item.sprint, "literal milestone");
const input = { repo: "fixture/repo", sources: [{ id: "LABEL", name: "bug, BUG" }], change: { kind: "rename", name: "planned/defect" },
  filters: [], mappings: [], choices: { tags: "keep", filters: "keep", mappings: "keep" } };
const readCatalog = async () => ({ complete: true, labels: input.sources });
const report = await planGithubLabelMigration(root, input, { readCatalog });
assert.equal(report.counts.tags, 1);
const encoded = encodePmTableRows(report.rows);
assert.deepEqual(validateGithubLabelMigrationReport({ ...report, rows: encoded.rows, rows_encoding: encoded.encoding }), report);
assert.equal((await planGithubLabelMigration(root, input, { readCatalog, approval: report.approval })).checked, true);
const settings = await readSettings(root);
await mutateItem({ pmRoot: root, settings, id: item.id, author: "fixture", op: "update", mutate: document => {
  document.metadata.tags = [" BUG, bug "]; return { changedFields: ["tags"] };
} });
assert.deepEqual((await get(item.id, {}, { pmRoot: root })).item.tags, ["bug, bug"]);
const zero = await planGithubLabelMigration(root, input, { readCatalog });
assert.equal(zero.counts.tags, 0);
assert.deepEqual(validateGithubLabelMigrationReport({ ...zero, rows: undefined, next: undefined }), zero);
const owner = (await get(item.id, {}, { pmRoot: root })).item;
const additive = buildAtomicImportMutations("fixture/repo", { issueNumber: 1, title: owner.title, itemType: owner.type,
  status: owner.status, description: "", body: "", tags: [...owner.tags, '["array"]', "gh:fixture/repo#1"],
  comments: [], syncAnnotations: false, linkOnly: true, match: owner }, settings.id_prefix, normalizeItemId);
assert.equal(additive.mutations[0].op, "update");
await update(owner.id, { ...additive.mutations[0].options, ...scope }, { pmRoot: root });
const preserved = (await get(owner.id, {}, { pmRoot: root })).item;
assert.ok(preserved.tags.includes("bug, bug"));
assert.ok(preserved.tags.includes('["array"]'));
assert.ok(!preserved.tags.includes("array"));

await mutateItem({ pmRoot: root, settings, id: item.id, author: "fixture", op: "update", mutate: document => {
  document.metadata.github_url = "https://github.com/fixture/repo/issues/1";
  document.metadata.github_repo = "fixture/repo"; document.metadata.github_number = 1;
  return { changedFields: ["github_url", "github_repo", "github_number"] };
} });
const target = { id: item.id, repo: "fixture/repo", number: 1 };
const revision = await readGithubImportOwner(root, target);
assert.match(revision, /^[a-f0-9]{64}$/);
await mutateGithubOwnedItem(root, target, "update", { title: "Owned minimum-SDK update" }, revision);
assert.equal((await get(item.id, {}, { pmRoot: root })).item.title, "Owned minimum-SDK update");
await assert.rejects(() => mutateGithubOwnedItem(root, target, "update", { title: "Stale revision rejected" }, revision), /revision|hash|changed/i);

console.log(JSON.stringify({ sdk: ${JSON.stringify(minimum)}, extension_import: true, encoded_rows: true, native_comma: true, json_tag: true, non_git: true }));
`);
    console.log(`minimum SDK ${minimum}: importing and exercising the installed artifact`);
    const result = JSON.parse(run(process.execPath, ["probe.mjs"], consumer, { ...environment, PATH: consumer })) as { sdk: string; extension_import: boolean; encoded_rows: boolean; native_comma: boolean; json_tag: boolean; non_git: boolean };
    assert.deepEqual(result, { sdk: minimum, extension_import: true, encoded_rows: true, native_comma: true, json_tag: true, non_git: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

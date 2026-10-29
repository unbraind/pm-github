/** The shipped artifact and every authored SDK import must work at the enforced minimum, independently of the dev lock. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(pkg.devDependencies[cli], `>=${minimum}`);
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repo, environment)) as { filename: string }[];
    assert.equal(packed.length, 1);
    const consumer = join(scratch, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "minimum-sdk-fixture", version: "0.0.0", private: true, type: "module",
      dependencies: { ...pkg.dependencies, ...pkg.devDependencies, [cli]: minimum, "pm-github": `file:${join(scratch, packed[0]!.filename)}` } }));
    console.log(`minimum SDK ${minimum}: installing isolated packed consumer`);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], consumer, environment);
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { version: string };
    assert.equal(installed.version, minimum, "the floor fixture must not silently resolve the development SDK");
    writeFileSync(join(consumer, "import.mjs"), 'import extension from "pm-github"; if (!extension) throw new Error("Missing packed extension");\n');
    console.log(`minimum SDK ${minimum}: linking the entire packed extension`);
    run(process.execPath, ["import.mjs"], consumer, { ...environment, PATH: consumer });
    const source = join(consumer, "source");
    mkdirSync(source);
    // Checking authored .ts files catches missing type-only imports even with dependency declaration checks skipped.
    const sources = readdirSync(repo).filter(name => name.endsWith(".ts"));
    for (const name of sources) cpSync(join(repo, name), join(source, name));
    cpSync(join(repo, "scripts"), join(source, "scripts"), { recursive: true });
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
import extension, { planGithubLabelMigration, validateGithubLabelMigrationReport, buildAtomicImportMutations } from "pm-github";
import { init, create, update, get, mutateItem, readSettings, encodePmTableRows, normalizeItemId } from "@unbrained/pm-cli/sdk";
assert.ok(extension);
const root = join(process.cwd(), "tracker");
await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: root, cwd: process.cwd(), noExtensions: true });
const scope = { parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] };
const item = (await create({ title: "Minimum SDK witness", type: "Task", tags: "bug", ...scope }, { pmRoot: root })).item;
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

console.log(JSON.stringify({ sdk: ${JSON.stringify(minimum)}, extension_import: true, encoded_rows: true, native_comma: true, json_tag: true, non_git: true }));
`);
    console.log(`minimum SDK ${minimum}: importing and exercising the installed artifact`);
    const result = JSON.parse(run(process.execPath, ["probe.mjs"], consumer, { ...environment, PATH: consumer })) as { sdk: string; extension_import: boolean; encoded_rows: boolean; native_comma: boolean; json_tag: boolean; non_git: boolean };
    assert.deepEqual(result, { sdk: minimum, extension_import: true, encoded_rows: true, native_comma: true, json_tag: true, non_git: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

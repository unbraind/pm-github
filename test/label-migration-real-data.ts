/** Opt-in public tracker and packed installation acceptance. Never reads private or hosted data. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, rmSync, copyFileSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { planGithubLabelMigration, readGithubLabelCatalog, validateGithubLabelMigrationReport, type GithubLabelMigrationInput } from "../index.ts";
import { decode } from "@toon-format/toon";

const packageRoot = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pm-label-public-"));
const copies: string[] = [];
const environment: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: dirname(scratch) };
for (const key of Object.keys(environment)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|^NPM_MEDIA_SERVER$|^npm_config_.*auth/i.test(key) || (/^npm_config_userconfig$/i.test(key) && key !== "NPM_CONFIG_USERCONFIG")) delete environment[key];
/** Register the actual installed artifact without changing its dependency layout. */
function installedExtension(root: string, extensionPath: string): void {
  mkdirSync(join(root, "extensions"), { recursive: true });
  const installed = join(root, "extensions/pm-github");
  mkdirSync(installed);
  copyFileSync(join(extensionPath, "package.json"), join(installed, "package.json"));
  const manifest = JSON.parse(readFileSync(join(extensionPath, "manifest.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(installed, "manifest.json"), JSON.stringify({ ...manifest, entry: "./entry.js" }));
  writeFileSync(join(installed, "entry.js"), `export { default } from ${JSON.stringify(pathToFileURL(join(extensionPath, "dist/index.js")).href)};\n`);
}
/** Keep malformed public wire evidence visible without dumping a minified SDK stack. */
function validatedWire(value: unknown) {
  try { return validateGithubLabelMigrationReport(value); }
  catch (error) { console.error(`Invalid public wire report: ${JSON.stringify(value)}`); throw error; }
}
/** Run one exact consumer command without exposing successful install logs. */
function run(binary: string, args: string[], cwd = packageRoot, overrides: NodeJS.ProcessEnv = {}, expectedStatus = 0): string {
  const installing = args[0] === "install" || args[0] === "add";
  const result = spawnSync(binary, args, { cwd, env: { ...environment, ...overrides }, encoding: "utf8", timeout: installing ? 600000 : 180000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, expectedStatus, `${binary.split("/").at(-1)}: ${result.error?.message ?? result.stderr}`);
  return expectedStatus === 0 ? result.stdout : result.stdout + result.stderr;
}
/** Enumerate only ordinary public tracker entries, never installed extension dependencies. */
function trackerEntries(root: string): { path: string; directory: boolean }[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "extensions" || entry.isSymbolicLink()) return [];
    const path = join(root, entry.name);
    return [{ path, directory: entry.isDirectory() }, ...(entry.isDirectory() ? trackerEntries(path) : [])];
  });
}
/** Hash public tracker bytes, excluding explicitly installed extension files. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of trackerEntries(root).filter(entry => !entry.directory).sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path.slice(root.length)).update(readFileSync(entry.path));
  }
  return hash.digest("hex");
}
/** Extract only the public tracked tracker, never git metadata or a working tracker mutation. */
function publicCopy(name: string, extensionPath?: string): string {
  const directory = join(scratch, `tracker-${name}`);
  mkdirSync(directory);
  const archive = spawnSync("git", ["archive", "origin/main", ".agents/pm"], { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(archive.status, 0);
  assert.equal(spawnSync("tar", ["-x", "-C", directory], { input: archive.stdout }).status, 0);
  const root = join(directory, ".agents/pm");
  copies.push(root);
  if (extensionPath) installedExtension(root, extensionPath);
  for (const entry of trackerEntries(root)) chmodSync(entry.path, entry.directory ? 0o555 : 0o444);
  chmodSync(root, 0o555);
  return root;
}

try {
  const visibility = JSON.parse(run("gh", ["api", "repos/unbraind/pm-github", "--jq", "{visibility}"])) as { visibility: string };
  assert.equal(visibility.visibility, "public");
  const revision = run("git", ["rev-parse", "origin/main"]).trim();
  const catalog = await readGithubLabelCatalog("unbraind/pm-github");
  const source = catalog.labels.find(label => label.name === "bug")!;
  assert.ok(source);
  const input: GithubLabelMigrationInput = { repo: "unbraind/pm-github", sources: [source], change: { kind: "rename", name: "planned/defect" },
    filters: [{ id: "declared-import-example", labels: ["BUG"] }], mappings: [{ id: "declared-export-example", from: "local-defect", to: "BuG" }],
    choices: { tags: "keep", filters: "replace", mappings: "replace" } };
  const root = publicCopy("sdk");
  const before = fingerprint(root);
  const start = performance.now();
  const report = await planGithubLabelMigration(root, input, { readCatalog: async () => catalog, page: { limit: 5 } });
  assert.ok(report.counts.items > 0);
  assert.equal(report.counts.filters, 1, "mixed-case import policies stay affected");
  assert.equal(report.counts.mappings, 1, "mixed-case export policies stay affected");
  const checked = await planGithubLabelMigration(root, input, { readCatalog: async () => catalog, approval: report.approval, page: { limit: 5 } });
  assert.equal(checked.checked, true);
  assert.equal(fingerprint(root), before);
  console.log(JSON.stringify({ public_tracker: "unbraind/pm-github", revision, provider_labels: catalog.labels.length,
    counts: report.counts, rows: report.rows.length, json_bytes: Buffer.byteLength(JSON.stringify(report)),
    plan_and_check_ms: Math.round(performance.now() - start), unchanged_tracker: true, non_git: true }));

  const requestFile = join(scratch, "request.json");
  const catalogFile = join(scratch, "catalog.json");
  writeFileSync(requestFile, JSON.stringify(input));
  writeFileSync(catalogFile, JSON.stringify(catalog));
  // Explicit synthetic offline catalog exercises CSV label names without changing provider labels or native data.
  const csvSource = { id: "DECLARED_CSV_EXAMPLE", name: "bug, BUG" };
  const csvCatalog = { complete: true, labels: [csvSource] };
  const csvInput: GithubLabelMigrationInput = { ...input, sources: [csvSource], filters: [], mappings: [],
    change: { kind: "rename", name: "planned/defect, next" }, choices: { ...input.choices, tags: "review" } };
  const csvRequestFile = join(scratch, "csv-request.json");
  const csvCatalogFile = join(scratch, "csv-catalog.json");
  writeFileSync(csvRequestFile, JSON.stringify(csvInput));
  writeFileSync(csvCatalogFile, JSON.stringify(csvCatalog));
  const csvReport = await planGithubLabelMigration(root, csvInput, { readCatalog: async () => csvCatalog, page: { limit: 5 } });
  assert.equal(csvReport.counts.tags, report.counts.tags);
  assert.ok(csvReport.rows.every(row => row.kind === "tags" && row.after_tags.join(",") === "next,planned/defect"));
  run("npm", ["run", "build"]);
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", scratch])) as [{ filename: string }];
  const tarball = join(scratch, packed[0].filename);
  const packedBytes = readFileSync(tarball);
  console.log(JSON.stringify({ packed_sha256: createHash("sha256").update(packedBytes).digest("hex"), packed_bytes: packedBytes.length }));
  const tooling = join(scratch, "tooling");
  run("npm", ["install", "--no-audit", "--no-fund", "--prefix", tooling, "--no-package-lock", "--no-save", "bun@1.3.14"]);
  const bun = join(tooling, "node_modules/.bin/bun");
  const local = join(scratch, "local");
  mkdirSync(local);
  writeFileSync(join(local, "package.json"), '{"name":"label-acceptance","private":true,"type":"module"}');
  console.log("Installing isolated packed consumers");
  run("npm", ["install", "--no-audit", "--no-fund", "--prefix", local, "--ignore-scripts", "--no-package-lock", "@unbrained/pm-cli@2026.10.26", tarball]);
  const npmGlobal = join(scratch, "npm-global");
  run("npm", ["install", "--no-audit", "--no-fund", "--global", "--prefix", npmGlobal, "--ignore-scripts", "@unbrained/pm-cli@2026.10.26", tarball]);
  const bunGlobal = join(scratch, "bun-global");
  const bunBin = join(scratch, "bun-bin");
  mkdirSync(bunGlobal);
  mkdirSync(bunBin);
  writeFileSync(join(bunGlobal, "package.json"), '{"name":"global-label-acceptance","private":true}');
  run(bun, ["add", "--global", "--ignore-scripts", "@unbrained/pm-cli@2026.10.26", tarball], packageRoot,
    { BUN_INSTALL_GLOBAL_DIR: bunGlobal, BUN_INSTALL_BIN: bunBin });
  const sdkProof = join(local, "sdk-proof.ts");
  writeFileSync(sdkProof, `import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { init, create, get, mutateItem, readSettings, update, normalizeItemId, encodePmTableRows } from "@unbrained/pm-cli/sdk";
import { planGithubLabelMigration, validateGithubLabelMigrationReport, prepareGithubImport, parseImportOptions, buildAtomicImportMutations, type GithubLabelMigrationInput } from ${JSON.stringify(pathToFileURL(join(local, "node_modules/pm-github/dist/index.js")).href)};
const input = JSON.parse(readFileSync(${JSON.stringify(requestFile)}, "utf8")) as GithubLabelMigrationInput;
const catalog: unknown = JSON.parse(readFileSync(${JSON.stringify(catalogFile)}, "utf8"));
const report = await planGithubLabelMigration(${JSON.stringify(root)}, input, { readCatalog: async () => catalog, page: { limit: 5 } });
const table = encodePmTableRows(report.rows);
assert.deepEqual(validateGithubLabelMigrationReport({ ...report, next: undefined, rows: table.rows, rows_encoding: table.encoding }), report);
const filterIndex = report.rows.findIndex(row => row.kind === "filters");
const bad = { ...report, rows: table.rows.map(row => ({ ...row })), rows_encoding: { ...table.encoding, absent: [[filterIndex, "after_tags"]] } };
delete bad.rows[filterIndex]!.after_tags;
const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "after_tags");
try {
  Object.defineProperty(Object.prototype, "after_tags", { value: null, configurable: true, writable: true });
  assert.throws(() => validateGithubLabelMigrationReport(bad), (error: unknown) => (error as { code?: string }).code === "invalid_output");
} finally {
  if (descriptor) Object.defineProperty(Object.prototype, "after_tags", descriptor);
  else Reflect.deleteProperty(Object.prototype, "after_tags");
}
const runtime = process.versions.bun ? "bun" : "node";
const nativeRoot = ${JSON.stringify(join(local, "native-proof-"))} + runtime;
mkdirSync(nativeRoot);
await init("fixture", { defaults: true, withPackages: false, agentGuidance: "skip" }, { pmRoot: nativeRoot, cwd: nativeRoot, noExtensions: true });
const scope = { parent: "none", clearDeps: true, unset: ["sprint", "release", "goal", "objective"] };
const target = (await create({ title: "Literal native comma", type: "Task", ...scope }, { pmRoot: nativeRoot })).item;
const settings = await readSettings(nativeRoot);
/** Seed native array state through the SDK without routing it through command CSV options. */
async function seedNative() {
  await mutateItem({ pmRoot: nativeRoot, settings, id: target.id, author: "fixture", op: "update", mutate: document => {
    document.metadata.tags = [" BUG, bug "];
    return { changedFields: ["tags"] };
  } });
}
await seedNative();
const nativeBefore = (await get(target.id, {}, { pmRoot: nativeRoot })).item;
assert.deepEqual(nativeBefore.tags, ["bug, bug"]);
const csvInput = JSON.parse(readFileSync(${JSON.stringify(csvRequestFile)}, "utf8")) as GithubLabelMigrationInput;
const csvCatalog: unknown = JSON.parse(readFileSync(${JSON.stringify(csvCatalogFile)}, "utf8"));
const nativePlan = await planGithubLabelMigration(nativeRoot, csvInput, { readCatalog: async () => csvCatalog });
assert.equal(nativePlan.counts.tags, 0);
assert.equal((await planGithubLabelMigration(nativeRoot, csvInput, { readCatalog: async () => csvCatalog, approval: nativePlan.approval })).checked, true);
const issue = { number: 1, title: nativeBefore.title, body: "", state: "open" as const, labels: [{ name: "bug, BUG" }],
  assignee: null, milestone: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", html_url: "https://github.com/unbraind/pm-github/issues/1" };
const entry = (await prepareGithubImport(issue, csvInput.repo, parseImportOptions({}), undefined, nativeBefore, undefined,
  { items: [nativeBefore], releases: [], timeline: async () => [] }))!;
const refresh = buildAtomicImportMutations(csvInput.repo, entry, settings.id_prefix, normalizeItemId, true).mutations[0]!;
if (refresh.op !== "update") throw new Error("Expected native refresh update");
assert.equal(typeof refresh.options.tags, "string", "literal comma state must require a refresh tag write");
await update(target.id, { ...refresh.options, ...scope }, { pmRoot: nativeRoot });
const actual = (await get(target.id, {}, { pmRoot: nativeRoot })).item;
assert.ok(actual.tags!.includes("bug") && !actual.tags!.includes("bug, bug"));
await seedNative();
writeFileSync(${JSON.stringify(join(local, "native-report-"))} + runtime + ".json", JSON.stringify(await planGithubLabelMigration(nativeRoot, csvInput, { readCatalog: async () => csvCatalog })));
console.log(JSON.stringify({ runtime: process.versions.bun ? "Bun" : "Node", sdk: "2026.10.26", table_codec: true, own_padding: true, native_comma: true, refresh_delta: true, scanned: report.counts.scanned, affected: report.counts.total }));
`);
  for (const runtime of [process.execPath, bun]) console.log(run(runtime, [sdkProof], local, { PM_PATH: root }).trim());
  assert.equal(fingerprint(root), before);
  const consumers = [
    { name: "project-local", binary: join(local, "node_modules/.bin/pm"), prefix: [], extension: join(local, "node_modules/pm-github") },
    { name: "npx", binary: "npx", prefix: ["--no-install", "pm"], extension: join(local, "node_modules/pm-github") },
    { name: "bunx", binary: join(tooling, "node_modules/.bin/bunx"), prefix: ["--bun", "--no-install", "pm"], extension: join(local, "node_modules/pm-github") },
    { name: "npm-global", binary: join(npmGlobal, "bin/pm"), prefix: [], extension: join(npmGlobal, "lib/node_modules/pm-github") },
    { name: "bun-global", binary: join(bunBin, "pm"), prefix: [], extension: join(bunGlobal, "node_modules/pm-github") },
  ];
  for (const consumer of consumers) {
    console.log(`Checking ${consumer.name}`);
    const tracker = publicCopy(consumer.name, consumer.extension);
    const original = fingerprint(tracker);
    const args = ["--path", tracker, "github", "labels", "plan", "--input", requestFile, "--catalog", catalogFile, "--limit", "5"];
    const result = validatedWire(JSON.parse(run(consumer.binary, [...consumer.prefix, ...args, "--json"], local)));
    assert.deepEqual(result, report);
    const repeated = validatedWire(JSON.parse(run(consumer.binary, [...consumer.prefix, ...args, "--approve", result.approval, "--json"], local)));
    assert.equal(repeated.checked, true);
    assert.deepEqual(validatedWire(decode(run(consumer.binary, [...consumer.prefix, ...args], local))), report);
    const csvArgs = ["--path", tracker, "github", "labels", "plan", "--input", csvRequestFile, "--catalog", csvCatalogFile, "--limit", "5"];
    const csv = validatedWire(JSON.parse(run(consumer.binary, [...consumer.prefix, ...csvArgs, "--json"], local)));
    assert.deepEqual(csv, csvReport);
    assert.deepEqual(validatedWire(decode(run(consumer.binary, [...consumer.prefix, ...csvArgs], local))), csvReport);
    assert.match(run(consumer.binary, [...consumer.prefix, ...csvArgs, "--approve", csv.approval, "--json"], local, {}, 2), /unresolved_choices/);
    assert.equal(fingerprint(tracker), original);
    const nativeTracker = join(scratch, `native-consumer-${consumer.name}`);
    cpSync(join(local, "native-proof-node"), nativeTracker, { recursive: true });
    copies.push(nativeTracker);
    installedExtension(nativeTracker, consumer.extension);
    for (const entry of trackerEntries(nativeTracker)) chmodSync(entry.path, entry.directory ? 0o555 : 0o444);
    chmodSync(nativeTracker, 0o555);
    const nativeBefore = fingerprint(nativeTracker);
    const expectedNative = validatedWire(JSON.parse(readFileSync(join(local, "native-report-node.json"), "utf8")));
    const nativeArgs = ["--path", nativeTracker, "github", "labels", "plan", "--input", csvRequestFile, "--catalog", csvCatalogFile];
    const native = validatedWire(JSON.parse(run(consumer.binary, [...consumer.prefix, ...nativeArgs, "--json"], local)));
    assert.deepEqual(native, expectedNative);
    assert.equal(native.counts.tags, 0);
    assert.deepEqual(validatedWire(decode(run(consumer.binary, [...consumer.prefix, ...nativeArgs], local))), expectedNative);
    assert.equal(validatedWire(JSON.parse(run(consumer.binary, [...consumer.prefix, ...nativeArgs, "--approve", native.approval, "--json"], local))).checked, true);
    assert.equal(fingerprint(nativeTracker), nativeBefore);
    console.log(JSON.stringify({ consumer: consumer.name, cli: "2026.10.26", json: true, toon: true, revalidated: true, csv_refused: true, native_comma: true, unchanged_tracker: true }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Public packed acceptance failed");
  process.exitCode = 1;
} finally {
  for (const root of copies) {
    chmodSync(root, 0o700);
    for (const entry of trackerEntries(root)) chmodSync(entry.path, entry.directory ? 0o700 : 0o600);
  }
  rmSync(scratch, { recursive: true, force: true });
}

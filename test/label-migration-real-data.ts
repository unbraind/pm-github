/** Opt-in public tracker and packed installation acceptance. Never reads private or hosted data. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { planGithubLabelMigration, readGithubLabelCatalog, validateGithubLabelMigrationReport, type GithubLabelMigrationInput } from "../index.ts";
import { decode } from "@toon-format/toon";

const packageRoot = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pm-label-public-"));
const copies: string[] = [];
const environment = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", PM_AUTHOR: "fixture", GIT_CEILING_DIRECTORIES: dirname(scratch) };
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
  if (extensionPath) {
    mkdirSync(join(root, "extensions"), { recursive: true });
    const installed = join(root, "extensions/pm-github");
    mkdirSync(installed);
    copyFileSync(join(extensionPath, "package.json"), join(installed, "package.json"));
    const manifest = JSON.parse(readFileSync(join(extensionPath, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(installed, "manifest.json"), JSON.stringify({ ...manifest, entry: "./entry.js" }));
    // A normal physical extension entry imports the actual installed artifact in place,
    // retaining npm/Bun's real dependency layout and global executable symlinks.
    writeFileSync(join(installed, "entry.js"), `export { default } from ${JSON.stringify(pathToFileURL(join(extensionPath, "dist/index.js")).href)};\n`);
  }
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
    console.log(JSON.stringify({ consumer: consumer.name, cli: "2026.10.26", json: true, toon: true, revalidated: true, csv_refused: true, unchanged_tracker: true }));
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

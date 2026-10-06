/**
 * Require exact coverage of every authored TypeScript and JavaScript source.
 *
 * Inventory includes operational scripts. c8 combines native V8 receipts from
 * test processes and their children, and reports unloaded modules at zero.
 * Reports are invalidated before a run; success requires complete source
 * receipts and exact covered/total equality in all four dimensions.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMainInvocation, nodeToolingExecutable } from "./main-invocation.ts";

/** Configuration cannot exempt sources or lower the required complete gate. */
interface CoverageConfig {
  readonly sources: readonly string[];
  readonly tests: readonly string[];
  readonly thresholds: Readonly<Record<string, number>>;
  readonly ignore?: readonly string[];
  readonly skipDirs?: readonly string[];
}

/** Exact coverage counters emitted by the standard JSON summary reporter. */
interface CoverageCounter {
  readonly total: number;
  readonly covered: number;
  readonly skipped: number;
}

/** A complete per-source receipt contains every required coverage dimension. */
type CoverageReceipt = Record<string, CoverageCounter>;

/** Test boundary for subprocess failures; production always starts real c8. */
export type CoverageRunner = (command: string, args: readonly string[], options: SpawnSyncOptions) => { readonly status: number | null; readonly error?: Error };

/** Test files, dependencies, tracker data, and generated artifacts are not source. */
const GENERATED_DIRECTORIES = new Set(["node_modules", "dist", "dist-test", "coverage", "test", "tests", ".agents", ".git", ".github"]);
/** Independent dimensions; equality uses counts, never rounded percentages. */
const DIMENSIONS = ["lines", "statements", "functions", "branches"] as const;

/**
 * Inventory all executable source modules under a configured location.
 *
 * @param root - Repository root used for stable relative paths.
 * @param target - Configured source file or directory.
 * @returns Source filenames; declaration modules carry no executable code.
 */
export function collectCoverageSources(root: string, target: string): string[] {
  const location = resolve(root, target);
  const repoRelative = relative(root, location);
  if (isAbsolute(repoRelative) || repoRelative === ".." || repoRelative.startsWith(`..${sep}`)) {
    throw new Error("Coverage source escapes the repository.");
  }
  if (!statSync(location).isDirectory()) {
    if (!/\.(?:ts|js)$/.test(location) || location.endsWith(".d.ts")) throw new Error("Coverage source must be an executable module.");
    return [repoRelative.split(sep).join("/")];
  }
  return readdirSync(location, { withFileTypes: true }).flatMap(entry => {
    const next = join(repoRelative, entry.name);
    if (entry.isDirectory()) return GENERATED_DIRECTORIES.has(entry.name) ? [] : collectCoverageSources(root, next);
    return /\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [next.split(sep).join("/")] : [];
  });
}

/**
 * Run the strict all-source gate and return its exit status.
 *
 * @param root - Repository to inventory and test.
 * @param runner - Subprocess runner, injectable for fail-closed diagnostics.
 * @returns Zero only for passing tests and complete 100/100/100/100 receipts.
 */
export function runCoverageGate(root: string, runner: CoverageRunner = spawnSync): number {
  const reports = join(root, "coverage");
  mkdirSync(reports, { recursive: true });
  for (const file of ["lcov.info", "coverage-summary.json", "coverage-final.json"]) rmSync(join(reports, file), { force: true });
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { coverageGate?: CoverageConfig };
    const config = manifest.coverageGate;
    if (!config || JSON.stringify(config.sources) !== '["."]' || DIMENSIONS.some(dimension => config.thresholds[dimension] !== 100) || (config.ignore?.length ?? 0) !== 0 || (config.skipDirs?.length ?? 0) !== 0) {
      throw new Error("Coverage requires four 100 percent thresholds and no source exemptions.");
    }
    const sources = [...new Set(config.sources.flatMap(source => collectCoverageSources(root, source)))];
    if (sources.length === 0 || config.tests.length === 0) throw new Error("Coverage inventory or test set is empty.");
    const c8 = join(dirname(createRequire(import.meta.url).resolve("c8/package.json")), "bin", "c8.js");
    const coverageEnv: NodeJS.ProcessEnv = { ...process.env, TZ: "UTC" };
    delete coverageEnv.NODE_TEST_CONTEXT;
    const node = nodeToolingExecutable(process.versions);
    const result = runner(node, [c8, "--100", "--all", "--exclude-after-remap", "--extension=.ts", "--extension=.js",
      `--reports-dir=${reports}`, `--temp-directory=${join(reports, "v8")}`,
      "--reporter=text", "--reporter=lcov", "--reporter=json-summary", "--reporter=json",
      ...sources.map(file => `--include=${file}`), node, "--test", ...config.tests],
      { cwd: root, stdio: "inherit", env: coverageEnv });
    if (result.error || result.status !== 0) {
      rmSync(join(reports, "lcov.info"), { force: true });
      return result.status ?? 1;
    }
    const summary = JSON.parse(readFileSync(join(reports, "coverage-summary.json"), "utf8")) as Record<string, CoverageReceipt>;
    const receiptFiles = new Set(Object.keys(summary).filter(file => file !== "total").map(file => relative(root, resolve(root, file)).split(sep).join("/")));
    if (sources.some(file => !receiptFiles.has(file))) throw new Error("Coverage receipt omits an authored source.");
    const lcovFiles = new Set(readFileSync(join(reports, "lcov.info"), "utf8").split("\n").filter(line => line.startsWith("SF:")).map(line => relative(root, resolve(root, line.slice(3))).split(sep).join("/")));
    if (sources.some(file => !lcovFiles.has(file))) throw new Error("LCOV receipt omits an authored source.");
    for (const receipt of Object.values(summary)) {
      if (DIMENSIONS.some(dimension => {
        const count = receipt[dimension];
        return !count || !Number.isInteger(count.total) || count.total < 0 || count.covered !== count.total || count.skipped !== 0;
      })) throw new Error("Coverage receipt is incomplete or contains skipped source.");
    }
    if (!summary.total || summary.total.lines!.total === 0) throw new Error("Coverage receipt has no executable lines.");
    console.log(`coverage-gate: ${sources.length} authored modules, exact 100/100/100/100 coverage.`);
    return 0;
  } catch {
    rmSync(join(reports, "lcov.info"), { force: true });
    console.error("coverage-gate: configuration, source inventory, or complete coverage receipt is invalid.");
    return 1;
  }
}

/**
 * Run the coverage gate when this file is the process entry point.
 *
 * The check lives in a function so a test can execute the true branch against a
 * fixture root. The CLI bottom call uses the real argv and this package root.
 *
 * @param argv - Process argv to compare with the module URL.
 * @param moduleUrl - `import.meta.url` of this module.
 * @param root - Repository root to inventory and test.
 */
export function runCoverageGateIfMain(argv: readonly string[], moduleUrl: string, root: string): void {
  if (isMainInvocation(argv, moduleUrl)) process.exitCode = runCoverageGate(root);
}

runCoverageGateIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));

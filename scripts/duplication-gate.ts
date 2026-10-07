/**
 * Run jscpd 5 over the complete authored source inventory using explicit paths.
 *
 * The engine no longer implements the older --pattern flag. A one-token pass
 * verifies that every module was actually scanned before the normal 50-token
 * duplication analysis can report success. Tests and generated output do not
 * enter the authored-source denominator.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { collectCoverageSources, type CoverageRunner } from "./coverage-gate.ts";
import { isMainInvocation, nodeToolingExecutable } from "./main-invocation.ts";

/** Engine counters validated independently of subprocess exit status. */
interface DuplicationSummary {
  readonly statistics: { readonly total: { readonly sources: number; readonly lines: number; readonly duplicatedLines: number } };
}

/**
 * Require a complete jscpd analysis and zero duplicated authored lines.
 *
 * @param root - Repository containing the explicit source inventory.
 * @param runner - Injectable subprocess boundary for failure-path tests.
 * @returns Zero only for complete clean detection with the pinned engine.
 */
export function runDuplicationGate(root: string, runner: CoverageRunner = spawnSync): number {
  try {
    const sources = collectCoverageSources(root, ".");
    if (sources.length === 0) throw new Error("No source modules exist.");
    const engine = join(dirname(createRequire(import.meta.url).resolve("jscpd/package.json")), "run-jscpd.js");
    let lines = 0;
    for (const minTokens of [1, 50]) {
      const output = join(root, "coverage", `duplication-${minTokens}`);
      rmSync(output, { recursive: true, force: true });
      mkdirSync(output, { recursive: true });
      const run = runner(nodeToolingExecutable(process.versions), [engine, "--absolute", "--no-gitignore", "--silent", `--threshold=${minTokens === 1 ? 1000000 : 0}`,
        `--min-tokens=${minTokens}`, "--min-lines=1", "--reporters=json", `--output=${output}`, ...sources.map(file => join(root, file))],
        { cwd: root, stdio: "inherit" });
      if (run.error || run.status !== 0) throw new Error("Detector failed.");
      const report = JSON.parse(readFileSync(join(output, "jscpd-report.json"), "utf8")) as DuplicationSummary;
      const counters = report.statistics.total;
      if (!Number.isInteger(counters.sources) || !Number.isInteger(counters.lines) || !Number.isInteger(counters.duplicatedLines) || counters.lines <= 0 || counters.duplicatedLines < 0) {
        throw new Error("Invalid detector counters.");
      }
      if (minTokens === 1 && counters.sources !== sources.length) throw new Error("Detector omitted source modules.");
      if (minTokens === 50 && counters.duplicatedLines !== 0) throw new Error("Authored source contains duplication.");
      lines = counters.lines;
    }
    console.log(`duplication-gate: ${sources.length} authored modules, ${lines} lines, zero duplicated lines.`);
    return 0;
  } catch {
    console.error("duplication-gate: detector failed, omitted source, or found duplicated lines.");
    return 1;
  }
}

/**
 * Run the duplication gate when this file is the process entry point.
 *
 * @param argv - Process argv to compare with the module URL.
 * @param moduleUrl - `import.meta.url` of this module.
 * @param root - Repository root whose authored sources are scanned.
 */
export function runDuplicationGateIfMain(argv: readonly string[], moduleUrl: string, root: string): void {
  if (isMainInvocation(argv, moduleUrl)) process.exitCode = runDuplicationGate(root);
}

runDuplicationGateIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));

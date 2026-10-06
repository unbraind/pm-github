/** Regression tests for the all-source denominator and fail-closed receipts. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectCoverageSources, runCoverageGate, runCoverageGateIfMain, type CoverageRunner } from "../scripts/coverage-gate.ts";
import { nodeToolingExecutable } from "../scripts/main-invocation.ts";

/** Create an independently runnable project with one branching source and its test. */
function coverageFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-github-coverage-"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", coverageGate: {
    sources: ["."], tests: ["test/*.test.ts"], thresholds: { lines: 100, statements: 100, branches: 100, functions: 100 }, ignore: [],
  } }));
  writeFileSync(join(root, "source.ts"), 'export function choose(value: boolean): string { return value ? "yes" : "no"; }\n');
  writeFileSync(join(root, "test", "source.test.ts"), 'import { choose } from "../source.ts"; import assert from "node:assert/strict"; assert.equal(choose(true), "yes"); assert.equal(choose(false), "no");\n');
  return root;
}

/** Emit explicit receipt variants to test the boundary independently of c8. */
function receiptRunner(root: string, variant: "complete" | "partial" | "omitted" | "empty" | "skipped" | "no-lcov"): CoverageRunner {
  return () => {
    const count = { total: variant === "empty" ? 0 : 1, covered: variant === "partial" || variant === "empty" ? 0 : 1, skipped: variant === "skipped" ? 1 : 0 };
    const entry = Object.fromEntries(["lines", "statements", "functions", "branches"].map(dimension => [dimension, count]));
    const sources = variant === "omitted" ? {} : { [join(root, "source.ts")]: entry };
    writeFileSync(join(root, "coverage", "coverage-summary.json"), JSON.stringify({ total: entry, ...sources }));
    if (variant !== "no-lcov") writeFileSync(join(root, "coverage", "lcov.info"), "SF:source.ts\nDA:1,1\nend_of_record\n");
    return { status: 0 };
  };
}

test("coverage inventory includes operational scripts and JavaScript, without generated data", () => {
  const root = coverageFixture();
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "scripts", "operation.ts"), "export const operation = 1;");
    writeFileSync(join(root, "policy.js"), "export const policy = true;");
    writeFileSync(join(root, "dist", "generated.js"), "export const artifact = true;");
    writeFileSync(join(root, "types.d.ts"), "export interface Data { value: string }");
    assert.deepEqual(collectCoverageSources(root, ".").sort(), ["policy.js", "scripts/operation.ts", "source.ts"]);
    assert.deepEqual(collectCoverageSources(root, "source.ts"), ["source.ts"]);
    assert.throws(() => collectCoverageSources(root, "types.d.ts"));
    assert.throws(() => collectCoverageSources(root, "package.json"));
    assert.throws(() => collectCoverageSources(root, "../escape"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage refuses lower thresholds, ignored sources, narrowed roots, and empty tests", () => {
  const root = coverageFixture();
  try {
    const baseline = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { coverageGate: Record<string, unknown> };
    for (const change of [{ thresholds: { lines: 99 } }, { ignore: ["source.ts"] }, { skipDirs: ["scripts"] }, { sources: ["source.ts"] }, { tests: [] }]) {
      writeFileSync(join(root, "package.json"), JSON.stringify({ coverageGate: { ...baseline.coverageGate, ...change } }));
      assert.equal(runCoverageGate(root), 1);
    }
    writeFileSync(join(root, "package.json"), "{}");
    assert.equal(runCoverageGate(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage invalidates stale receipts and rejects startup, process, and report failures", () => {
  const root = coverageFixture();
  try {
    mkdirSync(join(root, "coverage"));
    for (const failure of [{ status: 1 }, { status: null }, { status: null, error: new Error("unavailable") }]) {
      writeFileSync(join(root, "coverage", "lcov.info"), "stale full-coverage receipt");
      assert.equal(runCoverageGate(root, () => failure), 1);
      assert.equal(existsSync(join(root, "coverage", "lcov.info")), false);
    }
    assert.equal(runCoverageGate(root, () => ({ status: 0 })), 1, "missing reports cannot pass");
    for (const variant of ["partial", "omitted", "empty", "skipped", "no-lcov"] as const) {
      assert.equal(runCoverageGate(root, receiptRunner(root, variant)), 1, variant);
    }
    assert.equal(runCoverageGate(root, receiptRunner(root, "complete")), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage treats a missing exemption list as empty and rejects an LCOV receipt that omits a source", () => {
  const root = coverageFixture();
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { coverageGate: Record<string, unknown> };
    delete manifest.coverageGate.ignore;
    delete manifest.coverageGate.skipDirs;
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    assert.equal(runCoverageGate(root, () => ({ status: 1 })), 1, "omitted exemption lists are not a configuration failure");
    const count = { total: 1, covered: 1, skipped: 0 };
    const entry = Object.fromEntries(["lines", "statements", "functions", "branches"].map(dimension => [dimension, count]));
    assert.equal(runCoverageGate(root, () => {
      writeFileSync(join(root, "coverage", "coverage-summary.json"), JSON.stringify({ total: entry, [join(root, "source.ts")]: entry }));
      writeFileSync(join(root, "coverage", "lcov.info"), "SF:other.ts\nDA:1,1\nend_of_record\n");
      return { status: 0 };
    }), 1);
    assert.equal(existsSync(join(root, "coverage", "lcov.info")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("node tooling selects Node under Bun and the current executable otherwise", () => {
  assert.equal(nodeToolingExecutable({ bun: "1.3.5" }), "node");
  assert.equal(nodeToolingExecutable({}), process.execPath);
});

test("coverage gate main entry runs against the supplied root", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-coverage-main-"));
  const previous = process.exitCode;
  try {
    const moduleUrl = new URL("../scripts/coverage-gate.ts", import.meta.url).href;
    runCoverageGateIfMain(["node", fileURLToPath(moduleUrl)], moduleUrl, root);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real c8 requires both branches and rejects a completely unloaded authored module", () => {
  const root = coverageFixture();
  try {
    assert.equal(runCoverageGate(root), 0);
    writeFileSync(join(root, "unloaded.ts"), "export function uncovered(): string { return 'never loaded'; }\n");
    assert.equal(runCoverageGate(root), 1);
    assert.equal(existsSync(join(root, "coverage", "lcov.info")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Regression tests for the all-source denominator and fail-closed receipts. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectCoverageSources, COVERAGE_HEAP_FLAG, runCoverageGate, runCoverageGateIfMain, withoutHeapOverrides, type CoverageRunner } from "../scripts/coverage-gate.ts";
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

test("full coverage gates cap test execution at two workers", () => {
  const root = coverageFixture();
  try {
    const receipt = receiptRunner(root, "complete");
    assert.equal(runCoverageGate(root, (command, args, options) => {
      assert.ok(args.includes("--test-concurrency=2"));
      return receipt(command, args, options);
    }), 0);
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { scripts: { test: string } };
    assert.match(manifest.scripts.test, /--test-concurrency=2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage gate main entry runs against the supplied root", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-github-coverage-main-"));
  const previous = process.exitCode;
  try {
    const moduleUrl = new URL("../scripts/coverage-gate.ts", import.meta.url).href;
    runCoverageGateIfMain(["node", fileURLToPath(moduleUrl)], moduleUrl, root);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous ?? 0;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real c8 bounds many-receipt merging and preserves covered, uncovered and unloaded sources", () => {
  const root = coverageFixture();
  try {
    assert.equal(runCoverageGate(root), 0);
    const testFile = join(root, "test", "source.test.ts");
    const fullTest = readFileSync(testFile, "utf8");
    // More serialized input than the merge heap can hold. Built-in URLs are
    // outside the inventory, just like most real child-process receipts.
    writeFileSync(testFile, fullTest + `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const noise = JSON.stringify({ result: [{ scriptId: "0", url: "node:coverage-noise",
        functions: Array.from({ length: 3000 }, () => ({ functionName: "outside",
          ranges: [{ startOffset: 0, endOffset: 1, count: 0 }], isBlockCoverage: true })) }] });
      for (let index = 0; index < 512; index++) {
        writeFileSync(join(process.env.NODE_V8_COVERAGE!, "noise-" + index + ".json"), noise);
      }
    `);
    assert.equal(runCoverageGate(root, (command, args, options) =>
      spawnSync(command, ["--max-old-space-size=128", ...args.slice(1)], options)), 0,
      "hundreds of raw receipts must fit a 128 MiB merge heap");

    writeFileSync(join(root, "source.ts"), 'export function choose(value: boolean): string {\n  if (value) {\n    return "yes";\n  }\n  return "no";\n}\n');
    writeFileSync(testFile, 'import { choose } from "../source.ts"; choose(true);\n');
    assert.equal(runCoverageGate(root), 1, "an uncovered line in an included URL must fail");
    const summary = JSON.parse(readFileSync(join(root, "coverage", "coverage-summary.json"), "utf8")) as Record<string, { lines: { covered: number; total: number } }>;
    const lines = summary[join(root, "source.ts")]!.lines;
    assert.ok(lines.covered > 0, "filtering must retain executed included-source counts");
    assert.ok(lines.covered < lines.total, "filtering cannot hide an uncovered included-source line");
    assert.equal(existsSync(join(root, "coverage", "lcov.info")), false);
    writeFileSync(testFile, fullTest);
    writeFileSync(join(root, "unloaded.ts"), "export function uncovered(): string { return 'never loaded'; }\n");
    assert.equal(runCoverageGate(root), 1);
    assert.equal(existsSync(join(root, "coverage", "lcov.info")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage inventory accepts dot-dot names inside the repository and rejects parent escape", () => {
  const root = coverageFixture();
  try {
    mkdirSync(join(root, "..cache"));
    writeFileSync(join(root, "..cache", "module.ts"), "export const value = 1;\n");
    assert.deepEqual(collectCoverageSources(root, "..cache"), ["..cache/module.ts"]);
    assert.throws(() => collectCoverageSources(root, ".."), /escapes the repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the incremental c8 merge receives its bounded heap before the entry point", () => {
  const seen: string[][] = [];
  const spy: CoverageRunner = (_command, args) => { seen.push([...args]); return { status: 1 }; };
  const root = coverageFixture();
  try {
    assert.equal(runCoverageGate(root, spy), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0], COVERAGE_HEAP_FLAG, "the heap flag must precede c8 so the merge process receives it");
  assert.equal(seen[0]![0], "--max-old-space-size=3072", "the heap ceiling must match docs/bounded-coverage-merge.md");
  assert.match(seen[0]![1]!, /c8\.js$/);
  assert.ok(seen[0]!.includes("--merge-async"));
});

test("inherited NODE_OPTIONS heap limits never reach the bounded c8 merge", () => {
  assert.equal(withoutHeapOverrides(undefined), undefined);
  assert.equal(withoutHeapOverrides("--max-old-space-size-percentage=60"), undefined);
  assert.equal(withoutHeapOverrides("--enable-source-maps --max_old_space_size 9000 --max-old-space-size=8192 --max-old-space-size-percentage 60 --trace-warnings"),
    "--enable-source-maps --trace-warnings");
  assert.equal(withoutHeapOverrides("--max-old-space-size --trace-warnings"), "--trace-warnings");
  assert.equal(withoutHeapOverrides("--trace-warnings --max-old-space-size"), "--trace-warnings");
  // A different flag that shares the prefix is kept.
  assert.equal(withoutHeapOverrides("--max-old-space-size-other=1"), "--max-old-space-size-other=1");
  const seen: (string | undefined)[] = [];
  const spy: CoverageRunner = (_command, _args, options) => { seen.push(options.env?.NODE_OPTIONS); return { status: 1 }; };
  const previous = process.env.NODE_OPTIONS;
  const root = coverageFixture();
  try {
    process.env.NODE_OPTIONS = "--max-old-space-size-percentage=60 --enable-source-maps";
    assert.equal(runCoverageGate(root, spy), 1);
    process.env.NODE_OPTIONS = "--max-old-space-size-percentage=60";
    assert.equal(runCoverageGate(root, spy), 1);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(seen, ["--enable-source-maps", undefined]);
});

test("the effective merge heap stays at the documented ceiling under an inherited percentage", () => {
  const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size-percentage=60" };
  const probe = ["-e", "process.stdout.write(String(require('v8').getHeapStatistics().heap_size_limit))"];
  assert.equal(withoutHeapOverrides(env.NODE_OPTIONS), undefined);
  const bounded = spawnSync(process.execPath, [COVERAGE_HEAP_FLAG, ...probe], { env: { ...env, NODE_OPTIONS: "" }, encoding: "utf8" });
  const mib = Number(bounded.stdout) / 1048576;
  // heap_size_limit adds the young generation to the old-space ceiling.
  assert.ok(mib > 0 && mib <= 3072 + 512, `bounded merge heap ${mib} MiB exceeds the 3072 MiB ceiling`);
});
